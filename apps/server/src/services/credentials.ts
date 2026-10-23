import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { providerConfigs, type Environment, type ProviderSettings, type Surface, type TokenAuthMethod } from "../db/schema.js";
import { unsealOptional } from "../lib/crypto.js";
import { ApiError } from "../lib/errors.js";
import { profileFor } from "../smart/profiles.js";

/**
 * Resolves which OAuth client identity to use for (workspace, vendor, surface, environment).
 *
 * "managed" credentials are InfiniMed's own app registrations, configured by the platform operator
 * (MANAGED_CREDENTIALS_JSON / MANAGED_CREDENTIALS_FILE). "custom" credentials belong to the
 * customer's own app registration and are stored sealed per workspace. Customers switch per vendor
 * and surface in the dashboard (Settings, Connections).
 */

export type ClientCredentials = {
  mode: "managed" | "custom";
  clientId: string;
  clientSecret: string | null;
  tokenAuthMethod: TokenAuthMethod;
  scopes: string[];
  settings: ProviderSettings;
  enabled: boolean;
};

type ManagedEntry = {
  client_id: string;
  client_secret?: string;
  token_auth_method?: TokenAuthMethod;
  scopes?: string[];
  surfaces?: Partial<Record<Surface, Omit<ManagedEntry, "surfaces">>>;
};
type ManagedFile = Record<string, Partial<Record<Environment, ManagedEntry>>>;

/** Built-in managed registrations for the sandboxes that need no vendor approval. */
const BUILT_IN: ManagedFile = {
  synthetic: {
    sandbox: {
      client_id: "infinimed-synthetic",
      token_auth_method: "private_key_jwt",
      surfaces: {
        clinical_workflow: { client_id: "infinimed-synthetic-provider", token_auth_method: "private_key_jwt" },
        backend: { client_id: "infinimed-synthetic-system", token_auth_method: "private_key_jwt" },
      },
    },
  },
  smart_sandbox: {
    sandbox: { client_id: "infinimed-platform", token_auth_method: "none" },
  },
};

let managed: ManagedFile | undefined;

export function managedCredentials(): ManagedFile {
  if (managed) return managed;
  const cfg = config();
  let fromConfig: ManagedFile = {};
  if (cfg.managedCredentialsJson) fromConfig = JSON.parse(cfg.managedCredentialsJson) as ManagedFile;
  else if (cfg.managedCredentialsFile) fromConfig = JSON.parse(readFileSync(cfg.managedCredentialsFile, "utf8")) as ManagedFile;
  managed = { ...BUILT_IN };
  for (const [vendor, envs] of Object.entries(fromConfig)) managed[vendor] = { ...(managed[vendor] ?? {}), ...envs };
  return managed;
}

export function resetManagedCredentials() {
  managed = undefined;
}

export function managedEntry(vendor: string, environment: Environment, surface: Surface) {
  const entry = managedCredentials()[vendor]?.[environment];
  if (!entry) return null;
  const surfaceOverride = entry.surfaces?.[surface];
  return { ...entry, ...(surfaceOverride ?? {}) };
}

export async function getProviderConfig(workspaceId: string, vendor: string, surface: Surface) {
  const [row] = await db()
    .select()
    .from(providerConfigs)
    .where(and(eq(providerConfigs.workspaceId, workspaceId), eq(providerConfigs.vendor, vendor), eq(providerConfigs.surface, surface)))
    .limit(1);
  return row ?? null;
}

export async function resolveCredentials(
  workspaceId: string,
  vendor: string,
  surface: Surface,
  environment: Environment,
): Promise<ClientCredentials> {
  const profile = profileFor(vendor);
  const row = await getProviderConfig(workspaceId, vendor, surface);
  const settings = row?.settings ?? {};
  const enabled = row?.enabled ?? true;
  const scopes = settings.scopes ?? profile.scopes[surface] ?? profile.scopes.patient_access ?? [];

  if (row?.credentialMode === "custom") {
    if (!row.clientId) {
      throw new ApiError("config_missing", `Custom ${profile.displayName} credentials have no client ID`, { param: "client_id" });
    }
    return {
      mode: "custom",
      clientId: row.clientId,
      clientSecret: unsealOptional(row.clientSecretEnc, `provider:${row.id}`),
      tokenAuthMethod: settings.token_auth_method ?? profile.defaultTokenAuthMethod,
      scopes,
      settings,
      enabled,
    };
  }
  const entry = managedEntry(vendor, environment, surface);
  if (!entry) {
    throw new ApiError(
      "config_missing",
      `${profile.displayName} has no InfiniMed-managed ${environment} credentials. Add your own client ID under Settings, Connections.`,
    );
  }
  return {
    mode: "managed",
    clientId: entry.client_id,
    clientSecret: entry.client_secret ?? null,
    tokenAuthMethod: settings.token_auth_method ?? entry.token_auth_method ?? profile.defaultTokenAuthMethod,
    scopes: settings.scopes ?? entry.scopes ?? scopes,
    settings,
    enabled,
  };
}

/** True when a connect flow for this vendor could start (credentials exist and the tile is enabled). */
export async function isConnectable(workspaceId: string, vendor: string, environment: Environment): Promise<boolean> {
  try {
    const creds = await resolveCredentials(workspaceId, vendor, "patient_access", environment);
    return creds.enabled;
  } catch {
    return false;
  }
}
