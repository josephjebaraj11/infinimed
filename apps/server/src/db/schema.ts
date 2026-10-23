import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * InfiniMed relational model.
 *
 * Tenancy: every customer-owned row carries `workspace_id`. A workspace is either sandbox or
 * production and that environment also scopes which catalog sources it may reach.
 *
 * Secrets: columns ending in `_enc` hold AES-GCM envelopes produced by lib/crypto.seal().
 */

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();

export type Environment = "sandbox" | "production";
export type Plan = "free" | "enterprise";
export type Role = "owner" | "admin" | "member";

// ---------------------------------------------------------------------------------------------
// Workspaces, users, access
// ---------------------------------------------------------------------------------------------

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  environment: text("environment").$type<Environment>().notNull(),
  plan: text("plan").$type<Plan>().notNull().default("free"),
  /** per-workspace feature overrides on top of the plan, e.g. { backend: true } */
  featureOverrides: jsonb("feature_overrides").$type<Record<string, boolean>>().notNull().default({}),
  /** Optional cap overriding the plan's active patient quota. */
  patientQuotaOverride: integer("patient_quota_override"),
  branding: jsonb("branding")
    .$type<{ display_name?: string; primary_color?: string; logo_url?: string; support_email?: string }>()
    .notNull()
    .default({}),
  /** When true the workspace may only hold its owner's own records (consumer/MCP personal workspaces). */
  personal: boolean("personal").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash"),
  createdAt: createdAt(),
  lastLoginAt: ts("last_login_at"),
});

export const memberships = pgTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    role: text("role").$type<Role>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("memberships_user_ws").on(t.userId, t.workspaceId)],
);

export const invitations = pgTable("invitations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").$type<Role>().notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  invitedByUserId: text("invited_by_user_id"),
  expiresAt: ts("expires_at").notNull(),
  acceptedAt: ts("accepted_at"),
  createdAt: createdAt(),
});

