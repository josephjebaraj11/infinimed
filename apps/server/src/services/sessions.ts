import { and, desc, eq, lt } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { connections, patientSessions, patients, sources, workspaces } from "../db/schema.js";
import { sha256Hex } from "../lib/crypto.js";
import { decodeCursor, encodeCursor, page } from "../lib/cursor.js";
import { ApiError } from "../lib/errors.js";
import { isLocalhostUrl } from "../lib/http.js";
import { newId, randomToken } from "../lib/ids.js";
import { isConnectable } from "./credentials.js";
import { emitEvent } from "./events.js";
import { upsertPatient, validateMetadata } from "./patients.js";
import { serializeSession } from "./serializers.js";
import { retrieveSource } from "./sources.js";

/**
 * Patient sessions: one browser journey in which a patient authorizes one or more sources.
 *   hosted mode  - the patient lands on InfiniMed's hosted search page and may connect several
 *   direct mode  - the session names one source and the patient goes straight to its portal
 * The session URL carries an unguessable token; only its hash is stored.
 */

type WorkspaceRow = typeof workspaces.$inferSelect;
type SessionRow = typeof patientSessions.$inferSelect;

export const DEFAULT_SESSION_TTL_SECONDS = 3600;

export function sessionUrl(token: string, mode: SessionRow["mode"]) {
  const base = `${config().publicUrl}/connect/${token}`;
  return mode === "direct" ? `${base}/start` : base;
}

export function validateReturnUrl(raw: unknown, ws: WorkspaceRow): string {
  if (typeof raw !== "string" || !raw) throw new ApiError("bad_request", "return_url is required", { param: "return_url" });
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError("invalid_data", "return_url is not a valid URL", { param: "return_url" });
  }
  const httpAllowed = url.protocol === "http:" && (isLocalhostUrl(url) || ws.environment === "sandbox");
  if (url.protocol !== "https:" && !httpAllowed) {
    throw new ApiError("invalid_data", "return_url must use https (http is allowed for localhost and sandbox workspaces)", { param: "return_url" });
  }
  if (url.hash) throw new ApiError("invalid_data", "return_url must not contain a fragment", { param: "return_url" });
  return url.toString();
}

export type CreateSessionInput = {
  patient_id: unknown;
  patient_email?: unknown;
  patient_name?: unknown;
  source_id?: unknown;
  recommended_source_ids?: unknown;
  return_url: unknown;
  return_button_label?: unknown;
  metadata?: unknown;
  expires_in?: unknown;
};

export async function createSession(ws: WorkspaceRow, input: CreateSessionInput, origin: SessionRow["origin"] = "api") {
  const returnUrl = validateReturnUrl(input.return_url, ws);
  if (input.source_id && input.recommended_source_ids) {
    throw new ApiError("bad_request", "Pass source_id or recommended_source_ids, not both", { param: "source_id" });
  }
  const label =
    input.return_button_label === undefined || input.return_button_label === null
      ? null
      : typeof input.return_button_label === "string" && input.return_button_label.length <= 60
        ? input.return_button_label
        : (() => {
            throw new ApiError("invalid_data", "return_button_label must be a string of at most 60 characters", { param: "return_button_label" });
          })();
  const metadata = validateMetadata(input.metadata);
  let ttl = DEFAULT_SESSION_TTL_SECONDS;
  if (input.expires_in !== undefined) {
    const n = Number(input.expires_in);
    if (!Number.isInteger(n) || n < 300 || n > 86_400) {
      throw new ApiError("invalid_data", "expires_in must be between 300 and 86400 seconds", { param: "expires_in" });
    }
    ttl = n;
  }

  let sourceId: string | null = null;
  if (input.source_id !== undefined && input.source_id !== null) {
    if (typeof input.source_id !== "string") throw new ApiError("invalid_data", "source_id must be a string", { param: "source_id" });
    const source = await retrieveSource(ws, input.source_id).catch(() => {
      throw new ApiError("resource_not_found", "The source_id does not exist or is not available to this workspace", { param: "source_id" });
    });
    if (!source.surfaces.includes("patient_access")) {
      throw new ApiError("bad_request", "This source does not support patient access", { param: "source_id" });
    }
    if (!(await isConnectable(ws.id, source.vendor, ws.environment))) {
      throw new ApiError("bad_request", `No credentials are configured for ${source.name}. Configure the connection under Settings, Connections.`, {
        param: "source_id",
      });
    }
    sourceId = source.id;
  }
  let recommended: string[] | null = null;
  if (input.recommended_source_ids !== undefined && input.recommended_source_ids !== null) {
    if (!Array.isArray(input.recommended_source_ids) || input.recommended_source_ids.some((x) => typeof x !== "string")) {
      throw new ApiError("invalid_data", "recommended_source_ids must be an array of strings", { param: "recommended_source_ids" });
    }
    if (input.recommended_source_ids.length > 20) {
      throw new ApiError("invalid_data", "recommended_source_ids accepts at most 20 ids", { param: "recommended_source_ids" });
    }
    recommended = [];
    for (const id of input.recommended_source_ids as string[]) {
      const s = await retrieveSource(ws, id).catch(() => {
        throw new ApiError("resource_not_found", `Recommended source ${id} does not exist or is not visible to this workspace`, {
          param: "recommended_source_ids",
        });
      });
      recommended.push(s.id);
    }
  }

  const patient = await upsertPatient(ws, { patient_id: input.patient_id, email: input.patient_email, name: input.patient_name }, origin === "portal" ? "session" : "session");
  const token = randomToken(32);
  const mode = sourceId ? "direct" : "hosted";
  const [row] = await db()
    .insert(patientSessions)
    .values({
      id: newId("patientSession"),
      workspaceId: ws.id,
      patientId: patient.id,
      mode,
      sourceId,
      recommendedSourceIds: recommended,
      returnUrl,
      returnButtonLabel: label,
      metadata,
      tokenHash: sha256Hex(token),
      origin,
      expiresAt: new Date(Date.now() + ttl * 1000),
    })
    .returning();
  return serializeSession(row!, patient.externalId, [], { url: sessionUrl(token, mode) });
}

