import { and, asc, eq, gt, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "../db/client.js";
import { sources, type Environment, type Surface } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { decodeCursor, encodeCursor, page } from "../lib/cursor.js";
import { serializeSource } from "./serializers.js";
import { isConnectable } from "./credentials.js";

type SourceRow = typeof sources.$inferSelect;

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function buildSearchText(s: { name: string; vendor: string; city?: string | null; state?: string | null; details?: Record<string, unknown> }) {
  const aliases = Array.isArray(s.details?.aliases) ? (s.details!.aliases as string[]).join(" ") : "";
  return [s.name, s.vendor, s.city, s.state, aliases].filter(Boolean).join(" ").toLowerCase();
}

/** Sources visible to a workspace: global entries of its environment plus its private sources. */
function visibleTo(workspaceId: string, environment: Environment): SQL {
  return and(
    eq(sources.active, true),
    or(and(isNull(sources.workspaceId), eq(sources.environment, environment)), eq(sources.workspaceId, workspaceId)),
  )!;
}

export async function searchSources(
  ws: { id: string; environment: Environment },
  opts: { q?: string; type?: string; surface?: Surface; limit: number; startingAfter?: string; includeConnectable?: boolean },
) {
  const filterKey = JSON.stringify({ q: opts.q ?? "", t: opts.type ?? "", s: opts.surface ?? "" });
  const conditions: SQL[] = [visibleTo(ws.id, ws.environment)];
  // Feed sources (HL7v2, external imports) are not patient-facing.
  conditions.push(sql`${sources.category} <> 'feed'`);
  if (opts.q) {
    for (const token of opts.q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)) {
      conditions.push(ilike(sources.searchText, `%${token.replace(/[%_\\]/g, (m) => `\\${m}`)}%`));
    }
  }
  if (opts.type) conditions.push(eq(sources.vendor, opts.type));
  if (opts.surface) conditions.push(sql`${sources.surfaces} @> ${JSON.stringify([opts.surface])}::jsonb`);
  if (opts.startingAfter) {
    const c = decodeCursor(opts.startingAfter, "sources", filterKey);
    const [name, id] = String(c.p).split("\u0000");
    conditions.push(or(gt(sources.name, name!), and(eq(sources.name, name!), gt(sources.id, id!)))!);
  }
  const rows = await db()
    .select()
    .from(sources)
    .where(and(...conditions))
    .orderBy(asc(sources.name), asc(sources.id))
    .limit(opts.limit + 1);
  const hasMore = rows.length > opts.limit;
  const items = rows.slice(0, opts.limit);
  const connectableByVendor = new Map<string, boolean>();
  if (opts.includeConnectable) {
    for (const vendor of new Set(items.map((s) => s.vendor))) {
      connectableByVendor.set(vendor, await isConnectable(ws.id, vendor, ws.environment));
    }
  }
  const data = items.map((s) => serializeSource(s, opts.includeConnectable ? { connectable: connectableByVendor.get(s.vendor) ?? false } : {}));
  const last = items[items.length - 1];
  return page(data, hasMore, last ? encodeCursor({ k: "sources", p: `${last.name}\u0000${last.id}`, f: filterKey }) : null);
}

/** Retrieve by `src_*` id or by FHIR base URL (both resolve to the same entry). */
export async function retrieveSource(ws: { id: string; environment: Environment }, idOrBase: string): Promise<SourceRow> {
  const key = idOrBase.startsWith("src_") ? eq(sources.id, idOrBase) : eq(sources.fhirBaseUrl, normalizeBaseUrl(idOrBase));
  const [row] = await db()
    .select()
    .from(sources)
    .where(and(key, visibleTo(ws.id, ws.environment)))
    .limit(1);
  if (!row) throw new ApiError("resource_not_found", "Source not found", { param: "id" });
  return row;
}

export async function sourcesByIds(ids: string[]) {
  if (ids.length === 0) return [];
  return db().select().from(sources).where(inArray(sources.id, ids));
}

export async function findSourceByIss(iss: string, environment?: Environment) {
  const base = normalizeBaseUrl(iss);
  const rows = await db()
    .select()
    .from(sources)
    .where(and(eq(sources.fhirBaseUrl, base), eq(sources.active, true)));
  return rows.find((r) => !environment || r.environment === environment) ?? rows[0] ?? null;
}
