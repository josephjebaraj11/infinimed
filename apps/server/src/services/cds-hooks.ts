import { and, eq } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { db } from "../db/client.js";
import { cdsCalls, providerConfigs, workspaces, type ProviderSettings } from "../db/schema.js";
import { sha256Hex } from "../lib/crypto.js";
import { ApiError } from "../lib/errors.js";
import { assertSafeOutboundUrl, fetchWithTimeout, readTextSafe } from "../lib/http.js";
import { newId } from "../lib/ids.js";
import { errorFields, log } from "../lib/logger.js";
import { signPlatformJwt } from "./keys.js";
import { featureEnabled } from "./billing.js";

/**
 * CDS Hooks gateway. The EHR is configured with one discovery URL per workspace:
 *   GET  /cds-services/{workspace_id}                         -> the customer's service list
 *   POST /cds-services/{workspace_id}/{service_id}            -> forwarded to the customer service
 *   POST /cds-services/{workspace_id}/{service_id}/feedback   -> forwarded feedback
 * Inbound EHR JWTs are verified when trusted issuers are configured. Forwarded calls carry an
 * InfiniMed-signed JWT the customer verifies against /.well-known/jwks.json. CDS is advisory, so an
 * unreachable customer service yields an empty card list rather than an error in the EHR.
 */

const CDS_TIMEOUT_MS = 4_500;
const discoveryCache = new Map<string, { at: number; body: unknown }>();
const responseCache = new Map<string, { at: number; body: unknown }>();

async function workspaceCdsSettings(workspaceId: string): Promise<ProviderSettings | null> {
  const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!ws || !featureEnabled(ws, "clinical_workflow")) return null;
  // Any enabled clinical-workflow provider tile may hold the CDS endpoint; the first one wins.
  const rows = await db()
    .select()
    .from(providerConfigs)
    .where(and(eq(providerConfigs.workspaceId, workspaceId), eq(providerConfigs.surface, "clinical_workflow"), eq(providerConfigs.enabled, true)));
  return rows.find((r) => r.settings.cds_endpoint)?.settings ?? null;
}

function serviceBase(endpoint: string) {
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.endsWith("/cds-services") ? trimmed : `${trimmed}/cds-services`;
}

async function verifyInbound(settings: ProviderSettings, authorization: string | null) {
  const trusted = settings.cds_trusted_issuers ?? [];
  if (trusted.length === 0) return;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  if (!token) throw new ApiError("not_authenticated", "CDS Hooks request is missing the EHR's JWT");
  const header = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8") || "{}") as { jku?: string };
  const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8") || "{}") as { iss?: string };
  const issuer = trusted.find((t) => t.iss === payload.iss);
  if (!issuer) throw new ApiError("forbidden", "CDS Hooks request came from an untrusted issuer");
  const jku = issuer.jku ?? header.jku;
  if (!jku) throw new ApiError("forbidden", "No JWKS URL for the CDS Hooks issuer");
  await jwtVerify(token, createRemoteJWKSet(new URL(jku)), { issuer: issuer.iss }).catch(() => {
    throw new ApiError("invalid_token", "CDS Hooks JWT verification failed");
  });
}

export async function cdsDiscovery(workspaceId: string) {
  const settings = await workspaceCdsSettings(workspaceId);
  if (!settings?.cds_endpoint) return { services: [] };
  const cached = discoveryCache.get(workspaceId);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.body;
  try {
    const url = serviceBase(settings.cds_endpoint);
    await assertSafeOutboundUrl(url, { param: "cds_endpoint" });
    const res = await fetchWithTimeout(url, { headers: { Accept: "application/json" }, timeoutMs: CDS_TIMEOUT_MS });
    if (!res.ok) throw new Error(`discovery returned HTTP ${res.status}`);
    const body = (await res.json()) as { services?: unknown[] };
    const result = { services: Array.isArray(body.services) ? body.services : [] };
    discoveryCache.set(workspaceId, { at: Date.now(), body: result });
    return result;
  } catch (err) {
    log.warn("cds discovery failed", { workspace_id: workspaceId, ...errorFields(err) });
    return { services: [] };
  }
}

export async function cdsInvoke(args: { workspaceId: string; serviceId: string; body: Record<string, unknown>; authorization: string | null; feedback?: boolean }) {
  const settings = await workspaceCdsSettings(args.workspaceId);
  if (!settings?.cds_endpoint) throw new ApiError("resource_not_found", "No CDS service is configured for this workspace");
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(args.serviceId)) throw new ApiError("bad_request", "Invalid CDS service id");
  await verifyInbound(settings, args.authorization);
  if (!args.feedback && (typeof args.body.hook !== "string" || typeof args.body.hookInstance !== "string")) {
    throw new ApiError("bad_request", "CDS Hooks request needs hook and hookInstance");
  }
  const started = Date.now();
  const ttl = settings.cds_caching_seconds ?? 0;
  const ctx = (args.body.context ?? {}) as Record<string, unknown>;
  const cacheKey = sha256Hex(JSON.stringify([args.workspaceId, args.serviceId, args.body.hook, ctx.patientId, ctx.userId, ctx.encounterId]));
  if (!args.feedback && ttl > 0) {
    const hit = responseCache.get(cacheKey);
    if (hit && Date.now() - hit.at < ttl * 1000) {
      await logCall(args, { statusCode: 200, cardCount: cardCount(hit.body), cached: true, durationMs: Date.now() - started });
      return { status: 200, body: hit.body };
    }
  }
  const url = `${serviceBase(settings.cds_endpoint)}/${encodeURIComponent(args.serviceId)}${args.feedback ? "/feedback" : ""}`;
  try {
    await assertSafeOutboundUrl(url, { param: "cds_endpoint" });
    const jwt = await signPlatformJwt({ workspace_id: args.workspaceId }, { audience: url, expiresIn: "5m", subject: args.workspaceId });
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(args.body),
      timeoutMs: CDS_TIMEOUT_MS,
    });
    const text = await readTextSafe(res, 1024 * 1024);
    let body: unknown = { cards: [] };
    try {
      body = text ? JSON.parse(text) : { cards: [] };
    } catch {
      body = { cards: [] };
    }
    if (!args.feedback && res.ok && ttl > 0) responseCache.set(cacheKey, { at: Date.now(), body });
    await logCall(args, { statusCode: res.status, cardCount: cardCount(body), cached: false, durationMs: Date.now() - started });
    if (!res.ok && res.status >= 500) return { status: 200, body: { cards: [] } };
    return { status: res.status, body };
  } catch (err) {
    await logCall(args, { statusCode: null, cardCount: 0, cached: false, durationMs: Date.now() - started, error: (err as Error).message });
    return { status: 200, body: { cards: [] } };
  }
}

const cardCount = (b: unknown) => (Array.isArray((b as { cards?: unknown[] })?.cards) ? (b as { cards: unknown[] }).cards.length : 0);

async function logCall(
  args: { workspaceId: string; serviceId: string; body: Record<string, unknown> },
  r: { statusCode: number | null; cardCount: number; cached: boolean; durationMs: number; error?: string },
) {
  await db()
    .insert(cdsCalls)
    .values({
      id: newId("cdsCall"),
      workspaceId: args.workspaceId,
      serviceId: args.serviceId,
      hook: typeof args.body.hook === "string" ? args.body.hook : null,
      hookInstance: typeof args.body.hookInstance === "string" ? args.body.hookInstance : null,
      statusCode: r.statusCode,
      cardCount: r.cardCount,
      cached: r.cached,
      durationMs: r.durationMs,
      error: r.error ?? null,
    })
    .catch(() => undefined);
}
