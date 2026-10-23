import { createHash } from "node:crypto";
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../db/client.js";
import { backendSyncs, connections, patients, providerConfigs, sources, workspaces } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { fetchWithTimeout, parseRetryAfter, readTextSafe } from "../lib/http.js";
import { newId } from "../lib/ids.js";
import { errorFields, log } from "../lib/logger.js";
import { resolveEndpoints } from "../smart/discovery.js";
import { profileFor } from "../smart/profiles.js";
import { clientCredentialsGrant } from "../smart/token-client.js";
import { requireFeature } from "../services/billing.js";
import { resolveCredentials } from "../services/credentials.js";
import { emitEvent } from "../services/events.js";
import { findMatchingPatient, registerIdentity } from "../services/mpi.js";
import { createPatient } from "../services/patients.js";
import { storeResources } from "../services/records.js";
import { collectReferences, type FhirResource } from "../fhir/client.js";
import { enqueue, RetryLater } from "./queue.js";
import { triggerExports } from "./pull.js";

/**
 * Backend (population) sync with SMART Backend Services and FHIR Bulk Data.
 *   kickoff  : client_credentials token (private_key_jwt), GET Group/{id}/$export (Prefer: respond-async)
 *   poll     : GET the Content-Location until 200, honouring Retry-After / X-Progress
 *   download : stream each NDJSON output, match every Patient through the MPI (existing patient or a
 *              new `im_bk_*` patient), and store resources on a per-patient backend connection
 * The manifest's transactionTime becomes `_since` for the next incremental export.
 */

type SyncRow = typeof backendSyncs.$inferSelect;
type WorkspaceRow = typeof workspaces.$inferSelect;
type SourceRow = typeof sources.$inferSelect;

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function backendToken(ws: WorkspaceRow, source: SourceRow): Promise<string> {
  const key = `${ws.id}|${source.id}`;
  const hit = tokenCache.get(key);
  if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token;
  const creds = await resolveCredentials(ws.id, source.vendor, "backend", source.environment);
  const endpoints = await resolveEndpoints(source);
  const token = await clientCredentialsGrant({ tokenUrl: endpoints.tokenUrl, scope: creds.scopes.join(" "), credentials: creds });
  tokenCache.set(key, { token: token.access_token, expiresAt: Date.now() + (token.expires_in ?? 300) * 1000 });
  return token.access_token;
}

async function loadSync(id: string) {
  const [row] = await db()
    .select({ sync: backendSyncs, ws: workspaces, source: sources })
    .from(backendSyncs)
    .innerJoin(workspaces, eq(workspaces.id, backendSyncs.workspaceId))
    .innerJoin(sources, eq(sources.id, backendSyncs.sourceId))
    .where(eq(backendSyncs.id, id))
    .limit(1);
  return row ?? null;
}

async function failSync(sync: SyncRow, message: string) {
  await db().update(backendSyncs).set({ status: "failed", errorMessage: message.slice(0, 1000), finishedAt: new Date() }).where(eq(backendSyncs.id, sync.id));
  log.warn("backend sync failed", { sync_id: sync.id, error: message.slice(0, 200) });
}

export async function startBackendSync(ws: WorkspaceRow, input: { source_id: string; group_id: string; full?: boolean }) {
  requireFeature(ws, "backend");
  const [source] = await db().select().from(sources).where(eq(sources.id, input.source_id)).limit(1);
  if (!source || (source.workspaceId && source.workspaceId !== ws.id) || source.environment !== ws.environment) {
    throw new ApiError("resource_not_found", "Source not found", { param: "source_id" });
  }
  if (!source.surfaces.includes("backend")) throw new ApiError("bad_request", "This source does not support backend access", { param: "source_id" });
  if (!/^[A-Za-z0-9\-.]{1,64}$/.test(input.group_id)) throw new ApiError("invalid_data", "group_id is not a valid FHIR id", { param: "group_id" });
  let since: Date | null = null;
  if (!input.full) {
    const [prev] = await db()
      .select()
      .from(backendSyncs)
      .where(and(eq(backendSyncs.workspaceId, ws.id), eq(backendSyncs.sourceId, source.id), eq(backendSyncs.groupId, input.group_id), eq(backendSyncs.status, "completed")))
      .orderBy(desc(backendSyncs.createdAt))
      .limit(1);
    since = prev?.transactionTime ?? null;
  }
  const [sync] = await db()
    .insert(backendSyncs)
    .values({ id: newId("backendSync"), workspaceId: ws.id, sourceId: source.id, groupId: input.group_id, mode: "bulk", status: "queued", since })
    .returning();
  await enqueue("backend.kickoff", { sync_id: sync!.id }, { dedupeKey: `bulk:${ws.id}:${source.id}:${input.group_id}` });
  return sync!;
}

