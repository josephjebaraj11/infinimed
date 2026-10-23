import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { connections, patients, sources, workspaces } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { decodeCursor, encodeCursor, page } from "../lib/cursor.js";
import { serializePatient } from "./serializers.js";
import { disconnectConnection } from "./connections.js";

/**
 * Patients are addressed by the customer's own stable id (`patient_id`). The id is unique per
 * workspace, at most 200 characters, and may not use the reserved `im_` prefix, which InfiniMed uses
 * for patients it creates itself (backend cohorts, HL7v2 feeds).
 */

type PatientRow = typeof patients.$inferSelect;
type WorkspaceRow = typeof workspaces.$inferSelect;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateExternalId(id: unknown, { allowReserved = false } = {}): string {
  if (typeof id !== "string" || id.length === 0) throw new ApiError("bad_request", "patient_id is required", { param: "patient_id" });
  if (id.length > 200) throw new ApiError("invalid_data", "patient_id must be at most 200 characters", { param: "patient_id" });
  if (!allowReserved && id.startsWith("im_")) throw new ApiError("invalid_data", "patient_id may not start with the reserved prefix im_", { param: "patient_id" });
  if (/[\u0000-\u001f]/.test(id)) throw new ApiError("invalid_data", "patient_id contains control characters", { param: "patient_id" });
  return id;
}

export function validateEmail(email: unknown, param = "email"): string | null {
  if (email === undefined || email === null || email === "") return null;
  if (typeof email !== "string" || !EMAIL.test(email) || email.length > 320) throw new ApiError("invalid_data", "email is malformed", { param });
  return email.toLowerCase();
}

export async function findPatient(workspaceId: string, externalId: string): Promise<PatientRow | null> {
  const [row] = await db()
    .select()
    .from(patients)
    .where(and(eq(patients.workspaceId, workspaceId), eq(patients.externalId, externalId)))
    .limit(1);
  return row ?? null;
}

export async function requirePatient(workspaceId: string, externalId: string): Promise<PatientRow> {
  const p = await findPatient(workspaceId, externalId);
  if (!p) throw new ApiError("resource_not_found", "Patient not found", { param: "id" });
  return p;
}

async function assertPersonalWorkspaceAllows(ws: WorkspaceRow) {
  if (!ws.personal) return;
  const [existing] = await db().select({ id: patients.id }).from(patients).where(eq(patients.workspaceId, ws.id)).limit(2);
  if (existing) throw new ApiError("forbidden", "This workspace holds its owner's own records only, so it cannot take another patient.");
}

export async function createPatient(
  ws: WorkspaceRow,
  input: { patient_id?: unknown; email?: unknown; name?: unknown; metadata?: unknown },
  origin: PatientRow["origin"] = "api",
  { allowReserved = false } = {},
): Promise<PatientRow> {
  const externalId = validateExternalId(input.patient_id, { allowReserved });
  const email = validateEmail(input.email);
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 300) : null;
  const metadata = validateMetadata(input.metadata);
  if (await findPatient(ws.id, externalId)) {
    throw new ApiError("external_id_already_exists", "A patient with this patient_id already exists", { param: "patient_id" });
  }
  await assertPersonalWorkspaceAllows(ws);
  const [row] = await db()
    .insert(patients)
    .values({ id: newId("patient"), workspaceId: ws.id, externalId, email, name, metadata, origin })
    .returning();
  return row!;
}

/** Create-or-reuse used by patient sessions: updates email/name when they differ. */
export async function upsertPatient(
  ws: WorkspaceRow,
  input: { patient_id?: unknown; email?: unknown; name?: unknown; metadata?: unknown },
  origin: PatientRow["origin"],
): Promise<PatientRow> {
  const externalId = validateExternalId(input.patient_id);
  const existing = await findPatient(ws.id, externalId);
  if (!existing) return createPatient(ws, input, origin);
  const email = validateEmail(input.email, "patient_email");
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 300) : null;
  const patch: Partial<PatientRow> = {};
  if (email && email !== existing.email) patch.email = email;
  if (name && name !== existing.name) patch.name = name;
  if (Object.keys(patch).length === 0) return existing;
  const [row] = await db()
    .update(patients)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(patients.id, existing.id))
    .returning();
  return row!;
}

