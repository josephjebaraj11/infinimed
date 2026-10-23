import { Hono } from "hono";
import { and, desc, eq, lt } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { authEvents, backendSyncs, connections, events, pulls } from "../db/schema.js";
import { decodeCursor, encodeCursor, page, parseLimit } from "../lib/cursor.js";
import { ApiError } from "../lib/errors.js";
import { readTextSafe } from "../lib/http.js";
import { apiKeyAuth, idempotency, readJson, requireScope } from "../http/middleware.js";
import type { AppEnv, Ctx } from "../http/context.js";
import { clientIp } from "../http/context.js";
import { audit } from "../services/audit.js";
import { requireFeature } from "../services/billing.js";
import { disconnectConnection } from "../services/connections.js";
import {
  createDestination,
  deleteDestination,
  getDestination,
  internalCredentials,
  listRuns,
  retryRun,
  serializeDestination,
  serializeRun,
  updateDestination,
} from "../services/destinations.js";
import { getLaunch, launchAccessToken } from "../services/ehr-launch.js";
import { ingestFhir, ingestHl7 } from "../services/ingest.js";
import { identitiesForPatient } from "../services/mpi.js";
import {
  createPatient,
  deletePatient,
  listPatients,
  requirePatient,
  serializePatientWithConnections,
  updatePatient,
} from "../services/patients.js";
import { listRecords, patientResources } from "../services/records.js";
import { serializeLaunch } from "../services/serializers.js";
import { createSession, listSessionsForPatient, retrieveSession } from "../services/sessions.js";
import { retrieveSource, searchSources } from "../services/sources.js";
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  listWebhookEvents,
  listWebhooks,
  redeliverEvent,
  rotateWebhookSecret,
  updateWebhook,
} from "../services/webhooks.js";
import { serializeWebhookEndpoint } from "../services/serializers.js";
import { requestManualPull } from "../jobs/pull.js";
import { serializeBackendSync, startBackendSync } from "../jobs/backend.js";
import { CONCEPTS } from "../models/concepts.js";
import { resolveFacts, type Aggregate } from "../models/resolver.js";
import { buildModel, MODEL_NAMES, MODEL_SOURCES, type ModelName } from "../models/views.js";
import { FhirClient } from "../fhir/client.js";
import { profileFor } from "../smart/profiles.js";
import { sources } from "../db/schema.js";
import { exportDestinations } from "../db/schema.js";