export async function sessionConnections(sessionId: string) {
  const rows = await db()
    .select({ connection: connections, source: sources })
    .from(connections)
    .leftJoin(sources, eq(sources.id, connections.sourceId))
    .where(eq(connections.patientSessionId, sessionId))
    .orderBy(desc(connections.updatedAt));
  return rows.map((r) => ({ connection: r.connection, source: r.source ?? undefined }));
}

export async function retrieveSession(workspaceId: string, sessionId: string) {
  const [row] = await db()
    .select({ session: patientSessions, patient: patients })
    .from(patientSessions)
    .innerJoin(patients, eq(patients.id, patientSessions.patientId))
    .where(and(eq(patientSessions.id, sessionId), eq(patientSessions.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new ApiError("resource_not_found", "Patient session not found", { param: "id" });
  return serializeSession(row.session, row.patient.externalId, await sessionConnections(row.session.id));
}

export async function listSessionsForPatient(workspaceId: string, patientId: string, externalId: string, opts: { limit: number; startingAfter?: string }) {
  const conds = [eq(patientSessions.workspaceId, workspaceId), eq(patientSessions.patientId, patientId)];
  if (opts.startingAfter) conds.push(lt(patientSessions.id, String(decodeCursor(opts.startingAfter, "patient_sessions", patientId).p)));
  const rows = await db()
    .select()
    .from(patientSessions)
    .where(and(...conds))
    .orderBy(desc(patientSessions.id))
    .limit(opts.limit + 1);
  const hasMore = rows.length > opts.limit;
  const items = rows.slice(0, opts.limit);
  const data = [];
  for (const s of items) data.push(serializeSession(s, externalId, await sessionConnections(s.id)));
  const last = items[items.length - 1];
  return page(data, hasMore, last ? encodeCursor({ k: "patient_sessions", p: last.id, f: patientId }) : null);
}

export async function findSessionByToken(token: string) {
  const [row] = await db()
    .select({ session: patientSessions, patient: patients, workspace: workspaces })
    .from(patientSessions)
    .innerJoin(patients, eq(patients.id, patientSessions.patientId))
    .innerJoin(workspaces, eq(workspaces.id, patientSessions.workspaceId))
    .where(eq(patientSessions.tokenHash, sha256Hex(token)))
    .limit(1);
  return row ?? null;
}

/** Marks the session complete (idempotent) and emits patient_session.completed once. */
export async function completeSession(sessionId: string) {
  const now = new Date();
  const [updated] = await db()
    .update(patientSessions)
    .set({ status: "complete", completedAt: now })
    .where(and(eq(patientSessions.id, sessionId), eq(patientSessions.status, "open")))
    .returning();
  if (!updated) return null;
  const [patient] = await db().select().from(patients).where(eq(patients.id, updated.patientId)).limit(1);
  const serialized = serializeSession(updated, patient!.externalId, await sessionConnections(updated.id));
  await emitEvent(updated.workspaceId, "patient_session.completed", serialized);
  return serialized;
}

export async function expireStaleSessions() {
  await db()
    .update(patientSessions)
    .set({ status: "expired" })
    .where(and(eq(patientSessions.status, "open"), lt(patientSessions.expiresAt, new Date())));
}

/** Builds the return redirect for a session, adding outcome parameters for direct mode. */
export function buildReturnUrl(
  session: Pick<SessionRow, "returnUrl" | "id">,
  patientExternalId: string,
  outcome?: { success: true; sourceId: string; connectionId: string } | { success: false; error: string; errorDescription: string },
) {
  const url = new URL(session.returnUrl);
  url.searchParams.set("patient_id", patientExternalId);
  url.searchParams.set("patient_session_id", session.id);
  if (outcome) {
    url.searchParams.set("success", String(outcome.success));
    if (outcome.success) {
      url.searchParams.set("source_id", outcome.sourceId);
      url.searchParams.set("connection_id", outcome.connectionId);
    } else {
      url.searchParams.set("error", outcome.error);
      url.searchParams.set("error_description", outcome.errorDescription);
    }
  }
  return url.toString();
}
