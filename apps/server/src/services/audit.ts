import { db } from "../db/client.js";
import { auditLogs } from "../db/schema.js";
import { newId } from "../lib/ids.js";
import { errorFields, log } from "../lib/logger.js";

/**
 * Append-only audit trail of security-relevant actions: key lifecycle, credential changes, PHI
 * reads through the MCP server, deletes, exports and membership changes. Metadata must not contain
 * PHI; record identifiers and counts only.
 */

export type Actor = { type: "user" | "api_key" | "mcp" | "system"; id: string | null };

export async function audit(entry: {
  workspaceId: string | null;
  actor: Actor;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  requestId?: string | null;
}) {
  try {
    await db()
      .insert(auditLogs)
      .values({
        id: newId("audit"),
        workspaceId: entry.workspaceId,
        actorType: entry.actor.type,
        actorId: entry.actor.id,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        metadata: entry.metadata ?? {},
        ip: entry.ip ?? null,
        requestId: entry.requestId ?? null,
      });
  } catch (err) {
    // Auditing must never take a request down, but a failure is itself worth an alert.
    log.error("audit write failed", { action: entry.action, ...errorFields(err) });
  }
}

export const systemActor: Actor = { type: "system", id: null };
