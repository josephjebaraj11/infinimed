import { and, eq, sql } from "drizzle-orm";
import { db, dbKind } from "../db/client.js";
import { authEvents, connections, fhirResources, mpiIdentities, patients, sources, workspaces } from "../db/schema.js";
import { seal, unsealOptional } from "../lib/crypto.js";
import { ApiError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { errorFields, log } from "../lib/logger.js";
import { resolveEndpoints } from "../smart/discovery.js";
import { refreshAccessToken, revokeToken, TokenError } from "../smart/token-client.js";
import { resolveCredentials } from "./credentials.js";
import { emitEvent } from "./events.js";
import { serializeConnection } from "./serializers.js";

type ConnectionRow = typeof connections.$inferSelect;
type WorkspaceRow = typeof workspaces.$inferSelect;
type PatientRow = typeof patients.$inferSelect;

export const tokenAad = (connectionId: string) => `connection:${connectionId}`;

export async function recordAuthEvent(e: Omit<typeof authEvents.$inferInsert, "id">) {
  await db()
    .insert(authEvents)
    .values({ id: newId("authEvent"), ...e });
}

export async function getConnection(id: string) {
  const [row] = await db().select().from(connections).where(eq(connections.id, id)).limit(1);
  return row ?? null;
}

export async function getSource(id: string) {
  const [row] = await db().select().from(sources).where(eq(sources.id, id)).limit(1);
  return row ?? null;
}

/**
 * Serialises token refresh per connection. Vendors with rolling refresh tokens invalidate the old
 * token on use, so two concurrent refreshes would kill the grant. On Postgres a transaction-scoped
 * advisory lock covers multiple worker processes; in-process calls are chained as well.
 */
const localLocks = new Map<string, Promise<unknown>>();

async function withConnectionLock<T>(connectionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = localLocks.get(connectionId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async () => {
    if (dbKind() === "postgres") {
      return db().transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${connectionId}))`);
        return fn();
      });
    }
    return fn();
  });
  localLocks.set(connectionId, run);
  try {
    return await run;
  } finally {
    if (localLocks.get(connectionId) === run) localLocks.delete(connectionId);
  }
}

export class ConnectionUnusableError extends Error {
  constructor(
    readonly connectionId: string,
    readonly status: ConnectionRow["status"],
  ) {
    super(`connection ${connectionId} is ${status}`);
    this.name = "ConnectionUnusableError";
  }
}

/** Returns a usable access token, refreshing it first when it expires within 60 seconds. */
export async function getAccessToken(connectionId: string, opts: { forceRefresh?: boolean } = {}): Promise<string> {
  return withConnectionLock(connectionId, async () => {
    const conn = await getConnection(connectionId);
    if (!conn) throw new ApiError("resource_not_found", "Connection not found");
    if (conn.status !== "active") throw new ConnectionUnusableError(conn.id, conn.status);
    // Feed and backend connections carry no patient tokens; never apply lapse logic to them.
    if (conn.surface !== "patient_access") throw new ApiError("token_unavailable", "This connection does not hold patient-authorized tokens");
    const access = unsealOptional(conn.accessTokenEnc, tokenAad(conn.id));
    const fresh = conn.accessTokenExpiresAt ? conn.accessTokenExpiresAt.getTime() - Date.now() > 60_000 : true;
    if (access && fresh && !opts.forceRefresh) return access;
    return refreshConnection(conn);
  });
}

async function refreshConnection(conn: ConnectionRow): Promise<string> {
  const refresh = unsealOptional(conn.refreshTokenEnc, tokenAad(conn.id));
  const source = await getSource(conn.sourceId);
  const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, conn.workspaceId)).limit(1);
  if (!source || !ws) throw new Error("connection references a missing source or workspace");

  if (!refresh) {
    // No refresh token (e.g. Aetna): access simply lapses.
    await markLapsed(conn, "expired", "access_token_expired", "Access token expired and the source issues no refresh tokens");
    throw new ConnectionUnusableError(conn.id, "expired");
  }
  const creds = await resolveCredentials(ws.id, source.vendor, "patient_access", source.environment);
  const endpoints = await resolveEndpoints(source);
  try {
    const token = await refreshAccessToken({ tokenUrl: endpoints.tokenUrl, refreshToken: refresh, credentials: creds });
    const now = new Date();
    await db()
      .update(connections)
      .set({
        accessTokenEnc: seal(token.access_token, tokenAad(conn.id)),
        // Rolling refresh: keep the new refresh token when one is issued, otherwise the old one stays valid.
        refreshTokenEnc: token.refresh_token ? seal(token.refresh_token, tokenAad(conn.id)) : conn.refreshTokenEnc,
        accessTokenExpiresAt: new Date(now.getTime() + (token.expires_in ?? 3600) * 1000),
        grantedScopes: token.scope ?? conn.grantedScopes,
        lastRefreshedAt: now,
        updatedAt: now,
      })
      .where(eq(connections.id, conn.id));
    await recordAuthEvent({ workspaceId: conn.workspaceId, patientId: conn.patientId, connectionId: conn.id, sourceId: conn.sourceId, step: "refresh", status: "success" });
    return token.access_token;
  } catch (err) {
    if (err instanceof TokenError && err.permanent) {
      await markLapsed(conn, "refresh_failed", err.code, err.description);
      throw new ConnectionUnusableError(conn.id, "refresh_failed");
    }
    await recordAuthEvent({
      workspaceId: conn.workspaceId,
      patientId: conn.patientId,
      connectionId: conn.id,
      sourceId: conn.sourceId,
      step: "refresh",
      status: "failure",
      errorCode: err instanceof TokenError ? err.code : "network_error",
      errorDescription: (err as Error).message.slice(0, 500),
    });
    throw err;
  }
}

async function markLapsed(conn: ConnectionRow, status: "refresh_failed" | "expired", code: string, description: string) {
  const now = new Date();
  const [updated] = await db()
    .update(connections)
    .set({
      status,
      failureCode: code,
      failureDescription: description.slice(0, 500),
      failureAt: now,
      accessTokenEnc: null,
      refreshTokenEnc: null,
      accessTokenExpiresAt: null,
      nextPullAt: null,
      updatedAt: now,
    })
    .where(and(eq(connections.id, conn.id), eq(connections.status, "active")))
    .returning();
  if (!updated) return;
  await recordAuthEvent({
    workspaceId: conn.workspaceId,
    patientId: conn.patientId,
    connectionId: conn.id,
    sourceId: conn.sourceId,
    step: "refresh",
    status: "failure",
    errorCode: code,
    errorDescription: description.slice(0, 500),
  });
  const [patient] = await db().select().from(patients).where(eq(patients.id, conn.patientId)).limit(1);
  await emitEvent(conn.workspaceId, "connection.token_refresh_failed", {
    id: conn.id,
    object: "connection",
    patient_id: patient?.externalId ?? null,
    source_id: conn.sourceId,
    status,
    failure_code: code,
    failure_at: now.toISOString(),
    created_at: conn.createdAt.toISOString(),
  });
}

/**
 * Revokes the workspace's access to one source for a patient: best-effort upstream revocation,
 * tokens cleared, stored records from that connection removed, event emitted.
 */
export async function disconnectConnection(ws: WorkspaceRow, patient: PatientRow, connectionId: string, opts: { emit?: boolean } = {}) {
  const [conn] = await db()
    .select()
    .from(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.patientId, patient.id), eq(connections.workspaceId, ws.id)))
    .limit(1);
  if (!conn) throw new ApiError("resource_not_found", "Connection not found", { param: "connection_id" });

  const source = await getSource(conn.sourceId);
  const refresh = unsealOptional(conn.refreshTokenEnc, tokenAad(conn.id));
  const access = unsealOptional(conn.accessTokenEnc, tokenAad(conn.id));
  if (source && (refresh || access) && source.category !== "feed") {
    try {
      const endpoints = await resolveEndpoints(source);
      if (endpoints.revokeUrl) {
        const creds = await resolveCredentials(ws.id, source.vendor, conn.surface === "backend" ? "backend" : "patient_access", source.environment);
        await revokeToken({
          revokeUrl: endpoints.revokeUrl,
          token: (refresh ?? access)!,
          hint: refresh ? "refresh_token" : "access_token",
          credentials: creds,
        });
      }
    } catch (err) {
      log.warn("upstream token revocation failed", { connection_id: conn.id, ...errorFields(err) });
    }
  }
  const now = new Date();
  await db().transaction(async (tx) => {
    await tx
      .update(connections)
      .set({
        status: "disconnected",
        accessTokenEnc: null,
        refreshTokenEnc: null,
        accessTokenExpiresAt: null,
        nextPullAt: null,
        disconnectedAt: now,
        updatedAt: now,
      })
      .where(eq(connections.id, conn.id));
    await tx.delete(fhirResources).where(eq(fhirResources.connectionId, conn.id));
    await tx.delete(mpiIdentities).where(eq(mpiIdentities.connectionId, conn.id));
  });
  await recordAuthEvent({ workspaceId: ws.id, patientId: patient.id, connectionId: conn.id, sourceId: conn.sourceId, step: "revoke", status: "success" });
  if (opts.emit !== false) {
    const [updated] = await db().select().from(connections).where(eq(connections.id, conn.id));
    await emitEvent(ws.id, "connection.disconnected", { ...serializeConnection(updated!, source ?? undefined), patient_id: patient.externalId });
  }
  return { id: conn.id, resource_type: "connection", disconnected: true };
}
