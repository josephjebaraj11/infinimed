import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";

/**
 * Central runtime configuration. Everything that varies between environments is read here once,
 * validated, and exported as a frozen object. Development conveniences (generated master key,
 * embedded database) are refused when NODE_ENV=production.
 */

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default("0.0.0.0"),
  PUBLIC_URL: z.string().url().default("http://localhost:4000"),
  DASHBOARD_URL: z.string().url().default("http://localhost:5173"),
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().optional(),
  DATA_DIR: z.string().default(".data"),
  MASTER_KEY: z.string().optional(),
  SIGNING_KEYS_DIR: z.string().optional(),
  SIGNING_KEYS_JSON: z.string().optional(),
  MANAGED_CREDENTIALS_FILE: z.string().optional(),
  MANAGED_CREDENTIALS_JSON: z.string().optional(),
  WORKER_INLINE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  ALLOW_PRIVATE_NETWORK_EGRESS: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  SEED_CATALOG: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  RECORD_PULL_INTERVAL_HOURS: z.coerce.number().positive().default(24),
});

export type AppConfig = ReturnType<typeof buildConfig>;

export function buildConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env);
  const isProduction = parsed.NODE_ENV === "production";
  const dataDir = path.resolve(parsed.DATA_DIR);

  if (isProduction && !parsed.DATABASE_URL) {
    throw new Error("DATABASE_URL is required in production (embedded PGlite is for development only)");
  }
  if (isProduction && !parsed.MASTER_KEY) {
    throw new Error("MASTER_KEY is required in production (base64-encoded 32 bytes)");
  }
  if (isProduction && !parsed.PUBLIC_URL.startsWith("https://")) {
    throw new Error("PUBLIC_URL must be https in production");
  }

  const masterKey = parsed.MASTER_KEY ?? devSecret(dataDir, "master.key", parsed.NODE_ENV);
  const masterKeyBytes = Buffer.from(masterKey, "base64");
  if (masterKeyBytes.length !== 32) {
    throw new Error("MASTER_KEY must decode to exactly 32 bytes");
  }

  const publicUrl = parsed.PUBLIC_URL.replace(/\/+$/, "");

  return Object.freeze({
    env: parsed.NODE_ENV,
    isProduction,
    isTest: parsed.NODE_ENV === "test",
    port: parsed.PORT,
    host: parsed.HOST,
    publicUrl,
    dashboardUrl: parsed.DASHBOARD_URL.replace(/\/+$/, ""),
    databaseUrl: parsed.DATABASE_URL,
    pgliteDir: parsed.PGLITE_DIR ?? path.join(dataDir, "pglite"),
    dataDir,
    masterKey: masterKeyBytes,
    signingKeysDir: parsed.SIGNING_KEYS_DIR ?? path.join(dataDir, "keys"),
    signingKeysJson: parsed.SIGNING_KEYS_JSON,
    managedCredentialsFile: parsed.MANAGED_CREDENTIALS_FILE,
    managedCredentialsJson: parsed.MANAGED_CREDENTIALS_JSON,
    workerInline: parsed.WORKER_INLINE,
    workerConcurrency: parsed.WORKER_CONCURRENCY,
    // Outbound requests to customer-supplied URLs (webhooks, exports, CDS) must not reach private
    // networks in production. Development allows it so localhost receivers work.
    allowPrivateEgress: parsed.ALLOW_PRIVATE_NETWORK_EGRESS ?? !isProduction,
    logLevel: parsed.LOG_LEVEL,
    seedCatalog: parsed.SEED_CATALOG,
    recordPullIntervalHours: parsed.RECORD_PULL_INTERVAL_HOURS,
    apiVersion: "2026-10-01",
    supportedApiVersions: ["2026-10-01"],
    oauthCallbackUrl: `${publicUrl}/oauth/callback`,
    ehrLaunchCallbackUrl: `${publicUrl}/smart/launch-callback`,
    jwksUrl: `${publicUrl}/.well-known/jwks.json`,
    mcpResourceUrl: `${publicUrl}/mcp`,
  });
}

/** Generates (once) and persists a development-only secret so restarts keep decrypting old data. */
function devSecret(dataDir: string, file: string, env: string): string {
  if (env === "test") return randomBytes(32).toString("base64");
  mkdirSync(dataDir, { recursive: true });
  const full = path.join(dataDir, file);
  if (existsSync(full)) return readFileSync(full, "utf8").trim();
  const value = randomBytes(32).toString("base64");
  writeFileSync(full, value, { mode: 0o600 });
  console.warn(`[config] generated development secret at ${full}. Set MASTER_KEY in production.`);
  return value;
}

let current: AppConfig | undefined;

export function config(): AppConfig {
  if (!current) current = buildConfig();
  return current;
}

/** Tests and embedded runners can install a specific configuration. */
export function setConfig(next: AppConfig) {
  current = next;
}
