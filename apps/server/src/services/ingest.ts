import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { connections, hl7Messages, mpiIdentities, patients, pulls, sources, workspaces } from "../db/schema.js";
import { seal } from "../lib/crypto.js";
import { ApiError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { buildAck } from "../hl7v2/ack.js";
import { Hl7ParseError, parseMessage, type Message } from "../hl7v2/parser.js";
import { mapMessage, SUPPORTED_EVENTS } from "../hl7v2/to-fhir.js";
import { triggerExports } from "../jobs/pull.js";
import type { FhirResource } from "../fhir/client.js";
import { requireFeature } from "./billing.js";
import { emitEvent } from "./events.js";
import { findMatchingPatient, registerIdentity } from "./mpi.js";
import { createPatient } from "./patients.js";
import { storeResources } from "./records.js";

/**
 * Data that arrives rather than being pulled: HL7v2 messages from an interface engine (or Epic's
 * HL7v2-over-HTTP), and FHIR bundles another vendor already retrieved. Each feed is a
 * workspace-private source; its records join the same patient record, MPI and exports as pulled data.
 */

type WorkspaceRow = typeof workspaces.$inferSelect;
type PatientRow = typeof patients.$inferSelect;

export async function feedSource(ws: WorkspaceRow, kind: "hl7v2" | "external", label: string) {
  const key = `urn:infinimed:feed:${ws.id}:${kind}:${label}`;
  const [existing] = await db()
    .select()
    .from(sources)
    .where(and(eq(sources.workspaceId, ws.id), eq(sources.fhirBaseUrl, key)))
    .limit(1);
  if (existing) return existing;
  const [row] = await db()
    .insert(sources)
    .values({
      id: newId("source"),
      workspaceId: ws.id,
      name: kind === "hl7v2" ? `HL7v2 feed: ${label}` : `External: ${label}`,
      vendor: kind,
      category: "feed",
      environment: ws.environment,
      fhirBaseUrl: key,
      surfaces: [],
      details: { label },
      searchText: `${kind} ${label}`.toLowerCase(),
    })
    .returning();
  return row!;
}

async function feedConnection(ws: WorkspaceRow, patient: PatientRow, sourceId: string) {
  const [existing] = await db()
    .select()
    .from(connections)
    .where(and(eq(connections.patientId, patient.id), eq(connections.sourceId, sourceId)))
    .limit(1);
  if (existing) {
    if (existing.status !== "active") {
      await db().update(connections).set({ status: "active", disconnectedAt: null, updatedAt: new Date() }).where(eq(connections.id, existing.id));
    }
    return existing.id;
  }
  const id = newId("connection");
  await db().insert(connections).values({ id, workspaceId: ws.id, patientId: patient.id, sourceId, surface: "feed", status: "active" });
  return id;
}

async function settleIngest(ws: WorkspaceRow, patient: PatientRow, connectionId: string, sourceId: string, resources: FhirResource[]) {
  const started = Date.now();
  const r = await storeResources({ workspaceId: ws.id, patientId: patient.id, connectionId, sourceId }, resources);
  const pullId = newId("pull");
  const total = r.created + r.updated + r.unchanged;
  await db()
    .insert(pulls)
    .values({
      id: pullId,
      workspaceId: ws.id,
      patientId: patient.id,
      connectionId,
      trigger: "ingest",
      status: "completed",
      total,
      created: r.created,
      updated: r.updated,
      startedAt: new Date(started),
      finishedAt: new Date(),
      durationMs: Date.now() - started,
    });
  await db().update(connections).set({ lastPullAt: new Date(), updatedAt: new Date() }).where(eq(connections.id, connectionId));
  if (!patient.activatedAt) await db().update(patients).set({ activatedAt: new Date() }).where(eq(patients.id, patient.id));
  await emitEvent(ws.id, "records.sync.completed", {
    resource_type: "records_sync",
    pull_id: pullId,
    patient_id: patient.externalId,
    source_id: sourceId,
    connection_id: connectionId,
    total,
    created: r.created,
    updated: r.updated,
    errors: 0,
    duration_ms: Date.now() - started,
  });
  if (r.created + r.updated > 0) await triggerExports(ws.id, "pull_completed");
  return { ...r, pull_id: pullId };
}

async function patientByIdentifiers(workspaceId: string, ids: { system: string; value: string }[]) {
  for (const id of ids) {
    const [hit] = await db()
      .select({ patientId: mpiIdentities.patientId })
      .from(mpiIdentities)
      .where(and(eq(mpiIdentities.workspaceId, workspaceId), sql`${mpiIdentities.demographics}->'identifiers' @> ${JSON.stringify([id])}::jsonb`))
      .limit(1);
    if (hit) return hit.patientId;
  }
  return null;
}

export async function ingestHl7(ws: WorkspaceRow, raw: string, opts: { feed: string; createPatients: boolean }) {
  requireFeature(ws, "hl7v2_ingest");
  const source = await feedSource(ws, "hl7v2", opts.feed);
  let msg: Message | null = null;
  const record = async (status: "accepted" | "error" | "rejected", ackCode: "AA" | "AE" | "AR", extra: { controlId?: string; messageType?: string; patientId?: string; resourcesCreated?: number; error?: string }) => {
    await db()
      .insert(hl7Messages)
      .values({
        id: newId("hl7Message"),
        workspaceId: ws.id,
        sourceId: source.id,
        controlId: extra.controlId ?? null,
        messageType: extra.messageType ?? null,
        patientId: extra.patientId ?? null,
        rawEnc: seal(raw, `hl7:${ws.id}`),
        status,
        ackCode,
        resourcesCreated: extra.resourcesCreated ?? 0,
        error: extra.error ?? null,
      });
  };
  try {
    msg = parseMessage(raw);
  } catch (err) {
    await record("rejected", "AR", { error: (err as Error).message });
    return { ack: buildAck(null, "AR", (err as Error).message), status: 400, accepted: false };
  }
  let mapped;
  try {
    mapped = mapMessage(msg, source.id);
  } catch (err) {
    await record("rejected", "AR", { error: (err as Error).message });
    return { ack: buildAck(msg, "AR", (err as Error).message), status: 400, accepted: false };
  }
  const typeKey = `${mapped.messageType}^${mapped.event}`;
  if (!SUPPORTED_EVENTS.has(typeKey)) {
    await record("rejected", "AR", { controlId: mapped.controlId, messageType: typeKey, error: "unsupported message type" });
    return { ack: buildAck(msg, "AR", `Unsupported message type ${typeKey}`), status: 422, accepted: false };
  }

  let patientRowId = await patientByIdentifiers(ws.id, mapped.patientIdentifiers);
  if (!patientRowId) patientRowId = (await findMatchingPatient(ws.id, mapped.patient))?.patientId ?? null;
  let patient: PatientRow | undefined;
  if (patientRowId) {
    [patient] = await db().select().from(patients).where(eq(patients.id, patientRowId)).limit(1);
  } else if (opts.createPatients) {
    const key = mapped.patientIdentifiers[0] ? `${mapped.patientIdentifiers[0].system}|${mapped.patientIdentifiers[0].value}` : mapped.patient.id;
    const externalId = `im_hl7_${createHash("sha256").update(`${source.id}|${key}`).digest("hex").slice(0, 24)}`;
    const name = (mapped.patient.name as { family?: string; given?: string[] }[] | undefined)?.[0];
    patient = await createPatient(ws, { patient_id: externalId, name: name ? [name.given?.join(" "), name.family].filter(Boolean).join(" ") : undefined }, "hl7v2", { allowReserved: true });
  }
  if (!patient) {
    await record("error", "AE", { controlId: mapped.controlId, messageType: typeKey, error: "no matching patient" });
    return { ack: buildAck(msg, "AE", "No matching patient; enable create_patients or connect the patient first"), status: 422, accepted: false };
  }

  const connectionId = await feedConnection(ws, patient, source.id);
  await registerIdentity({ workspaceId: ws.id, patientId: patient.id, connectionId, sourceId: source.id, fhirPatient: mapped.patient });
  const result = await settleIngest(ws, patient, connectionId, source.id, [mapped.patient as FhirResource, ...(mapped.resources as FhirResource[])]);
  await record("accepted", "AA", { controlId: mapped.controlId, messageType: typeKey, patientId: patient.id, resourcesCreated: result.created });
  return { ack: buildAck(msg, "AA"), status: 200, accepted: true, patient_id: patient.externalId, ...result };
}

/** Accepts a FHIR Bundle (or array) of resources another system already retrieved for this patient. */
export async function ingestFhir(ws: WorkspaceRow, patient: PatientRow, body: unknown, label: string) {
  const resources: FhirResource[] = Array.isArray(body)
    ? (body as FhirResource[])
    : (body as { resourceType?: string; entry?: { resource?: FhirResource }[] })?.resourceType === "Bundle"
      ? ((body as { entry?: { resource?: FhirResource }[] }).entry ?? []).map((e) => e.resource!).filter(Boolean)
      : [];
  if (resources.length === 0) throw new ApiError("bad_request", "Body must be a FHIR Bundle or an array of resources", { param: "body" });
  if (resources.length > 5000) throw new ApiError("payload_too_large", "At most 5000 resources per request");
  for (const r of resources) {
    if (typeof r.resourceType !== "string" || !/^[A-Z][A-Za-z]+$/.test(r.resourceType)) throw new ApiError("invalid_data", "Every entry needs a valid resourceType");
    if (typeof r.id !== "string" || !r.id) throw new ApiError("invalid_data", `${r.resourceType} entry is missing an id`);
  }
  if (!/^[A-Za-z0-9 _.-]{1,60}$/.test(label)) throw new ApiError("invalid_data", "source_label must be 1-60 letters, digits, spaces, dots, dashes or underscores", { param: "source_label" });
  const source = await feedSource(ws, "external", label);
  const connectionId = await feedConnection(ws, patient, source.id);
  const fhirPatient = resources.find((r) => r.resourceType === "Patient");
  if (fhirPatient) await registerIdentity({ workspaceId: ws.id, patientId: patient.id, connectionId, sourceId: source.id, fhirPatient });
  const result = await settleIngest(ws, patient, connectionId, source.id, resources);
  return { object: "ingest_result", source_id: source.id, connection_id: connectionId, ...result };
}
