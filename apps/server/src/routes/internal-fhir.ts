import { Hono } from "hono";
import { and, asc, eq, gt, inArray, lt, sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import { exportDestinations, internalFhirResources } from "../db/schema.js";
import { safeEqual } from "../lib/crypto.js";
import { randomToken } from "../lib/ids.js";
import type { AppEnv } from "../http/context.js";
import { internalCredentials } from "../services/destinations.js";
import { deleteInternal, upsertInternal } from "../exports/fhir-destination.js";
import { FHIR_ID } from "../exports/transform.js";

/**
 * InfiniMed-hosted FHIR R4 server, one per "internal FHIR server" export destination:
 *   {PUBLIC_URL}/fhir/{destination_id}
 * Bearer-token protected. Supports read, search (_id, identifier, patient/subject/beneficiary,
 * _lastUpdated, _include, _count/_offset paging), create, update, delete and transaction/batch
 * Bundles: enough for exports, downstream ingestion and the queries in the docs.
 */

type R = Record<string, unknown>;
const TYPE = /^[A-Z][A-Za-z]{1,63}$/;
const tokenCache = new Map<string, { token: string; at: number }>();

const outcome = (status: number, code: string, diagnostics: string) => ({
  resourceType: "OperationOutcome",
  issue: [{ severity: status >= 500 ? "fatal" : "error", code, diagnostics }],
});

async function authorize(destId: string, header: string | undefined) {
  if (!header?.startsWith("Bearer ")) return false;
  let cached = tokenCache.get(destId);
  if (!cached || Date.now() - cached.at > 60_000) {
    const [dest] = await db().select().from(exportDestinations).where(eq(exportDestinations.id, destId)).limit(1);
    const creds = dest ? internalCredentials(dest) : null;
    if (!creds) return false;
    cached = { token: creds.bearer_token, at: Date.now() };
    tokenCache.set(destId, cached);
  }
  return safeEqual(cached.token, header.slice(7));
}

function capability(base: string) {
  return {
    resourceType: "CapabilityStatement",
    status: "active",
    date: "2026-01-01",
    kind: "instance",
    fhirVersion: "4.0.1",
    format: ["json"],
    implementation: { description: "InfiniMed hosted FHIR R4 server", url: base },
    rest: [
      {
        mode: "server",
        security: { description: "Bearer token issued in the InfiniMed dashboard" },
        interaction: [{ code: "transaction" }, { code: "batch" }],
        searchParam: [
          { name: "_id", type: "token" },
          { name: "identifier", type: "token" },
          { name: "patient", type: "reference" },
          { name: "_lastUpdated", type: "date" },
        ],
      },
    ],
  };
}

export function internalFhirRouter() {
  const r = new Hono<AppEnv>();

  r.use("/fhir/:dest/*", async (c, next) => {
    const dest = c.req.param("dest")!;
    if (!(await authorize(dest, c.req.header("authorization")))) {
      return c.json(outcome(401, "login", "Missing or invalid bearer token"), 401, { "WWW-Authenticate": 'Bearer realm="infinimed-fhir"' });
    }
    await next();
    c.header("Content-Type", "application/fhir+json");
  });

  const baseOf = (c: { req: { url: string } }, dest: string) => {
    const u = new URL(c.req.url);
    return `${u.origin}/fhir/${dest}`;
  };

  r.get("/fhir/:dest/metadata", (c) => c.json(capability(baseOf(c, c.req.param("dest")))));

  r.get("/fhir/:dest/:type/:id", async (c) => {
    const { dest, type, id } = c.req.param();
    if (!TYPE.test(type)) return c.json(outcome(400, "invalid", "Invalid resource type"), 400);
    const [row] = await db()
      .select()
      .from(internalFhirResources)
      .where(and(eq(internalFhirResources.destinationId, dest), eq(internalFhirResources.resourceType, type), eq(internalFhirResources.resourceId, id)))
      .limit(1);
    if (!row) return c.json(outcome(404, "not-found", `${type}/${id} not found`), 404);
    c.header("ETag", `W/"${row.versionId}"`);
    return c.json(row.resource);
  });

  r.get("/fhir/:dest/:type", async (c) => {
    const { dest, type } = c.req.param();
    if (!TYPE.test(type)) return c.json(outcome(400, "invalid", "Invalid resource type"), 400);
    const q = new URL(c.req.url).searchParams;
    const conds: SQL[] = [eq(internalFhirResources.destinationId, dest), eq(internalFhirResources.resourceType, type)];
    const ids = q.get("_id");
    if (ids) conds.push(inArray(internalFhirResources.resourceId, ids.split(",")));
    const identifier = q.get("identifier");
    if (identifier) {
      const token = identifier.includes("|") ? identifier : `|${identifier}`;
      conds.push(sql`${internalFhirResources.identifiers} @> ${JSON.stringify([token])}::jsonb`);
    }
    const pat = q.get("patient") ?? q.get("subject") ?? q.get("beneficiary");
    if (pat) conds.push(eq(internalFhirResources.patientRef, pat.replace(/^.*Patient\//, "")));
    for (const lu of q.getAll("_lastUpdated")) {
      const m = /^(gt|ge|lt|le)?(.+)$/.exec(lu);
      const d = m ? new Date(m[2]!) : null;
      if (!d || Number.isNaN(d.getTime())) return c.json(outcome(400, "invalid", "Invalid _lastUpdated"), 400);
      conds.push(m![1] === "lt" || m![1] === "le" ? lt(internalFhirResources.lastUpdated, d) : gt(internalFhirResources.lastUpdated, d));
    }
    const count = Math.min(Math.max(Number(q.get("_count") ?? 50) || 50, 1), 500);
    const offset = Math.max(Number(q.get("_offset") ?? 0) || 0, 0);
    const [{ total } = { total: 0 }] = await db()
      .select({ total: sql<number>`count(*)::int` })
      .from(internalFhirResources)
      .where(and(...conds));
    const rows = await db()
      .select()
      .from(internalFhirResources)
      .where(and(...conds))
      .orderBy(asc(internalFhirResources.resourceId))
      .limit(count)
      .offset(offset);
    const base = baseOf(c, dest);
    const entries: R[] = rows.map((row) => ({ fullUrl: `${base}/${type}/${row.resourceId}`, resource: row.resource, search: { mode: "match" } }));

    // _include=Type:param resolves top-level reference fields of the matches.
    for (const inc of q.getAll("_include")) {
      const [, param] = inc.split(":");
      if (!param) continue;
      const refs = new Set<string>();
      for (const row of rows) {
        const v = (row.resource as R)[param];
        for (const item of Array.isArray(v) ? v : [v]) {
          const ref = (item as { reference?: string } | undefined)?.reference;
          if (ref && /^[A-Z][A-Za-z]+\/[A-Za-z0-9\-.]+$/.test(ref)) refs.add(ref);
        }
      }
      for (const ref of refs) {
        const [t, id] = ref.split("/") as [string, string];
        const [hit] = await db()
          .select()
          .from(internalFhirResources)
          .where(and(eq(internalFhirResources.destinationId, dest), eq(internalFhirResources.resourceType, t), eq(internalFhirResources.resourceId, id)))
          .limit(1);
        if (hit) entries.push({ fullUrl: `${base}/${t}/${id}`, resource: hit.resource, search: { mode: "include" } });
      }
    }
    const link = [{ relation: "self", url: c.req.url }];
    if (offset + count < Number(total)) {
      const next = new URL(c.req.url);
      next.searchParams.set("_offset", String(offset + count));
      link.push({ relation: "next", url: next.toString() });
    }
    return c.json({ resourceType: "Bundle", type: "searchset", total: Number(total), link, entry: entries });
  });

  async function writeOne(dest: string, type: string, id: string, resource: R) {
    if (resource.resourceType !== type) return { status: 400, body: outcome(400, "invalid", "resourceType does not match the URL") };
    if (!FHIR_ID.test(id)) return { status: 400, body: outcome(400, "invalid", "Invalid resource id") };
    const result = await upsertInternal(dest, { ...resource, id });
    return { status: result.created ? 201 : 200, body: result.resource, versionId: result.versionId, lastUpdated: result.lastUpdated };
  }

  r.put("/fhir/:dest/:type/:id", async (c) => {
    const { dest, type, id } = c.req.param();
    const body = (await c.req.json().catch(() => null)) as R | null;
    if (!body) return c.json(outcome(400, "structure", "Body must be a FHIR resource"), 400);
    if (body.id && body.id !== id) return c.json(outcome(400, "invalid", "Resource id does not match the URL"), 400);
    const res = await writeOne(dest, type, id, body);
    return c.json(res.body, res.status as 200);
  });

  r.post("/fhir/:dest/:type", async (c) => {
    const { dest, type } = c.req.param();
    const body = (await c.req.json().catch(() => null)) as R | null;
    if (!body) return c.json(outcome(400, "structure", "Body must be a FHIR resource"), 400);
    const res = await writeOne(dest, type, randomToken(12).replace(/_/g, "-"), body);
    return c.json(res.body, res.status as 200);
  });

  r.delete("/fhir/:dest/:type/:id", async (c) => {
    const { dest, type, id } = c.req.param();
    await deleteInternal(dest, type, id);
    return c.body(null, 204);
  });

  r.post("/fhir/:dest", async (c) => {
    const dest = c.req.param("dest");
    const bundle = (await c.req.json().catch(() => null)) as { resourceType?: string; type?: string; entry?: { resource?: R; request?: { method?: string; url?: string } }[] } | null;
    if (!bundle || bundle.resourceType !== "Bundle" || !["transaction", "batch"].includes(String(bundle.type))) {
      return c.json(outcome(400, "structure", "Expected a transaction or batch Bundle"), 400);
    }
    const responses: R[] = [];
    const apply = async () => {
      for (const entry of bundle.entry ?? []) {
        const method = entry.request?.method?.toUpperCase();
        const [type, id] = (entry.request?.url ?? "").split("?")[0]!.split("/");
        if (!type || !TYPE.test(type)) {
          if (bundle.type === "transaction") throw new Error(`invalid request url ${entry.request?.url}`);
          responses.push({ response: { status: "400 Bad Request" } });
          continue;
        }
        if (method === "PUT" && id && entry.resource) {
          const res = await writeOne(dest, type, id, entry.resource);
          if (res.status >= 400 && bundle.type === "transaction") throw new Error(`entry ${type}/${id} rejected`);
          responses.push({ response: { status: res.status === 201 ? "201 Created" : res.status === 200 ? "200 OK" : `${res.status}`, ...(res.versionId ? { etag: `W/"${res.versionId}"` } : {}) } });
        } else if (method === "POST" && entry.resource) {
          const res = await writeOne(dest, type, randomToken(12).replace(/_/g, "-"), entry.resource);
          responses.push({ response: { status: "201 Created", location: `${type}/${(res.body as R).id}` } });
        } else if (method === "DELETE" && id) {
          await deleteInternal(dest, type, id);
          responses.push({ response: { status: "204 No Content" } });
        } else {
          if (bundle.type === "transaction") throw new Error(`unsupported entry ${method} ${entry.request?.url}`);
          responses.push({ response: { status: "400 Bad Request" } });
        }
      }
    };
    // Transactions are all-or-nothing: validate every entry before writing any of them.
    if (bundle.type === "transaction") {
      for (const entry of bundle.entry ?? []) {
        const method = entry.request?.method?.toUpperCase();
        const [type, id] = (entry.request?.url ?? "").split("?")[0]!.split("/");
        const valid =
          !!type &&
          TYPE.test(type) &&
          ((method === "PUT" && !!id && FHIR_ID.test(id) && entry.resource?.resourceType === type) ||
            (method === "POST" && entry.resource?.resourceType === type) ||
            (method === "DELETE" && !!id));
        if (!valid) return c.json(outcome(400, "processing", `Invalid transaction entry ${method ?? "?"} ${entry.request?.url ?? "?"}`), 400);
      }
    }
    try {
      await apply();
    } catch (err) {
      return c.json(outcome(400, "processing", (err as Error).message), 400);
    }
    return c.json({ resourceType: "Bundle", type: `${bundle.type}-response`, entry: responses });
  });

  return r;
}
