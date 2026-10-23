import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { connections, exportDestinations, patients, pulls, sources, workspaces } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { errorFields, log } from "../lib/logger.js";
import { collectReferences, FhirClient, FhirHttpError, RateLimitedError, type FhirResource } from "../fhir/client.js";
import { profileFor } from "../smart/profiles.js";
import { assertCanActivate } from "../services/billing.js";
import { ConnectionUnusableError, getAccessToken } from "../services/connections.js";
import { emitEvent } from "../services/events.js";
import { registerIdentity } from "../services/mpi.js";
import { storeResources, storedReferenceKeys } from "../services/records.js";
import { enqueue, patchJobPayload, RetryLater, type JobRow } from "./queue.js";

/**
 * Background pull: turns an active connection into stored records.
 *   1. read the Patient, register it with the MPI
 *   2. run the vendor's query plan (patient compartment searches, all pages)
 *   3. resolve referenced Practitioner/Organization/Location/Medication resources
 *   4. settle: counts, events, next scheduled pull, export triggers
 * Unsupported resource types (400/403/404/422) are recorded and skipped, not fatal.
 */

type PullTrigger = (typeof pulls.$inferSelect)["trigger"];

const MAX_REFERENCE_FETCHES = 400;

export async function handlePullJob(payload: Record<string, unknown>, job: JobRow) {
  const connectionId = String(payload.connection_id);
  const trigger = (payload.trigger as PullTrigger) ?? "manual";

  const [row] = await db()
    .select({ conn: connections, source: sources, ws: workspaces, patient: patients })
    .from(connections)
    .innerJoin(sources, eq(sources.id, connections.sourceId))
    .innerJoin(workspaces, eq(workspaces.id, connections.workspaceId))
    .innerJoin(patients, eq(patients.id, connections.patientId))
    .where(eq(connections.id, connectionId))
    .limit(1);
  if (!row) return;
  const { conn, source, ws, patient } = row;
  if (conn.status !== "active" || !conn.fhirPatientId || !source.fhirBaseUrl) return;

  let pullId = typeof payload.pull_id === "string" ? payload.pull_id : null;
  const startedAt = new Date();
  if (!pullId) {
    pullId = newId("pull");
    await db().insert(pulls).values({ id: pullId, workspaceId: ws.id, patientId: patient.id, connectionId, trigger, status: "running", startedAt });
  } else {
    await db().update(pulls).set({ status: "running" }).where(eq(pulls.id, pullId));
  }

  const fail = async (code: string, message: string) => {
    const finishedAt = new Date();
    await db()
      .update(pulls)
      .set({ status: "failed", errorCode: code, errorMessage: message.slice(0, 1000), finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime() })
      .where(eq(pulls.id, pullId!));
    await emitEvent(ws.id, "records.sync.failed", {
      resource_type: "records_sync",
      pull_id: pullId,
      patient_id: patient.externalId,
      source_id: source.id,
      connection_id: connectionId,
      error_code: code,
      error_message: message.slice(0, 500),
    });
  };

  try {
    await assertCanActivate(ws, patient);
  } catch (err) {
    if (err instanceof ApiError) {
      await fail(err.code, err.message);
      return;
    }
    throw err;
  }

  const profile = profileFor(source.vendor);
  const client = new FhirClient(source.fhirBaseUrl, (force) => getAccessToken(connectionId, { forceRefresh: force }), {
    requestsPerMinute: profile.requestsPerMinute,
  });
  const ctx = { workspaceId: ws.id, patientId: patient.id, connectionId, sourceId: source.id };
  const totals = { created: 0, updated: 0, unchanged: 0, errors: 0 };
  const details: Record<string, unknown> = {};
  const referenced = new Set<string>();

  const store = async (resources: FhirResource[]) => {
    const r = await storeResources(ctx, resources);
    totals.created += r.created;
    totals.updated += r.updated;
    totals.unchanged += r.unchanged;
    for (const res of resources) collectReferences(res, referenced);
  };

  try {
    // 1. Patient
    const patientResource = await client.read("Patient", conn.fhirPatientId);
    await store([patientResource]);
    await registerIdentity({ workspaceId: ws.id, patientId: patient.id, connectionId, sourceId: source.id, fhirPatient: patientResource });
    details.Patient = { fetched: 1 };

    // 2. Query plan
    for (const step of profile.queryPlan) {
      const label = step.label ?? step.resourceType;
      const params = Object.fromEntries(Object.entries(step.params).map(([k, v]) => [k, v.replaceAll("{patient}", conn.fhirPatientId!)]));
      try {
        const r = await client.searchAll(step.resourceType, params, store, { count: 100 });
        details[label] = { fetched: r.resources, pages: r.pages, ...(r.truncated ? { truncated: true } : {}) };
      } catch (err) {
        if (err instanceof FhirHttpError && [400, 403, 404, 405, 422, 501].includes(err.status)) {
          details[label] = { skipped: true, status: err.status };
          if (err.status !== 404 && err.status !== 501) totals.errors++;
          continue;
        }
        throw err;
      }
    }

    // 3. References not already stored for this connection
    const followTypes = profile.followReferences;
    if (followTypes.length) {
      const have = await storedReferenceKeys(connectionId, followTypes);
      const todo = [...referenced].filter((ref) => followTypes.includes(ref.split("/")[0]!) && !have.has(ref)).slice(0, MAX_REFERENCE_FETCHES);
      let fetched = 0;
      for (const ref of todo) {
        const [type, id] = ref.split("/") as [string, string];
        try {
          await store([await client.read(type, id)]);
          fetched++;
        } catch (err) {
          if (err instanceof FhirHttpError) continue;
          throw err;
        }
      }
      details.references = { fetched, candidates: todo.length };
    }
  } catch (err) {
    if (err instanceof RateLimitedError) {
      await db().update(pulls).set({ status: "queued", details }).where(eq(pulls.id, pullId));
      throw new RetryLater(err.retryAfterSeconds, "source rate limit", { pull_id: pullId });
    }
    if (err instanceof ConnectionUnusableError) {
      await fail(err.status === "refresh_failed" ? "token_refresh_failed" : "token_unavailable", "Access to the source lapsed; the patient needs to reconnect");
      return;
    }
    const message = err instanceof FhirHttpError ? `${err.message}: ${err.body.slice(0, 200)}` : (err as Error).message;
    // Transient failures retry with backoff; only the final attempt surfaces as records.sync.failed.
    if (job.attempts < job.max_attempts && !(err instanceof FhirHttpError && err.status < 500)) {
      log.warn("pull attempt failed, will retry", { connection_id: connectionId, attempt: job.attempts, ...errorFields(err) });
      await db().update(pulls).set({ status: "queued", details }).where(eq(pulls.id, pullId));
      await patchJobPayload(job.id, { pull_id: pullId });
      throw new Error(message);
    }
    await fail(err instanceof FhirHttpError ? "fhir_error" : "retrieval_error", message);
    return;
  }

  // 4. Settle
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  const total = totals.created + totals.updated + totals.unchanged;
  await db()
    .update(pulls)
    .set({ status: "completed", total, created: totals.created, updated: totals.updated, errors: totals.errors, details, finishedAt, durationMs })
    .where(eq(pulls.id, pullId));
  const intervalMs = config().recordPullIntervalHours * 3600_000;
  const [latest] = await db().select().from(connections).where(eq(connections.id, connectionId)).limit(1);
  const canRepull = !!latest?.refreshTokenEnc || (latest?.accessTokenExpiresAt?.getTime() ?? 0) > Date.now() + intervalMs;
  await db()
    .update(connections)
    .set({ lastPullAt: finishedAt, nextPullAt: canRepull ? new Date(finishedAt.getTime() + intervalMs) : null, updatedAt: finishedAt })
    .where(eq(connections.id, connectionId));
  await db()
    .update(patients)
    .set({ activatedAt: finishedAt })
    .where(and(eq(patients.id, patient.id), isNull(patients.activatedAt)));

  await emitEvent(ws.id, "records.sync.completed", {
    resource_type: "records_sync",
    pull_id: pullId,
    patient_id: patient.externalId,
    source_id: source.id,
    connection_id: connectionId,
    total,
    created: totals.created,
    updated: totals.updated,
    errors: totals.errors,
    duration_ms: durationMs,
  });
  if (totals.created + totals.updated > 0) await triggerExports(ws.id, "pull_completed");
}

