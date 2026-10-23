/** Wire types of the InfiniMed API (snake_case, as returned). */

export type ConnectionStatus = "active" | "failed" | "refresh_failed" | "expired" | "disconnected";
export type SessionStatus = "open" | "complete" | "expired";

export interface Facility {
  id: string;
  name: string;
  type: string;
  logo_url: string | null;
  portal_url: string | null;
  fhir_base_url: string | null;
}

export interface Connection {
  id: string;
  object: "connection";
  source_id: string;
  surface: string;
  status: ConnectionStatus;
  failure_code: string | null;
  failure_description: string | null;
  failure_at: string | null;
  patient_session_id: string | null;
  last_pull_at: string | null;
  created_at: string;
  updated_at: string;
  facility: Facility | null;
}

export interface Patient {
  id: string;
  object: "patient";
  email: string | null;
  name: string | null;
  metadata: Record<string, unknown>;
  activated_at: string | null;
  created_at: string;
  updated_at: string;
  connections: Connection[];
}

export interface Source {
  id: string;
  object: "source";
  name: string;
  type: string;
  category: string;
  environment: "sandbox" | "production";
  fhir_base_url: string | null;
  logo_url: string | null;
  portal_url: string | null;
  city: string | null;
  state: string | null;
  surfaces: string[];
  connectable?: boolean;
}

export interface PatientSession {
  id: string;
  object: "patient_session";
  status: SessionStatus;
  mode: "hosted" | "direct";
  patient_id: string;
  source_id: string | null;
  recommended_source_ids: string[] | null;
  return_url: string;
  return_button_label: string | null;
  metadata: Record<string, unknown>;
  /** Present only on the create response. */
  url?: string;
  expires_at: string;
  completed_at: string | null;
  created_at: string;
  connections: Connection[];
}

export interface Page<T> {
  object: "list";
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface RecordItem {
  source: string;
  connection_id: string;
  changed_at: string;
  resource: { resourceType: string; id: string; [key: string]: unknown };
}

export interface RecordsPage extends Page<RecordItem> {
  resource_type: "records";
  patient_id: string;
}

export interface Provenance {
  reference: string;
  source: string;
  performer: string | null;
  effective: string | null;
  value: number | string | null;
  unit: string | null;
  coding: { system: string; code: string } | null;
}

export interface Fact {
  subject: string;
  code: string;
  display: string;
  category: string;
  aggregate: string;
  status: "hasValue" | "noValue";
  resolved_by: "direct" | "derived" | "none";
  value: number | string | null;
  unit: string | null;
  effective: string | null;
  count: number;
  provenance: Provenance[];
  series?: { effective: string | null; value: number | string; unit: string; provenance: Provenance[] }[];
  issues?: string[];
}

export interface WebhookEndpoint {
  id: string;
  object: "webhook_endpoint";
  url: string;
  events: string[];
  description: string | null;
  metadata: Record<string, unknown>;
  status: "active" | "disabled";
  api_version: string;
  created_at: string;
  updated_at: string;
  /** Present only on create and rotateSecret. */
  secret?: string;
}

export interface WebhookEventRecord {
  id: string;
  object: "webhook_event";
  type: string;
  endpoint_id: string;
  delivery_id: string;
  attempts: number;
  next_attempt_at: string | null;
  delivered_at: string | null;
  last_status_code: number | null;
  last_response_body: string | null;
  last_error: string | null;
  last_redelivered_at: string | null;
  created_at: string;
}

export interface LaunchContext {
  id: string;
  object: "launch_context";
  status: "authorizing" | "active" | "failed";
  source_id: string;
  iss: string;
  patient: string | null;
  encounter: string | null;
  fhir_user: string | null;
  scope: string | null;
  context: Record<string, unknown>;
  fhir_proxy_url: string;
  error_code: string | null;
  error_description: string | null;
  created_at: string;
}

export interface RecordsSync {
  resource_type: "records_sync";
  pull_id?: string;
  patient_id: string;
  source_id: string;
  connection_id: string;
  total: number;
  created: number;
  updated: number;
  errors: number;
  duration_ms: number | null;
}

export interface RecordsSyncFailure {
  resource_type: "records_sync";
  pull_id?: string;
  patient_id: string;
  source_id: string;
  connection_id: string;
  error_code: string;
  error_message: string | null;
}

export interface ConnectionLapse {
  id: string;
  object: "connection";
  patient_id: string | null;
  source_id: string;
  status: "refresh_failed" | "expired";
  failure_code: string | null;
  failure_at: string | null;
  created_at: string;
}

type Envelope<T extends string, O> = { id: string; object: "event"; type: T; api_version: string; created_at: string; data: { object: O } };

export type WebhookEvent =
  | Envelope<"patient_session.completed", PatientSession>
  | Envelope<"connection.token_refresh_failed", ConnectionLapse>
  | Envelope<"connection.disconnected", Connection & { patient_id: string }>
  | Envelope<"records.sync.completed", RecordsSync>
  | Envelope<"records.sync.failed", RecordsSyncFailure>
  | Envelope<"export.run.completed", Record<string, unknown>>
  | Envelope<"export.run.failed", Record<string, unknown>>
  | Envelope<"ehr_launch.completed", LaunchContext>;

export type WebhookEventType = WebhookEvent["type"];

export type InfiniMedErrorType =
  | "authentication_error"
  | "permission_error"
  | "invalid_request_error"
  | "not_found_error"
  | "conflict_error"
  | "rate_limit_error"
  | "billing_error"
  | "ehr_error"
  | "api_error";
