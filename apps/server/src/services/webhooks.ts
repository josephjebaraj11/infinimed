import { and, desc, eq, lt, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { events, webhookDeliveries, webhookEndpoints, workspaces } from "../db/schema.js";
import { seal } from "../lib/crypto.js";
import { decodeCursor, encodeCursor, page } from "../lib/cursor.js";
import { ApiError } from "../lib/errors.js";
import { assertSafeOutboundUrl } from "../lib/http.js";
import { newId, randomToken } from "../lib/ids.js";
import { attemptDelivery } from "../webhooks/delivery.js";
import { requireFeature } from "./billing.js";
import { EVENT_TYPES, isEventType } from "./events.js";
import { validateMetadata } from "./patients.js";
import { serializeDelivery, serializeWebhookEndpoint } from "./serializers.js";

type WorkspaceRow = typeof workspaces.$inferSelect;

export const MAX_ENDPOINTS = 16;
const secretAad = (id: string) => `webhook:${id}`;

function validateEvents(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) throw new ApiError("invalid_data", "events must be a non-empty array", { param: "events" });
  if (input.includes("*")) return ["*"];
  for (const e of input) {
    if (typeof e !== "string" || !isEventType(e)) {
      throw new ApiError("invalid_data", `Unknown event type ${String(e)}. Valid: ${EVENT_TYPES.join(", ")} or "*"`, { param: "events" });
    }
  }
  return [...new Set(input as string[])];
}

async function validateUrl(raw: unknown, ws: WorkspaceRow) {
  if (typeof raw !== "string" || !raw) throw new ApiError("invalid_data", "url is required", { param: "url" });
  // Production workspaces must use HTTPS; sandbox may use http://localhost for local receivers.
  return (await assertSafeOutboundUrl(raw, { param: "url", allowHttpLocalhost: ws.environment === "sandbox" && !config().isProduction })).toString();
}

export async function createWebhook(ws: WorkspaceRow, input: Record<string, unknown>) {
  requireFeature(ws, "webhooks");
  const url = await validateUrl(input.url, ws);
  const evts = validateEvents(input.events);
  const [count] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.workspaceId, ws.id));
  if (Number(count?.n ?? 0) >= MAX_ENDPOINTS) {
    throw new ApiError("webhook_endpoint_limit_reached", `A workspace can have at most ${MAX_ENDPOINTS} webhook endpoints`);
  }
  const id = newId("webhook");
  const secret = `whsec_${randomToken(32)}`;
  const [row] = await db()
    .insert(webhookEndpoints)
    .values({
      id,
      workspaceId: ws.id,
      url,
      events: evts,
      description: typeof input.description === "string" ? input.description.slice(0, 500) : null,
      metadata: validateMetadata(input.metadata),
      apiVersion: config().apiVersion,
      secretEnc: seal(secret, secretAad(id)),
    })
    .returning();
  return serializeWebhookEndpoint(row!, secret);
}

export async function getWebhook(ws: WorkspaceRow, id: string) {
  const [row] = await db()
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.workspaceId, ws.id)))
    .limit(1);
  if (!row) throw new ApiError("resource_not_found", "Webhook endpoint not found", { param: "id" });
  return row;
}

export async function listWebhooks(ws: WorkspaceRow, opts: { limit: number; startingAfter?: string; status?: string }) {
  if (opts.status && !["active", "disabled"].includes(opts.status)) throw new ApiError("bad_request", "status must be active or disabled", { param: "status" });
  const conds = [eq(webhookEndpoints.workspaceId, ws.id)];
  if (opts.status) conds.push(eq(webhookEndpoints.status, opts.status as "active" | "disabled"));
  if (opts.startingAfter) conds.push(lt(webhookEndpoints.id, String(decodeCursor(opts.startingAfter, "webhooks", opts.status).p)));
  const rows = await db()
    .select()
    .from(webhookEndpoints)
    .where(and(...conds))
    .orderBy(desc(webhookEndpoints.id))
    .limit(opts.limit + 1);
  const items = rows.slice(0, opts.limit);
  const last = items[items.length - 1];
  return page(items.map((r) => serializeWebhookEndpoint(r)), rows.length > opts.limit, last ? encodeCursor({ k: "webhooks", p: last.id, f: opts.status }) : null);
}

