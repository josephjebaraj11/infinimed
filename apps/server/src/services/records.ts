import { and, asc, eq, gt, inArray, lte, ne, sql } from "drizzle-orm";
import { db, rawRows } from "../db/client.js";
import { connections, fhirResources } from "../db/schema.js";
import { sha256Hex } from "../lib/crypto.js";
import { decodeCursor, encodeCursor } from "../lib/cursor.js";
import { ApiError } from "../lib/errors.js";
import type { FhirResource } from "../fhir/client.js";

/**
 * The record store keeps the latest version of every resource per connection, exactly as the source
 * returned it. Writes are content-addressed: an unchanged resource is not rewritten and keeps its
 * change sequence, so exports and `since` reads only see real changes.
 */

export const PATIENT_ID_SYSTEM = "urn:infinimed:patient-id";

/** Deterministic JSON (sorted keys) so equivalent resources hash identically. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentHash(resource: FhirResource) {
  // meta.lastUpdated/versionId churn on some servers without a clinical change; ignore them.
  const { meta, ...rest } = resource as FhirResource & { meta?: Record<string, unknown> };
  const metaRest = meta ? Object.fromEntries(Object.entries(meta).filter(([k]) => k !== "lastUpdated" && k !== "versionId")) : undefined;
  return sha256Hex(stableStringify(metaRest && Object.keys(metaRest).length ? { ...rest, meta: metaRest } : rest));
}

export type StoreContext = { workspaceId: string; patientId: string; connectionId: string; sourceId: string };

export async function storeResources(ctx: StoreContext, resources: FhirResource[]): Promise<{ created: number; updated: number; unchanged: number }> {
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  const valid = resources.filter((r) => typeof r.resourceType === "string" && typeof r.id === "string" && r.id.length > 0);
  // Deduplicate within the batch (servers sometimes repeat an included resource).
  const unique = new Map<string, FhirResource>();
  for (const r of valid) unique.set(`${r.resourceType}/${r.id}`, r);
  const list = [...unique.values()];
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const values = chunk.map((r) => ({
      workspaceId: ctx.workspaceId,
      patientId: ctx.patientId,
      connectionId: ctx.connectionId,
      sourceId: ctx.sourceId,
      resourceType: r.resourceType,
      resourceId: String(r.id),
      contentHash: contentHash(r),
      resource: r as Record<string, unknown>,
    }));
    const rows = await db()
      .insert(fhirResources)
      .values(values)
      .onConflictDoUpdate({
        target: [fhirResources.connectionId, fhirResources.resourceType, fhirResources.resourceId],
        set: {
          resource: sql`excluded.resource`,
          contentHash: sql`excluded.content_hash`,
          changeSeq: sql`nextval('fhir_change_seq')`,
          changedAt: sql`now()`,
        },
        setWhere: sql`${fhirResources.contentHash} <> excluded.content_hash`,
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    for (const r of rows) {
      if (r.inserted) created++;
      else updated++;
    }
    unchanged += chunk.length - rows.length;
  }
  return { created, updated, unchanged };
}

export async function storedReferenceKeys(connectionId: string, types: string[]): Promise<Set<string>> {
  if (types.length === 0) return new Set();
  const rows = await db()
    .select({ t: fhirResources.resourceType, id: fhirResources.resourceId })
    .from(fhirResources)
    .where(and(eq(fhirResources.connectionId, connectionId), inArray(fhirResources.resourceType, types)));
  return new Set(rows.map((r) => `${r.t}/${r.id}`));
}

/** Adds the customer's patient id to Patient resources on the way out (reads and exports). */
export function withPatientIdentifier(resource: Record<string, unknown>, externalPatientId: string): Record<string, unknown> {
  if (resource.resourceType !== "Patient") return resource;
  const identifiers = Array.isArray(resource.identifier) ? (resource.identifier as { system?: string; value?: string }[]) : [];
  if (identifiers.some((i) => i.system === PATIENT_ID_SYSTEM)) return resource;
  return { ...resource, identifier: [...identifiers, { system: PATIENT_ID_SYSTEM, value: externalPatientId }] };
}

