import { and, eq, isNull, ne } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { connections, oauthStates, patients, patientSessions, sources, workspaces } from "../db/schema.js";
import { seal, unseal } from "../lib/crypto.js";
import { ApiError } from "../lib/errors.js";
import { fetchWithTimeout } from "../lib/http.js";
import { newId, randomToken } from "../lib/ids.js";
import { errorFields, log } from "../lib/logger.js";
import { enqueue } from "../jobs/queue.js";
import { resolveEndpoints } from "../smart/discovery.js";
import { createPkcePair } from "../smart/pkce.js";
import { profileFor } from "../smart/profiles.js";
import { exchangeAuthorizationCode, idTokenClaims, patientIdFromFhirUser, TokenError, type TokenResponse } from "../smart/token-client.js";
import { recordAuthEvent, tokenAad } from "./connections.js";
import { resolveCredentials } from "./credentials.js";
import { buildReturnUrl, completeSession } from "./sessions.js";

/**
 * SMART on FHIR standalone patient launch, run entirely server-side:
 *   startAuthorization -> 302 to the source's authorize endpoint (PKCE S256, state, aud)
 *   handleCallback     -> exchange code (vendor-specific client auth), resolve the patient's FHIR id,
 *                         persist sealed tokens on an `active` connection, queue the background pull
 * Authorization codes are exchanged inline in the callback (MEDITECH codes live 60 seconds).
 */

type SourceRow = typeof sources.$inferSelect;
type WorkspaceRow = typeof workspaces.$inferSelect;
type SessionRow = typeof patientSessions.$inferSelect;
type PatientRow = typeof patients.$inferSelect;

const STATE_TTL_MS = 15 * 60 * 1000;

