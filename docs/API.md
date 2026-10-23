# InfiniMed REST API (v1)

Base URL: `{PUBLIC_URL}/v1`. Authenticate every request with a workspace API key:

```
Authorization: Bearer im_sk_sbx_…        (sandbox)   or   im_sk_live_…   (production)
InfiniMed-Version: 2026-10-01             (optional; pins the API version)
Idempotency-Key: <uuid>                   (optional on POST; the SDK sets one automatically)
```

API keys are server-side secrets; the API sends no CORS headers. Keys can be restricted to scopes:
`patients:read`, `patients:write`, `patients:delete`, `records:read`, `records:write`,
`sources:read`, `sessions:read`, `sessions:write`, `webhooks:read`, `webhooks:write`,
`exports:read`, `exports:write`, `launch:read`, `backend:read`, `backend:write` (`*` = all).

## Conventions

**Errors.** Every non-2xx response:

```json
{ "error": { "type": "invalid_request_error", "code": "bad_request", "message": "…", "param": "return_url",
             "doc_url": "…", "request_id": "9c9b6f7a-…" } }
```

| Type | HTTP | Codes |
| --- | --- | --- |
| `authentication_error` | 401 | `missing_api_key`, `invalid_api_key`, `expired_api_key`, `not_authenticated`, `invalid_credentials`, `session_expired`, `invalid_token` |
| `permission_error` | 403 | `forbidden`, `workspace_access_denied`, `role_insufficient`, `environment_mismatch`, `insufficient_scope` |
| `invalid_request_error` | 400/413 | `bad_request`, `invalid_data`, `payload_too_large`, `unsupported_api_version`, `oauth_state_expired`, `unsafe_url`, `destination_test_failed`, `idempotency_key_reused` |
| `not_found_error` | 404 | `resource_not_found` |
| `conflict_error` | 409 | `resource_conflict`, `external_id_already_exists`, `webhook_endpoint_limit_reached`, `already_linked` |
| `rate_limit_error` | 429 | `throttled`, `api_key_limit_exceeded` (with `Retry-After`) |
| `billing_error` | 402 | `feature_not_enabled`, `quota_exceeded` |
| `ehr_error` | 502 | `fhir_error`, `oauth_error`, `token_exchange_failed`, `token_unavailable`, `storage_error`, `upstream_unavailable` |
| `api_error` | 500 | `internal_error`, `db_error`, `config_missing` |

Log `error.code` and `error.request_id`. Retry 429/502/503/504 with backoff (the SDK does).

**Pagination.** Lists return `{ object: "list", data, has_more, next_cursor }`. Pass `next_cursor` back
as `starting_after`. `limit` defaults to 10 (1 to 100); records use `count` (1 to 1000, default 100).
Cursors are opaque, bound to the filters they were issued for, and valid for 7 days.

**Idempotency.** Repeating a POST with the same `Idempotency-Key` and body within 24 hours replays the
original response (`Idempotent-Replayed: true`); a different body with the same key returns 400.

## Patients

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/patients` | `{ patient_id, email?, name?, metadata? }`. `patient_id` is yours: stable, ≤200 chars, not starting with `im_` |
| GET | `/patients` | `limit`, `starting_after`, `email` |
| GET | `/patients/{id}` | Includes `connections[]` with an inline `facility` |
| PUT/PATCH | `/patients/{id}` | `{ email?, name?, metadata? }` |
| DELETE | `/patients/{id}` | Revokes upstream access, deletes every stored record |
| GET | `/patients/{id}/records` | `count`, `starting_after`, `type=Observation,Condition`, `since=ISO-8601`. Items: `{ source, connection_id, changed_at, resource }`. Patient resources carry `urn:infinimed:patient-id` |
| POST | `/patients/{id}/records?source_label=…` | Ingest a FHIR Bundle or array retrieved elsewhere |
| GET | `/patients/{id}/patient-sessions` | Newest first |
| DELETE | `/patients/{id}/connections/{connection_id}` | Revoke and disconnect one source; its records are removed |
| POST | `/patients/{id}/connections/{connection_id}/pull` | Queue a manual re-pull (202) |
| GET | `/patients/{id}/pulls` | Pull history with per-resource-type details |
| GET | `/patients/{id}/auth-events` | Authorization trail |
| GET | `/patients/{id}/identities` | MPI status of each source identity |
| GET | `/patients/{id}/facts` | `concepts=bmi,hba1c`, `aggregate=latest|earliest|min|max|mean|count|all`, `from`, `to` |
| GET | `/patients/{id}/models/{model}` | `allergies, conditions, medications, immunizations, procedures, encounters, labs, vitals, documents, coverage, claims` |
| GET | `/concepts`, `/models` | Catalogs of concepts and models |

A fact:

```json
{ "subject": "Patient/user_42", "code": "bmi", "display": "Body mass index", "aggregate": "latest",
  "status": "hasValue", "resolved_by": "direct", "value": 24.6, "unit": "kg/m2", "effective": "2026-05-02T10:00:00Z",
  "count": 2, "provenance": [ { "reference": "Observation/bmi-2", "source": "src_…", "performer": "Clinic A",
  "effective": "2026-05-02T10:00:00Z", "value": 24.6, "unit": "kg/m2", "coding": { "system": "http://loinc.org", "code": "39156-5" } } ] }
