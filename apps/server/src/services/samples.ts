import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { connections, patients, pulls, workspaces } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { syntheticSourceId } from "../catalog/seed.js";
import { generateSyntheticPatient, SYNTHETIC_PEOPLE } from "../synthetic/generator.js";
import type { FhirResource } from "../fhir/client.js";
import { findPatient } from "./patients.js";
import { registerIdentity } from "./mpi.js";
import { storeResources } from "./records.js";

/**
 * "Load sample patients" for sandbox workspaces: creates patients whose Synthetic Hospital records
 * are imported directly (no portal sign-in), so dashboards, models, exports and webhooks can be
 * explored immediately. These connections carry no tokens and are not re-pulled.
 */
export async function loadSamplePatients(ws: typeof workspaces.$inferSelect, count = SYNTHETIC_PEOPLE.length) {
  if (ws.environment !== "sandbox") throw new ApiError("forbidden", "Sample patients can only be loaded into sandbox workspaces");
  const sourceId = await syntheticSourceId();
  const created: string[] = [];
  for (let i = 0; i < Math.min(count, SYNTHETIC_PEOPLE.length); i++) {
    const gen = generateSyntheticPatient(i);
    const externalId = `sample-${i + 1}`;
    let patient: typeof patients.$inferSelect | null | undefined = await findPatient(ws.id, externalId);
    if (!patient) {
      [patient] = await db()
        .insert(patients)
        .values({ id: newId("patient"), workspaceId: ws.id, externalId, name: gen.displayName, email: gen.username, origin: "sample" })
        .returning();
    }
    let [conn] = await db()
      .select()
      .from(connections)
      .where(and(eq(connections.patientId, patient!.id), eq(connections.sourceId, sourceId)))
      .limit(1);
    if (!conn) {
      [conn] = await db()
        .insert(connections)
        .values({ id: newId("connection"), workspaceId: ws.id, patientId: patient!.id, sourceId, status: "active", fhirPatientId: gen.patientId })
        .returning();
    }
    const resources = ((gen.bundle.entry as { resource: FhirResource }[]) ?? []).map((e) => e.resource);
    const started = new Date();
    const r = await storeResources({ workspaceId: ws.id, patientId: patient!.id, connectionId: conn!.id, sourceId }, resources);
    const fhirPatient = resources.find((x) => x.resourceType === "Patient");
    if (fhirPatient) await registerIdentity({ workspaceId: ws.id, patientId: patient!.id, connectionId: conn!.id, sourceId, fhirPatient });
    await db()
      .insert(pulls)
      .values({ id: newId("pull"), workspaceId: ws.id, patientId: patient!.id, connectionId: conn!.id, trigger: "ingest", status: "completed", total: resources.length, created: r.created, updated: r.updated, startedAt: started, finishedAt: new Date(), durationMs: Date.now() - started.getTime() });
    await db().update(connections).set({ lastPullAt: new Date() }).where(eq(connections.id, conn!.id));
    await db().update(patients).set({ activatedAt: patient!.activatedAt ?? new Date() }).where(eq(patients.id, patient!.id));
    created.push(externalId);
  }
  return created;
}