export const userSessions = pgTable("user_sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  activeWorkspaceId: text("active_workspace_id"),
  expiresAt: ts("expires_at").notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: createdAt(),
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenPrefix: text("token_prefix").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    last4: text("last4").notNull(),
    /** Scopes stamped on the key. ["*"] means full API access. */
    scopes: jsonb("scopes").$type<string[]>().notNull().default(["*"]),
    createdByUserId: text("created_by_user_id"),
    createdAt: createdAt(),
    lastUsedAt: ts("last_used_at"),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [index("api_keys_ws").on(t.workspaceId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    actorType: text("actor_type").$type<"user" | "api_key" | "mcp" | "system">().notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    requestId: text("request_id"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_ws_created").on(t.workspaceId, t.createdAt)],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    workspaceId: text("workspace_id").notNull(),
    key: text("key").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    requestHash: text("request_hash").notNull(),
    statusCode: integer("status_code").notNull(),
    responseBody: text("response_body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);

// ---------------------------------------------------------------------------------------------
// Catalog: sources and per-workspace provider configuration
// ---------------------------------------------------------------------------------------------

export type Surface = "patient_access" | "clinical_workflow" | "backend" | "network";
export type SourceCategory = "ehr" | "payer" | "network" | "sandbox" | "feed";

export const sources = pgTable(
  "sources",
  {
    id: text("id").primaryKey(),
    /** null = global catalog entry; set = a workspace-private source (HL7v2 feed, external import) */
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    vendor: text("vendor").notNull(),
    category: text("category").$type<SourceCategory>().notNull(),
    environment: text("environment").$type<Environment>().notNull(),
    fhirBaseUrl: text("fhir_base_url"),
    /** OAuth `aud` when it differs from the FHIR base (Aetna). */
    audience: text("audience"),
    authorizeUrl: text("authorize_url"),
    tokenUrl: text("token_url"),
    revokeUrl: text("revoke_url"),
    userinfoUrl: text("userinfo_url"),
    jwksUri: text("jwks_uri"),
    discoveryFetchedAt: ts("discovery_fetched_at"),
    logoUrl: text("logo_url"),
    portalUrl: text("portal_url"),
    city: text("city"),
    state: text("state"),
    surfaces: jsonb("surfaces").$type<Surface[]>().notNull().default(["patient_access"]),
    /** Free-form vendor details (tenant id, practice code, brand ids, aliases). */
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    searchText: text("search_text").notNull().default(""),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("sources_base_env").on(t.fhirBaseUrl, t.environment, t.workspaceId),
    index("sources_vendor").on(t.vendor),
  ],
);

export type ProviderSettings = {
  app_launch_url?: string;
  cds_endpoint?: string;
  cds_caching_seconds?: number;
  cds_trusted_issuers?: { iss: string; jku?: string }[];
  /** backend: organizations (sources) and FHIR Group ids pulled for population sync */
  organizations?: { source_id: string; group_ids: string[] }[];
  backend_schedule_hour_utc?: number;
  backend_resource_types?: string[];
  token_auth_method?: TokenAuthMethod;
  scopes?: string[];
};

export type TokenAuthMethod = "private_key_jwt" | "client_secret_basic" | "client_secret_post" | "none";

export const providerConfigs = pgTable(
  "provider_configs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    vendor: text("vendor").notNull(),
    surface: text("surface").$type<Surface>().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    credentialMode: text("credential_mode").$type<"managed" | "custom">().notNull().default("managed"),
    clientId: text("client_id"),
    clientSecretEnc: text("client_secret_enc"),
    settings: jsonb("settings").$type<ProviderSettings>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("provider_configs_ws_vendor_surface").on(t.workspaceId, t.vendor, t.surface)],
);

// ---------------------------------------------------------------------------------------------
// Patients, sessions, connections, authorization
// ---------------------------------------------------------------------------------------------

export const patients = pgTable(
  "patients",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /** The customer's stable patient id (the public `patient_id`). */
    externalId: text("external_id").notNull(),
    email: text("email"),
    name: text("name"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** Set the first time records are pulled successfully: this is what counts against quota. */
    activatedAt: ts("activated_at"),
    origin: text("origin").$type<"api" | "session" | "dashboard" | "backend" | "hl7v2" | "mcp" | "sample">().notNull().default("api"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("patients_ws_external").on(t.workspaceId, t.externalId), index("patients_ws_created").on(t.workspaceId, t.createdAt)],
);

export type SessionStatus = "open" | "complete" | "expired";

export const patientSessions = pgTable(
  "patient_sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    patientId: text("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    mode: text("mode").$type<"hosted" | "direct">().notNull(),
    sourceId: text("source_id"),
    recommendedSourceIds: jsonb("recommended_source_ids").$type<string[] | null>(),
    returnUrl: text("return_url").notNull(),
    returnButtonLabel: text("return_button_label"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<SessionStatus>().notNull().default("open"),
    tokenHash: text("token_hash").notNull().unique(),
    origin: text("origin").$type<"api" | "portal" | "mcp" | "dashboard">().notNull().default("api"),
    expiresAt: ts("expires_at").notNull(),
    completedAt: ts("completed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("patient_sessions_patient").on(t.patientId, t.createdAt)],
);

export type ConnectionStatus = "active" | "failed" | "refresh_failed" | "expired" | "disconnected";

export const connections = pgTable(
  "connections",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    patientId: text("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    patientSessionId: text("patient_session_id"),
    surface: text("surface").$type<Surface | "feed">().notNull().default("patient_access"),
    status: text("status").$type<ConnectionStatus>().notNull(),
    failureCode: text("failure_code"),
    failureDescription: text("failure_description"),
    failureAt: ts("failure_at"),
    fhirPatientId: text("fhir_patient_id"),
    fhirUser: text("fhir_user"),
    grantedScopes: text("granted_scopes"),
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    idTokenClaims: jsonb("id_token_claims").$type<Record<string, unknown> | null>(),
    lastRefreshedAt: ts("last_refreshed_at"),
    lastPullAt: ts("last_pull_at"),
    nextPullAt: ts("next_pull_at"),
    disconnectedAt: ts("disconnected_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("connections_patient").on(t.patientId),
    index("connections_ws_status").on(t.workspaceId, t.status),
    index("connections_next_pull").on(t.status, t.nextPullAt),
  ],
);

export const oauthStates = pgTable("oauth_states", {
  id: text("id").primaryKey(),
  purpose: text("purpose").$type<"patient_access" | "ehr_launch">().notNull(),
  workspaceId: text("workspace_id").notNull(),
  patientSessionId: text("patient_session_id"),
  sourceId: text("source_id").notNull(),
  codeVerifierEnc: text("code_verifier_enc").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  scope: text("scope").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  expiresAt: ts("expires_at").notNull(),
  consumedAt: ts("consumed_at"),
  createdAt: createdAt(),
});

export const authEvents = pgTable(
  "auth_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    patientId: text("patient_id"),
    connectionId: text("connection_id"),
    patientSessionId: text("patient_session_id"),
    sourceId: text("source_id"),
    step: text("step").$type<"redirect" | "callback" | "token_exchange" | "refresh" | "revoke" | "ehr_launch" | "backend_token">().notNull(),
    status: text("status").$type<"success" | "failure">().notNull(),
    errorCode: text("error_code"),
    errorDescription: text("error_description"),
    createdAt: createdAt(),
  },
  (t) => [index("auth_events_patient").on(t.patientId, t.createdAt), index("auth_events_ws").on(t.workspaceId, t.createdAt)],
);

// ---------------------------------------------------------------------------------------------
// Records and pulls
// ---------------------------------------------------------------------------------------------

/** Global monotonically increasing change counter: export watermarks and `since` reads use it. */
export const fhirChangeSeq = pgSequence("fhir_change_seq");

export const fhirResources = pgTable(
  "fhir_resources",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    patientId: text("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    contentHash: text("content_hash").notNull(),
    resource: jsonb("resource").$type<Record<string, unknown>>().notNull(),
    changeSeq: bigint("change_seq", { mode: "number" })
      .notNull()
      .default(sql`nextval('fhir_change_seq')`),
    firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
    changedAt: ts("changed_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("fhir_resources_conn_type_id").on(t.connectionId, t.resourceType, t.resourceId),
    index("fhir_resources_patient_seq").on(t.patientId, t.seq),
    index("fhir_resources_ws_change").on(t.workspaceId, t.changeSeq),
    index("fhir_resources_patient_type").on(t.patientId, t.resourceType),
  ],
);

export type PullStatus = "queued" | "running" | "completed" | "failed";

export const pulls = pgTable(
  "pulls",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    patientId: text("patient_id").notNull(),
    connectionId: text("connection_id").notNull(),
    trigger: text("trigger").$type<"connected" | "scheduled" | "manual" | "retry" | "backend" | "ingest">().notNull(),
    status: text("status").$type<PullStatus>().notNull().default("queued"),
    total: integer("total").notNull().default(0),
    created: integer("created").notNull().default(0),
    updated: integer("updated").notNull().default(0),
    errors: integer("errors").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    /** per resource type outcome: { Observation: { fetched: 120, pages: 3 }, Device: { error: "403" } } */
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    durationMs: integer("duration_ms"),
    createdAt: createdAt(),
  },
  (t) => [index("pulls_connection").on(t.connectionId, t.createdAt), index("pulls_patient").on(t.patientId, t.createdAt)],
);

// ---------------------------------------------------------------------------------------------
// Job queue (Postgres-backed; FOR UPDATE SKIP LOCKED)
// ---------------------------------------------------------------------------------------------

export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    queue: text("queue").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<"queued" | "running" | "done" | "failed">().notNull().default("queued"),
    priority: integer("priority").notNull().default(100),
    runAt: ts("run_at").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedBy: text("locked_by"),
    lockedUntil: ts("locked_until"),
    lastError: text("last_error"),
    dedupeKey: text("dedupe_key"),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("jobs_ready").on(t.status, t.runAt, t.priority),
    uniqueIndex("jobs_dedupe_pending")
      .on(t.dedupeKey)
      .where(sql`${t.status} in ('queued','running') and ${t.dedupeKey} is not null`),
  ],
);

// ---------------------------------------------------------------------------------------------
// Webhooks and events
// ---------------------------------------------------------------------------------------------

export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    events: jsonb("events").$type<string[]>().notNull(),
    description: text("description"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<"active" | "disabled">().notNull().default("active"),
    apiVersion: text("api_version").notNull(),
    secretEnc: text("secret_enc").notNull(),
    disabledAt: ts("disabled_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("webhook_endpoints_ws").on(t.workspaceId)],
);

export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("events_ws_created").on(t.workspaceId, t.createdAt)],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: ts("next_attempt_at"),
    deliveredAt: ts("delivered_at"),
    lastStatusCode: integer("last_status_code"),
    lastResponseBody: text("last_response_body"),
    lastError: text("last_error"),
    lastAttemptAt: ts("last_attempt_at"),
    lastRedeliveredAt: ts("last_redelivered_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("webhook_deliveries_event_endpoint").on(t.eventId, t.endpointId),
    index("webhook_deliveries_endpoint").on(t.endpointId, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------------------------

export type DestinationType = "fhir_internal" | "fhir_custom" | "object_storage";

export const exportDestinations = pgTable("export_destinations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").$type<DestinationType>().notNull(),
  /** Non-secret settings shown in the dashboard (base URL, bucket, region, file type, auth type). */
  publicConfig: jsonb("public_config").$type<Record<string, unknown>>().notNull().default({}),
  /** Sealed secret settings (tokens, client secrets, access keys). */
  secretConfigEnc: text("secret_config_enc"),
  enabled: boolean("enabled").notNull().default(true),
  watermarkSeq: bigint("watermark_seq", { mode: "number" }).notNull().default(0),
  lastExportedAt: ts("last_exported_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const exportRuns = pgTable(
  "export_runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    destinationId: text("destination_id")
      .notNull()
      .references(() => exportDestinations.id, { onDelete: "cascade" }),
    trigger: text("trigger").$type<"destination_added" | "pull_completed" | "reactivated" | "manual_retry" | "scheduled">().notNull(),
    status: text("status").$type<"queued" | "running" | "completed" | "partial" | "failed">().notNull().default("queued"),
    fromSeq: bigint("from_seq", { mode: "number" }).notNull().default(0),
    toSeq: bigint("to_seq", { mode: "number" }),
    patientsProcessed: integer("patients_processed").notNull().default(0),
    resourcesProcessed: integer("resources_processed").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    /** failed items for manual retry: [{ patient_id, connection_id, resource_type, resource_id, error }] */
    failedItems: jsonb("failed_items").$type<Record<string, unknown>[]>().notNull().default([]),
    errorMessage: text("error_message"),
    retryOfRunId: text("retry_of_run_id"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
  },
  (t) => [index("export_runs_dest").on(t.destinationId, t.createdAt)],
);

/** Storage for the InfiniMed-hosted ("internal") FHIR R4 destination. */
export const internalFhirResources = pgTable(
  "internal_fhir_resources",
  {
    destinationId: text("destination_id")
      .notNull()
      .references(() => exportDestinations.id, { onDelete: "cascade" }),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    versionId: integer("version_id").notNull().default(1),
    patientRef: text("patient_ref"),
    identifiers: jsonb("identifiers").$type<string[]>().notNull().default([]),
    resource: jsonb("resource").$type<Record<string, unknown>>().notNull(),
    lastUpdated: ts("last_updated").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.destinationId, t.resourceType, t.resourceId] }),
    index("internal_fhir_patient").on(t.destinationId, t.resourceType, t.patientRef),
  ],
);

// ---------------------------------------------------------------------------------------------
// Clinician workflow: EHR launches and CDS Hooks
// ---------------------------------------------------------------------------------------------

export const ehrLaunches = pgTable(
  "ehr_launches",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    sourceId: text("source_id").notNull(),
    iss: text("iss").notNull(),
    status: text("status").$type<"authorizing" | "active" | "failed">().notNull(),
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    scope: text("scope"),
    patientFhirId: text("patient_fhir_id"),
    encounterFhirId: text("encounter_fhir_id"),
    fhirUser: text("fhir_user"),
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    errorCode: text("error_code"),
    errorDescription: text("error_description"),
    retrievedAt: ts("retrieved_at"),
    createdAt: createdAt(),
  },
  (t) => [index("ehr_launches_ws").on(t.workspaceId, t.createdAt)],
);

export const cdsCalls = pgTable(
  "cds_calls",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    serviceId: text("service_id").notNull(),
    hook: text("hook"),
    hookInstance: text("hook_instance"),
    statusCode: integer("status_code"),
    cardCount: integer("card_count"),
    cached: boolean("cached").notNull().default(false),
    durationMs: integer("duration_ms"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("cds_calls_ws").on(t.workspaceId, t.createdAt)],
);

// ---------------------------------------------------------------------------------------------
// Backend (population) sync and HL7v2 feeds
// ---------------------------------------------------------------------------------------------

export const backendSyncs = pgTable(
  "backend_syncs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    sourceId: text("source_id").notNull(),
    groupId: text("group_id"),
    mode: text("mode").$type<"bulk" | "system_read">().notNull(),
    status: text("status").$type<"queued" | "kicked_off" | "polling" | "downloading" | "completed" | "failed">().notNull(),
    statusUrl: text("status_url"),
    since: ts("since"),
    transactionTime: ts("transaction_time"),
    output: jsonb("output").$type<Record<string, unknown>[]>().notNull().default([]),
    patientsSeen: integer("patients_seen").notNull().default(0),
    resourcesSeen: integer("resources_seen").notNull().default(0),
    errorMessage: text("error_message"),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
  },
  (t) => [index("backend_syncs_ws").on(t.workspaceId, t.createdAt)],
);

export const hl7Messages = pgTable(
  "hl7_messages",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    sourceId: text("source_id").notNull(),
    controlId: text("control_id"),
    messageType: text("message_type"),
    patientId: text("patient_id"),
    /** sealed raw message: HL7v2 bodies are PHI */
    rawEnc: text("raw_enc").notNull(),
    status: text("status").$type<"accepted" | "error" | "rejected">().notNull(),
    ackCode: text("ack_code").notNull(),
    resourcesCreated: integer("resources_created").notNull().default(0),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("hl7_messages_ws").on(t.workspaceId, t.createdAt)],
);

// ---------------------------------------------------------------------------------------------
// Master patient index
// ---------------------------------------------------------------------------------------------

export const mpiIdentities = pgTable(
  "mpi_identities",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    patientId: text("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    fhirPatientId: text("fhir_patient_id").notNull(),
    demographics: jsonb("demographics").$type<Record<string, unknown>>().notNull(),
    /** score against the patient's anchor identity (first linked), 0..1 */
    matchScore: integer("match_score_pct"),
    matchStatus: text("match_status").$type<"anchor" | "match" | "review" | "mismatch" | "confirmed" | "rejected">().notNull(),
    matchDetails: jsonb("match_details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("mpi_identities_conn_fhir").on(t.connectionId, t.fhirPatientId), index("mpi_identities_ws").on(t.workspaceId)],
);

// ---------------------------------------------------------------------------------------------
// MCP server (OAuth 2.1 authorization server state)
// ---------------------------------------------------------------------------------------------

export const mcpClients = pgTable("mcp_clients", {
  id: text("id").primaryKey(),
  clientName: text("client_name"),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
});

export const mcpGrants = pgTable(
  "mcp_grants",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    refreshTokenHash: text("refresh_token_hash").unique(),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("mcp_grants_user").on(t.userId)],
);

export const mcpAuthCodes = pgTable("mcp_auth_codes", {
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id").notNull(),
  userId: text("user_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  codeChallenge: text("code_challenge").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  resource: text("resource"),
  expiresAt: ts("expires_at").notNull(),
  consumedAt: ts("consumed_at"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------------------------
// Sandbox: patient portal magic links and the Synthetic Hospital
// ---------------------------------------------------------------------------------------------

export const magicLinks = pgTable("magic_links", {
  tokenHash: text("token_hash").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  patientId: text("patient_id")
    .notNull()
    .references(() => patients.id, { onDelete: "cascade" }),
  expiresAt: ts("expires_at").notNull(),
  createdAt: createdAt(),
});

export const syntheticPatients = pgTable("synthetic_patients", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  fhirPatientId: text("fhir_patient_id").notNull(),
  bundle: jsonb("bundle").$type<Record<string, unknown>>().notNull(),
  uploaded: boolean("uploaded").notNull().default(false),
  createdAt: createdAt(),
});

export const syntheticTokens = pgTable("synthetic_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  kind: text("kind").$type<"code" | "access" | "refresh">().notNull(),
  syntheticPatientId: text("synthetic_patient_id").notNull(),
  clientId: text("client_id").notNull(),
  scope: text("scope").notNull(),
  redirectUri: text("redirect_uri"),
  codeChallenge: text("code_challenge"),
  /** EHR-launch context carried from the authorization code to the token response. */
  context: jsonb("context").$type<Record<string, unknown> | null>(),
  expiresAt: ts("expires_at").notNull(),
  consumedAt: ts("consumed_at"),
  createdAt: createdAt(),
});