const FHIR_TYPE = /^[A-Z][A-Za-z]{1,63}$/;

/**
 * Snapshot-consistent record pages. The first page fixes a high-water mark (`seq`); later pages only
 * return rows that existed then, ordered by insertion, so a reader never sees a resource twice or
 * in shifting order. Rows of connections revoked mid-read disappear from the following pages.
 */
export async function listRecords(args: {
  patient: { id: string; externalId: string };
  count: number;
  startingAfter?: string;
  types?: string;
  since?: string;
}) {
  const types = args.types
    ? args.types
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  for (const t of types) if (!FHIR_TYPE.test(t)) throw new ApiError("bad_request", `Invalid resource type: ${t}`, { param: "type" });
  let sinceDate: Date | null = null;
  if (args.since) {
    if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(args.since) || Number.isNaN(Date.parse(args.since))) {
      throw new ApiError("bad_request", "since must be an ISO 8601 timestamp", { param: "since" });
    }
    sinceDate = new Date(args.since);
  }
  const filterHash = sha256Hex(JSON.stringify({ types: [...types].sort(), since: sinceDate?.toISOString() ?? null })).slice(0, 16);

  let snapshot: number;
  let after = 0;
  if (args.startingAfter) {
    const c = decodeCursor(args.startingAfter, `records:${args.patient.id}`, filterHash);
    snapshot = Number(c.s);
    after = Number(c.p);
  } else {
    const [row] = await rawRows<{ s: number | null }>(sql`select max(seq) as s from fhir_resources where patient_id = ${args.patient.id}`);
    snapshot = Number(row?.s ?? 0);
  }

  const conds = [
    eq(fhirResources.patientId, args.patient.id),
    gt(fhirResources.seq, after),
    lte(fhirResources.seq, snapshot),
    ne(connections.status, "disconnected"),
  ];
  if (types.length) conds.push(inArray(fhirResources.resourceType, types));
  if (sinceDate) conds.push(gt(fhirResources.changedAt, sinceDate));

  const rows = await db()
    .select({ seq: fhirResources.seq, sourceId: fhirResources.sourceId, connectionId: fhirResources.connectionId, resource: fhirResources.resource, changedAt: fhirResources.changedAt })
    .from(fhirResources)
    .innerJoin(connections, eq(connections.id, fhirResources.connectionId))
    .where(and(...conds))
    .orderBy(asc(fhirResources.seq))
    .limit(args.count + 1);
  const hasMore = rows.length > args.count;
  const items = rows.slice(0, args.count);
  const last = items[items.length - 1];
  return {
    object: "list" as const,
    resource_type: "records",
    patient_id: args.patient.externalId,
    data: items.map((r) => ({
      source: r.sourceId,
      connection_id: r.connectionId,
      changed_at: r.changedAt.toISOString(),
      resource: withPatientIdentifier(r.resource, args.patient.externalId),
    })),
    has_more: hasMore,
    next_cursor: hasMore && last ? encodeCursor({ k: `records:${args.patient.id}`, p: last.seq, s: snapshot, f: filterHash }) : null,
  };
}

export async function recordStats(patientId: string) {
  return rawRows<{ resource_type: string; n: number; source_id: string }>(sql`
    select resource_type, source_id, count(*)::int as n from fhir_resources
    where patient_id = ${patientId} group by resource_type, source_id order by resource_type`);
}

/** All current resources of a patient (active connections), optionally filtered by type. */
export async function patientResources(patientId: string, types?: string[]) {
  const conds = [eq(fhirResources.patientId, patientId), ne(connections.status, "disconnected")];
  if (types?.length) conds.push(inArray(fhirResources.resourceType, types));
  return db()
    .select({ sourceId: fhirResources.sourceId, connectionId: fhirResources.connectionId, resource: fhirResources.resource })
    .from(fhirResources)
    .innerJoin(connections, eq(connections.id, fhirResources.connectionId))
    .where(and(...conds));
}
