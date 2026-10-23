import { Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { and, desc, eq, ilike, isNotNull, lt, or, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import {
  auditLogs,
  authEvents,
  backendSyncs,
  cdsCalls,
  connections,
  events,
  exportDestinations,
  fhirResources,
  hl7Messages,
  mcpGrants,
  mcpClients,
  memberships,
  patients,
  patientSessions,
  pulls,
  users,
  webhookDeliveries,
  workspaces,
  type Role,
} from "../db/schema.js";
import { parseLimit } from "../lib/cursor.js";
import { ApiError } from "../lib/errors.js";
import type { AppEnv, Ctx } from "../http/context.js";
import { clientIp } from "../http/context.js";
import { readJson } from "../http/middleware.js";
import {
  acceptInvitation,
  authenticate,
  createApiKey,
  createSessionFor,
  createUser,
  createWorkspace,
  deleteApiKey,
  destroySession,
  inviteMember,
  listApiKeys,
  membershipsFor,
  revokeApiKey,
  roleAtLeast,
  roleIn,
  serializeApiKey,
  sessionFromToken,
  setActiveWorkspace,
  SESSION_TTL_MS,
  API_KEY_SCOPES,
} from "../services/accounts.js";
import { audit } from "../services/audit.js";
import { activePatientCount, featureEnabled, PLANS, patientQuota, type Feature } from "../services/billing.js";
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
import { identitiesForPatient, setIdentityDecision } from "../services/mpi.js";
import { createPatient, deletePatient, patientConnections, requirePatient } from "../services/patients.js";
import { getTile, listTiles, updateTile } from "../services/provider-configs.js";
import { listRecords, patientResources, recordStats } from "../services/records.js";
import { loadSamplePatients } from "../services/samples.js";
import { serializeConnection, serializePatient, serializeSession } from "../services/serializers.js";
import { sessionConnections } from "../services/sessions.js";
import { searchSources } from "../services/sources.js";
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
import { createMagicLink } from "./portal.js";
import { requestManualPull } from "../jobs/pull.js";
import { serializeBackendSync, startBackendSync } from "../jobs/backend.js";
import { resolveFacts, type Aggregate } from "../models/resolver.js";
import { buildModel, MODEL_NAMES, MODEL_SOURCES, type ModelName } from "../models/views.js";

/**
 * Dashboard API (`/dashboard-api`), used by the web console. Cookie session auth; every mutating
 * request must carry `X-InfiniMed-CSRF: 1` (a custom header cross-site forms cannot send, and CORS
 * only admits the dashboard origin). The active workspace comes from the session or the
 * `X-Workspace-Id` header, always checked against the user's memberships.
 */

const COOKIE = "im_session";

export function dashboardRouter() {
  const r = new Hono<AppEnv>();

  const cookieOpts = () => ({
    httpOnly: true,
    secure: config().isProduction,
    sameSite: "Lax" as const,
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });

  r.use("*", async (c, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("x-infinimed-csrf") !== "1") {
      throw new ApiError("forbidden", "Missing CSRF header");
    }
    c.header("Cache-Control", "no-store");
    await next();
  });

  // ------------------------------------------------------------------ auth
  r.post("/auth/signup", async (c) => {
    const body = await readJson(c);
    const user = await createUser({ email: body.email, password: body.password, name: body.name });
    const ws = await createWorkspace(user.id, { name: body.workspace_name ?? `${user.name ?? "My"} workspace`, environment: body.environment ?? "sandbox" });
    const s = await createSessionFor(user.id, ws.id, { ip: clientIp(c), userAgent: c.req.header("user-agent") ?? null });
    setCookie(c, COOKIE, s.token, cookieOpts());
    await audit({ workspaceId: ws.id, actor: { type: "user", id: user.id }, action: "user.signup", ip: clientIp(c) });
    return c.json({ user: { id: user.id, email: user.email, name: user.name }, workspace_id: ws.id }, 201);
  });

  r.post("/auth/login", async (c) => {
    const body = await readJson(c);
    const user = await authenticate(body.email, body.password, clientIp(c));
    const ms = await membershipsFor(user.id);
    const s = await createSessionFor(user.id, ms[0]?.ws.id ?? null, { ip: clientIp(c), userAgent: c.req.header("user-agent") ?? null });
    setCookie(c, COOKIE, s.token, cookieOpts());
    await audit({ workspaceId: ms[0]?.ws.id ?? null, actor: { type: "user", id: user.id }, action: "user.login", ip: clientIp(c) });
    return c.json({ ok: true });
  });

  r.post("/auth/logout", async (c) => {
    const token = getCookie(c, COOKIE);
    if (token) await destroySession(token);
    deleteCookie(c, COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // Session for everything below.
  const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
    const token = getCookie(c, COOKIE);
    const s = token ? await sessionFromToken(token) : null;
    if (!s) throw new ApiError("not_authenticated", "Sign in to continue");
    c.set("user", s.user);
    c.set("sessionId", s.session.id);
    c.set("actor", { type: "user", id: s.user.id });
    const wsId = c.req.header("x-workspace-id") ?? s.session.activeWorkspaceId;
    if (wsId) {
      const role = await roleIn(s.user.id, wsId);
      if (role) {
        const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, wsId)).limit(1);
        if (ws) {
          c.set("ws", ws);
          c.set("role", role);
        }
      }
    }
    await next();
  };
  r.use("*", async (c, next) => (c.req.path.startsWith("/dashboard-api/auth/") ? next() : requireUser(c, next)));

  const needWs = (c: Ctx, min: Role = "member") => {
    const ws = c.get("ws");
    if (!ws) throw new ApiError("workspace_access_denied", "Select a workspace first");
    if (!roleAtLeast(c.get("role"), min)) throw new ApiError("role_insufficient", `This action needs the ${min} role`);
    return ws;
  };
  const log = (c: Ctx, action: string, targetType?: string, targetId?: string, metadata?: Record<string, unknown>) =>
    audit({ workspaceId: c.get("ws")?.id ?? null, actor: c.get("actor"), action, targetType, targetId, metadata, ip: clientIp(c), requestId: c.get("requestId") });

  r.get("/me", async (c) => {
    const user = c.get("user");
    const ms = await membershipsFor(user.id);
    const ws = c.get("ws");
    return c.json({
      user: { id: user.id, email: user.email, name: user.name },
      workspaces: ms.map((m) => ({ id: m.ws.id, name: m.ws.name, environment: m.ws.environment, plan: m.ws.plan, role: m.role })),
      active_workspace_id: ws?.id ?? null,
      api_key_scopes: API_KEY_SCOPES,
      public_url: config().publicUrl,
    });
  });

  r.post("/workspaces", async (c) => {
    const body = await readJson(c);
    const ws = await createWorkspace(c.get("user").id, { name: body.name, environment: body.environment });
    await setActiveWorkspace(c.get("sessionId"), ws.id);
    await audit({ workspaceId: ws.id, actor: c.get("actor"), action: "workspace.create", ip: clientIp(c) });
    return c.json({ id: ws.id, name: ws.name, environment: ws.environment }, 201);
  });

  r.post("/workspaces/:id/switch", async (c) => {
    const id = c.req.param("id");
    if (!(await roleIn(c.get("user").id, id))) throw new ApiError("workspace_access_denied", "You are not a member of this workspace");
    await setActiveWorkspace(c.get("sessionId"), id);
    return c.json({ ok: true, active_workspace_id: id });
  });

  r.get("/workspace", async (c) => {
    const ws = needWs(c);
    const features = Object.fromEntries(
      (["patient_access", "exports", "webhooks", "custom_credentials", "mcp", "clinical_models", "hl7v2_ingest", "backend", "clinical_workflow", "network", "document_structuring"] as Feature[]).map((f) => [f, featureEnabled(ws, f)]),
    );
    return c.json({ id: ws.id, name: ws.name, environment: ws.environment, plan: ws.plan, branding: ws.branding, features, role: c.get("role") });
  });

  r.patch("/workspace", async (c) => {
    const ws = needWs(c, "admin");
    const body = await readJson(c);
    const patch: Partial<typeof workspaces.$inferInsert> = { updatedAt: new Date() };
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 100);
    if (body.branding && typeof body.branding === "object") {
      const b = body.branding as Record<string, unknown>;
      const branding = { ...ws.branding };
      if (typeof b.display_name === "string") branding.display_name = b.display_name.slice(0, 80);
      if (typeof b.primary_color === "string") {
        if (!/^#[0-9a-fA-F]{6}$/.test(b.primary_color)) throw new ApiError("invalid_data", "primary_color must be #RRGGBB", { param: "primary_color" });
        branding.primary_color = b.primary_color;
      }
      if (typeof b.logo_url === "string") {
        if (b.logo_url && !/^https:\/\//.test(b.logo_url)) throw new ApiError("invalid_data", "logo_url must be https", { param: "logo_url" });
        branding.logo_url = b.logo_url || undefined;
      }
      if (typeof b.support_email === "string") branding.support_email = b.support_email.slice(0, 200);
      patch.branding = branding;
    }
    const [row] = await db().update(workspaces).set(patch).where(eq(workspaces.id, ws.id)).returning();
    await log(c, "workspace.update");
    return c.json({ id: row!.id, name: row!.name, branding: row!.branding });
  });

  r.get("/overview", async (c) => {
    const ws = needWs(c);
    const one = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
    const since = new Date(Date.now() - 24 * 3600_000);
    return c.json({
      patients: await one(db().select({ n: sql<number>`count(*)::int` }).from(patients).where(eq(patients.workspaceId, ws.id))),
      active_patients: await activePatientCount(ws.id),
      active_connections: await one(db().select({ n: sql<number>`count(*)::int` }).from(connections).where(and(eq(connections.workspaceId, ws.id), eq(connections.status, "active")))),
      needs_reconnect: await one(db().select({ n: sql<number>`count(*)::int` }).from(connections).where(and(eq(connections.workspaceId, ws.id), or(eq(connections.status, "refresh_failed"), eq(connections.status, "expired"))))),
      records: await one(db().select({ n: sql<number>`count(*)::int` }).from(fhirResources).where(eq(fhirResources.workspaceId, ws.id))),
      pulls_24h: await one(db().select({ n: sql<number>`count(*)::int` }).from(pulls).where(and(eq(pulls.workspaceId, ws.id), sql`${pulls.createdAt} > ${since.toISOString()}`))),
      failed_pulls_24h: await one(db().select({ n: sql<number>`count(*)::int` }).from(pulls).where(and(eq(pulls.workspaceId, ws.id), eq(pulls.status, "failed"), sql`${pulls.createdAt} > ${since.toISOString()}`))),
      failing_webhook_deliveries: await one(
        db()
          .select({ n: sql<number>`count(*)::int` })
          .from(webhookDeliveries)
          .where(and(eq(webhookDeliveries.workspaceId, ws.id), sql`${webhookDeliveries.deliveredAt} is null`, sql`${webhookDeliveries.attempts} > 0`)),
      ),
      export_destinations: await one(db().select({ n: sql<number>`count(*)::int` }).from(exportDestinations).where(eq(exportDestinations.workspaceId, ws.id))),
    });
  });

  // ------------------------------------------------------------------ members
  r.get("/members", async (c) => {
    const ws = needWs(c);
    const rows = await db().select({ m: memberships, u: users }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.workspaceId, ws.id));
    return c.json({ data: rows.map((x) => ({ user_id: x.u.id, email: x.u.email, name: x.u.name, role: x.m.role, joined_at: x.m.createdAt.toISOString() })) });
  });
  r.post("/members/invitations", async (c) => {
    const ws = needWs(c, "admin");
    const body = await readJson(c);
    if (body.role === "owner" && c.get("role") !== "owner") throw new ApiError("role_insufficient", "Only owners can invite owners");
    const token = await inviteMember(ws.id, { email: body.email, role: body.role ?? "member" }, c.get("user").id);
    await log(c, "member.invite", "invitation", undefined, { role: body.role });
    return c.json({ invite_url: `${config().dashboardUrl}/accept-invite?token=${token}` }, 201);
  });
  r.post("/invitations/:token/accept", async (c) => {
    const wsId = await acceptInvitation(c.get("user").id, c.get("user").email, c.req.param("token"));
    await setActiveWorkspace(c.get("sessionId"), wsId);
    return c.json({ workspace_id: wsId });
  });
  r.patch("/members/:userId", async (c) => {
    const ws = needWs(c, "owner");
    const body = await readJson(c);
    if (!["owner", "admin", "member"].includes(String(body.role))) throw new ApiError("invalid_data", "Invalid role", { param: "role" });
    await db().update(memberships).set({ role: body.role as Role }).where(and(eq(memberships.workspaceId, ws.id), eq(memberships.userId, c.req.param("userId"))));
    await log(c, "member.role_change", "user", c.req.param("userId"), { role: body.role });
    return c.json({ ok: true });
  });
  r.delete("/members/:userId", async (c) => {
    const ws = needWs(c, "owner");
    if (c.req.param("userId") === c.get("user").id) throw new ApiError("bad_request", "You cannot remove yourself");
    await db().delete(memberships).where(and(eq(memberships.workspaceId, ws.id), eq(memberships.userId, c.req.param("userId"))));
    await log(c, "member.remove", "user", c.req.param("userId"));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------ API keys
  r.get("/api-keys", async (c) => c.json({ data: (await listApiKeys(needWs(c).id)).map(serializeApiKey) }));
  r.post("/api-keys", async (c) => {
    const ws = needWs(c, "admin");
    const { row, secret } = await createApiKey(ws, await readJson(c), c.get("user").id);
    await log(c, "api_key.create", "api_key", row.id);
    return c.json({ ...serializeApiKey(row), secret }, 201);
  });
  r.post("/api-keys/:id/revoke", async (c) => {
    const ws = needWs(c, "admin");
    const row = await revokeApiKey(ws.id, c.req.param("id"));
    await log(c, "api_key.revoke", "api_key", row.id);
    return c.json(serializeApiKey(row));
  });
  r.delete("/api-keys/:id", async (c) => {
    const ws = needWs(c, "admin");
    await deleteApiKey(ws.id, c.req.param("id"));
    await log(c, "api_key.delete", "api_key", c.req.param("id"));
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------------ patients
  r.get("/patients", async (c) => {
    const ws = needWs(c);
    const q = c.req.query("q")?.trim();
    const limit = parseLimit(c.req.query("limit"), 50);
    const before = c.req.query("before");
    const conds = [eq(patients.workspaceId, ws.id)];
    if (q) conds.push(or(ilike(patients.externalId, `%${q}%`), ilike(patients.email, `%${q}%`), ilike(patients.name, `%${q}%`))!);
    if (before) conds.push(lt(patients.id, before));
    const rows = await db().select().from(patients).where(and(...conds)).orderBy(desc(patients.id)).limit(limit + 1);
    const items = rows.slice(0, limit);
    const data = [];
    for (const p of items) data.push(serializePatient(p, await patientConnections(p.id)));
    return c.json({ data, has_more: rows.length > limit, next_before: rows.length > limit ? items[items.length - 1]!.id : null });
  });
  r.post("/patients", async (c) => {
    const ws = needWs(c, "admin");
    const p = await createPatient(ws, await readJson(c), "dashboard");
    await log(c, "patient.create", "patient", p.externalId);
    return c.json(serializePatient(p, []), 201);
  });
  r.post("/sample-patients", async (c) => {
    const ws = needWs(c, "admin");
    const created = await loadSamplePatients(ws);
    await log(c, "patient.load_samples", undefined, undefined, { count: created.length });
    return c.json({ created });
  });
  r.get("/patients/:id", async (c) => {
    const ws = needWs(c);
    const p = await requirePatient(ws.id, c.req.param("id"));
    const conns = await patientConnections(p.id);
    const sessions = await db().select().from(patientSessions).where(eq(patientSessions.patientId, p.id)).orderBy(desc(patientSessions.createdAt)).limit(10);
    const sessionData = [];
    for (const s of sessions) sessionData.push(serializeSession(s, p.externalId, await sessionConnections(s.id)));
    const pullRows = await db().select().from(pulls).where(eq(pulls.patientId, p.id)).orderBy(desc(pulls.createdAt)).limit(20);
    const authRows = await db().select().from(authEvents).where(eq(authEvents.patientId, p.id)).orderBy(desc(authEvents.createdAt)).limit(50);
    const identities = await identitiesForPatient(p.id);
    await log(c, "patient.view", "patient", p.externalId);
    return c.json({
      patient: serializePatient(p, conns),
      sessions: sessionData,
      pulls: pullRows.map((x) => ({ ...x, startedAt: x.startedAt?.toISOString() ?? null, finishedAt: x.finishedAt?.toISOString() ?? null, createdAt: x.createdAt.toISOString() })),
      auth_events: authRows.map((x) => ({ ...x, createdAt: x.createdAt.toISOString() })),
      record_stats: await recordStats(p.id),
      identities: identities.map((x) => ({ id: x.id, source_id: x.sourceId, connection_id: x.connectionId, fhir_patient_id: x.fhirPatientId, match_status: x.matchStatus, match_probability: x.matchScore === null ? null : x.matchScore / 100, match_details: x.matchDetails })),
      can_magic_link: ws.environment === "sandbox",
    });
  });
  r.delete("/patients/:id", async (c) => {
    const ws = needWs(c, "admin");
    const result = await deletePatient(ws, c.req.param("id"));
    await log(c, "patient.delete", "patient", c.req.param("id"));
    return c.json(result);
  });
  r.post("/patients/:id/magic-link", async (c) => {
    const ws = needWs(c, "admin");
    if (ws.environment !== "sandbox") throw new ApiError("forbidden", "Magic links are available in sandbox workspaces only");
    const p = await requirePatient(ws.id, c.req.param("id"));
    const url = await createMagicLink(ws.id, p.id);
    await log(c, "patient.magic_link", "patient", p.externalId);
    return c.json({ url, expires_in: 86400 });
  });
  r.post("/patients/:id/connections/:cid/pull", async (c) => {
    const ws = needWs(c, "admin");
    const p = await requirePatient(ws.id, c.req.param("id"));
    const [conn] = await db().select().from(connections).where(and(eq(connections.id, c.req.param("cid")), eq(connections.patientId, p.id))).limit(1);
    if (!conn) throw new ApiError("resource_not_found", "Connection not found");
    if (conn.status !== "active" || (!conn.accessTokenEnc && !conn.refreshTokenEnc)) throw new ApiError("bad_request", "This connection has no usable access and cannot be re-pulled");
    await requestManualPull(conn.id);
    await log(c, "connection.manual_pull", "connection", conn.id);
    return c.json({ queued: true }, 202);
  });
  r.delete("/patients/:id/connections/:cid", async (c) => {
    const ws = needWs(c, "admin");
    const p = await requirePatient(ws.id, c.req.param("id"));
    const result = await disconnectConnection(ws, p, c.req.param("cid"));
    await log(c, "connection.disconnect", "connection", c.req.param("cid"));
    return c.json(result);
  });
  r.get("/patients/:id/records", async (c) => {
    const ws = needWs(c);
    const p = await requirePatient(ws.id, c.req.param("id"));
    await log(c, "records.read", "patient", p.externalId);
    return c.json(await listRecords({ patient: p, count: parseLimit(c.req.query("count"), 50, 500), startingAfter: c.req.query("starting_after"), types: c.req.query("type") }));
  });
  r.get("/patients/:id/models/:model", async (c) => {
    const ws = needWs(c);
    const model = c.req.param("model") as ModelName;
    if (!MODEL_NAMES.includes(model)) throw new ApiError("resource_not_found", "Unknown model");
    const p = await requirePatient(ws.id, c.req.param("id"));
    await log(c, "models.read", "patient", p.externalId, { model });
    return c.json({ data: buildModel(model, await patientResources(p.id, MODEL_SOURCES[model])) });
  });
  r.get("/patients/:id/facts", async (c) => {
    const ws = needWs(c);
    const p = await requirePatient(ws.id, c.req.param("id"));
    const aggregate = (c.req.query("aggregate") ?? "latest") as Aggregate;
    const codes = c.req.query("concepts")?.split(",").filter(Boolean);
    await log(c, "facts.read", "patient", p.externalId);
    return c.json({ data: resolveFacts({ subject: `Patient/${p.externalId}`, resources: await patientResources(p.id, ["Observation"]), codes, aggregate }) });
  });
  r.post("/identities/:id/decision", async (c) => {
    const ws = needWs(c, "admin");
    const body = await readJson(c);
    if (body.decision !== "confirmed" && body.decision !== "rejected") throw new ApiError("invalid_data", "decision must be confirmed or rejected", { param: "decision" });
    const row = await setIdentityDecision(ws.id, c.req.param("id"), body.decision);
    if (!row) throw new ApiError("resource_not_found", "Identity not found");
    await log(c, "identity.decision", "identity", row.id, { decision: body.decision });
    return c.json({ id: row.id, match_status: row.matchStatus });
  });

  // ------------------------------------------------------------------ sources and connection settings
  r.get("/sources", async (c) => {
    const ws = needWs(c);
    return c.json(
      await searchSources(ws, {
        q: c.req.query("q"),
        type: c.req.query("type"),
        surface: c.req.query("surface") as "patient_access" | undefined,
        limit: parseLimit(c.req.query("limit"), 25),
        startingAfter: c.req.query("starting_after"),
        includeConnectable: true,
      }),
    );
  });
  r.get("/connections", async (c) => c.json({ data: await listTiles(needWs(c)) }));
  r.get("/connections/:vendor/:surface", async (c) => c.json(await getTile(needWs(c), c.req.param("vendor"), c.req.param("surface") as "patient_access")));
  r.put("/connections/:vendor/:surface", async (c) => {
    const ws = needWs(c, "admin");
    const result = await updateTile(ws, c.req.param("vendor"), c.req.param("surface") as "patient_access", await readJson(c));
    await log(c, "provider_config.update", "provider_config", `${c.req.param("vendor")}:${c.req.param("surface")}`, { credential_mode: result.credential_mode });
    return c.json(result);
  });

  // ------------------------------------------------------------------ exports
  r.get("/exports", async (c) => {
    const ws = needWs(c);
    const rows = await db().select().from(exportDestinations).where(eq(exportDestinations.workspaceId, ws.id)).orderBy(desc(exportDestinations.createdAt));
    return c.json({ data: rows.map(serializeDestination) });
  });
  r.post("/exports", async (c) => {
    const ws = needWs(c, "admin");
    const dest = await createDestination(ws, await readJson(c));
    await log(c, "export_destination.create", "export_destination", dest.id, { type: dest.type });
    return c.json({ ...serializeDestination(dest), internal_access: internalCredentials(dest) }, 201);
  });
  r.get("/exports/:id", async (c) => {
    const ws = needWs(c);
    const dest = await getDestination(ws.id, c.req.param("id"));
    const showSecret = roleAtLeast(c.get("role"), "admin");
    const creds = internalCredentials(dest);
    return c.json({ ...serializeDestination(dest), internal_access: creds && !showSecret ? { base_url: creds.base_url, bearer_token: null } : creds, runs: (await listRuns(dest.id, 50)).map(serializeRun) });
  });
  r.patch("/exports/:id", async (c) => {
    const ws = needWs(c, "admin");
    const dest = await updateDestination(ws, c.req.param("id"), await readJson(c));
    await log(c, "export_destination.update", "export_destination", dest.id);
    return c.json(serializeDestination(dest));
  });
  r.delete("/exports/:id", async (c) => {
    const ws = needWs(c, "admin");
    const result = await deleteDestination(ws, c.req.param("id"));
    await log(c, "export_destination.delete", "export_destination", c.req.param("id"));
    return c.json(result);
  });
  r.post("/exports/:id/runs/:runId/retry", async (c) => c.json(await retryRun(needWs(c, "admin"), c.req.param("id"), c.req.param("runId")), 202));

  // ------------------------------------------------------------------ webhooks and events
  r.get("/webhooks", async (c) => c.json(await listWebhooks(needWs(c), { limit: 100 })));
  r.post("/webhooks", async (c) => {
    const ws = needWs(c, "admin");
    const created = await createWebhook(ws, await readJson(c));
    await log(c, "webhook.create", "webhook_endpoint", created.id);
    return c.json(created, 201);
  });
  r.get("/webhooks/:id", async (c) => {
    const ws = needWs(c);
    return c.json({ endpoint: serializeWebhookEndpoint(await getWebhook(ws, c.req.param("id"))), deliveries: await listWebhookEvents(ws, c.req.param("id"), { limit: 50 }) });
  });
  r.patch("/webhooks/:id", async (c) => c.json(await updateWebhook(needWs(c, "admin"), c.req.param("id"), await readJson(c))));
  r.delete("/webhooks/:id", async (c) => {
    const ws = needWs(c, "admin");
    const result = await deleteWebhook(ws, c.req.param("id"));
    await log(c, "webhook.delete", "webhook_endpoint", c.req.param("id"));
    return c.json(result);
  });
  r.post("/webhooks/:id/rotate-secret", async (c) => {
    const ws = needWs(c, "admin");
    const result = await rotateWebhookSecret(ws, c.req.param("id"));
    await log(c, "webhook.rotate_secret", "webhook_endpoint", c.req.param("id"));
    return c.json(result);
  });
  r.post("/events/:id/redeliver", async (c) => {
    const ws = needWs(c, "admin");
    const body = await readJson(c);
    return c.json(await redeliverEvent(ws, c.req.param("id"), typeof body.endpoint_id === "string" ? body.endpoint_id : undefined));
  });
  r.get("/events", async (c) => {
    const ws = needWs(c);
    const rows = await db().select().from(events).where(eq(events.workspaceId, ws.id)).orderBy(desc(events.createdAt)).limit(parseLimit(c.req.query("limit"), 50));
    return c.json({ data: rows.map((e) => ({ id: e.id, type: e.type, created_at: e.createdAt.toISOString(), data: e.data })) });
  });

  // ------------------------------------------------------------------ backend, feeds, CDS
  r.get("/backend-syncs", async (c) => {
    const ws = needWs(c);
    const rows = await db().select().from(backendSyncs).where(eq(backendSyncs.workspaceId, ws.id)).orderBy(desc(backendSyncs.createdAt)).limit(50);
    return c.json({ data: rows.map(serializeBackendSync) });
  });
  r.post("/backend-syncs", async (c) => {
    const ws = needWs(c, "admin");
    const body = await readJson(c);
    const sync = await startBackendSync(ws, { source_id: String(body.source_id), group_id: String(body.group_id), full: body.full === true });
    await log(c, "backend_sync.start", "backend_sync", sync.id);
    return c.json(serializeBackendSync(sync), 202);
  });
  r.get("/hl7-messages", async (c) => {
    const ws = needWs(c);
    const rows = await db()
      .select({ id: hl7Messages.id, controlId: hl7Messages.controlId, messageType: hl7Messages.messageType, status: hl7Messages.status, ackCode: hl7Messages.ackCode, resourcesCreated: hl7Messages.resourcesCreated, error: hl7Messages.error, createdAt: hl7Messages.createdAt })
      .from(hl7Messages)
      .where(eq(hl7Messages.workspaceId, ws.id))
      .orderBy(desc(hl7Messages.createdAt))
      .limit(100);
    return c.json({ data: rows });
  });
  r.get("/cds-calls", async (c) => {
    const ws = needWs(c);
    return c.json({ data: await db().select().from(cdsCalls).where(eq(cdsCalls.workspaceId, ws.id)).orderBy(desc(cdsCalls.createdAt)).limit(100) });
  });

  // ------------------------------------------------------------------ MCP grants, audit, billing
  r.get("/mcp/grants", async (c) => {
    const ws = needWs(c);
    const rows = await db()
      .select({ g: mcpGrants, client: mcpClients, u: users })
      .from(mcpGrants)
      .leftJoin(mcpClients, eq(mcpClients.id, mcpGrants.clientId))
      .innerJoin(users, eq(users.id, mcpGrants.userId))
      .where(and(eq(mcpGrants.workspaceId, ws.id)))
      .orderBy(desc(mcpGrants.createdAt));
    return c.json({
      data: rows.map((x) => ({
        id: x.g.id,
        client_name: x.client?.clientName ?? x.g.clientId,
        user_email: x.u.email,
        scopes: x.g.scopes,
        created_at: x.g.createdAt.toISOString(),
        last_used_at: x.g.lastUsedAt?.toISOString() ?? null,
        revoked_at: x.g.revokedAt?.toISOString() ?? null,
      })),
    });
  });
  r.post("/mcp/grants/:id/revoke", async (c) => {
    const ws = needWs(c);
    const [grant] = await db().select().from(mcpGrants).where(and(eq(mcpGrants.id, c.req.param("id")), eq(mcpGrants.workspaceId, ws.id))).limit(1);
    if (!grant) throw new ApiError("resource_not_found", "Grant not found");
    if (grant.userId !== c.get("user").id && !roleAtLeast(c.get("role"), "admin")) throw new ApiError("role_insufficient", "Only admins can revoke other members' grants");
    await db().update(mcpGrants).set({ revokedAt: new Date(), refreshTokenHash: null }).where(eq(mcpGrants.id, grant.id));
    await log(c, "mcp.grant_revoke", "mcp_grant", grant.id);
    return c.json({ ok: true });
  });
  r.get("/audit", async (c) => {
    const ws = needWs(c, "admin");
    const before = c.req.query("before");
    const conds = [eq(auditLogs.workspaceId, ws.id)];
    if (before) conds.push(lt(auditLogs.createdAt, new Date(before)));
    const rows = await db().select().from(auditLogs).where(and(...conds)).orderBy(desc(auditLogs.createdAt)).limit(parseLimit(c.req.query("limit"), 100, 500));
    return c.json({ data: rows.map((x) => ({ ...x, createdAt: x.createdAt.toISOString() })) });
  });
  r.get("/billing", async (c) => {
    const ws = needWs(c);
    return c.json({ plan: ws.plan, quota: patientQuota(ws), active_patients: await activePatientCount(ws.id), plan_features: PLANS[ws.plan].features, environment: ws.environment });
  });

  r.get("/connections-needing-attention", async (c) => {
    const ws = needWs(c);
    const rows = await db()
      .select({ conn: connections, p: patients })
      .from(connections)
      .innerJoin(patients, eq(patients.id, connections.patientId))
      .where(and(eq(connections.workspaceId, ws.id), or(eq(connections.status, "refresh_failed"), eq(connections.status, "expired")), isNotNull(connections.failureAt)))
      .orderBy(desc(connections.failureAt))
      .limit(100);
    return c.json({ data: rows.map((x) => ({ patient_id: x.p.externalId, ...serializeConnection(x.conn, undefined) })) });
  });

  return r;
}
