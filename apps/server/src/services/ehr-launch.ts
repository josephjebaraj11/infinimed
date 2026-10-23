import { and, eq, isNull } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { ehrLaunches, oauthStates, sources, workspaces } from "../db/schema.js";
import { seal, unseal, unsealOptional } from "../lib/crypto.js";
import { ApiError } from "../lib/errors.js";
import { newId, randomToken } from "../lib/ids.js";
import { resolveEndpoints } from "../smart/discovery.js";
import { createPkcePair } from "../smart/pkce.js";
import { profileFor } from "../smart/profiles.js";
import { exchangeAuthorizationCode, idTokenClaims, refreshAccessToken, TokenError } from "../smart/token-client.js";
import { requireFeature } from "./billing.js";
import { resolveCredentials } from "./credentials.js";
import { emitEvent } from "./events.js";
import { serializeLaunch } from "./serializers.js";
import { findSourceByIss } from "./sources.js";

/**
 * SMART App Launch (EHR launch) on behalf of a customer app. The EHR opens
 *   {PUBLIC_URL}/smart/launch/{workspace_id}?iss=...&launch=...
 * InfiniMed completes authorization with the EHR, stores the tokens, and redirects the clinician to
 * the customer's app launch URL with `im_launch=lc_*`. The app's backend resolves that handle via
 * GET /v1/launch-contexts/{id} and can read FHIR through the launch-scoped proxy without ever
 * holding EHR tokens itself.
 */

const launchAad = (id: string) => `launch:${id}`;

export async function beginEhrLaunch(workspaceId: string, iss: string | null, launch: string | null) {
  if (!iss) throw new ApiError("bad_request", "The EHR launch is missing the iss parameter", { param: "iss" });
  const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws) throw new ApiError("resource_not_found", "Workspace not found");
  requireFeature(ws, "clinical_workflow");
  const source = await findSourceByIss(iss, ws.environment);
  if (!source) throw new ApiError("resource_not_found", `FHIR source not found for iss ${new URL(iss).origin}. Add the EHR's FHIR base URL to the catalog.`);
  const creds = await resolveCredentials(ws.id, source.vendor, "clinical_workflow", source.environment);
  if (!creds.settings.app_launch_url) throw new ApiError("config_missing", "Set the App launch URL under Settings, Connections, Clinical workflow");
  const endpoints = await resolveEndpoints(source);
  const pkce = createPkcePair();
  const state = randomToken(32);
  const scopes = new Set(creds.scopes.length ? creds.scopes : profileFor(source.vendor).scopes.clinical_workflow ?? ["launch", "openid", "fhirUser"]);
  if (launch) scopes.add("launch");
  const scope = [...scopes].join(" ");
  await db()
    .insert(oauthStates)
    .values({
      id: state,
      purpose: "ehr_launch",
      workspaceId: ws.id,
      sourceId: source.id,
      codeVerifierEnc: seal(pkce.verifier, `state:${state}`),
      redirectUri: config().ehrLaunchCallbackUrl,
      scope,
      payload: { iss, launch_present: !!launch },
      expiresAt: new Date(Date.now() + 10 * 60_000),
    });
  const url = new URL(endpoints.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("redirect_uri", config().ehrLaunchCallbackUrl);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("aud", iss);
  if (launch) url.searchParams.set("launch", launch);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function completeEhrLaunch(query: URLSearchParams): Promise<{ redirectTo?: string; error?: { code: string; description: string } }> {
  const stateId = query.get("state") ?? "";
  const [state] = await db()
    .update(oauthStates)
    .set({ consumedAt: new Date() })
    .where(and(eq(oauthStates.id, stateId), isNull(oauthStates.consumedAt), eq(oauthStates.purpose, "ehr_launch")))
    .returning();
  if (!state || state.expiresAt.getTime() < Date.now()) return { error: { code: "oauth_state_expired", description: "The launch took too long or was already used." } };
  const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, state.workspaceId)).limit(1);
  const [source] = await db().select().from(sources).where(eq(sources.id, state.sourceId)).limit(1);
  if (!ws || !source) return { error: { code: "resource_not_found", description: "The workspace or source no longer exists." } };
  const creds = await resolveCredentials(ws.id, source.vendor, "clinical_workflow", source.environment);
  const appUrl = creds.settings.app_launch_url!;
  const id = newId("launchContext");
  const iss = String(state.payload.iss);

  const fail = async (code: string, description: string) => {
    await db().insert(ehrLaunches).values({ id, workspaceId: ws.id, sourceId: source.id, iss, status: "failed", errorCode: code, errorDescription: description.slice(0, 500) });
    const u = new URL(appUrl);
    u.searchParams.set("im_launch", id);
    u.searchParams.set("im_launch_error", code);
    return { redirectTo: u.toString() };
  };

  if (query.get("error")) return fail(query.get("error") === "access_denied" ? "user_denied" : "oauth_error", query.get("error_description") ?? "The EHR returned an authorization error");
  const code = query.get("code");
  if (!code) return fail("oauth_error", "No authorization code returned");
  try {
    const endpoints = await resolveEndpoints(source);
    const token = await exchangeAuthorizationCode({ tokenUrl: endpoints.tokenUrl, code, redirectUri: state.redirectUri, codeVerifier: unseal(state.codeVerifierEnc, `state:${state.id}`), credentials: creds });
    const claims = idTokenClaims(token.id_token);
    const context: Record<string, unknown> = {};
    for (const key of ["need_patient_banner", "smart_style_url", "intent", "tenant", "fhirContext"]) if (token[key] !== undefined) context[key] = token[key];
    await db()
      .insert(ehrLaunches)
      .values({
        id,
        workspaceId: ws.id,
        sourceId: source.id,
        iss,
        status: "active",
        accessTokenEnc: seal(token.access_token, launchAad(id)),
        refreshTokenEnc: token.refresh_token ? seal(token.refresh_token, launchAad(id)) : null,
        accessTokenExpiresAt: new Date(Date.now() + (token.expires_in ?? 3600) * 1000),
        scope: token.scope ?? state.scope,
        patientFhirId: typeof token.patient === "string" ? token.patient : null,
        encounterFhirId: typeof token.encounter === "string" ? token.encounter : null,
        fhirUser: typeof claims?.fhirUser === "string" ? claims.fhirUser : typeof claims?.profile === "string" ? claims.profile : null,
        context,
      });
    const [row] = await db().select().from(ehrLaunches).where(eq(ehrLaunches.id, id));
    await emitEvent(ws.id, "ehr_launch.completed", serializeLaunch(row!));
    const u = new URL(appUrl);
    u.searchParams.set("im_launch", id);
    return { redirectTo: u.toString() };
  } catch (err) {
    return fail("token_exchange_failed", err instanceof TokenError ? `${err.code}: ${err.description}` : (err as Error).message);
  }
}

