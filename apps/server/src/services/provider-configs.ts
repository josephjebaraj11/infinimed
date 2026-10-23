import { and, eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { providerConfigs, workspaces, type ProviderSettings, type Surface, type TokenAuthMethod } from "../db/schema.js";
import { seal } from "../lib/crypto.js";
import { ApiError } from "../lib/errors.js";
import { assertSafeOutboundUrl, isLocalhostUrl } from "../lib/http.js";
import { newId } from "../lib/ids.js";
import { PROFILES, profileFor } from "../smart/profiles.js";
import { requireFeature, type Feature } from "./billing.js";
import { managedEntry } from "./credentials.js";
import { cdsDiscoveryUrlFor, launchUrlFor } from "./ehr-launch.js";

/**
 * Settings, Connections: one tile per (vendor, surface). Each tile shows whether the workspace uses
 * InfiniMed-managed credentials or its own app registration, and the values to copy into the
 * vendor's developer portal (redirect URI, JWKS URI, launch URL, CDS Hooks discovery URL).
 */

type WorkspaceRow = typeof workspaces.$inferSelect;

const SURFACE_FEATURE: Record<Surface, Feature> = {
  patient_access: "patient_access",
  clinical_workflow: "clinical_workflow",
  backend: "backend",
  network: "network",
};

const NETWORK_TILES = [
  { vendor: "commonwell", display_name: "CommonWell Health Alliance" },
  { vendor: "carequality", display_name: "Carequality" },
  { vendor: "tefca", display_name: "TEFCA (via a QHIN)" },
];

function urlsFor(ws: WorkspaceRow, surface: Surface) {
  const cfg = config();
  const base = { jwks_uri: cfg.jwksUrl };
  if (surface === "patient_access") return { ...base, redirect_uri: cfg.oauthCallbackUrl };
  if (surface === "clinical_workflow") return { ...base, redirect_uri: cfg.ehrLaunchCallbackUrl, launch_url: launchUrlFor(ws.id), cds_hooks_url: cdsDiscoveryUrlFor(ws.id) };
  return base;
}

export async function listTiles(ws: WorkspaceRow) {
  const rows = await db().select().from(providerConfigs).where(eq(providerConfigs.workspaceId, ws.id));
  const tiles = [];
  for (const profile of Object.values(PROFILES)) {
    for (const surface of Object.keys(profile.scopes) as Surface[]) {
      const row = rows.find((r) => r.vendor === profile.vendor && r.surface === surface);
      tiles.push(tile(ws, profile.vendor, surface, row));
    }
  }
  for (const n of NETWORK_TILES) {
    tiles.push({
      vendor: n.vendor,
      display_name: n.display_name,
      surface: "network" as Surface,
      category: "network",
      configurable: false,
      setup: "managed",
      enabled: false,
      credential_mode: "managed",
      managed_available: false,
      note: "Network access is set up with InfiniMed: share your use case, permitted purpose, requesting organization and patient identifiers.",
    });
  }
  return tiles;
}

function tile(ws: WorkspaceRow, vendor: string, surface: Surface, row: typeof providerConfigs.$inferSelect | undefined) {
  const profile = profileFor(vendor);
  const managed = managedEntry(vendor, ws.environment, surface);
  const mode = row?.credentialMode ?? "managed";
  const method: TokenAuthMethod = row?.settings.token_auth_method ?? (mode === "managed" ? managed?.token_auth_method : undefined) ?? profile.defaultTokenAuthMethod;
  return {
    vendor,
    display_name: profile.displayName,
    surface,
    category: profile.category,
    configurable: true,
    enabled: row?.enabled ?? true,
    credential_mode: mode,
    managed_available: !!managed,
    status: mode === "custom" ? (row?.clientId ? "custom" : "incomplete") : managed ? "managed" : "not_configured",
    client_id: mode === "custom" ? row?.clientId ?? null : managed?.client_id ?? null,
    has_client_secret: mode === "custom" ? !!row?.clientSecretEnc : !!managed?.client_secret,
    token_auth_method: method,
    requires_client_secret: method === "client_secret_basic" || method === "client_secret_post",
    scopes: row?.settings.scopes ?? (mode === "managed" ? managed?.scopes : undefined) ?? profile.scopes[surface] ?? [],
    settings: {
      app_launch_url: row?.settings.app_launch_url ?? null,
      cds_endpoint: row?.settings.cds_endpoint ?? null,
      cds_caching_seconds: row?.settings.cds_caching_seconds ?? 0,
      cds_trusted_issuers: row?.settings.cds_trusted_issuers ?? [],
      organizations: row?.settings.organizations ?? [],
      backend_schedule_hour_utc: row?.settings.backend_schedule_hour_utc ?? 2,
    },
    urls: urlsFor(ws, surface),
    notes: profile.notes ?? null,
  };
}

export async function getTile(ws: WorkspaceRow, vendor: string, surface: Surface) {
  if (!PROFILES[vendor] || !PROFILES[vendor]!.scopes[surface]) throw new ApiError("resource_not_found", "Unknown connection");
  const [row] = await db()
    .select()
    .from(providerConfigs)
    .where(and(eq(providerConfigs.workspaceId, ws.id), eq(providerConfigs.vendor, vendor), eq(providerConfigs.surface, surface)))
    .limit(1);
  return tile(ws, vendor, surface, row);
}

async function validateAppUrl(raw: unknown, ws: WorkspaceRow, param: string): Promise<string | undefined> {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") throw new ApiError("invalid_data", `${param} must be a URL`, { param });
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ApiError("invalid_data", `${param} must be a URL`, { param });
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (isLocalhostUrl(u) || ws.environment === "sandbox"))) {
    throw new ApiError("invalid_data", `${param} must use https`, { param });
  }
  return u.toString();
}

