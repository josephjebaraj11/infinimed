import { and, eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { events, webhookDeliveries, webhookEndpoints } from "../db/schema.js";
import { newId } from "../lib/ids.js";
import { enqueue } from "../jobs/queue.js";

/**
 * Event bus. Every notable state change produces an `evt_*` record; each active webhook endpoint
 * subscribed to the type gets a delivery row and a delivery job. Payloads use one envelope:
 *   { id, object: "event", type, api_version, created_at, data: { object } }
 */

export const EVENT_TYPES = [
  "patient_session.completed",
  "connection.token_refresh_failed",
  "connection.disconnected",
  "records.sync.completed",
  "records.sync.failed",
  "export.run.completed",
  "export.run.failed",
  "ehr_launch.completed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

export function buildEnvelope(evt: { id: string; type: string; createdAt: Date; data: Record<string, unknown> }, apiVersion: string) {
  return {
    id: evt.id,
    object: "event",
    type: evt.type,
    api_version: apiVersion,
    created_at: evt.createdAt.toISOString(),
    data: { object: evt.data },
  };
}

export async function emitEvent(workspaceId: string, type: EventType, object: Record<string, unknown>): Promise<string> {
  const id = newId("event");
  const createdAt = new Date();
  await db().insert(events).values({ id, workspaceId, type, data: object, createdAt });

  const endpoints = await db()
    .select({ id: webhookEndpoints.id, events: webhookEndpoints.events })
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.workspaceId, workspaceId), eq(webhookEndpoints.status, "active")));

  for (const ep of endpoints) {
    if (!ep.events.includes("*") && !ep.events.includes(type)) continue;
    const deliveryId = newId("delivery");
    await db()
      .insert(webhookDeliveries)
      .values({ id: deliveryId, workspaceId, eventId: id, endpointId: ep.id, nextAttemptAt: createdAt })
      .onConflictDoNothing();
    await enqueue("webhook.deliver", { delivery_id: deliveryId }, { priority: 10, maxAttempts: 1 });
  }
  return id;
}

export const currentApiVersion = () => config().apiVersion;
