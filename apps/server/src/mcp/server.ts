import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createLocalJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { and, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { apiKeys, connections, mcpGrants, patients, users, workspaces } from "../db/schema.js";
import { sha256Hex } from "../lib/crypto.js";
import { ApiError } from "../lib/errors.js";
import type { AppEnv } from "../http/context.js";
import { API_KEY_PREFIX } from "../http/middleware.js";
import { membershipsFor } from "../services/accounts.js";
import { audit } from "../services/audit.js";
import { featureEnabled } from "../services/billing.js";
import { disconnectConnection } from "../services/connections.js";
import { publicJwks } from "../services/keys.js";
import { createPatient, deletePatient, findPatient, patientConnections, requirePatient } from "../services/patients.js";
import { patientResources, recordStats } from "../services/records.js";
import { createSession, retrieveSession } from "../services/sessions.js";
import { searchSources } from "../services/sources.js";
import { resolveFacts } from "../models/resolver.js";
import { buildModel, MODEL_SOURCES, type ModelName } from "../models/views.js";
import { protectedResourceMetadata, type McpScope } from "./oauth.js";

/**
 * MCP server at {PUBLIC_URL}/mcp (Streamable HTTP, stateless). An AI assistant authenticated by
 * OAuth (consent-scoped) or a workspace API key can look up the workspace, search facilities, start
 * patient-portal connections, check them, read normalized records, and (with `manage`) disconnect
 * or delete. Every tool call writes an audit entry.
 */

type McpContext = {
  workspaceId: string;
  userId: string | null;
  grantId: string | null;
  apiKeyId: string | null;
  scopes: Set<McpScope>;
};

const KEY_SCOPE_MAP: Record<string, McpScope[]> = {
  "*": ["connect", "records:read", "manage"],
  "records:read": ["records:read"],
  "sessions:write": ["connect"],
  "patients:delete": ["manage"],
};

async function authenticateMcp(authorization: string | undefined): Promise<McpContext | null> {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7).trim();
  if (token.startsWith("im_sk_")) {
    const [row] = await db()
      .select({ key: apiKeys, ws: workspaces })
      .from(apiKeys)
      .innerJoin(workspaces, eq(workspaces.id, apiKeys.workspaceId))
      .where(and(eq(apiKeys.tokenHash, sha256Hex(token)), isNull(apiKeys.revokedAt)))
      .limit(1);
    if (!row || (row.key.expiresAt && row.key.expiresAt < new Date()) || !token.startsWith(API_KEY_PREFIX[row.ws.environment])) return null;
    const scopes = new Set<McpScope>(row.key.scopes.flatMap((s) => KEY_SCOPE_MAP[s] ?? []));
    return { workspaceId: row.ws.id, userId: null, grantId: null, apiKeyId: row.key.id, scopes };
  }
  try {
    const { payload } = await jwtVerify(token, createLocalJWKSet(await publicJwks()), { audience: config().mcpResourceUrl, issuer: config().publicUrl });
    const [grant] = await db()
      .select()
      .from(mcpGrants)
      .where(and(eq(mcpGrants.id, String(payload.gid)), isNull(mcpGrants.revokedAt)))
      .limit(1);
    if (!grant) return null;
    void db().update(mcpGrants).set({ lastUsedAt: new Date() }).where(eq(mcpGrants.id, grant.id)).catch(() => undefined);
    return { workspaceId: grant.workspaceId, userId: grant.userId, grantId: grant.id, apiKeyId: null, scopes: new Set(grant.scopes as McpScope[]) };
  } catch {
    return null;
  }
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

function buildServer(ctx: McpContext) {
  const server = new McpServer({ name: "infinimed-platform", version: "1.0.0" }, { instructions: "InfiniMed connects people's health records from hospitals, clinics and insurers. Check existing connections before asking where someone receives care. Confirm with the user before destructive tools." });

  const workspace = async () => {
    const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, ctx.workspaceId)).limit(1);
    if (!ws) throw new ApiError("resource_not_found", "Workspace not found");
    return ws;
  };
  const guard = (scope: McpScope | null) => {
    if (scope && !ctx.scopes.has(scope)) throw new ApiError("insufficient_scope", `This assistant was not granted "${scope}". Reconnect and allow it to use this tool.`);
  };
  const run = <A>(name: string, scope: McpScope | null, fn: (args: A) => Promise<unknown>) =>
    async (args: A) => {
      try {
        guard(scope);
        const ws = await workspace();
        if (!featureEnabled(ws, "mcp")) throw new ApiError("feature_not_enabled", "The MCP server is not enabled for this workspace");
        const result = await fn(args);
        await audit({ workspaceId: ctx.workspaceId, actor: { type: "mcp", id: ctx.grantId ?? ctx.apiKeyId }, action: `mcp.tool.${name}`, metadata: { user_id: ctx.userId } });
        return text(result);
      } catch (err) {
        await audit({ workspaceId: ctx.workspaceId, actor: { type: "mcp", id: ctx.grantId ?? ctx.apiKeyId }, action: `mcp.tool.${name}.error`, metadata: { error: (err as Error).message.slice(0, 200) } });
        return fail(err instanceof ApiError ? err.message : `Tool failed: ${(err as Error).message}`);
      }
    };

  async function personFor(args: { patient_id?: string; person_name?: string }) {
    const ws = await workspace();
    if (args.patient_id) return requirePatient(ws.id, args.patient_id);
    let name = args.person_name?.trim();
    if (!name && ctx.userId) {
      const [u] = await db().select().from(users).where(eq(users.id, ctx.userId)).limit(1);
      name = u?.name ?? undefined;
    }
    if (!name) throw new ApiError("bad_request", "Whose records are these? Provide the person's full name.");
    const [existing] = await db().select().from(patients).where(and(eq(patients.workspaceId, ws.id), ilike(patients.name, name))).limit(1);
    if (existing) return existing;
    if (name.split(/\s+/).length < 2) throw new ApiError("bad_request", "A new person needs a real full name (first and last).");
    return createPatient(ws, { patient_id: `mcp_${sha256Hex(`${ws.id}|${name.toLowerCase()}`).slice(0, 16)}`, name }, "mcp");
  }

  server.registerTool(
    "get_workspace_overview",
    { description: "Who the user is, the selected workspace, and the health systems already connected there.", annotations: { readOnlyHint: true } },
    run("get_workspace_overview", null, async () => {
      const ws = await workspace();
      const [u] = ctx.userId ? await db().select().from(users).where(eq(users.id, ctx.userId)).limit(1) : [];
      const conns = await db()
        .select({ status: connections.status, sourceId: connections.sourceId, n: sql<number>`count(*)::int` })
        .from(connections)
        .where(eq(connections.workspaceId, ws.id))
        .groupBy(connections.status, connections.sourceId);
      const { sources } = await import("../db/schema.js");
      const names = new Map((await db().select({ id: sources.id, name: sources.name }).from(sources)).map((s) => [s.id, s.name]));
      const [people] = await db().select({ n: sql<number>`count(*)::int` }).from(patients).where(eq(patients.workspaceId, ws.id));
      return {
        user: u ? { name: u.name, email: u.email } : { api_key: ctx.apiKeyId },
        workspace: { id: ws.id, name: ws.name, environment: ws.environment, people: Number(people?.n ?? 0) },
        connected_health_systems: conns.map((c) => ({ name: names.get(c.sourceId) ?? c.sourceId, source_id: c.sourceId, status: c.status, connections: Number(c.n), needs_attention: c.status === "refresh_failed" || c.status === "expired" })),
        granted_capabilities: [...ctx.scopes],
      };
    }),
  );

  server.registerTool(
    "list_workspaces",
    { description: "List every workspace the user can use, labeled production or sandbox.", annotations: { readOnlyHint: true } },
    run("list_workspaces", null, async () => {
      if (!ctx.userId) return { workspaces: [{ id: ctx.workspaceId, selected: true, note: "API key connections are bound to one workspace" }] };
      return { workspaces: (await membershipsFor(ctx.userId)).map((m) => ({ id: m.ws.id, name: m.ws.name, environment: m.ws.environment, selected: m.ws.id === ctx.workspaceId })) };
    }),
  );

  server.registerTool(
    "select_workspace",
    { description: "Switch the workspace this assistant works in (for example to a sandbox when the user asks for testing). The user must be a member.", inputSchema: { workspace_id: z.string() } },
    run("select_workspace", null, async ({ workspace_id }: { workspace_id: string }) => {
      if (!ctx.userId || !ctx.grantId) throw new ApiError("forbidden", "API key connections cannot switch workspaces");
      if (!(await membershipsFor(ctx.userId)).some((m) => m.ws.id === workspace_id)) throw new ApiError("workspace_access_denied", "You are not a member of that workspace");
      await db().update(mcpGrants).set({ workspaceId: workspace_id }).where(eq(mcpGrants.id, ctx.grantId));
      ctx.workspaceId = workspace_id;
      return { selected: workspace_id };
    }),
  );

  server.registerTool(
    "list_people",
    { description: "List the people (patients) set up in the workspace, with their connection status.", inputSchema: { query: z.string().optional() }, annotations: { readOnlyHint: true } },
    run("list_people", "records:read", async ({ query }: { query?: string }) => {
      const ws = await workspace();
      const conds = [eq(patients.workspaceId, ws.id)];
      if (query) conds.push(ilike(patients.name, `%${query}%`));
      const rows = await db().select().from(patients).where(and(...conds)).orderBy(desc(patients.createdAt)).limit(50);
      const out = [];
      for (const p of rows) {
        const conns = await patientConnections(p.id);
        out.push({ patient_id: p.externalId, name: p.name, connections: conns.map((c) => ({ id: c.connection.id, facility: c.source?.name, status: c.connection.status })) });
      }
      return { people: out };
    }),
  );

  server.registerTool(
    "search_health_systems",
    { description: "Search hospitals, clinics and insurers by name.", inputSchema: { query: z.string().min(2), type: z.string().optional() }, annotations: { readOnlyHint: true } },
    run("search_health_systems", "connect", async ({ query, type }: { query: string; type?: string }) => {
      const ws = await workspace();
      const res = await searchSources(ws, { q: query, type, surface: "patient_access", limit: 15, includeConnectable: true });
      return { matches: res.data.filter((s) => s.connectable).map((s) => ({ source_id: s.id, name: s.name, type: s.type, location: [s.city, s.state].filter(Boolean).join(", ") || null })) };
    }),
  );

  server.registerTool(
    "choose_health_systems",
    { description: "Find matches for several facility names at once so the user can pick the right ones before connecting.", inputSchema: { names: z.array(z.string().min(2)).min(1).max(8) }, annotations: { readOnlyHint: true } },
    run("choose_health_systems", "connect", async ({ names }: { names: string[] }) => {
      const ws = await workspace();
      const groups = [];
      for (const name of names) {
        const res = await searchSources(ws, { q: name, surface: "patient_access", limit: 8, includeConnectable: true });
        groups.push({ query: name, matches: res.data.filter((s) => s.connectable).map((s) => ({ source_id: s.id, name: s.name, location: [s.city, s.state].filter(Boolean).join(", ") || null })) });
      }
      return { groups, next_step: "Ask the user to confirm which source_ids are theirs, then call connect_health_system." };
    }),
  );

  server.registerTool(
    "connect_health_system",
    {
      description: "Create a secure link where the person signs in to their patient portal(s). Reuses an existing person with the same name, or creates one from the real full name provided.",
      inputSchema: { source_ids: z.array(z.string()).min(1).max(10), person_name: z.string().optional(), patient_id: z.string().optional() },
    },
    run("connect_health_system", "connect", async (args: { source_ids: string[]; person_name?: string; patient_id?: string }) => {
      const ws = await workspace();
      const person = await personFor(args);
      const single = args.source_ids.length === 1;
      const session = await createSession(
        ws,
        {
          patient_id: person.externalId,
          ...(single ? { source_id: args.source_ids[0] } : { recommended_source_ids: args.source_ids }),
          return_url: `${config().publicUrl}/mcp/connected`,
          return_button_label: "Back to your assistant",
          metadata: { via: "mcp" },
        },
        "mcp",
      );
      return { link: session.url, patient_session_id: session.id, patient_id: person.externalId, expires_at: session.expires_at, instructions: "Open the link, sign in to each facility, then come back and ask me to check the status." };
    }),
  );

  server.registerTool(
    "check_connection_status",
    { description: "Check how a connection is going, for one session or for a whole person.", inputSchema: { patient_session_id: z.string().optional(), patient_id: z.string().optional() }, annotations: { readOnlyHint: true } },
    run("check_connection_status", null, async (args: { patient_session_id?: string; patient_id?: string }) => {
      const ws = await workspace();
      if (args.patient_session_id) {
        const s = await retrieveSession(ws.id, args.patient_session_id);
        return { session_status: s.status, connections: s.connections.map((c) => ({ facility: c.facility?.name, status: c.status, failure: c.failure_description })) };
      }
      if (!args.patient_id) throw new ApiError("bad_request", "Provide patient_session_id or patient_id");
      const p = await requirePatient(ws.id, args.patient_id);
      const conns = await patientConnections(p.id);
      const stats = await recordStats(p.id);
      return {
        connections: conns.map((c) => ({ id: c.connection.id, facility: c.source?.name, status: c.connection.status, last_pull_at: c.connection.lastPullAt?.toISOString() ?? null, needs_reconnect: c.connection.status === "refresh_failed" || c.connection.status === "expired" })),
        records: stats.reduce((n, s) => n + Number(s.n), 0),
      };
    }),
  );

  server.registerTool(
    "get_health_records",
    {
      description: "Read a person's records from their connected health systems, reconciled across sources. view: summary, allergies, conditions, medications, labs, vitals, immunizations, procedures, encounters, documents, coverage, claims, facts.",
      inputSchema: { patient_id: z.string(), view: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
      annotations: { readOnlyHint: true },
    },
    run("get_health_records", "records:read", async ({ patient_id, view, limit }: { patient_id: string; view?: string; limit?: number }) => {
      const ws = await workspace();
      const p = await requirePatient(ws.id, patient_id);
      const max = limit ?? 50;
      const v = view ?? "summary";
      if (v === "facts") return { facts: resolveFacts({ subject: `Patient/${p.externalId}`, resources: await patientResources(p.id, ["Observation"]) }).filter((f) => f.status === "hasValue") };
      if (v === "summary") {
        const all = await patientResources(p.id);
        const strip = (rows: Record<string, unknown>[]) => rows.slice(0, 15).map(({ key, codes, sources, ...rest }) => ({ ...rest, sources: (sources as unknown[]).length }));
        return {
          patient_id: p.externalId,
          allergies: strip(buildModel("allergies", all)),
          active_conditions: strip(buildModel("conditions", all).filter((r) => r.clinical_status === "active")),
          active_medications: strip(buildModel("medications", all).filter((r) => r.status === "active")),
          latest_vitals_and_labs: resolveFacts({ subject: `Patient/${p.externalId}`, resources: all }).filter((f) => f.status === "hasValue").map((f) => ({ concept: f.display, value: f.value, unit: f.unit, date: f.effective })),
        };
      }
      if (!(v in MODEL_SOURCES)) throw new ApiError("bad_request", `Unknown view ${v}`);
      const rows = buildModel(v as ModelName, await patientResources(p.id, MODEL_SOURCES[v as ModelName]));
      return { view: v, total: rows.length, rows: rows.slice(0, max) };
    }),
  );

  server.registerTool(
    "disconnect_health_system",
    { description: "Stop retrieving records from one connected health system and revoke access. Confirm with the user first.", inputSchema: { patient_id: z.string(), connection_id: z.string() }, annotations: { destructiveHint: true } },
    run("disconnect_health_system", "manage", async ({ patient_id, connection_id }: { patient_id: string; connection_id: string }) => {
      const ws = await workspace();
      return disconnectConnection(ws, await requirePatient(ws.id, patient_id), connection_id);
    }),
  );

  server.registerTool(
    "delete_person",
    { description: "Permanently remove a person and all their retrieved records from the workspace. Confirm with the user first.", inputSchema: { patient_id: z.string() }, annotations: { destructiveHint: true } },
    run("delete_person", "manage", async ({ patient_id }: { patient_id: string }) => {
      const ws = await workspace();
      if (!(await findPatient(ws.id, patient_id))) throw new ApiError("resource_not_found", "Person not found");
      return deletePatient(ws, patient_id);
    }),
  );

  return server;
}

export function mcpRouter() {
  const r = new Hono<AppEnv>();
  r.all("/mcp", async (c) => {
    const ctx = await authenticateMcp(c.req.header("authorization"));
    if (!ctx) {
      const meta = `${config().publicUrl}/.well-known/oauth-protected-resource/mcp`;
      return c.json({ error: "invalid_token", error_description: "Authenticate with OAuth or an InfiniMed API key" }, 401, {
        "WWW-Authenticate": `Bearer resource_metadata="${meta}", scope="${protectedResourceMetadata().scopes_supported.join(" ")}"`,
      });
    }
    const server = buildServer(ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const res = await transport.handleRequest(c.req.raw);
    return res;
  });
  return r;
}
