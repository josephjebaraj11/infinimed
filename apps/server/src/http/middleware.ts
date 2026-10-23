import type { MiddlewareHandler } from "hono";
import { and, eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { apiKeys, idempotencyKeys, workspaces } from "../db/schema.js";
import { sha256Hex } from "../lib/crypto.js";
import { ApiError, isApiError } from "../lib/errors.js";
import { randomToken } from "../lib/ids.js";
import { errorFields, log } from "../lib/logger.js";
import type { AppEnv, Ctx } from "./context.js";

export const API_KEY_PREFIX = { sandbox: "im_sk_sbx_", production: "im_sk_live_" } as const;

export const requestId: MiddlewareHandler<AppEnv> = async (c, next) => {
  const incoming = c.req.header("x-request-id");
  const id = incoming && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
};

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  if (!c.res.headers.has("X-Frame-Options")) c.header("X-Frame-Options", "DENY");
  if (config().isProduction) c.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
};

export function errorResponse(c: Ctx, err: unknown) {
  const rid = c.get("requestId") ?? randomToken(8);
  if (isApiError(err)) {
    if (err.retryAfter) c.header("Retry-After", String(err.retryAfter));
    return c.json(err.toEnvelope(rid), err.status as 400);
  }
  if (err instanceof SyntaxError && /JSON/.test(err.message)) {
    return c.json(new ApiError("bad_request", "Request body is not valid JSON").toEnvelope(rid), 400);
  }
  log.error("unhandled error", { request_id: rid, path: c.req.path, ...errorFields(err) });
  return c.json(new ApiError("internal_error", "Unexpected server error. Retry with backoff.").toEnvelope(rid), 500);
}

/** Per-key token bucket (in-process). Multi-instance deployments should front this with a shared limiter. */
const buckets = new Map<string, { tokens: number; at: number }>();
const RATE = { perSecond: 25, burst: 100 };

function takeToken(key: string): number | null {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: RATE.burst, at: now };
  b.tokens = Math.min(RATE.burst, b.tokens + ((now - b.at) / 1000) * RATE.perSecond);
  b.at = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return Math.ceil((1 - b.tokens) / RATE.perSecond);
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return null;
}

const lastUsedWrites = new Map<string, number>();

export const apiKeyAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("authorization");
  if (!header) throw new ApiError("missing_api_key", "The Authorization header is missing. Send `Authorization: Bearer <api key>`.");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token.startsWith("im_sk_")) throw new ApiError("invalid_api_key", "API key invalid");
  const [row] = await db()
    .select({ key: apiKeys, ws: workspaces })
    .from(apiKeys)
    .innerJoin(workspaces, eq(workspaces.id, apiKeys.workspaceId))
    .where(eq(apiKeys.tokenHash, sha256Hex(token)))
    .limit(1);
  if (!row || row.key.revokedAt) throw new ApiError("invalid_api_key", "API key invalid");
  if (row.key.expiresAt && row.key.expiresAt.getTime() < Date.now()) throw new ApiError("expired_api_key", "API key expired");
  if (!token.startsWith(API_KEY_PREFIX[row.ws.environment])) throw new ApiError("invalid_api_key", "API key does not match the workspace environment");

  const retry = takeToken(row.key.id);
  if (retry !== null) throw new ApiError("throttled", "Too many requests", { retryAfter: retry });

  const version = c.req.header("infinimed-version");
  if (version && !config().supportedApiVersions.includes(version)) {
    throw new ApiError("unsupported_api_version", `Unsupported InfiniMed-Version ${version}. Supported: ${config().supportedApiVersions.join(", ")}`);
  }
  c.header("InfiniMed-Version", version ?? config().apiVersion);
  c.set("ws", row.ws);
  c.set("apiKey", row.key);
  c.set("actor", { type: "api_key", id: row.key.id });

  const last = lastUsedWrites.get(row.key.id) ?? 0;
  if (Date.now() - last > 60_000) {
    lastUsedWrites.set(row.key.id, Date.now());
    void db().update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.key.id)).catch(() => undefined);
  }
  await next();
};

/** Requires one of the scopes stamped on the API key ("*" grants everything). */
export function requireScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const key = c.get("apiKey");
    if (key && !key.scopes.includes("*") && !key.scopes.includes(scope)) {
      throw new ApiError("insufficient_scope", `API key lacks the ${scope} scope`);
    }
    await next();
  };
}

/**
 * Idempotency for POST requests: a repeated `Idempotency-Key` with the same body replays the stored
 * response; with a different body it is rejected. Keys are kept for 24 hours.
 */
export const idempotency: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = c.req.header("idempotency-key");
  if (c.req.method !== "POST" || !key) return next();
  if (key.length > 255) throw new ApiError("bad_request", "Idempotency-Key must be at most 255 characters");
  const ws = c.get("ws");
  const body = await c.req.raw.clone().text();
  const hash = sha256Hex(`${c.req.method} ${c.req.path}\n${body}`);
  const [existing] = await db()
    .select()
    .from(idempotencyKeys)
    .where(and(eq(idempotencyKeys.workspaceId, ws.id), eq(idempotencyKeys.key, key)))
    .limit(1);
  if (existing && Date.now() - existing.createdAt.getTime() < 24 * 3600_000) {
    if (existing.requestHash !== hash) throw new ApiError("idempotency_key_reused", "Idempotency-Key was already used with a different request");
    c.header("Idempotent-Replayed", "true");
    return c.body(existing.responseBody, existing.statusCode as 200, { "Content-Type": "application/json" });
  }
  await next();
  if (c.res.status < 500) {
    const responseBody = await c.res.clone().text();
    await db()
      .insert(idempotencyKeys)
      .values({ workspaceId: ws.id, key, method: c.req.method, path: c.req.path, requestHash: hash, statusCode: c.res.status, responseBody })
      .onConflictDoUpdate({
        target: [idempotencyKeys.workspaceId, idempotencyKeys.key],
        set: { requestHash: hash, statusCode: c.res.status, responseBody, createdAt: new Date() },
      });
  }
};

export async function readJson(c: Ctx): Promise<Record<string, unknown>> {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > 10 * 1024 * 1024) throw new ApiError("payload_too_large", "Request body is too large");
  const text = await c.req.text();
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError("bad_request", "Request body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new ApiError("bad_request", "Request body must be a JSON object");
  return parsed as Record<string, unknown>;
}