export async function updateTile(ws: WorkspaceRow, vendor: string, surface: Surface, input: Record<string, unknown>) {
  const profile = PROFILES[vendor];
  if (!profile || !profile.scopes[surface]) throw new ApiError("resource_not_found", "Unknown connection");
  requireFeature(ws, SURFACE_FEATURE[surface]);
  const [existing] = await db()
    .select()
    .from(providerConfigs)
    .where(and(eq(providerConfigs.workspaceId, ws.id), eq(providerConfigs.vendor, vendor), eq(providerConfigs.surface, surface)))
    .limit(1);
  const settings: ProviderSettings = { ...(existing?.settings ?? {}) };
  const patch: Partial<typeof providerConfigs.$inferInsert> = { updatedAt: new Date() };

  if (input.enabled !== undefined) patch.enabled = Boolean(input.enabled);
  if (input.credential_mode !== undefined) {
    if (input.credential_mode !== "managed" && input.credential_mode !== "custom") throw new ApiError("invalid_data", "credential_mode must be managed or custom", { param: "credential_mode" });
    if (input.credential_mode === "custom") requireFeature(ws, "custom_credentials");
    patch.credentialMode = input.credential_mode;
  }
  if (input.client_id !== undefined) {
    if (input.client_id !== null && (typeof input.client_id !== "string" || input.client_id.length > 300)) throw new ApiError("invalid_data", "client_id must be a string", { param: "client_id" });
    patch.clientId = (input.client_id as string | null)?.trim() || null;
  }
  const id = existing?.id ?? newId("providerConfig");
  if (input.client_secret !== undefined) {
    if (input.client_secret !== null && typeof input.client_secret !== "string") throw new ApiError("invalid_data", "client_secret must be a string", { param: "client_secret" });
    patch.clientSecretEnc = input.client_secret ? seal(input.client_secret as string, `provider:${id}`) : null;
  }
  if (input.token_auth_method !== undefined) {
    if (input.token_auth_method === null) delete settings.token_auth_method;
    else if (["private_key_jwt", "client_secret_basic", "client_secret_post", "none"].includes(String(input.token_auth_method))) settings.token_auth_method = input.token_auth_method as TokenAuthMethod;
    else throw new ApiError("invalid_data", "Invalid token_auth_method", { param: "token_auth_method" });
  }
  if (input.scopes !== undefined) {
    if (input.scopes === null) delete settings.scopes;
    else if (Array.isArray(input.scopes) && input.scopes.every((s) => typeof s === "string" && /^[\w/.*:-]+$/.test(s))) settings.scopes = input.scopes as string[];
    else throw new ApiError("invalid_data", "scopes must be an array of scope strings", { param: "scopes" });
  }
  const s = (input.settings ?? {}) as Record<string, unknown>;
  if (surface === "clinical_workflow") {
    if ("app_launch_url" in s) settings.app_launch_url = await validateAppUrl(s.app_launch_url, ws, "app_launch_url");
    if ("cds_endpoint" in s) {
      if (s.cds_endpoint) await assertSafeOutboundUrl(String(s.cds_endpoint), { param: "cds_endpoint", allowHttpLocalhost: ws.environment === "sandbox" && !config().isProduction });
      settings.cds_endpoint = s.cds_endpoint ? String(s.cds_endpoint) : undefined;
    }
    if ("cds_caching_seconds" in s) {
      const n = Number(s.cds_caching_seconds);
      if (!Number.isInteger(n) || n < 0 || n > 3600) throw new ApiError("invalid_data", "cds_caching_seconds must be 0-3600", { param: "cds_caching_seconds" });
      settings.cds_caching_seconds = n;
    }
    if ("cds_trusted_issuers" in s) {
      const list = s.cds_trusted_issuers;
      if (!Array.isArray(list) || list.some((x) => typeof (x as { iss?: unknown })?.iss !== "string")) throw new ApiError("invalid_data", "cds_trusted_issuers must be [{ iss, jku? }]", { param: "cds_trusted_issuers" });
      settings.cds_trusted_issuers = list as { iss: string; jku?: string }[];
    }
  }
  if (surface === "backend") {
    if ("organizations" in s) {
      const orgs = s.organizations;
      if (!Array.isArray(orgs) || orgs.some((o) => typeof (o as { source_id?: unknown }).source_id !== "string" || !Array.isArray((o as { group_ids?: unknown }).group_ids))) {
        throw new ApiError("invalid_data", "organizations must be [{ source_id, group_ids: [] }]", { param: "organizations" });
      }
      settings.organizations = (orgs as { source_id: string; group_ids: string[] }[]).map((o) => ({ source_id: o.source_id, group_ids: o.group_ids.map(String).filter((g) => /^[A-Za-z0-9\-.]{1,64}$/.test(g)) }));
    }
    if ("backend_schedule_hour_utc" in s) {
      const h = Number(s.backend_schedule_hour_utc);
      if (!Number.isInteger(h) || h < 0 || h > 23) throw new ApiError("invalid_data", "backend_schedule_hour_utc must be 0-23", { param: "backend_schedule_hour_utc" });
      settings.backend_schedule_hour_utc = h;
    }
    if ("backend_resource_types" in s) settings.backend_resource_types = Array.isArray(s.backend_resource_types) ? (s.backend_resource_types as string[]).filter((t) => /^[A-Z][A-Za-z]+$/.test(t)) : undefined;
  }
  patch.settings = settings;

  if (existing) {
    await db().update(providerConfigs).set(patch).where(eq(providerConfigs.id, existing.id));
  } else {
    await db()
      .insert(providerConfigs)
      .values({ id, workspaceId: ws.id, vendor, surface, ...patch });
  }
  return getTile(ws, vendor, surface);
}
