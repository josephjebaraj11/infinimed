import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { events, webhookDeliveries, webhookEndpoints } from "../db/schema.js";
import { unseal } from "../lib/crypto.js";
import { assertSafeOutboundUrl, fetchWithTimeout, readTextSafe } from "../lib/http.js";
import { log } from "../lib/logger.js";
import { enqueue } from "../jobs/queue.js";
import { buildEnvelope } from "../services/events.js";
import { signPayload, SIGNATURE_HEADER } from "./signing.js";

/**
 * Delivery worker. Up to 9 attempts per event and endpoint with delays of
 * 0, 1m, 5m, 30m, 2h, 12h, 24h, 24h, 24h (about 3.6 days end to end). A delivery that exhausts its
 * attempts disables the endpoint; no event is emitted for that transition. Timeout is 5 seconds.
 */

export const RETRY_DELAYS_SECONDS = [0, 60, 300, 1800, 7200, 43200, 86400, 86400, 86400];
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length;
export const DELIVERY_TIMEOUT_MS = 5_000;

type AttemptResult = { ok: boolean; status: number | null; body: string; error: string | null };

export async function attemptDelivery(deliveryId: string, opts: { manual?: boolean } = {}): Promise<AttemptResult | null> {
  const [row] = await db()
    .select({ delivery: webhookDeliveries, endpoint: webhookEndpoints, event: events })
    .from(webhookDeliveries)
    .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
    .innerJoin(events, eq(events.id, webhookDeliveries.eventId))
    .where(eq(webhookDeliveries.id, deliveryId))
    .limit(1);
  if (!row) return null;
  const { delivery, endpoint, event } = row;
  if (delivery.deliveredAt && !opts.manual) return null;
  if (endpoint.status !== "active" && !opts.manual) {
    await db().update(webhookDeliveries).set({ nextAttemptAt: null }).where(eq(webhookDeliveries.id, deliveryId));
    return null;
  }

  const body = JSON.stringify(buildEnvelope(event, endpoint.apiVersion));
  const secret = unseal(endpoint.secretEnc, `webhook:${endpoint.id}`);
  const { header } = signPayload(secret, body);
  let result: AttemptResult;
  try {
    await assertSafeOutboundUrl(endpoint.url);
    const res = await fetchWithTimeout(endpoint.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "InfiniMed-Webhooks/1.0",
        [SIGNATURE_HEADER]: header,
        "InfiniMed-Event-Id": event.id,
        "InfiniMed-Event-Type": event.type,
      },
      body,
      timeoutMs: DELIVERY_TIMEOUT_MS,
    });
    const text = await readTextSafe(res, 4096);
    result = { ok: res.status >= 200 && res.status < 300, status: res.status, body: text, error: null };
  } catch (err) {
    result = { ok: false, status: null, body: "", error: (err as Error).message };
  }

  const attempts = delivery.attempts + 1;
  const now = new Date();
  if (result.ok) {
    await db()
      .update(webhookDeliveries)
      .set({
        attempts,
        deliveredAt: now,
        nextAttemptAt: null,
        lastStatusCode: result.status,
        lastResponseBody: result.body,
        lastError: null,
        lastAttemptAt: now,
        ...(opts.manual ? { lastRedeliveredAt: now } : {}),
      })
      .where(eq(webhookDeliveries.id, deliveryId));
    return result;
  }

  // Manual redeliveries do not move the automatic schedule.
  const exhausted = !opts.manual && attempts >= MAX_ATTEMPTS;
  const nextDelay = RETRY_DELAYS_SECONDS[attempts];
  const nextAttemptAt = opts.manual
    ? delivery.nextAttemptAt
    : exhausted || nextDelay === undefined
      ? null
      : new Date(now.getTime() + nextDelay * 1000);
  await db()
    .update(webhookDeliveries)
    .set({
      attempts,
      nextAttemptAt,
      lastStatusCode: result.status,
      lastResponseBody: result.body,
      lastError: result.error,
      lastAttemptAt: now,
      ...(opts.manual ? { lastRedeliveredAt: now } : {}),
    })
    .where(eq(webhookDeliveries.id, deliveryId));

  if (exhausted) {
    await db()
      .update(webhookEndpoints)
      .set({ status: "disabled", disabledAt: now, updatedAt: now })
      .where(eq(webhookEndpoints.id, endpoint.id));
    log.warn("webhook endpoint auto-disabled", { endpoint_id: endpoint.id, workspace_id: endpoint.workspaceId });
  } else if (nextAttemptAt && !opts.manual) {
    await enqueue("webhook.deliver", { delivery_id: deliveryId }, { runAt: nextAttemptAt, priority: 10, maxAttempts: 1 });
  }
  return result;
}

export async function handleDeliveryJob(payload: Record<string, unknown>) {
  await attemptDelivery(String(payload.delivery_id));
}
