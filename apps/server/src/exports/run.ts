import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { db, rawRows } from "../db/client.js";
import { connections, exportDestinations, exportRuns, fhirResources, patients } from "../db/schema.js";
import { newId } from "../lib/ids.js";
import { errorFields, log } from "../lib/logger.js";
import { emitEvent } from "../services/events.js";
import { serializeRun, writerFor } from "../services/destinations.js";
import { transformForExport } from "./transform.js";

/**
 * Export run engine. A run covers the change window (watermark, high-water mark] fixed at start:
 *   FHIR destinations  - every changed resource is PUT (update-as-create) in transaction batches
 *   object storage     - every (patient, source) pair touched in the window is rewritten in full
 * Item-level failures are kept on the run for manual retry and do not block the watermark; a
 * destination-level failure (unreachable, credentials rejected) fails the run and keeps it.
 */

type Trigger = (typeof exportRuns.$inferSelect)["trigger"];
type Failed = { patient_id?: string; connection_id?: string; resource_type?: string; resource_id?: string; error: string };

const BATCH = 500;

export async function handleExportJob(payload: Record<string, unknown>) {
  const destinationId = String(payload.destination_id);
  const trigger = (payload.trigger as Trigger) ?? "pull_completed";
  const [dest] = await db().select().from(exportDestinations).where(eq(exportDestinations.id, destinationId)).limit(1);
  if (!dest || !dest.enabled) return;

  const retryOf = typeof payload.retry_of_run_id === "string" ? payload.retry_of_run_id : null;
  const [{ hwm } = { hwm: 0 }] = await rawRows<{ hwm: number | null }>(
    sql`select coalesce(max(change_seq), 0) as hwm from fhir_resources where workspace_id = ${dest.workspaceId}`,
  );
  const toSeq = Number(hwm ?? 0);
  const fromSeq = trigger === "destination_added" ? 0 : dest.watermarkSeq;
  const runId = newId("exportRun");
  const startedAt = new Date();
  await db()
    .insert(exportRuns)
    .values({ id: runId, workspaceId: dest.workspaceId, destinationId, trigger, status: "running", fromSeq, toSeq, retryOfRunId: retryOf, startedAt });

  const failed: Failed[] = [];
  const patientsSeen = new Set<string>();
  let processed = 0;
  let fatal: string | null = null;
  const patientExternal = new Map<string, string>();
  const externalIdOf = async (patientId: string) => {
    let ext = patientExternal.get(patientId);
    if (!ext) {
      const [p] = await db().select({ e: patients.externalId }).from(patients).where(eq(patients.id, patientId)).limit(1);
      ext = p?.e ?? patientId;
      patientExternal.set(patientId, ext);
    }
    return ext;
  };

  try {
    const target = writerFor(dest);
    if (retryOf) {
      // Manual retry: only the failed items of the earlier run.
      const [prev] = await db().select().from(exportRuns).where(eq(exportRuns.id, retryOf)).limit(1);
      const items = (prev?.failedItems ?? []) as Failed[];
      if (target.kind === "fhir") {
        for (const item of items) {
          const [row] = await db()
            .select()
            .from(fhirResources)
            .where(and(eq(fhirResources.connectionId, item.connection_id!), eq(fhirResources.resourceType, item.resource_type!), eq(fhirResources.resourceId, item.resource_id!)))
            .limit(1);
          if (!row) continue;
          const res = await target.writer.write([
            transformForExport(row.resource, { externalPatientId: await externalIdOf(row.patientId), sourceId: row.sourceId, idStrategy: target.idStrategy }),
          ]);
          processed += res.ok;
          patientsSeen.add(row.patientId);
          for (const f of res.failed) failed.push({ ...item, error: f.error });
        }
      } else {
        for (const item of items) {
          const n = await writeObjectFile(target.writer, dest.workspaceId, item.patient_id!, item.connection_id!, externalIdOf).catch((err: Error) => {
            failed.push({ ...item, error: err.message });
            return 0;
          });
          processed += n;
          patientsSeen.add(item.patient_id!);
        }
      }
    } else if (target.kind === "fhir") {
      let after = fromSeq;
      for (;;) {
        const rows = await db()
          .select()
          .from(fhirResources)
          .innerJoin(connections, eq(connections.id, fhirResources.connectionId))
          .where(and(eq(fhirResources.workspaceId, dest.workspaceId), gt(fhirResources.changeSeq, after), lte(fhirResources.changeSeq, toSeq)))
          .orderBy(asc(fhirResources.changeSeq))
          .limit(BATCH);
        if (rows.length === 0) break;
        after = rows[rows.length - 1]!.fhir_resources.changeSeq;
        const live = rows.filter((r) => r.connections.status !== "disconnected").map((r) => r.fhir_resources);
        const transformed = [];
        for (const r of live) {
          patientsSeen.add(r.patientId);
          transformed.push({ row: r, resource: transformForExport(r.resource, { externalPatientId: await externalIdOf(r.patientId), sourceId: r.sourceId, idStrategy: target.idStrategy }) });
        }
        const res = await target.writer.write(transformed.map((t) => t.resource));
        processed += res.ok;
        for (const f of res.failed) {
          const t = transformed.find((x) => x.resource.resourceType === f.resourceType && x.resource.id === f.id);
          failed.push({ patient_id: t?.row.patientId, connection_id: t?.row.connectionId, resource_type: t?.row.resourceType, resource_id: t?.row.resourceId, error: f.error.slice(0, 300) });
        }
      }
    } else {
      const pairs = await rawRows<{ patient_id: string; connection_id: string }>(sql`
        select distinct r.patient_id, r.connection_id from fhir_resources r
        join connections c on c.id = r.connection_id
        where r.workspace_id = ${dest.workspaceId} and r.change_seq > ${fromSeq} and r.change_seq <= ${toSeq} and c.status <> 'disconnected'`);
      for (const pair of pairs) {
        try {
          processed += await writeObjectFile(target.writer, dest.workspaceId, pair.patient_id, pair.connection_id, externalIdOf);
          patientsSeen.add(pair.patient_id);
        } catch (err) {
          failed.push({ patient_id: pair.patient_id, connection_id: pair.connection_id, error: (err as Error).message.slice(0, 300) });
          if (failed.length >= 3 && processed === 0) throw err;
        }
      }
    }
  } catch (err) {
    fatal = (err as Error).message;
    log.warn("export run failed", { destination_id: destinationId, run_id: runId, ...errorFields(err) });
  }

  const finishedAt = new Date();
  const status = fatal ? "failed" : failed.length ? "partial" : "completed";
  const [run] = await db()
    .update(exportRuns)
    .set({
      status,
      patientsProcessed: patientsSeen.size,
      resourcesProcessed: processed,
      errorCount: failed.length + (fatal ? 1 : 0),
      failedItems: failed.slice(0, 1000) as Record<string, unknown>[],
      errorMessage: fatal,
      finishedAt,
    })
    .where(eq(exportRuns.id, runId))
    .returning();
  if (!fatal && !retryOf) {
    await db()
      .update(exportDestinations)
      .set({ watermarkSeq: Math.max(toSeq, dest.watermarkSeq), lastExportedAt: finishedAt, updatedAt: finishedAt })
      .where(eq(exportDestinations.id, destinationId));
  }
  if (status !== "completed") await emitEvent(dest.workspaceId, "export.run.failed", serializeRun(run!));
  else if (processed > 0) await emitEvent(dest.workspaceId, "export.run.completed", serializeRun(run!));
}

