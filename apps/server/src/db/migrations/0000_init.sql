CREATE SEQUENCE "public"."fhir_change_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"token_prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"last4" text NOT NULL,
	"scopes" jsonb DEFAULT '["*"]'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"patient_id" text,
	"connection_id" text,
	"patient_session_id" text,
	"source_id" text,
	"step" text NOT NULL,
	"status" text NOT NULL,
	"error_code" text,
	"error_description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backend_syncs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"group_id" text,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"status_url" text,
	"since" timestamp with time zone,
	"transaction_time" timestamp with time zone,
	"output" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"patients_seen" integer DEFAULT 0 NOT NULL,
	"resources_seen" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cds_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"service_id" text NOT NULL,
	"hook" text,
	"hook_instance" text,
	"status_code" integer,
	"card_count" integer,
	"cached" boolean DEFAULT false NOT NULL,
	"duration_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"source_id" text NOT NULL,
	"patient_session_id" text,
	"surface" text DEFAULT 'patient_access' NOT NULL,
	"status" text NOT NULL,
	"failure_code" text,
	"failure_description" text,
	"failure_at" timestamp with time zone,
	"fhir_patient_id" text,
	"fhir_user" text,
	"granted_scopes" text,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"access_token_expires_at" timestamp with time zone,
	"id_token_claims" jsonb,
	"last_refreshed_at" timestamp with time zone,
	"last_pull_at" timestamp with time zone,
	"next_pull_at" timestamp with time zone,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ehr_launches" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"iss" text NOT NULL,
	"status" text NOT NULL,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"access_token_expires_at" timestamp with time zone,
	"scope" text,
	"patient_fhir_id" text,
	"encounter_fhir_id" text,
	"fhir_user" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"error_description" text,
	"retrieved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_destinations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"public_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_config_enc" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"watermark_seq" bigint DEFAULT 0 NOT NULL,
	"last_exported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "export_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"destination_id" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"from_seq" bigint DEFAULT 0 NOT NULL,
	"to_seq" bigint,
	"patients_processed" integer DEFAULT 0 NOT NULL,
	"resources_processed" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"failed_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_message" text,
	"retry_of_run_id" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fhir_resources" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"source_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"resource" jsonb NOT NULL,
	"change_seq" bigint DEFAULT nextval('fhir_change_seq') NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hl7_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"source_id" text NOT NULL,
	"control_id" text,
	"message_type" text,
	"patient_id" text,
	"raw_enc" text NOT NULL,
	"status" text NOT NULL,
	"ack_code" text NOT NULL,
	"resources_created" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"workspace_id" text NOT NULL,
	"key" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"request_hash" text NOT NULL,
	"status_code" integer NOT NULL,
	"response_body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_workspace_id_key_pk" PRIMARY KEY("workspace_id","key")
);
--> statement-breakpoint
CREATE TABLE "internal_fhir_resources" (
	"destination_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"version_id" integer DEFAULT 1 NOT NULL,
	"patient_ref" text,
	"identifiers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resource" jsonb NOT NULL,
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "internal_fhir_resources_destination_id_resource_type_resource_id_pk" PRIMARY KEY("destination_id","resource_type","resource_id")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "magic_links" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_auth_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"code_challenge" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"resource" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"client_name" text,
	"redirect_uris" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"refresh_token_hash" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_grants_refresh_token_hash_unique" UNIQUE("refresh_token_hash")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mpi_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"source_id" text NOT NULL,
	"fhir_patient_id" text NOT NULL,
	"demographics" jsonb NOT NULL,
	"match_score_pct" integer,
	"match_status" text NOT NULL,
	"match_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"workspace_id" text NOT NULL,
	"patient_session_id" text,
	"source_id" text NOT NULL,
	"code_verifier_enc" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"scope" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"mode" text NOT NULL,
	"source_id" text,
	"recommended_source_ids" jsonb,
	"return_url" text NOT NULL,
	"return_button_label" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"token_hash" text NOT NULL,
	"origin" text DEFAULT 'api' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"external_id" text NOT NULL,
	"email" text,
	"name" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activated_at" timestamp with time zone,
	"origin" text DEFAULT 'api' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"vendor" text NOT NULL,
	"surface" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"credential_mode" text DEFAULT 'managed' NOT NULL,
	"client_id" text,
	"client_secret_enc" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pulls" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"patient_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"created" integer DEFAULT 0 NOT NULL,
	"updated" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text,
	"name" text NOT NULL,
	"vendor" text NOT NULL,
	"category" text NOT NULL,
	"environment" text NOT NULL,
	"fhir_base_url" text,
	"audience" text,
	"authorize_url" text,
	"token_url" text,
	"revoke_url" text,
	"userinfo_url" text,
	"jwks_uri" text,
	"discovery_fetched_at" timestamp with time zone,
	"logo_url" text,
	"portal_url" text,
	"city" text,
	"state" text,
	"surfaces" jsonb DEFAULT '["patient_access"]'::jsonb NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"search_text" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "synthetic_patients" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"fhir_patient_id" text NOT NULL,
	"bundle" jsonb NOT NULL,
	"uploaded" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "synthetic_patients_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "synthetic_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"synthetic_patient_id" text NOT NULL,
	"client_id" text NOT NULL,
	"scope" text NOT NULL,
	"redirect_uri" text,
	"code_challenge" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" text NOT NULL,
	"active_workspace_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"event_id" text NOT NULL,
	"endpoint_id" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_status_code" integer,
	"last_response_body" text,
	"last_error" text,
	"last_attempt_at" timestamp with time zone,
	"last_redelivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"url" text NOT NULL,
	"events" jsonb NOT NULL,
	"description" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"api_version" text NOT NULL,
	"secret_enc" text NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"environment" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"feature_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"patient_quota_override" integer,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"personal" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_destinations" ADD CONSTRAINT "export_destinations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_runs" ADD CONSTRAINT "export_runs_destination_id_export_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."export_destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fhir_resources" ADD CONSTRAINT "fhir_resources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fhir_resources" ADD CONSTRAINT "fhir_resources_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fhir_resources" ADD CONSTRAINT "fhir_resources_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "internal_fhir_resources" ADD CONSTRAINT "internal_fhir_resources_destination_id_export_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."export_destinations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_grants" ADD CONSTRAINT "mcp_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpi_identities" ADD CONSTRAINT "mpi_identities_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mpi_identities" ADD CONSTRAINT "mpi_identities_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_sessions" ADD CONSTRAINT "patient_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_sessions" ADD CONSTRAINT "patient_sessions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_configs" ADD CONSTRAINT "provider_configs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_ws" ON "api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "audit_ws_created" ON "audit_logs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "auth_events_patient" ON "auth_events" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE INDEX "auth_events_ws" ON "auth_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "backend_syncs_ws" ON "backend_syncs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "cds_calls_ws" ON "cds_calls" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "connections_patient" ON "connections" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "connections_ws_status" ON "connections" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "connections_next_pull" ON "connections" USING btree ("status","next_pull_at");--> statement-breakpoint
CREATE INDEX "ehr_launches_ws" ON "ehr_launches" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "events_ws_created" ON "events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "export_runs_dest" ON "export_runs" USING btree ("destination_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "fhir_resources_conn_type_id" ON "fhir_resources" USING btree ("connection_id","resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "fhir_resources_patient_seq" ON "fhir_resources" USING btree ("patient_id","seq");--> statement-breakpoint
CREATE INDEX "fhir_resources_ws_change" ON "fhir_resources" USING btree ("workspace_id","change_seq");--> statement-breakpoint
CREATE INDEX "fhir_resources_patient_type" ON "fhir_resources" USING btree ("patient_id","resource_type");--> statement-breakpoint
CREATE INDEX "hl7_messages_ws" ON "hl7_messages" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "internal_fhir_patient" ON "internal_fhir_resources" USING btree ("destination_id","resource_type","patient_ref");--> statement-breakpoint
CREATE INDEX "jobs_ready" ON "jobs" USING btree ("status","run_at","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_pending" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."status" in ('queued','running') and "jobs"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "mcp_grants_user" ON "mcp_grants" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_ws" ON "memberships" USING btree ("user_id","workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mpi_identities_conn_fhir" ON "mpi_identities" USING btree ("connection_id","fhir_patient_id");--> statement-breakpoint
CREATE INDEX "mpi_identities_ws" ON "mpi_identities" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "patient_sessions_patient" ON "patient_sessions" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "patients_ws_external" ON "patients" USING btree ("workspace_id","external_id");--> statement-breakpoint
CREATE INDEX "patients_ws_created" ON "patients" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_configs_ws_vendor_surface" ON "provider_configs" USING btree ("workspace_id","vendor","surface");--> statement-breakpoint
CREATE INDEX "pulls_connection" ON "pulls" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE INDEX "pulls_patient" ON "pulls" USING btree ("patient_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_base_env" ON "sources" USING btree ("fhir_base_url","environment","workspace_id");--> statement-breakpoint
CREATE INDEX "sources_vendor" ON "sources" USING btree ("vendor");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_event_endpoint" ON "webhook_deliveries" USING btree ("event_id","endpoint_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_endpoint" ON "webhook_deliveries" USING btree ("endpoint_id","created_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_ws" ON "webhook_endpoints" USING btree ("workspace_id");