export async function handleKickoff(payload: Record<string, unknown>) {
  const ctx = await loadSync(String(payload.sync_id));
  if (!ctx || ctx.sync.status !== "queued") return;
  const { sync, ws, source } = ctx;
  try {
    const token = await backendToken(ws, source);
    const profile = profileFor(source.vendor);
    const url = new URL(`${source.fhirBaseUrl}/Group/${sync.groupId}/$export`);
    const settings = (await db().select().from(providerConfigs).where(and(eq(providerConfigs.workspaceId, ws.id), eq(providerConfigs.vendor, source.vendor), eq(providerConfigs.surface, "backend"))).limit(1))[0]?.settings;
    const types = settings?.backend_resource_types ?? profile.bulkTypes;
    if (types?.length) url.searchParams.set("_type", types.join(","));
    if (sync.since) url.searchParams.set("_since", sync.since.toISOString());
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/fhir+json", Prefer: "respond-async" },
      timeoutMs: 60_000,
    });
    if (res.status !== 202) {
      await failSync(sync, `kickoff returned HTTP ${res.status}: ${await readTextSafe(res, 300)}`);
      return;
    }
    const statusUrl = res.headers.get("content-location");
    if (!statusUrl) {
      await failSync(sync, "kickoff response had no Content-Location");
      return;
    }
    await db().update(backendSyncs).set({ status: "polling", statusUrl }).where(eq(backendSyncs.id, sync.id));
    await enqueue("backend.poll", { sync_id: sync.id }, { delaySeconds: parseRetryAfter(res.headers.get("retry-after")) ?? 10, maxAttempts: 10 });
  } catch (err) {
    await failSync(sync, (err as Error).message);
  }
}

export async function handlePoll(payload: Record<string, unknown>) {
  const ctx = await loadSync(String(payload.sync_id));
  if (!ctx || ctx.sync.status !== "polling" || !ctx.sync.statusUrl) return;
  const { sync, ws, source } = ctx;
  if (Date.now() - sync.createdAt.getTime() > 24 * 3600_000) {
    await failSync(sync, "bulk export did not complete within 24 hours");
    return;
  }
  const token = await backendToken(ws, source);
  const res = await fetchWithTimeout(sync.statusUrl!, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, timeoutMs: 30_000 });
  if (res.status === 202) {
    await readTextSafe(res, 256);
    throw new RetryLater(Math.min(parseRetryAfter(res.headers.get("retry-after")) ?? 30, 600), `bulk export in progress ${res.headers.get("x-progress") ?? ""}`);
  }
  if (res.status === 429) throw new RetryLater(parseRetryAfter(res.headers.get("retry-after")) ?? 60, "rate limited while polling");
  if (!res.ok) {
    await failSync(sync, `status poll returned HTTP ${res.status}: ${await readTextSafe(res, 300)}`);
    return;
  }
  const manifest = (await res.json()) as { transactionTime?: string; requiresAccessToken?: boolean; output?: { type: string; url: string; count?: number }[]; error?: { url: string }[] };
  await db()
    .update(backendSyncs)
    .set({ status: "downloading", output: (manifest.output ?? []) as Record<string, unknown>[], transactionTime: manifest.transactionTime ? new Date(manifest.transactionTime) : new Date() })
    .where(eq(backendSyncs.id, sync.id));
  await enqueue("backend.download", { sync_id: sync.id, requires_token: manifest.requiresAccessToken !== false }, { maxAttempts: 3 });
}

