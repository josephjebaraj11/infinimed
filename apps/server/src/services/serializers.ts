import type {
  connections,
  ehrLaunches,
  events,
  patientSessions,
  patients,
  sources,
  webhookDeliveries,
  webhookEndpoints,
} from "../db/schema.js";
import { config } from "../config.js";

/**
 * Public API representations. Internal ids (pat_*) never leave the server: patients are addressed
 * by the customer's own `patient_id`. Timestamps are ISO 8601 strings; absent values are null.
 */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

type SourceRow = typeof sources.$inferSelect;
type ConnectionRow = typeof connections.$inferSelect;
type PatientRow = typeof patients.$inferSelect;
type SessionRow = typeof patientSessions.$inferSelect;

export function serializeSource(s: SourceRow, extra: { connectable?: boolean } = {}) {
  return {
    id: s.id,
    object: "source" as const,
    name: s.name,
    type: s.vendor,
    category: s.category,
    environment: s.environment,
    fhir_base_url: s.fhirBaseUrl,
    logo_url: s.logoUrl,
    portal_url: s.portalUrl,
    city: s.city,
    state: s.state,
    surfaces: s.surfaces,
    ...(extra.connectable === undefined ? {} : { connectable: extra.connectable }),
  };
}

export function serializeConnection(c: ConnectionRow, source: SourceRow | undefined) {
  return {
    id: c.id,
    object: "connection" as const,
    source_id: c.sourceId,
    surface: c.surface,
    status: c.status,
    failure_code: c.failureCode,
    failure_description: c.failureDescription,
    failure_at: iso(c.failureAt),
    patient_session_id: c.patientSessionId,
    last_pull_at: iso(c.lastPullAt),
    created_at: iso(c.createdAt),
    updated_at: iso(c.updatedAt),
    facility: source
      ? {
          id: source.id,
          name: source.name,
          type: source.vendor,
          logo_url: source.logoUrl,
          portal_url: source.portalUrl,
          fhir_base_url: source.fhirBaseUrl,
        }
      : null,
  };
}

export function serializePatient(p: PatientRow, conns?: { connection: ConnectionRow; source: SourceRow | undefined }[]) {
  return {
    id: p.externalId,
    object: "patient" as const,
    email: p.email,
    name: p.name,
    metadata: p.metadata,
    activated_at: iso(p.activatedAt),
    created_at: iso(p.createdAt),
    updated_at: iso(p.updatedAt),
    ...(conns ? { connections: conns.map((c) => serializeConnection(c.connection, c.source)) } : {}),
  };
}

export function serializeSession(
  s: SessionRow,
  patientExternalId: string,
  conns: { connection: ConnectionRow; source: SourceRow | undefined }[],
  extra: { url?: string } = {},
) {
  return {
    id: s.id,
    object: "patient_session" as const,
    status: effectiveSessionStatus(s),
    mode: s.mode,
    patient_id: patientExternalId,
    source_id: s.sourceId,
    recommended_source_ids: s.recommendedSourceIds,
    return_url: s.returnUrl,
    return_button_label: s.returnButtonLabel,
    metadata: s.metadata,
    ...(extra.url ? { url: extra.url } : {}),
    expires_at: iso(s.expiresAt),
    completed_at: iso(s.completedAt),
    created_at: iso(s.createdAt),
    connections: conns.map((c) => serializeConnection(c.connection, c.source)),
  };
}

export function effectiveSessionStatus(s: Pick<SessionRow, "status" | "expiresAt">) {
  if (s.status === "open" && s.expiresAt.getTime() < Date.now()) return "expired" as const;
  return s.status;
}

export function serializeWebhookEndpoint(e: typeof webhookEndpoints.$inferSelect, secret?: string) {
  return {
    id: e.id,
    object: "webhook_endpoint" as const,
    url: e.url,
    events: e.events,
    description: e.description,
    metadata: e.metadata,
    status: e.status,
    api_version: e.apiVersion,
    created_at: iso(e.createdAt),
    updated_at: iso(e.updatedAt),
    ...(secret ? { secret } : {}),
  };
}

export function serializeDelivery(d: typeof webhookDeliveries.$inferSelect, evt: typeof events.$inferSelect) {
  return {
    id: evt.id,
    object: "webhook_event" as const,
    type: evt.type,
    endpoint_id: d.endpointId,
    delivery_id: d.id,
    attempts: d.attempts,
    next_attempt_at: iso(d.nextAttemptAt),
    delivered_at: iso(d.deliveredAt),
    last_status_code: d.lastStatusCode,
    last_response_body: d.lastResponseBody,
    last_error: d.lastError,
    last_redelivered_at: iso(d.lastRedeliveredAt),
    created_at: iso(evt.createdAt),
  };
}

export function serializeLaunch(l: typeof ehrLaunches.$inferSelect) {
  return {
    id: l.id,
    object: "launch_context" as const,
    status: l.status,
    source_id: l.sourceId,
    iss: l.iss,
    patient: l.patientFhirId,
    encounter: l.encounterFhirId,
    fhir_user: l.fhirUser,
    scope: l.scope,
    context: l.context,
    fhir_proxy_url: `${config().publicUrl}/v1/launch-contexts/${l.id}/fhir`,
    error_code: l.errorCode,
    error_description: l.errorDescription,
    created_at: iso(l.createdAt),
  };
}

export const tombstone = (id: string, resourceType: string, verb: "deleted" | "disconnected" = "deleted") => ({
  id,
  resource_type: resourceType,
  [verb]: true,
});