export function validateMetadata(metadata: unknown): Record<string, unknown> {
  if (metadata === undefined || metadata === null) return {};
  if (typeof metadata !== "object" || Array.isArray(metadata)) throw new ApiError("invalid_data", "metadata must be an object", { param: "metadata" });
  if (JSON.stringify(metadata).length > 16_384) throw new ApiError("invalid_data", "metadata must be at most 16 KB", { param: "metadata" });
  return metadata as Record<string, unknown>;
}

export async function updatePatient(ws: WorkspaceRow, externalId: string, input: { email?: unknown; name?: unknown; metadata?: unknown }) {
  const p = await requirePatient(ws.id, externalId);
  const patch: Partial<PatientRow> = { updatedAt: new Date() };
  if ("email" in input) patch.email = validateEmail(input.email);
  if ("name" in input) patch.name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 300) : null;
  if ("metadata" in input) patch.metadata = validateMetadata(input.metadata);
  const [row] = await db().update(patients).set(patch).where(eq(patients.id, p.id)).returning();
  return row!;
}

export async function patientConnections(patientId: string) {
  const rows = await db()
    .select({ connection: connections, source: sources })
    .from(connections)
    .leftJoin(sources, eq(sources.id, connections.sourceId))
    .where(eq(connections.patientId, patientId))
    .orderBy(desc(connections.createdAt));
  return rows.map((r) => ({ connection: r.connection, source: r.source ?? undefined }));
}

export async function serializePatientWithConnections(p: PatientRow) {
  return serializePatient(p, await patientConnections(p.id));
}

export async function listPatients(workspaceId: string, opts: { limit: number; startingAfter?: string; email?: string }) {
  const filter = opts.email ? `email:${opts.email}` : undefined;
  const conditions = [eq(patients.workspaceId, workspaceId)];
  if (opts.email) conditions.push(eq(patients.email, opts.email.toLowerCase()));
  if (opts.startingAfter) {
    const cursor = decodeCursor(opts.startingAfter, "patients", filter);
    conditions.push(lt(patients.id, String(cursor.p)));
  }
  const rows = await db()
    .select()
    .from(patients)
    .where(and(...conditions))
    .orderBy(desc(patients.id))
    .limit(opts.limit + 1);
  const hasMore = rows.length > opts.limit;
  const items = rows.slice(0, opts.limit);
  const ids = items.map((p) => p.id);
  const conns = ids.length
    ? await db()
        .select({ connection: connections, source: sources })
        .from(connections)
        .leftJoin(sources, eq(sources.id, connections.sourceId))
        .where(inArray(connections.patientId, ids))
    : [];
  const data = items.map((p) =>
    serializePatient(
      p,
      conns.filter((c) => c.connection.patientId === p.id).map((c) => ({ connection: c.connection, source: c.source ?? undefined })),
    ),
  );
  const last = items[items.length - 1];
  return page(data, hasMore, last ? encodeCursor({ k: "patients", p: last.id, f: filter }) : null);
}

/** Permanently removes a patient, revoking upstream access first and cascading all stored records. */
export async function deletePatient(ws: WorkspaceRow, externalId: string) {
  const p = await requirePatient(ws.id, externalId);
  const conns = await db().select().from(connections).where(eq(connections.patientId, p.id));
  for (const c of conns) {
    if (c.status === "active" || c.status === "refresh_failed") {
      await disconnectConnection(ws, p, c.id, { emit: false }).catch(() => undefined);
    }
  }
  await db().delete(patients).where(eq(patients.id, p.id));
  return { id: externalId, resource_type: "patient", deleted: true };
}