/** Streams an NDJSON body line by line without loading the whole file. */
async function* ndjsonLines(res: Response): AsyncGenerator<FhirResource> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line) as FhirResource;
    }
    if (done) break;
  }
  if (buffer.trim()) yield JSON.parse(buffer.trim()) as FhirResource;
}

function patientRefOf(r: FhirResource): string | null {
  for (const key of ["subject", "patient", "beneficiary"]) {
    const ref = (r[key] as { reference?: string } | undefined)?.reference;
    const m = ref ? /(?:^|\/)Patient\/([^/]+)$/.exec(ref) : null;
    if (m) return m[1]!;
  }
  return null;
}

export async function handleDownload(payload: Record<string, unknown>) {
  const ctx = await loadSync(String(payload.sync_id));
  if (!ctx || ctx.sync.status !== "downloading") return;
  const { sync, ws, source } = ctx;
  const outputs = sync.output as { type: string; url: string }[];
  const token = payload.requires_token === false ? null : await backendToken(ws, source);
  // Patients first so every other resource can be attached to its patient.
  const ordered = [...outputs.filter((o) => o.type === "Patient"), ...outputs.filter((o) => o.type !== "Patient")];
  const byFhirPatient = new Map<string, { patientId: string; connectionId: string }>();
  const shared = new Map<string, FhirResource>();
  const perPatient = new Map<string, FhirResource[]>();
  let resourcesSeen = 0;

  try {
    for (const out of ordered) {
      const res = await fetchWithTimeout(out.url, { headers: { Accept: "application/fhir+ndjson", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, timeoutMs: 600_000 });
      if (!res.ok || !res.body) throw new Error(`download of ${out.type} returned HTTP ${res.status}`);
      for await (const resource of ndjsonLines(res)) {
        resourcesSeen++;
        if (resource.resourceType === "Patient") {
          const link = await linkBackendPatient(ws, source, resource);
          byFhirPatient.set(String(resource.id), link);
          perPatient.set(String(resource.id), [resource]);
          continue;
        }
        const pref = patientRefOf(resource);
        if (pref && perPatient.has(pref)) perPatient.get(pref)!.push(resource);
        else shared.set(`${resource.resourceType}/${resource.id}`, resource);
      }
    }
    for (const [fhirId, resources] of perPatient) {
      const link = byFhirPatient.get(fhirId)!;
      const refs = new Set<string>();
      for (const r of resources) collectReferences(r, refs);
      const referencedShared = [...refs].map((k) => shared.get(k)).filter((r): r is FhirResource => !!r);
      const stored = await storeResources({ workspaceId: ws.id, patientId: link.patientId, connectionId: link.connectionId, sourceId: source.id }, [...resources, ...referencedShared]);
      await db().update(connections).set({ lastPullAt: new Date(), updatedAt: new Date() }).where(eq(connections.id, link.connectionId));
      const [p] = await db().select().from(patients).where(eq(patients.id, link.patientId)).limit(1);
      if (p && !p.activatedAt) await db().update(patients).set({ activatedAt: new Date() }).where(eq(patients.id, p.id));
      if (stored.created + stored.updated > 0) {
        await emitEvent(ws.id, "records.sync.completed", {
          resource_type: "records_sync",
          patient_id: p?.externalId ?? null,
          source_id: source.id,
          connection_id: link.connectionId,
          backend_sync_id: sync.id,
          total: stored.created + stored.updated + stored.unchanged,
          created: stored.created,
          updated: stored.updated,
          errors: 0,
          duration_ms: null,
        });
      }
    }
    await db()
      .update(backendSyncs)
      .set({ status: "completed", patientsSeen: perPatient.size, resourcesSeen, finishedAt: new Date() })
      .where(eq(backendSyncs.id, sync.id));
    await triggerExports(ws.id, "pull_completed");
  } catch (err) {
    log.warn("bulk download failed", { sync_id: sync.id, ...errorFields(err) });
    throw err;
  }
}

async function linkBackendPatient(ws: WorkspaceRow, source: SourceRow, fhirPatient: FhirResource) {
  const fhirId = String(fhirPatient.id);
  // Already linked from an earlier sync of this source?
  const [existingConn] = await db()
    .select()
    .from(connections)
    .where(and(eq(connections.workspaceId, ws.id), eq(connections.sourceId, source.id), eq(connections.fhirPatientId, fhirId), eq(connections.surface, "backend")))
    .limit(1);
  if (existingConn) {
    await registerIdentity({ workspaceId: ws.id, patientId: existingConn.patientId, connectionId: existingConn.id, sourceId: source.id, fhirPatient });
    return { patientId: existingConn.patientId, connectionId: existingConn.id };
  }
  const match = await findMatchingPatient(ws.id, fhirPatient);
  let patientId = match?.patientId;
  if (!patientId) {
    const externalId = `im_bk_${createHash("sha256").update(`${source.id}|${fhirId}`).digest("hex").slice(0, 24)}`;
    const name = (fhirPatient.name as { family?: string; given?: string[] }[] | undefined)?.[0];
    const p = await createPatient(ws, { patient_id: externalId, name: name ? [name.given?.join(" "), name.family].filter(Boolean).join(" ") : undefined }, "backend", { allowReserved: true });
    patientId = p.id;
  }
  const connectionId = newId("connection");
  await db()
    .insert(connections)
    .values({ id: connectionId, workspaceId: ws.id, patientId, sourceId: source.id, surface: "backend", status: "active", fhirPatientId: fhirId });
  await registerIdentity({ workspaceId: ws.id, patientId, connectionId, sourceId: source.id, fhirPatient });
  return { patientId, connectionId };
}

/** Hourly: start scheduled syncs for configured organizations and groups. */
export async function scheduleBackendSyncs() {
  const hour = new Date().getUTCHours();
  const configs = await db()
    .select({ cfg: providerConfigs, ws: workspaces })
    .from(providerConfigs)
    .innerJoin(workspaces, eq(workspaces.id, providerConfigs.workspaceId))
    .where(and(eq(providerConfigs.surface, "backend"), eq(providerConfigs.enabled, true)));
  for (const { cfg, ws } of configs) {
    if ((cfg.settings.backend_schedule_hour_utc ?? 2) !== hour) continue;
    for (const org of cfg.settings.organizations ?? []) {
      for (const groupId of org.group_ids) {
        const [recent] = await db()
          .select({ id: backendSyncs.id })
          .from(backendSyncs)
          .where(and(eq(backendSyncs.workspaceId, ws.id), eq(backendSyncs.sourceId, org.source_id), eq(backendSyncs.groupId, groupId), gte(backendSyncs.createdAt, new Date(Date.now() - 20 * 3600_000))))
          .limit(1);
        if (recent) continue;
        try {
          await startBackendSync(ws, { source_id: org.source_id, group_id: groupId });
        } catch (err) {
          log.warn("scheduled backend sync could not start", { workspace_id: ws.id, source_id: org.source_id, ...errorFields(err) });
        }
      }
    }
  }
}

export function serializeBackendSync(s: SyncRow) {
  return {
    id: s.id,
    object: "backend_sync" as const,
    source_id: s.sourceId,
    group_id: s.groupId,
    status: s.status,
    since: s.since?.toISOString() ?? null,
    transaction_time: s.transactionTime?.toISOString() ?? null,
    patients_seen: s.patientsSeen,
    resources_seen: s.resourcesSeen,
    error_message: s.errorMessage,
    created_at: s.createdAt.toISOString(),
    finished_at: s.finishedAt?.toISOString() ?? null,
  };
}