export async function getLaunch(workspaceId: string, id: string) {
  const [row] = await db()
    .select()
    .from(ehrLaunches)
    .where(and(eq(ehrLaunches.id, id), eq(ehrLaunches.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new ApiError("resource_not_found", "Launch context not found", { param: "id" });
  if (Date.now() - row.createdAt.getTime() > 12 * 3600_000) throw new ApiError("resource_not_found", "Launch context expired", { param: "id" });
  if (!row.retrievedAt) await db().update(ehrLaunches).set({ retrievedAt: new Date() }).where(eq(ehrLaunches.id, id));
  return row;
}

/** Returns a valid EHR access token for the launch, refreshing when possible. */
export async function launchAccessToken(launch: typeof ehrLaunches.$inferSelect): Promise<string> {
  const access = unsealOptional(launch.accessTokenEnc, launchAad(launch.id));
  if (access && launch.accessTokenExpiresAt && launch.accessTokenExpiresAt.getTime() - Date.now() > 30_000) return access;
  const refresh = unsealOptional(launch.refreshTokenEnc, launchAad(launch.id));
  if (!refresh) throw new ApiError("token_unavailable", "The EHR session for this launch has expired; relaunch from the EHR");
  const [source] = await db().select().from(sources).where(eq(sources.id, launch.sourceId)).limit(1);
  const creds = await resolveCredentials(launch.workspaceId, source!.vendor, "clinical_workflow", source!.environment);
  const endpoints = await resolveEndpoints(source!);
  const token = await refreshAccessToken({ tokenUrl: endpoints.tokenUrl, refreshToken: refresh, credentials: creds });
  await db()
    .update(ehrLaunches)
    .set({
      accessTokenEnc: seal(token.access_token, launchAad(launch.id)),
      refreshTokenEnc: token.refresh_token ? seal(token.refresh_token, launchAad(launch.id)) : launch.refreshTokenEnc,
      accessTokenExpiresAt: new Date(Date.now() + (token.expires_in ?? 3600) * 1000),
    })
    .where(eq(ehrLaunches.id, launch.id));
  return token.access_token;
}

export function launchUrlFor(workspaceId: string) {
  return `${config().publicUrl}/smart/launch/${workspaceId}`;
}

export function cdsDiscoveryUrlFor(workspaceId: string) {
  return `${config().publicUrl}/cds-services/${workspaceId}`;
}

