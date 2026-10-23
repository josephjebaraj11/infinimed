import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { sources } from "../db/schema.js";
import { ApiError } from "../lib/errors.js";
import { fetchWithTimeout } from "../lib/http.js";

/**
 * SMART configuration discovery. Resolution order:
 *   1. endpoints pinned on the catalog row (vendors with non-standard layouts, e.g. Aetna)
 *   2. `{base}/.well-known/smart-configuration` (SMART App Launch 2.x)
 *   3. CapabilityStatement `rest.security.extension[oauth-uris]` (SMART 1.0 fallback)
 * Results are cached on the source row for 24 hours.
 */

export type SmartEndpoints = {
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string | null;
  userinfoUrl: string | null;
  jwksUri: string | null;
  scopesSupported?: string[];
};

type SourceRow = typeof sources.$inferSelect;

const CACHE_MS = 24 * 60 * 60 * 1000;

export async function resolveEndpoints(source: SourceRow, opts: { force?: boolean } = {}): Promise<SmartEndpoints> {
  const fresh = source.discoveryFetchedAt && Date.now() - source.discoveryFetchedAt.getTime() < CACHE_MS;
  if (source.authorizeUrl && source.tokenUrl && (fresh || source.details?.pinned_endpoints) && !opts.force) {
    return {
      authorizeUrl: source.authorizeUrl,
      tokenUrl: source.tokenUrl,
      revokeUrl: source.revokeUrl,
      userinfoUrl: source.userinfoUrl,
      jwksUri: source.jwksUri,
    };
  }
  if (!source.fhirBaseUrl) throw new ApiError("config_missing", `Source ${source.id} has no FHIR base URL`);
  const discovered = await discover(source.fhirBaseUrl);
  await db()
    .update(sources)
    .set({
      authorizeUrl: discovered.authorizeUrl,
      tokenUrl: discovered.tokenUrl,
      revokeUrl: discovered.revokeUrl,
      userinfoUrl: discovered.userinfoUrl,
      jwksUri: discovered.jwksUri,
      discoveryFetchedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(sources.id, source.id));
  return discovered;
}

export async function discover(fhirBaseUrl: string): Promise<SmartEndpoints> {
  const base = fhirBaseUrl.replace(/\/+$/, "");
  try {
    const res = await fetchWithTimeout(`${base}/.well-known/smart-configuration`, {
      headers: { Accept: "application/json" },
      timeoutMs: 10_000,
      redirect: "follow",
    });
    if (res.ok) {
      const json = (await res.json()) as Record<string, unknown>;
      if (typeof json.authorization_endpoint === "string" && typeof json.token_endpoint === "string") {
        return {
          authorizeUrl: json.authorization_endpoint,
          tokenUrl: json.token_endpoint,
          revokeUrl: typeof json.revocation_endpoint === "string" ? json.revocation_endpoint : null,
          userinfoUrl: typeof json.userinfo_endpoint === "string" ? json.userinfo_endpoint : null,
          jwksUri: typeof json.jwks_uri === "string" ? json.jwks_uri : null,
          scopesSupported: Array.isArray(json.scopes_supported) ? (json.scopes_supported as string[]) : undefined,
        };
      }
    }
  } catch {
    // fall through to CapabilityStatement
  }
  const res = await fetchWithTimeout(`${base}/metadata`, {
    headers: { Accept: "application/fhir+json" },
    timeoutMs: 15_000,
    redirect: "follow",
  }).catch((err: unknown) => {
    throw new ApiError("upstream_unavailable", `SMART discovery failed: ${(err as Error).message}`);
  });
  if (!res.ok) throw new ApiError("upstream_unavailable", `SMART discovery failed with HTTP ${res.status}`);
  const cap = (await res.json()) as {
    rest?: { security?: { extension?: { url: string; extension?: { url: string; valueUri?: string }[] }[] } }[];
  };
  const ext = cap.rest?.[0]?.security?.extension?.find((e) => e.url.endsWith("oauth-uris"));
  const uri = (name: string) => ext?.extension?.find((e) => e.url === name)?.valueUri ?? null;
  const authorizeUrl = uri("authorize");
  const tokenUrl = uri("token");
  if (!authorizeUrl || !tokenUrl) throw new ApiError("upstream_unavailable", "Source does not advertise SMART OAuth endpoints");
  return { authorizeUrl, tokenUrl, revokeUrl: uri("revoke"), userinfoUrl: null, jwksUri: null };
}