async function writeObjectFile(
  writer: import("./object-storage.js").ObjectStorageWriter,
  workspaceId: string,
  patientId: string,
  connectionId: string,
  externalIdOf: (id: string) => Promise<string>,
) {
  const rows = await db()
    .select({ resource: fhirResources.resource, sourceId: fhirResources.sourceId, type: fhirResources.resourceType })
    .from(fhirResources)
    .where(and(eq(fhirResources.patientId, patientId), eq(fhirResources.connectionId, connectionId)))
    .orderBy(asc(fhirResources.seq));
  if (rows.length === 0) return 0;
  const ext = await externalIdOf(patientId);
  const sourceId = rows[0]!.sourceId;
  // Patient first so ingestion can read the patient id before the rest of the file.
  const ordered = [...rows.filter((r) => r.type === "Patient"), ...rows.filter((r) => r.type !== "Patient")];
  const resources = ordered.map((r) => transformForExport(r.resource, { externalPatientId: ext, sourceId, idStrategy: "source" }));
  await writer.writePatientFile({ workspaceId, patientExternalId: ext, sourceId, resources });
  return resources.length;
}

export async function destinationsForWorkspace(workspaceId: string) {
  return db().select().from(exportDestinations).where(eq(exportDestinations.workspaceId, workspaceId));
}

export async function runsByIds(ids: string[]) {
  return ids.length ? db().select().from(exportRuns).where(inArray(exportRuns.id, ids)) : [];
}