export async function startAuthorization(args: { ws: WorkspaceRow; session: SessionRow; source: SourceRow; sessionToken: string }) {
  const { ws, session, source } = args;
  if (session.status !== "open" || session.expiresAt.getTime() < Date.now()) {
    throw new ApiError("oauth_state_expired", "This connection link has expired. Start a new session.");
  }
  if (!source.surfaces.includes("patient_access")) throw new ApiError("bad_request", "Source does not support patient access");
  if (source.environment !== ws.environment && source.workspaceId !== ws.id) {
    throw new ApiError("environment_mismatch", `A ${ws.environment} workspace cannot connect to ${source.environment} sources`);
  }
  const profile = profileFor(source.vendor);
  const creds = await resolveCredentials(ws.id, source.vendor, "patient_access", source.environment);
  if (!creds.enabled) throw new ApiError("forbidden", `${source.name} is disabled for this workspace`);
  const endpoints = await resolveEndpoints(source);
  const pkce = createPkcePair();
  const state = randomToken(32);
  const redirectUri = config().oauthCallbackUrl;
  const scope = creds.scopes.join(" ");

  await db()
    .insert(oauthStates)
    .values({
      id: state,
      purpose: "patient_access",
      workspaceId: ws.id,
      patientSessionId: session.id,
      sourceId: source.id,
      codeVerifierEnc: seal(pkce.verifier, `state:${state}`),
      redirectUri,
      scope,
      payload: { session_token_enc: seal(args.sessionToken, `state:${state}`) },
      expiresAt: new Date(Date.now() + STATE_TTL_MS),
    });

  const url = new URL(endpoints.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", creds.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("aud", source.audience ?? source.fhirBaseUrl!);
  if (profile.pkce) {
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", pkce.method);
  }
  for (const [k, v] of Object.entries(profile.extraAuthorizeParams ?? {})) url.searchParams.set(k, v);

  await recordAuthEvent({ workspaceId: ws.id, patientId: session.patientId, patientSessionId: session.id, sourceId: source.id, step: "redirect", status: "success" });
  return url.toString();
}

export type CallbackOutcome = {
  redirectTo: string;
  /** for rendering an error page when no redirect target is known */
  error?: { code: string; description: string };
};

async function resolvePatientFhirId(token: TokenResponse, source: SourceRow, clientId: string): Promise<{ patient: string | null; fhirUser: string | null; claims: Record<string, unknown> | null }> {
  const profile = profileFor(source.vendor);
  let claims = idTokenClaims(token.id_token);
  if (claims && token.id_token && source.jwksUri) {
    try {
      const jwks = createRemoteJWKSet(new URL(source.jwksUri));
      claims = (await jwtVerify(token.id_token, jwks, { audience: clientId })).payload as Record<string, unknown>;
    } catch (err) {
      log.warn("id_token verification failed; ignoring its claims", { source_id: source.id, ...errorFields(err) });
      claims = null;
    }
  }
  const fhirUser = typeof claims?.fhirUser === "string" ? claims.fhirUser : typeof claims?.profile === "string" ? claims.profile : null;
  for (const method of profile.identity) {
    if (method === "token_patient" && typeof token.patient === "string" && token.patient) return { patient: token.patient, fhirUser, claims };
    if (method === "id_token_fhir_user") {
      const id = patientIdFromFhirUser(fhirUser);
      if (id) return { patient: id, fhirUser, claims };
    }
    if (method === "userinfo" && source.userinfoUrl) {
      try {
        const res = await fetchWithTimeout(source.userinfoUrl, { headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" }, timeoutMs: 10_000 });
        if (res.ok) {
          const info = (await res.json()) as Record<string, unknown>;
          const id = (typeof info.patient === "string" && info.patient) || patientIdFromFhirUser(info.fhirUser) || (typeof info.sub === "string" ? info.sub : null);
          if (id) return { patient: id, fhirUser: typeof info.fhirUser === "string" ? info.fhirUser : fhirUser, claims };
        }
      } catch (err) {
        log.warn("userinfo lookup failed", { source_id: source.id, ...errorFields(err) });
      }
    }
  }
  return { patient: null, fhirUser, claims };
}

async function recordFailedAttempt(args: { ws: WorkspaceRow; session: SessionRow; patient: PatientRow; source: SourceRow; code: string; description: string }) {
  const { ws, session, patient, source } = args;
  const now = new Date();
  // Reuse one failed row per (patient, source) so retries do not pile up.
  const [existing] = await db()
    .select()
    .from(connections)
    .where(and(eq(connections.patientId, patient.id), eq(connections.sourceId, source.id), eq(connections.status, "failed")))
    .limit(1);
  let id = existing?.id;
  if (existing) {
    await db()
      .update(connections)
      .set({ patientSessionId: session.id, failureCode: args.code, failureDescription: args.description.slice(0, 500), failureAt: now, updatedAt: now })
      .where(eq(connections.id, existing.id));
  } else {
    id = newId("connection");
    await db()
      .insert(connections)
      .values({
        id,
        workspaceId: ws.id,
        patientId: patient.id,
        sourceId: source.id,
        patientSessionId: session.id,
        status: "failed",
        failureCode: args.code,
        failureDescription: args.description.slice(0, 500),
        failureAt: now,
      });
  }
  return id!;
}

export async function handleCallback(query: URLSearchParams): Promise<CallbackOutcome> {
  const stateId = query.get("state");
  if (!stateId) return { redirectTo: "", error: { code: "oauth_state_expired", description: "The authorization response had no state." } };

  const [state] = await db()
    .update(oauthStates)
    .set({ consumedAt: new Date() })
    .where(and(eq(oauthStates.id, stateId), isNull(oauthStates.consumedAt), eq(oauthStates.purpose, "patient_access")))
    .returning();
  if (!state || state.expiresAt.getTime() < Date.now()) {
    return { redirectTo: "", error: { code: "oauth_state_expired", description: "This sign-in took too long or was already used. Please start again." } };
  }

  const [ctx] = await db()
    .select({ session: patientSessions, patient: patients, ws: workspaces })
    .from(patientSessions)
    .innerJoin(patients, eq(patients.id, patientSessions.patientId))
    .innerJoin(workspaces, eq(workspaces.id, patientSessions.workspaceId))
    .where(eq(patientSessions.id, state.patientSessionId!))
    .limit(1);
  const [source] = await db().select().from(sources).where(eq(sources.id, state.sourceId)).limit(1);
  if (!ctx || !source) return { redirectTo: "", error: { code: "resource_not_found", description: "The patient session no longer exists." } };
  const { session, patient, ws } = ctx;
  const sessionToken = unseal(String(state.payload.session_token_enc), `state:${state.id}`);

  const finish = async (outcome: { success: true; connectionId: string } | { success: false; error: string; description: string }) => {
    if (session.mode === "direct") {
      await completeSession(session.id);
      return {
        redirectTo: buildReturnUrl(
          session,
          patient.externalId,
          outcome.success
            ? { success: true, sourceId: source.id, connectionId: outcome.connectionId }
            : { success: false, error: outcome.error, errorDescription: outcome.description },
        ),
      };
    }
    const hosted = new URL(`${config().publicUrl}/connect/${sessionToken}`);
    if (outcome.success) hosted.searchParams.set("connected", source.id);
    else {
      hosted.searchParams.set("failed", source.id);
      hosted.searchParams.set("error", outcome.error);
    }
    return { redirectTo: hosted.toString() };
  };

  const upstreamError = query.get("error");
  if (upstreamError) {
    const code = upstreamError === "access_denied" ? "user_denied" : "oauth_error";
    const description = query.get("error_description") ?? (code === "user_denied" ? "Patient canceled the connection" : "The portal returned an authorization error");
    await recordAuthEvent({ workspaceId: ws.id, patientId: patient.id, patientSessionId: session.id, sourceId: source.id, step: "callback", status: "failure", errorCode: code, errorDescription: description.slice(0, 500) });
    await recordFailedAttempt({ ws, session, patient, source, code, description });
    return finish({ success: false, error: code, description });
  }

  const code = query.get("code");
  if (!code) {
    await recordFailedAttempt({ ws, session, patient, source, code: "oauth_error", description: "No authorization code returned" });
    return finish({ success: false, error: "oauth_error", description: "No authorization code returned" });
  }
  await recordAuthEvent({ workspaceId: ws.id, patientId: patient.id, patientSessionId: session.id, sourceId: source.id, step: "callback", status: "success" });

  const creds = await resolveCredentials(ws.id, source.vendor, "patient_access", source.environment);
  let token: TokenResponse;
  try {
    const endpoints = await resolveEndpoints(source);
    token = await exchangeAuthorizationCode({
      tokenUrl: endpoints.tokenUrl,
      code,
      redirectUri: state.redirectUri,
      codeVerifier: unseal(state.codeVerifierEnc, `state:${state.id}`),
      credentials: creds,
    });
  } catch (err) {
    const description = err instanceof TokenError ? err.description || err.code : (err as Error).message;
    const errCode = err instanceof TokenError ? err.code : "network_error";
    await recordAuthEvent({ workspaceId: ws.id, patientId: patient.id, patientSessionId: session.id, sourceId: source.id, step: "token_exchange", status: "failure", errorCode: errCode, errorDescription: description.slice(0, 500) });
    await recordFailedAttempt({ ws, session, patient, source, code: "token_exchange_failed", description: `${errCode}: ${description}` });
    return finish({ success: false, error: "token_exchange_failed", description: "The portal approved access but the token exchange failed" });
  }

  const identity = await resolvePatientFhirId(token, source, creds.clientId);
  if (!identity.patient) {
    await recordAuthEvent({ workspaceId: ws.id, patientId: patient.id, patientSessionId: session.id, sourceId: source.id, step: "token_exchange", status: "failure", errorCode: "no_patient_context", errorDescription: "Token response did not identify a patient" });
    await recordFailedAttempt({ ws, session, patient, source, code: "no_patient_context", description: "The source did not return a patient context (check launch/patient and fhirUser scopes)" });
    return finish({ success: false, error: "no_patient_context", description: "The portal did not share which patient's records were approved" });
  }

  const now = new Date();
  const [existing] = await db()
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.patientId, patient.id),
        eq(connections.sourceId, source.id),
        eq(connections.fhirPatientId, identity.patient),
        ne(connections.status, "failed"),
      ),
    )
    .limit(1);
  const connectionId = existing?.id ?? newId("connection");
  const tokenFields = {
    status: "active" as const,
    patientSessionId: session.id,
    failureCode: null,
    failureDescription: null,
    failureAt: null,
    fhirPatientId: identity.patient,
    fhirUser: identity.fhirUser,
    grantedScopes: token.scope ?? state.scope,
    accessTokenEnc: seal(token.access_token, tokenAad(connectionId)),
    refreshTokenEnc: token.refresh_token ? seal(token.refresh_token, tokenAad(connectionId)) : null,
    accessTokenExpiresAt: new Date(now.getTime() + (token.expires_in ?? 3600) * 1000),
    idTokenClaims: identity.claims ? { iss: identity.claims.iss, sub: identity.claims.sub, fhirUser: identity.fhirUser } : null,
    lastRefreshedAt: now,
    disconnectedAt: null,
    nextPullAt: now,
    updatedAt: now,
  };
  if (existing) {
    await db().update(connections).set(tokenFields).where(eq(connections.id, existing.id));
  } else {
    await db()
      .insert(connections)
      .values({ id: connectionId, workspaceId: ws.id, patientId: patient.id, sourceId: source.id, surface: "patient_access", ...tokenFields });
  }
  // A successful connection supersedes earlier failed attempts against the same source.
  await db()
    .delete(connections)
    .where(and(eq(connections.patientId, patient.id), eq(connections.sourceId, source.id), eq(connections.status, "failed")));

  await recordAuthEvent({ workspaceId: ws.id, patientId: patient.id, connectionId, patientSessionId: session.id, sourceId: source.id, step: "token_exchange", status: "success" });
  await enqueue("records.pull", { connection_id: connectionId, trigger: "connected" }, { dedupeKey: `pull:${connectionId}`, priority: 20 });
  return finish({ success: true, connectionId });
}
