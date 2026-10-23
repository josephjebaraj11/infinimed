import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { internalFhirResources } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { assertSafeOutboundUrl, fetchWithTimeout, readTextSafe } from "../lib/http.js";

/**
 * FHIR R4 destinations. Custom servers receive transaction Bundles of PUT (update-as-create)
 * entries; when a Bundle is rejected the batch falls back to per-resource PUTs so one bad resource
 * cannot block the rest. The InfiniMed-hosted ("internal") server is written directly to storage.
 */

export type FhirAuth =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "client_credentials"; token_url: string; client_id: string; client_secret: string; scope?: string };

export type WriteResult = { ok: number; failed: { resourceType: string; id: string; error: string }[] };

export interface FhirWriter {
  write(resources: Record<string, unknown>[]): Promise<WriteResult>;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function bearerFor(auth: FhirAuth): Promise<string | null> {
  if (auth.type === "none") return null;
  if (auth.type === "bearer") return auth.token;
  const key = `${auth.token_url}|${auth.client_id}|${auth.scope ?? ""}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
  await assertSafeOutboundUrl(auth.token_url, { param: "token_url" });
  const body = new URLSearchParams({ grant_type: "client_credentials" });
  if (auth.scope) body.set("scope", auth.scope);
  const res = await fetchWithTimeout(auth.token_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${encodeURIComponent(auth.client_id)}:${encodeURIComponent(auth.client_secret)}`).toString("base64")}`,
    },
    body: body.toString(),
    timeoutMs: 15_000,
  });
  if (!res.ok) throw new Error(`destination token request failed: HTTP ${res.status} ${await readTextSafe(res, 200)}`);
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("destination token response had no access_token");
  tokenCache.set(key, { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 300) * 1000 });
  return json.access_token;
}

export class CustomFhirWriter implements FhirWriter {
  private readonly base: string;
  constructor(
    base: string,
    private readonly auth: FhirAuth,
  ) {
    this.base = base.replace(/\/+$/, "");
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await bearerFor(this.auth);
    return {
      "Content-Type": "application/fhir+json",
      Accept: "application/fhir+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async testConnection() {
    await assertSafeOutboundUrl(this.base, { param: "base_url" });
    let res: Response;
    try {
      res = await fetchWithTimeout(`${this.base}/metadata`, { headers: await this.headers(), timeoutMs: 15_000 });
    } catch (err) {
      throw new ApiError("destination_test_failed", `Could not reach the FHIR server: ${(err as Error).message}. Check the URL and network allowlist.`);
    }
    const text = await readTextSafe(res, 512 * 1024);
    if (!res.ok) throw new ApiError("destination_test_failed", `FHIR server returned HTTP ${res.status} for /metadata`);
    try {
      const json = JSON.parse(text) as { resourceType?: string; fhirVersion?: string };
      if (json.resourceType !== "CapabilityStatement") throw new Error("not a CapabilityStatement");
      if (json.fhirVersion && !json.fhirVersion.startsWith("4.")) {
        throw new ApiError("destination_test_failed", `Destination reports FHIR ${json.fhirVersion}; an R4 (4.0.x) server is required`);
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError("destination_test_failed", "Destination /metadata did not return a FHIR CapabilityStatement");
    }
  }

  private async putOne(resource: Record<string, unknown>): Promise<string | null> {
    const url = `${this.base}/${resource.resourceType}/${encodeURIComponent(String(resource.id))}`;
    try {
      const res = await fetchWithTimeout(url, { method: "PUT", headers: await this.headers(), body: JSON.stringify(resource), timeoutMs: 30_000 });
      if (res.ok) {
        await readTextSafe(res, 256);
        return null;
      }
      return `HTTP ${res.status}: ${(await readTextSafe(res, 500)).replace(/\s+/g, " ")}`;
    } catch (err) {
      return (err as Error).message;
    }
  }

  async write(resources: Record<string, unknown>[]): Promise<WriteResult> {
    await assertSafeOutboundUrl(this.base, { param: "base_url" });
    const result: WriteResult = { ok: 0, failed: [] };
    for (let i = 0; i < resources.length; i += 100) {
      const chunk = resources.slice(i, i + 100);
      const bundle = {
        resourceType: "Bundle",
        type: "transaction",
        entry: chunk.map((r) => ({
          fullUrl: `${this.base}/${r.resourceType}/${r.id}`,
          resource: r,
          request: { method: "PUT", url: `${r.resourceType}/${r.id}` },
        })),
      };
      let bundleOk = false;
      try {
        const res = await fetchWithTimeout(this.base, { method: "POST", headers: await this.headers(), body: JSON.stringify(bundle), timeoutMs: 120_000 });
        bundleOk = res.ok;
        await readTextSafe(res, 1024);
        if (res.status === 401 || res.status === 403) {
          throw new Error(`destination rejected credentials (HTTP ${res.status})`);
        }
      } catch (err) {
        if ((err as Error).message.startsWith("destination rejected")) throw err;
      }
      if (bundleOk) {
        result.ok += chunk.length;
        continue;
      }
      for (const r of chunk) {
        const error = await this.putOne(r);
        if (error) result.failed.push({ resourceType: String(r.resourceType), id: String(r.id), error });
        else result.ok++;
      }
      // Every single PUT failed: the destination is down, not the data. Stop the run.
      if (result.ok === 0 && result.failed.length >= chunk.length) {
        throw new Error(`destination unreachable: ${result.failed[0]?.error ?? "unknown error"}`);
      }
    }
    return result;
  }
}

/** Fields indexed for search on the hosted server. */
export function patientRefOf(resource: Record<string, unknown>): string | null {
  if (resource.resourceType === "Patient") return String(resource.id);
  for (const key of ["subject", "patient", "beneficiary"]) {
    const ref = (resource[key] as { reference?: string } | undefined)?.reference;
    if (typeof ref === "string") {
      const m = /(?:^|\/)Patient\/([^/]+)$/.exec(ref);
      if (m) return m[1]!;
    }
  }
  return null;
}

export function identifierTokens(resource: Record<string, unknown>): string[] {
  const ids = (resource.identifier as { system?: string; value?: string }[] | undefined) ?? [];
  return ids.filter((i) => i.value).flatMap((i) => [`${i.system ?? ""}|${i.value}`, `|${i.value}`]);
}

export class InternalFhirWriter implements FhirWriter {
  constructor(private readonly destinationId: string) {}

  async write(resources: Record<string, unknown>[]): Promise<WriteResult> {
    for (const r of resources) {
      await upsertInternal(this.destinationId, r);
    }
    return { ok: resources.length, failed: [] };
  }
}

export async function upsertInternal(destinationId: string, r: Record<string, unknown>) {
  const resourceType = String(r.resourceType);
  const resourceId = String(r.id);
  const [existing] = await db()
    .select({ versionId: internalFhirResources.versionId })
    .from(internalFhirResources)
    .where(
      and(eq(internalFhirResources.destinationId, destinationId), eq(internalFhirResources.resourceType, resourceType), eq(internalFhirResources.resourceId, resourceId)),
    )
    .limit(1);
  const versionId = (existing?.versionId ?? 0) + 1;
  const lastUpdated = new Date();
  const stored = { ...r, meta: { ...((r.meta as object) ?? {}), versionId: String(versionId), lastUpdated: lastUpdated.toISOString() } };
  await db()
    .insert(internalFhirResources)
    .values({ destinationId, resourceType, resourceId, versionId, patientRef: patientRefOf(r), identifiers: identifierTokens(r), resource: stored, lastUpdated })
    .onConflictDoUpdate({
      target: [internalFhirResources.destinationId, internalFhirResources.resourceType, internalFhirResources.resourceId],
      set: { versionId, patientRef: patientRefOf(r), identifiers: identifierTokens(r), resource: stored, lastUpdated },
    });
  return { versionId, lastUpdated, created: !existing, resource: stored };
}

export async function deleteInternal(destinationId: string, resourceType: string, resourceId: string) {
  await db()
    .delete(internalFhirResources)
    .where(
      and(eq(internalFhirResources.destinationId, destinationId), eq(internalFhirResources.resourceType, resourceType), eq(internalFhirResources.resourceId, resourceId)),
    );
}

export async function internalResourceCount(destinationId: string) {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(internalFhirResources)
    .where(eq(internalFhirResources.destinationId, destinationId));
  return Number(row?.n ?? 0);
}