/** Public REST API, `/v1`. Authenticated with workspace API keys (`Authorization: Bearer im_sk_...`). */
export function apiRouter() {
  const api = new Hono<AppEnv>();

  api.get("/health", (c) => c.json({ object: "health", status: "ok", time: new Date().toISOString(), api_version: config().apiVersion }));

  api.use("*", apiKeyAuth, idempotency);

  const auditApi = (c: Ctx, action: string, targetType?: string, targetId?: string, metadata?: Record<string, unknown>) =>
    audit({ workspaceId: c.get("ws").id, actor: c.get("actor"), action, targetType, targetId, metadata, ip: clientIp(c), requestId: c.get("requestId") });

  // ---------------------------------------------------------------- patients
  api.post("/patients", requireScope("patients:write"), async (c) => {
    const body = await readJson(c);
    const p = await createPatient(c.get("ws"), body);
    await auditApi(c, "patient.create", "patient", p.externalId);
    return c.json(await serializePatientWithConnections(p), 201);
  });

  api.get("/patients", requireScope("patients:read"), async (c) =>
    c.json(
      await listPatients(c.get("ws").id, {
        limit: parseLimit(c.req.query("limit")),
        startingAfter: c.req.query("starting_after"),
        email: c.req.query("email"),
      }),
    ),
  );

  api.get("/patients/:id", requireScope("patients:read"), async (c) => c.json(await serializePatientWithConnections(await requirePatient(c.get("ws").id, c.req.param("id")))));

  const update = async (c: Ctx) => {
    const p = await updatePatient(c.get("ws"), c.req.param("id")!, await readJson(c));
    return c.json(await serializePatientWithConnections(p));
  };
  api.put("/patients/:id", requireScope("patients:write"), update);
  api.patch("/patients/:id", requireScope("patients:write"), update);

  api.delete("/patients/:id", requireScope("patients:delete"), async (c) => {
    const result = await deletePatient(c.get("ws"), c.req.param("id"));
    await auditApi(c, "patient.delete", "patient", c.req.param("id"));
    return c.json(result);
  });

  api.get("/patients/:id/records", requireScope("records:read"), async (c) => {
    const p = await requirePatient(c.get("ws").id, c.req.param("id"));
    const result = await listRecords({
      patient: p,
      count: parseLimit(c.req.query("count") ?? c.req.query("limit"), 100, 1000),
      startingAfter: c.req.query("starting_after"),
      types: c.req.query("type"),
      since: c.req.query("since"),
    });
    await auditApi(c, "records.read", "patient", p.externalId, { count: result.data.length });
    return c.json(result);
  });

  api.post("/patients/:id/records", requireScope("records:write"), async (c) => {
    const p = await requirePatient(c.get("ws").id, c.req.param("id"));
    const text = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError("bad_request", "Body must be JSON (a FHIR Bundle or an array of resources)");
    }
    const result = await ingestFhir(c.get("ws"), p, body, c.req.query("source_label") ?? "external");
    await auditApi(c, "records.ingest", "patient", p.externalId, { created: result.created, updated: result.updated });
    return c.json(result, 201);
  });

  api.get("/patients/:id/patient-sessions", requireScope("patients:read"), async (c) => {
    const p = await requirePatient(c.get("ws").id, c.req.param("id"));
    return c.json(await listSessionsForPatient(c.get("ws").id, p.id, p.externalId, { limit: parseLimit(c.req.query("limit")), startingAfter: c.req.query("starting_after") }));
  });

  api.delete("/patients/:id/connections/:connection_id", requireScope("patients:write"), async (c) => {
    const p = await requirePatient(c.get("ws").id, c.req.param("id"));
    const result = await disconnectConnection(c.get("ws"), p, c.req.param("connection_id"));
    await auditApi(c, "connection.disconnect", "connection", c.req.param("connection_id"));
    return c.json(result);
  });

  api.post("/patients/:id/connections/:connection_id/pull", requireScope("patients:write"), async (c) => {
    const p = await requirePatient(c.get("ws").id, c.req.param("id"));
    const [conn] = await db()
      .select()
      .from(connections)
      .where(and(eq(connections.id, c.req.param("connection_id")), eq(connections.patientId, p.id)))
      .limit(1);
    if (!conn) throw new ApiError("resource_not_found", "Connection not found", { param: "connection_id" });
    if (conn.status !== "active" || conn.surface !== "patient_access") throw new ApiError("bad_request", `Connection is ${conn.status}; only active patient-access connections can be pulled`);
    await requestManualPull(conn.id);
    return c.json({ object: "pull_request", connection_id: conn.id, queued: true }, 202);
  });

  api.get("/patients/:id/pulls", requireScope("patients:read"), async (c) => {
    const p = await requirePatient(c.get("ws").id, c.req.param("id"));
    const limit = parseLimit(c.req.query("limit"), 20);
    const rows = await db().select().from(pulls).where(eq(pulls.patientId, p.id)).orderBy(desc(pulls.createdAt)).limit(limit);
    return c.json(
      page(
        rows.map((r) => ({
          id: r.id,
          object: "pull",
          connection_id: r.connectionId,
          trigger: r.trigger,
          status: r.status,
          total: r.total,
          created: r.created,
          updated: r.updated,
          errors: r.errors,
          error_code: r.errorCode,
          error_message: r.errorMessage,
          details: r.details,
          started_at: r.startedAt?.toISOString() ?? null,
          finished_at: r.finishedAt?.toISOString() ?? null,
          duration_ms: r.durationMs,
        })),
        false,
        null,
      ),
    );
  });

  api.get("/patients/:id/auth-events", requireScope("patients:read"), async (c) => {
    const p = await requirePatient(c.get("ws").id, c.req.param("id"));
    const rows = await db().select().from(authEvents).where(eq(authEvents.patientId, p.id)).orderBy(desc(authEvents.createdAt)).limit(parseLimit(c.req.query("limit"), 50));
    return c.json(
      page(
        rows.map((r) => ({
          id: r.id,
          object: "auth_event",
          source_id: r.sourceId,
          connection_id: r.connectionId,
          patient_session_id: r.patientSessionId,
          step: r.step,
          status: r.status,
          error_code: r.errorCode,
          error_description: r.errorDescription,
          created_at: r.createdAt.toISOString(),
        })),
        false,
        null,
      ),
    );
  });

  api.get("/patients/:id/identities", requireScope("patients:read"), async (c) => {
    const p = await requirePatient(c.get("ws").id, c.req.param("id"));
    const rows = await identitiesForPatient(p.id);
    return c.json(
      page(
        rows.map((r) => ({
          id: r.id,
          object: "identity",
          source_id: r.sourceId,
          connection_id: r.connectionId,
          fhir_patient_id: r.fhirPatientId,
          match_status: r.matchStatus,
          match_probability: r.matchScore === null ? null : r.matchScore / 100,
          match_details: r.matchDetails,
          created_at: r.createdAt.toISOString(),
        })),
        false,
        null,
      ),
    );
  });

  // Clinical models: facts with provenance and reconciled tables.
  api.get("/patients/:id/facts", requireScope("records:read"), async (c) => {
    requireFeature(c.get("ws"), "clinical_models");
    const p = await requirePatient(c.get("ws").id, c.req.param("id"));
    const aggregateParam = (c.req.query("aggregate") ?? "latest") as Aggregate;
    if (!["latest", "earliest", "min", "max", "mean", "count", "all"].includes(aggregateParam)) throw new ApiError("bad_request", "aggregate must be latest, earliest, min, max, mean, count or all", { param: "aggregate" });
    const codes = c.req.query("concepts")?.split(",").map((s) => s.trim()).filter(Boolean);
    for (const code of codes ?? []) if (!CONCEPTS.some((x) => x.code === code)) throw new ApiError("bad_request", `Unknown concept ${code}. See GET /v1/concepts`, { param: "concepts" });
    const rows = await patientResources(p.id, ["Observation"]);
    const facts = resolveFacts({ subject: `Patient/${p.externalId}`, resources: rows, codes, aggregate: aggregateParam, from: c.req.query("from"), to: c.req.query("to") });
    await auditApi(c, "facts.read", "patient", p.externalId, { concepts: codes?.length ?? CONCEPTS.length });
    return c.json({ object: "list", resource_type: "facts", patient_id: p.externalId, data: facts });
  });

  api.get("/patients/:id/models/:model", requireScope("records:read"), async (c) => {
    requireFeature(c.get("ws"), "clinical_models");
    const model = c.req.param("model") as ModelName;
    if (!MODEL_NAMES.includes(model)) throw new ApiError("resource_not_found", `Unknown model. Available: ${MODEL_NAMES.join(", ")}`, { param: "model" });
    const p = await requirePatient(c.get("ws").id, c.req.param("id"));
    const rows = await patientResources(p.id, MODEL_SOURCES[model]);
    const data = buildModel(model, rows);
    await auditApi(c, "models.read", "patient", p.externalId, { model, rows: data.length });
    return c.json({ object: "list", resource_type: model, patient_id: p.externalId, data });
  });

  api.get("/concepts", (c) => c.json({ object: "list", data: CONCEPTS.map((x) => ({ code: x.code, display: x.display, category: x.category, unit: x.unit || null, loinc: x.loinc })) }));
  api.get("/models", (c) => c.json({ object: "list", data: MODEL_NAMES.map((name) => ({ name, reads: MODEL_SOURCES[name] })) }));

  // ---------------------------------------------------------------- sources (connection catalog)
  api.get("/sources", requireScope("sources:read"), async (c) => {
    const surface = c.req.query("surface");
    if (surface && !["patient_access", "clinical_workflow", "backend", "network"].includes(surface)) throw new ApiError("bad_request", "Invalid surface", { param: "surface" });
    return c.json(
      await searchSources(c.get("ws"), {
        q: c.req.query("q"),
        type: c.req.query("type"),
        surface: surface as "patient_access" | undefined,
        limit: parseLimit(c.req.query("limit")),
        startingAfter: c.req.query("starting_after"),
        includeConnectable: true,
      }),
    );
  });
  api.get("/sources/:id", requireScope("sources:read"), async (c) => {
    const { serializeSource } = await import("../services/serializers.js");
    return c.json(serializeSource(await retrieveSource(c.get("ws"), decodeURIComponent(c.req.param("id")))));
  });

  // ---------------------------------------------------------------- patient sessions
  api.post("/patient-sessions", requireScope("sessions:write"), async (c) => {
    const body = await readJson(c);
    const session = await createSession(c.get("ws"), body as never);
    await auditApi(c, "patient_session.create", "patient_session", session.id);
    return c.json(session, 201);
  });
  api.get("/patient-sessions/:id", requireScope("sessions:read"), async (c) => c.json(await retrieveSession(c.get("ws").id, c.req.param("id"))));

  // ---------------------------------------------------------------- webhooks and events
  api.post("/webhooks", requireScope("webhooks:write"), async (c) => {
    const created = await createWebhook(c.get("ws"), await readJson(c));
    await auditApi(c, "webhook.create", "webhook_endpoint", created.id);
    return c.json(created, 201);
  });
  api.get("/webhooks", requireScope("webhooks:read"), async (c) =>
    c.json(await listWebhooks(c.get("ws"), { limit: parseLimit(c.req.query("limit")), startingAfter: c.req.query("starting_after"), status: c.req.query("status") })),
  );
  api.get("/webhooks/:id", requireScope("webhooks:read"), async (c) => c.json(serializeWebhookEndpoint(await getWebhook(c.get("ws"), c.req.param("id")))));
  api.patch("/webhooks/:id", requireScope("webhooks:write"), async (c) => c.json(await updateWebhook(c.get("ws"), c.req.param("id"), await readJson(c))));
  api.delete("/webhooks/:id", requireScope("webhooks:write"), async (c) => {
    const result = await deleteWebhook(c.get("ws"), c.req.param("id"));
    await auditApi(c, "webhook.delete", "webhook_endpoint", c.req.param("id"));
    return c.json(result);
  });
  api.post("/webhooks/:id/rotate-secret", requireScope("webhooks:write"), async (c) => {
    const result = await rotateWebhookSecret(c.get("ws"), c.req.param("id"));
    await auditApi(c, "webhook.rotate_secret", "webhook_endpoint", c.req.param("id"));
    return c.json(result);
  });
  api.get("/webhooks/:id/events", requireScope("webhooks:read"), async (c) =>
    c.json(await listWebhookEvents(c.get("ws"), c.req.param("id"), { limit: parseLimit(c.req.query("limit")), startingAfter: c.req.query("starting_after") })),
  );
  api.post("/events/:id/redeliver", requireScope("webhooks:write"), async (c) => {
    const body = await readJson(c).catch(() => ({}) as Record<string, unknown>);
    return c.json(await redeliverEvent(c.get("ws"), c.req.param("id"), typeof body.endpoint_id === "string" ? body.endpoint_id : undefined));
  });
  api.get("/events", requireScope("webhooks:read"), async (c) => {
    const limit = parseLimit(c.req.query("limit"));
    const type = c.req.query("type");
    const conds = [eq(events.workspaceId, c.get("ws").id)];
    if (type) conds.push(eq(events.type, type));
    const after = c.req.query("starting_after");
    if (after) conds.push(lt(events.id, String(decodeCursor(after, "events", type).p)));
    const rows = await db().select().from(events).where(and(...conds)).orderBy(desc(events.id)).limit(limit + 1);
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return c.json(
      page(
        items.map((e) => ({ id: e.id, object: "event", type: e.type, created_at: e.createdAt.toISOString(), data: { object: e.data } })),
        rows.length > limit,
        last ? encodeCursor({ k: "events", p: last.id, f: type }) : null,
      ),
    );
  });

  // ---------------------------------------------------------------- clinician workflow
  api.get("/launch-contexts/:id", requireScope("launch:read"), async (c) => c.json(serializeLaunch(await getLaunch(c.get("ws").id, c.req.param("id")))));

  /** Read-only FHIR proxy scoped to the launch: the customer never handles EHR tokens. */
  api.get("/launch-contexts/:id/fhir/*", requireScope("launch:read"), async (c) => {
    const launch = await getLaunch(c.get("ws").id, c.req.param("id"));
    if (launch.status !== "active") throw new ApiError("bad_request", "Launch did not complete");
    const [source] = await db().select().from(sources).where(eq(sources.id, launch.sourceId)).limit(1);
    const prefix = `/v1/launch-contexts/${launch.id}/fhir/`;
    const path = new URL(c.req.url).pathname.slice(prefix.length);
    if (!/^[A-Z][A-Za-z]+(\/[A-Za-z0-9\-.]{1,64})?$/.test(path)) throw new ApiError("bad_request", "Proxy supports `{Type}` searches and `{Type}/{id}` reads only");
    const client = new FhirClient(launch.iss, () => launchAccessToken(launch), { requestsPerMinute: profileFor(source?.vendor ?? "generic").requestsPerMinute });
    const qs = new URL(c.req.url).search;
    const res = await client.request(`${client.base}/${path}${qs}`);
    const body = await readTextSafe(res, 20 * 1024 * 1024);
    return c.body(body, res.status as 200, { "Content-Type": res.headers.get("content-type") ?? "application/fhir+json" });
  });

  // ---------------------------------------------------------------- backend (population) sync
  api.post("/backend-syncs", requireScope("backend:write"), async (c) => {
    const body = await readJson(c);
    if (typeof body.source_id !== "string" || typeof body.group_id !== "string") throw new ApiError("bad_request", "source_id and group_id are required");
    const sync = await startBackendSync(c.get("ws"), { source_id: body.source_id, group_id: body.group_id, full: body.full === true });
    await auditApi(c, "backend_sync.start", "backend_sync", sync.id);
    return c.json(serializeBackendSync(sync), 202);
  });
  api.get("/backend-syncs", requireScope("backend:read"), async (c) => {
    const rows = await db().select().from(backendSyncs).where(eq(backendSyncs.workspaceId, c.get("ws").id)).orderBy(desc(backendSyncs.createdAt)).limit(parseLimit(c.req.query("limit"), 20));
    return c.json(page(rows.map(serializeBackendSync), false, null));
  });
  api.get("/backend-syncs/:id", requireScope("backend:read"), async (c) => {
    const [row] = await db().select().from(backendSyncs).where(and(eq(backendSyncs.id, c.req.param("id")), eq(backendSyncs.workspaceId, c.get("ws").id))).limit(1);
    if (!row) throw new ApiError("resource_not_found", "Backend sync not found");
    return c.json(serializeBackendSync(row));
  });

  // ---------------------------------------------------------------- HL7v2 ingestion
  api.post("/ingest/hl7v2", requireScope("records:write"), async (c) => {
    const raw = await c.req.text();
    if (!raw.trim()) throw new ApiError("bad_request", "Empty HL7v2 message");
    if (raw.length > 2 * 1024 * 1024) throw new ApiError("payload_too_large", "HL7v2 message too large");
    const result = await ingestHl7(c.get("ws"), raw, { feed: c.req.query("feed") ?? "default", createPatients: c.req.query("create_patients") === "true" });
    if ((c.req.header("accept") ?? "").includes("application/json")) {
      const { ack, ...rest } = result;
      return c.json({ object: "hl7v2_ack", ack, ...rest }, result.status as 200);
    }
    return c.body(result.ack, result.status as 200, { "Content-Type": "x-application/hl7-v2+er7; charset=utf-8" });
  });

  // ---------------------------------------------------------------- exports
  api.get("/export-destinations", requireScope("exports:read"), async (c) => {
    const rows = await db().select().from(exportDestinations).where(eq(exportDestinations.workspaceId, c.get("ws").id)).orderBy(desc(exportDestinations.createdAt));
    return c.json(page(rows.map(serializeDestination), false, null));
  });
  api.post("/export-destinations", requireScope("exports:write"), async (c) => {
    const dest = await createDestination(c.get("ws"), await readJson(c));
    await auditApi(c, "export_destination.create", "export_destination", dest.id, { type: dest.type });
    return c.json({ ...serializeDestination(dest), internal_access: internalCredentials(dest) }, 201);
  });
  api.get("/export-destinations/:id", requireScope("exports:read"), async (c) => {
    const dest = await getDestination(c.get("ws").id, c.req.param("id"));
    return c.json({ ...serializeDestination(dest), internal_access: internalCredentials(dest), runs: (await listRuns(dest.id)).map(serializeRun) });
  });
  api.patch("/export-destinations/:id", requireScope("exports:write"), async (c) => {
    const dest = await updateDestination(c.get("ws"), c.req.param("id"), await readJson(c));
    await auditApi(c, "export_destination.update", "export_destination", dest.id);
    return c.json(serializeDestination(dest));
  });
  api.delete("/export-destinations/:id", requireScope("exports:write"), async (c) => {
    const result = await deleteDestination(c.get("ws"), c.req.param("id"));
    await auditApi(c, "export_destination.delete", "export_destination", c.req.param("id"));
    return c.json(result);
  });
  api.post("/export-destinations/:id/runs/:run_id/retry", requireScope("exports:write"), async (c) => c.json(await retryRun(c.get("ws"), c.req.param("id"), c.req.param("run_id")), 202));

  return api;
}
