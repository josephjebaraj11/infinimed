import { and, desc, eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { exportDestinations, exportRuns, workspaces, type DestinationType } from "../db/schema.js";
import { sealJson, unsealJson } from "../lib/crypto.js";
import { ApiError } from "../lib/errors.js";
import { newId, randomToken } from "../lib/ids.js";
import { enqueue } from "../jobs/queue.js";
import { CustomFhirWriter, InternalFhirWriter, type FhirAuth, type FhirWriter } from "../exports/fhir-destination.js";
import { ObjectStorageWriter, type ObjectStorageConfig, type ObjectStorageSecrets } from "../exports/object-storage.js";
import type { IdStrategy } from "../exports/transform.js";
import { requireFeature } from "./billing.js";

/**
 * Export destinations: where records go after pulls settle. Creating one tests connectivity first,
 * then queues a full backfill; later pulls trigger delta runs from the destination's watermark.
 */

type DestinationRow = typeof exportDestinations.$inferSelect;
type WorkspaceRow = typeof workspaces.$inferSelect;

type FhirPublic = { base_url: string; auth_type: FhirAuth["type"]; token_url?: string; client_id?: string; scope?: string; id_strategy: IdStrategy };
type FhirSecret = { bearer_token?: string; client_secret?: string };
type InternalSecret = { access_token: string };

const aad = (id: string) => `destination:${id}`;
const str = (v: unknown, param: string, required = false): string | undefined => {
  if (v === undefined || v === null || v === "") {
    if (required) throw new ApiError("invalid_data", `${param} is required`, { param });
    return undefined;
  }
  if (typeof v !== "string") throw new ApiError("invalid_data", `${param} must be a string`, { param });
  return v.trim();
};

export function internalBaseUrl(destinationId: string) {
  return `${config().publicUrl}/fhir/${destinationId}`;
}

export function writerFor(dest: DestinationRow): { kind: "fhir"; writer: FhirWriter; idStrategy: IdStrategy } | { kind: "object"; writer: ObjectStorageWriter } {
  if (dest.type === "fhir_internal") return { kind: "fhir", writer: new InternalFhirWriter(dest.id), idStrategy: (dest.publicConfig.id_strategy as IdStrategy) ?? "source" };
  if (dest.type === "fhir_custom") {
    const pub = dest.publicConfig as unknown as FhirPublic;
    const sec = dest.secretConfigEnc ? unsealJson<FhirSecret>(dest.secretConfigEnc, aad(dest.id)) : {};
    return { kind: "fhir", writer: new CustomFhirWriter(pub.base_url, buildFhirAuth(pub, sec)), idStrategy: pub.id_strategy ?? "source" };
  }
  const pub = dest.publicConfig as unknown as ObjectStorageConfig;
  const sec = dest.secretConfigEnc ? unsealJson<ObjectStorageSecrets>(dest.secretConfigEnc, aad(dest.id)) : {};
  return { kind: "object", writer: new ObjectStorageWriter(pub, sec) };
}

function buildFhirAuth(pub: FhirPublic, sec: FhirSecret): FhirAuth {
  if (pub.auth_type === "bearer") return { type: "bearer", token: sec.bearer_token ?? "" };
  if (pub.auth_type === "client_credentials") {
    return { type: "client_credentials", token_url: pub.token_url!, client_id: pub.client_id!, client_secret: sec.client_secret ?? "", scope: pub.scope };
  }
  return { type: "none" };
}

function parseFhirCustom(input: Record<string, unknown>): { pub: FhirPublic; sec: FhirSecret } {
  const authType = (str(input.auth_type, "auth_type") ?? "none") as FhirAuth["type"];
  if (!["none", "bearer", "client_credentials"].includes(authType)) throw new ApiError("invalid_data", "auth_type must be none, bearer or client_credentials", { param: "auth_type" });
  const idStrategy = (str(input.id_strategy, "id_strategy") ?? "source") as IdStrategy;
  if (!["source", "namespaced"].includes(idStrategy)) throw new ApiError("invalid_data", "id_strategy must be source or namespaced", { param: "id_strategy" });
  const pub: FhirPublic = { base_url: str(input.base_url, "base_url", true)!.replace(/\/+$/, ""), auth_type: authType, id_strategy: idStrategy };
  const sec: FhirSecret = {};
  if (authType === "bearer") sec.bearer_token = str(input.bearer_token, "bearer_token", true);
  if (authType === "client_credentials") {
    pub.token_url = str(input.token_url, "token_url", true);
    pub.client_id = str(input.client_id, "client_id", true);
    pub.scope = str(input.scope, "scope");
    sec.client_secret = str(input.client_secret, "client_secret", true);
  }
  return { pub, sec };
}

function parseObjectStorage(input: Record<string, unknown>): { pub: ObjectStorageConfig; sec: ObjectStorageSecrets } {
  const vendor = (str(input.vendor, "vendor") ?? "aws") as ObjectStorageConfig["vendor"];
  if (!["aws", "s3_compatible", "azure_blob"].includes(vendor)) throw new ApiError("invalid_data", "vendor must be aws, s3_compatible or azure_blob", { param: "vendor" });
  const fileType = (str(input.file_type, "file_type") ?? "ndjson") as ObjectStorageConfig["file_type"];
  if (!["ndjson", "ndjson_zip"].includes(fileType)) throw new ApiError("invalid_data", "file_type must be ndjson or ndjson_zip", { param: "file_type" });
  return {
    pub: {
      vendor,
      bucket: str(input.bucket, "bucket", vendor !== "azure_blob"),
      region: str(input.region, "region"),
      endpoint: str(input.endpoint, "endpoint"),
      prefix: str(input.prefix, "prefix"),
      file_type: fileType,
      force_path_style: input.force_path_style === undefined ? undefined : Boolean(input.force_path_style),
    },
    sec: {
      access_key_id: str(input.access_key_id, "access_key_id"),
      secret_access_key: str(input.secret_access_key, "secret_access_key"),
      sas_url: str(input.sas_url, "sas_url"),
    },
  };
}

export async function createDestination(ws: WorkspaceRow, input: Record<string, unknown>) {
  requireFeature(ws, "exports");
  const type = str(input.type, "type", true) as DestinationType;
  const name = str(input.name, "name", true)!.slice(0, 120);
  const id = newId("destination");
  let publicConfig: Record<string, unknown>;
  let secret: unknown;

  if (type === "fhir_internal") {
    const idStrategy = (str(input.id_strategy, "id_strategy") ?? "source") as IdStrategy;
    publicConfig = { base_url: internalBaseUrl(id), id_strategy: idStrategy };
    secret = { access_token: `imfhir_${randomToken(32)}` } satisfies InternalSecret;
  } else if (type === "fhir_custom") {
    const { pub, sec } = parseFhirCustom(input);
    await new CustomFhirWriter(pub.base_url, buildFhirAuth(pub, sec)).testConnection();
    publicConfig = pub as unknown as Record<string, unknown>;
    secret = sec;
  } else if (type === "object_storage") {
    const { pub, sec } = parseObjectStorage(input);
    await new ObjectStorageWriter(pub, sec).testConnection();
    publicConfig = pub as unknown as Record<string, unknown>;
    secret = sec;
  } else {
    throw new ApiError("invalid_data", "type must be fhir_internal, fhir_custom or object_storage", { param: "type" });
  }

  const [row] = await db()
    .insert(exportDestinations)
    .values({ id, workspaceId: ws.id, name, type, publicConfig, secretConfigEnc: sealJson(secret, aad(id)) })
    .returning();
  await enqueue("export.run", { destination_id: id, trigger: "destination_added" }, { dedupeKey: `export:${id}` });
  return row!;
}

export async function getDestination(workspaceId: string, id: string) {
  const [row] = await db()
    .select()
    .from(exportDestinations)
    .where(and(eq(exportDestinations.id, id), eq(exportDestinations.workspaceId, workspaceId)))
    .limit(1);
  if (!row) throw new ApiError("resource_not_found", "Export destination not found", { param: "id" });
  return row;
}

export function internalCredentials(dest: DestinationRow) {
  if (dest.type !== "fhir_internal" || !dest.secretConfigEnc) return null;
  const sec = unsealJson<InternalSecret>(dest.secretConfigEnc, aad(dest.id));
  return { base_url: internalBaseUrl(dest.id), bearer_token: sec.access_token };
}

export function serializeDestination(d: DestinationRow) {
  return {
    id: d.id,
    object: "export_destination" as const,
    name: d.name,
    type: d.type,
    config: d.publicConfig,
    enabled: d.enabled,
    watermark: d.watermarkSeq,
    last_exported_at: d.lastExportedAt?.toISOString() ?? null,
    created_at: d.createdAt.toISOString(),
    updated_at: d.updatedAt.toISOString(),
  };
}

export function serializeRun(r: typeof exportRuns.$inferSelect) {
  return {
    id: r.id,
    object: "export_run" as const,
    destination_id: r.destinationId,
    trigger: r.trigger,
    status: r.status,
    patients_processed: r.patientsProcessed,
    resources_processed: r.resourcesProcessed,
    error_count: r.errorCount,
    error_message: r.errorMessage,
    failed_items: r.failedItems.slice(0, 50),
    retry_of_run_id: r.retryOfRunId,
    started_at: r.startedAt?.toISOString() ?? null,
    finished_at: r.finishedAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
  };
}

export async function listRuns(destinationId: string, limit = 20) {
  return db().select().from(exportRuns).where(eq(exportRuns.destinationId, destinationId)).orderBy(desc(exportRuns.createdAt)).limit(limit);
}

export async function updateDestination(ws: WorkspaceRow, id: string, input: Record<string, unknown>) {
  const dest = await getDestination(ws.id, id);
  const patch: Partial<DestinationRow> = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = str(input.name, "name", true)!.slice(0, 120);
  let reactivated = false;
  if (input.enabled !== undefined) {
    patch.enabled = Boolean(input.enabled);
    reactivated = !dest.enabled && patch.enabled;
  }
  if (input.credentials !== undefined && dest.type !== "fhir_internal") {
    const merged = { ...dest.publicConfig, ...(input.credentials as Record<string, unknown>) };
    if (dest.type === "fhir_custom") {
      const { pub, sec } = parseFhirCustom(merged);
      await new CustomFhirWriter(pub.base_url, buildFhirAuth(pub, sec)).testConnection();
      patch.publicConfig = pub as unknown as Record<string, unknown>;
      patch.secretConfigEnc = sealJson(sec, aad(dest.id));
    } else {
      const { pub, sec } = parseObjectStorage(merged);
      await new ObjectStorageWriter(pub, sec).testConnection();
      patch.publicConfig = pub as unknown as Record<string, unknown>;
      patch.secretConfigEnc = sealJson(sec, aad(dest.id));
    }
  }
  if (input.rotate_internal_token === true && dest.type === "fhir_internal") {
    patch.secretConfigEnc = sealJson({ access_token: `imfhir_${randomToken(32)}` } satisfies InternalSecret, aad(dest.id));
  }
  const [row] = await db().update(exportDestinations).set(patch).where(eq(exportDestinations.id, dest.id)).returning();
  if (reactivated) await enqueue("export.run", { destination_id: dest.id, trigger: "reactivated" }, { dedupeKey: `export:${dest.id}` });
  return row!;
}

export async function deleteDestination(ws: WorkspaceRow, id: string) {
  const dest = await getDestination(ws.id, id);
  await db().delete(exportDestinations).where(eq(exportDestinations.id, dest.id));
  return { id: dest.id, resource_type: "export_destination", deleted: true };
}

export async function retryRun(ws: WorkspaceRow, destinationId: string, runId: string) {
  const dest = await getDestination(ws.id, destinationId);
  const [run] = await db()
    .select()
    .from(exportRuns)
    .where(and(eq(exportRuns.id, runId), eq(exportRuns.destinationId, dest.id)))
    .limit(1);
  if (!run) throw new ApiError("resource_not_found", "Export run not found", { param: "run_id" });
  if (run.status !== "failed" && run.status !== "partial") throw new ApiError("bad_request", "Only failed or partial runs can be retried");
  await enqueue("export.run", { destination_id: dest.id, trigger: "manual_retry", retry_of_run_id: run.id }, { dedupeKey: `export:${dest.id}` });
  return { queued: true };
}