```

## Sources (connection catalog)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/sources` | `q` (name/city/aliases), `type` (vendor), `surface`, `limit`, `starting_after`. Each item has `connectable` |
| GET | `/sources/{id_or_fhir_base_url}` | URL-encode a base URL |

## Patient sessions

`POST /patient-sessions`

```json
{ "patient_id": "user_42", "return_url": "https://app.example.com/connected",
  "patient_email": "…", "patient_name": "…",
  "source_id": "src_…",                    // direct mode: straight to that portal
  "recommended_source_ids": ["src_…"],     // hosted mode: shown first (not with source_id)
  "return_button_label": "Back to Acme", "metadata": {}, "expires_in": 3600 }
```

The response includes `url` (send the patient's browser there). The patient returns to `return_url` with
`patient_id` and `patient_session_id`; direct mode adds `success` and `source_id` + `connection_id`, or
`error` + `error_description` (`user_denied`, `oauth_error`, `token_exchange_failed`,
`no_patient_context`). Treat it as UI state; confirm with `GET /patient-sessions/{id}` or webhooks.

Session `status`: `open`, `complete`, `expired`. Connection `status`: `active`, `failed`,
`refresh_failed`, `expired`, `disconnected`.

## Webhooks and events

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/webhooks` | `{ url, events: [...] | ["*"], description?, metadata? }`; returns `secret` once |
| GET | `/webhooks`, `/webhooks/{id}` | `status=active|disabled` filter |
| PATCH | `/webhooks/{id}` | `url`, `events`, `description`, `metadata`, `status` (re-enable) |
| DELETE | `/webhooks/{id}` | |
| POST | `/webhooks/{id}/rotate-secret` | Old secret stops verifying immediately |
| GET | `/webhooks/{id}/events` | Delivery log: `attempts`, `next_attempt_at`, `delivered_at`, `last_status_code`, `last_response_body` |
| POST | `/events/{id}/redeliver` | `{ endpoint_id? }`, once per minute per event |
| GET | `/events` | `type`, `limit` |

Envelope: `{ id: "evt_…", object: "event", type, api_version, created_at, data: { object } }`.
Verify `InfiniMed-Signature: t=<unix>,v1=<hex>` = HMAC-SHA256(secret, `${t}.${rawBody}`) over the
**raw** body, reject timestamps older than 5 minutes, dedupe by `id`, respond 2xx within 5 seconds.

## Clinician workflow

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/launch-contexts/{lc_id}` | `patient`, `encounter`, `fhir_user`, `scope`, `context` (`need_patient_banner`, `intent`, …) |
| GET | `/launch-contexts/{lc_id}/fhir/{Type}[/{id}]` | Read-only FHIR proxy with the launch's EHR token |

EHR-facing endpoints (no API key): `GET /smart/launch/{workspace_id}?iss&launch`,
`GET /cds-services/{workspace_id}`, `POST /cds-services/{workspace_id}/{service_id}[/feedback]`.

## Backend, feeds and exports

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/backend-syncs` | `{ source_id, group_id, full? }` starts a Bulk Data Group export (202) |
| GET | `/backend-syncs[/{id}]` | Status, `patients_seen`, `resources_seen`, `transaction_time` |
| POST | `/ingest/hl7v2?feed=name&create_patients=true` | Body: one ER7 message. Returns the ACK (or JSON with `Accept: application/json`) |
| GET/POST | `/export-destinations` | Types `fhir_internal`, `fhir_custom` (`base_url`, `auth_type` none/bearer/client_credentials, `id_strategy`), `object_storage` (`vendor` aws/s3_compatible/azure_blob, `bucket`, `region`, `endpoint`, `prefix`, keys or `sas_url`, `file_type` ndjson/ndjson_zip). Connectivity is tested before saving |
| GET/PATCH/DELETE | `/export-destinations/{id}` | Detail includes runs and hosted-server credentials; PATCH `enabled`, `name`, `credentials`, `rotate_internal_token` |
| POST | `/export-destinations/{id}/runs/{run_id}/retry` | Re-process failed items of a failed/partial run |

Hosted FHIR server: `{PUBLIC_URL}/fhir/{destination_id}` with `Authorization: Bearer imfhir_…`;
find a patient with `GET /Patient?identifier=urn:infinimed:patient-id|{patient_id}`.
