import { readFile } from "node:fs/promises";
import type { Environment, SourceCategory, Surface } from "../db/schema.js";
import { fetchWithTimeout } from "../lib/http.js";
import { upsertSeedSource, type SeedSource } from "./seed.js";

/**
 * Directory importer for published endpoint lists. Accepted formats:
 *   - FHIR Bundle of Endpoint resources (e.g. Epic's open.epic.com/Endpoints/R4, Oracle Health and
 *     MEDITECH directories exported as FHIR)
 *   - SMART User-access Brands bundles (Organization + Endpoint, SMART App Launch 2.2)
 *   - a JSON array of { name, fhir_base_url, logo_url?, portal_url?, city?, state? }
 * Each endpoint becomes a catalog source of the given vendor and environment; re-importing updates
 * entries in place, matched on FHIR base URL.
 */

type FhirResource = { resourceType: string; id?: string; [k: string]: unknown };

export type ImportOptions = {
  vendor: string;
  environment: Environment;
  category?: SourceCategory;
  surfaces?: Surface[];
};

export async function loadDirectory(location: string): Promise<unknown> {
  if (/^https?:\/\//.test(location)) {
    const res = await fetchWithTimeout(location, { headers: { Accept: "application/fhir+json, application/json" }, timeoutMs: 60_000, redirect: "follow" });
    if (!res.ok) throw new Error(`directory download failed: HTTP ${res.status}`);
    return res.json();
  }
  return JSON.parse(await readFile(location, "utf8"));
}

export function parseDirectory(doc: unknown, opts: ImportOptions): SeedSource[] {
  const base = (s: Omit<SeedSource, "key" | "vendor" | "category" | "environment" | "surfaces">): SeedSource => ({
    key: `dir:${opts.vendor}:${s.fhirBaseUrl}`,
    vendor: opts.vendor,
    category: opts.category ?? "ehr",
    environment: opts.environment,
    surfaces: opts.surfaces ?? ["patient_access"],
    ...s,
  });

  if (Array.isArray(doc)) {
    return doc
      .filter((d): d is Record<string, string> => typeof d === "object" && d !== null && typeof (d as Record<string, unknown>).fhir_base_url === "string")
      .map((d) =>
        base({
          name: d.name ?? d.fhir_base_url!,
          fhirBaseUrl: d.fhir_base_url!,
          logoUrl: d.logo_url,
          portalUrl: d.portal_url,
          details: { city: d.city, state: d.state, imported: true },
        }),
      );
  }

  const bundle = doc as { resourceType?: string; entry?: { resource?: FhirResource }[] };
  if (bundle.resourceType !== "Bundle") throw new Error("Directory must be a FHIR Bundle or a JSON array");
  const resources = (bundle.entry ?? []).map((e) => e.resource).filter((r): r is FhirResource => !!r);
  const orgs = new Map(resources.filter((r) => r.resourceType === "Organization").map((o) => [o.id, o]));

  const out: SeedSource[] = [];
  for (const ep of resources.filter((r) => r.resourceType === "Endpoint")) {
    const address = typeof ep.address === "string" ? ep.address : null;
    if (!address || ep.status === "off") continue;
    // Brands bundles link Organization.endpoint -> Endpoint; Epic's bundle names the Endpoint itself.
    const org = [...orgs.values()].find((o) => ((o.endpoint as { reference?: string }[] | undefined) ?? []).some((r) => r.reference === `Endpoint/${ep.id}`));
    const name = (org?.name as string | undefined) ?? (ep.name as string | undefined) ?? address;
    const logo = (org?.extension as { url: string; valueUrl?: string }[] | undefined)?.find((x) => x.url.endsWith("brand-logo"))?.valueUrl;
    const portal = (org?.extension as { url: string; extension?: { url: string; valueUrl?: string }[] }[] | undefined)
      ?.find((x) => x.url.endsWith("patient-access"))
      ?.extension?.find((x) => x.url === "portalUrl")?.valueUrl;
    const addr = (org?.address as { city?: string; state?: string }[] | undefined)?.[0];
    const aliases = ((org?.alias as string[] | undefined) ?? []).slice(0, 10);
    out.push(
      base({
        name,
        fhirBaseUrl: address,
        logoUrl: logo,
        portalUrl: portal,
        details: { aliases, city: addr?.city, state: addr?.state, endpoint_id: ep.id, imported: true },
      }),
    );
  }
  return out;
}

export async function importDirectory(location: string, opts: ImportOptions) {
  const doc = await loadDirectory(location);
  const entries = parseDirectory(doc, opts);
  let n = 0;
  for (const e of entries) {
    await upsertSeedSource(e);
    n++;
  }
  return { imported: n };
}