export async function updateWebhook(ws: WorkspaceRow, id: string, input: Record<string, unknown>) {
  const existing = await getWebhook(ws, id);
  if ("api_version" in input) throw new ApiError("invalid_data", "api_version is immutable", { param: "api_version" });
  const patch: Partial<typeof webhookEndpoints.$inferInsert> = { updatedAt: new Date() };
  if (input.url !== undefined) patch.url = await validateUrl(input.url, ws);
  if (input.events !== undefined) patch.events = validateEvents(input.events);
  if (input.description !== undefined) patch.description = input.description === null ? null : String(input.description).slice(0, 500);
  if (input.metadata !== undefined) patch.metadata = validateMetadata(input.metadata);
  if (input.status !== undefined) {
    if (input.status !== "active" && input.status !== "disabled") throw new ApiError("invalid_data", "status must be active or disabled", { param: "status" });
    patch.status = input.status;
    patch.disabledAt = input.status === "disabled" ? new Date() : null;
  }
  const [row] = await db().update(webhookEndpoints).set(patch).where(eq(webhookEndpoints.id, existing.id)).returning();
  return serializeWebhookEndpoint(row!);
}

export async function deleteWebhook(ws: WorkspaceRow, id: string) {
  const existing = await getWebhook(ws, id);
  await db().delete(webhookEndpoints).where(eq(webhookEndpoints.id, existing.id));
  return { id, resource_type: "webhook_endpoint", deleted: true };
}

/** New signing secret; the old one stops verifying immediately (no grace period). */
export async function rotateWebhookSecret(ws: WorkspaceRow, id: string) {
  const existing = await getWebhook(ws, id);
  const secret = `whsec_${randomToken(32)}`;
  const [row] = await db()
    .update(webhookEndpoints)
    .set({ secretEnc: seal(secret, secretAad(existing.id)), updatedAt: new Date() })
    .where(eq(webhookEndpoints.id, existing.id))
    .returning();
  return serializeWebhookEndpoint(row!, secret);
}

export async function listWebhookEvents(ws: WorkspaceRow, endpointId: string, opts: { limit: number; startingAfter?: string }) {
  await getWebhook(ws, endpointId);
  const conds = [eq(webhookDeliveries.endpointId, endpointId)];
  if (opts.startingAfter) conds.push(lt(webhookDeliveries.id, String(decodeCursor(opts.startingAfter, "deliveries", endpointId).p)));
  const rows = await db()
    .select({ d: webhookDeliveries, e: events })
    .from(webhookDeliveries)
    .innerJoin(events, eq(events.id, webhookDeliveries.eventId))
    .where(and(...conds))
    .orderBy(desc(webhookDeliveries.id))
    .limit(opts.limit + 1);
  const items = rows.slice(0, opts.limit);
  const last = items[items.length - 1];
  return page(items.map((r) => serializeDelivery(r.d, r.e)), rows.length > opts.limit, last ? encodeCursor({ k: "deliveries", p: last.d.id, f: endpointId }) : null);
}

const redeliveredAt = new Map<string, number>();

/** Manual redelivery of one event (same event id), limited to once per minute per event. */
export async function redeliverEvent(ws: WorkspaceRow, eventId: string, endpointId?: string) {
  const conds = [eq(webhookDeliveries.eventId, eventId), eq(webhookDeliveries.workspaceId, ws.id)];
  if (endpointId) conds.push(eq(webhookDeliveries.endpointId, endpointId));
  const deliveries = await db().select().from(webhookDeliveries).where(and(...conds));
  if (deliveries.length === 0) throw new ApiError("resource_not_found", "Event not found", { param: "id" });
  const last = redeliveredAt.get(eventId) ?? deliveries.reduce((m, d) => Math.max(m, d.lastRedeliveredAt?.getTime() ?? 0), 0);
  const wait = 60 - Math.floor((Date.now() - last) / 1000);
  if (wait > 0) throw new ApiError("throttled", "This event was redelivered less than a minute ago", { retryAfter: wait });
  redeliveredAt.set(eventId, Date.now());
  const target = deliveries[0]!;
  await attemptDelivery(target.id, { manual: true });
  const [d] = await db().select({ d: webhookDeliveries, e: events }).from(webhookDeliveries).innerJoin(events, eq(events.id, webhookDeliveries.eventId)).where(eq(webhookDeliveries.id, target.id));
  return serializeDelivery(d!.d, d!.e);
}