export async function triggerExports(workspaceId: string, trigger: "pull_completed" | "reactivated" | "destination_added" | "scheduled") {
  const dests = await db()
    .select({ id: exportDestinations.id })
    .from(exportDestinations)
    .where(and(eq(exportDestinations.workspaceId, workspaceId), eq(exportDestinations.enabled, true)));
  for (const d of dests) {
    // A short delay coalesces bursts of pulls into one export run per destination.
    await enqueue("export.run", { destination_id: d.id, trigger }, { dedupeKey: `export:${d.id}`, delaySeconds: trigger === "pull_completed" ? 5 : 0 });
  }
}

/** Scheduler: re-pull connections whose next pull is due. */
export async function scheduleDuePulls() {
  const due = await db()
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.status, "active"), lte(connections.nextPullAt, new Date()), sql`${connections.surface} = 'patient_access'`))
    .limit(200);
  for (const c of due) {
    await enqueue("records.pull", { connection_id: c.id, trigger: "scheduled" }, { dedupeKey: `pull:${c.id}`, priority: 50 });
  }
  return due.length;
}

export async function requestManualPull(connectionId: string) {
  return enqueue("records.pull", { connection_id: connectionId, trigger: "manual" }, { dedupeKey: `pull:${connectionId}`, priority: 20 });
}
