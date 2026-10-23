# InfiniMed architecture

## Components

```
                ┌────────────────────────── apps/server (one Node 24 process type) ──────────────────────────┐
 Customer       │  /v1  REST API (API keys)          /dashboard-api (cookie sessions)    /mcp + /oauth (MCP)  │
 backend ──────▶│  /connect, /oauth/callback (hosted patient pages)   /smart/launch, /cds-services (EHR)       │
 Patients ─────▶│  /fhir/{dest} (hosted FHIR server)   /synthetic (sandbox EHR)   /.well-known/jwks.json      │
 EHRs ─────────▶│                                                                                             │
 AI assistants ▶│  services: sessions · patient-access (SMART) · connections/tokens · records · MPI · models   │
                │            exports · webhooks · billing · audit · credentials · catalog · ingest            │
                │  worker:   records.pull · webhook.deliver · export.run · backend.kickoff/poll/download      │
                └──────────────┬──────────────────────────────────────────────────────────┬─────────────────┘
                               │ Drizzle (SQL migrations)                                   │ outbound (SSRF-guarded)
                        PostgreSQL (or PGlite in dev)                       EHR/payer FHIR + OAuth, webhook receivers,
                        jobs queue · records · tokens (sealed)              FHIR/S3/Azure destinations, CDS services
```

- **API and worker are the same codebase.** `WORKER_INLINE=true` runs the job loop in the API
  process; production runs dedicated workers (`src/worker-main.ts`). Any number of workers can run.
- **Dashboard** (`apps/dashboard`) is a static React app served by the API at `/app`, talking only
  to `/dashboard-api` with a same-origin cookie.
- **SDK** (`packages/sdk`) wraps `/v1` and verifies webhooks; it has no runtime dependencies.

## Tenancy and environments

Every customer row carries `workspace_id`. A workspace is `sandbox` or `production`; the environment
scopes which catalog sources it can see and is encoded in API key prefixes (`im_sk_sbx_`,
`im_sk_live_`), so a sandbox key can never start a session against a production EHR. Workspace-private
sources (HL7v2 feeds, external imports) have `sources.workspace_id` set.

## Data model (key tables)

| Table | Purpose |
| --- | --- |
| `workspaces`, `users`, `memberships`, `user_sessions`, `invitations`, `api_keys` | Accounts, roles (owner/admin/member), hashed session tokens and API keys |
| `sources` | Catalog: one row per FHIR endpoint (vendor, environment, endpoints, surfaces) |
| `provider_configs` | Per workspace, vendor and surface: managed or custom credentials (secret sealed), launch/CDS/backend settings |
| `patients` | The customer's patients, addressed by their own `external_id` |
| `patient_sessions` | Browser journeys; only a hash of the URL token is stored |
| `connections` | Authorized links patient↔source (patient access, backend, feed) with sealed access/refresh tokens |
| `oauth_states` | One-time OAuth state with sealed PKCE verifier |
| `auth_events` | Every authorization step (redirect, callback, token exchange, refresh, revoke) |
| `fhir_resources` | Latest version of every resource per connection; `seq` (insertion) and `change_seq` (global change counter) |
| `pulls` | Background pull runs with per-resource-type details |
| `mpi_identities` | Each source Patient's demographics and match status against the anchor |
| `events`, `webhook_endpoints`, `webhook_deliveries` | Event log and per-endpoint delivery state |
| `export_destinations`, `export_runs`, `internal_fhir_resources` | Exports with watermarks; storage of the hosted FHIR server |
| `ehr_launches`, `cds_calls` | Clinician workflow state and logs |
| `backend_syncs`, `hl7_messages` | Population syncs; HL7v2 messages (sealed bodies) |
| `mcp_clients`, `mcp_grants`, `mcp_auth_codes` | OAuth 2.1 authorization server for MCP |
| `jobs` | Durable queue |
| `audit_logs`, `idempotency_keys` | Audit trail; POST replay protection |

Secrets at rest (`*_enc`) are AES-256-GCM envelopes under a key derived (HKDF) from `MASTER_KEY`, with
associated data binding each envelope to its row (a token sealed for connection A cannot be swapped
onto connection B).

## Flows

### Patient access (SMART standalone launch)

```
Customer backend           InfiniMed                                   EHR / payer
POST /v1/patient-sessions ─▶ upsert patient, session (token hash), url
patient browser ──────────▶ GET /connect/{token}  (hosted search) or /connect/{token}/start (direct)
                            POST /connect/{token}/authorize
                              resolve credentials (managed | custom) + SMART discovery
                              state + PKCE (S256) stored, 302 ───────────▶ /authorize (aud, scopes, vendor params)
                                                                             patient signs in, approves
                            GET /oauth/callback?code&state ◀──────────── 302
                              consume state (single use, 15 min)
                              token exchange (private_key_jwt | basic | post | none) ─▶ /token
                              patient id: token `patient` → verified id_token fhirUser → userinfo
                              upsert connection (active, sealed tokens), queue records.pull
                            302 → hosted page (more sources) or return_url?success&connection_id
```

Vendor differences live in `src/smart/profiles.ts`: client authentication, scopes, extra authorize
parameters (Aetna `skin`), audience overrides, identity source, refresh behaviour, query plans and
request budgets. Codes are always exchanged inline (MEDITECH codes expire in 60 seconds).

### Background pull

`records.pull` reads the Patient, registers it with the MPI, runs the vendor's query plan (all pages,
same-origin `next` links only), follows Practitioner/Organization/Location/Medication references,
and settles: counts, `records.sync.completed` or `records.sync.failed`, next scheduled pull, and
export triggers. Unsupported types (400/403/404/422) are recorded and skipped. A 429 with a long
`Retry-After` defers the job without burning an attempt; transient errors retry with backoff and only
the last attempt emits a failure. Tokens refresh under a per-connection lock (advisory lock on
Postgres) because rolling refresh tokens die if two refreshes race. A dead refresh token moves the
connection to `refresh_failed` and emits `connection.token_refresh_failed`.

Writes are content-addressed: an unchanged resource keeps its `change_seq`, so exports and `since`
reads see only real changes.

### Reading records

`GET /v1/patients/{id}/records` is snapshot-consistent: the first page fixes the patient's maximum
`seq`, later pages return only rows that existed then, ordered by insertion. Cursors are HMAC-signed,
bind the filters, and expire 7 days after the page that issued them. Connections revoked mid-read
disappear from the following pages (consent wins over consistency).

### Clinical models

- **Facts** (`src/models/resolver.ts`): ~45 concepts (vitals, chronic-care labs, surveys) keyed by
  LOINC codes, normalised to a canonical UCUM unit (lb→kg, °F→°C, IFCC mmol/mol→% HbA1c, mmol/L→mg/dL
  per analyte...). The same measurement reported by several sources (same minute, same value) merges
  into one with multi-source provenance. Aggregates: latest, earliest, min, max, mean, count, all.
  BMI is derived from weight and height when not recorded. Implausible values are flagged, unit
  mismatches reported as issues, never silently converted.
- **Models** (`src/models/views.ts`): allergies, conditions, medications, immunizations,
  procedures, encounters, labs, vitals, documents, coverage, claims; reconciled across sources by
  normalised code (RxNorm/SNOMED/ICD-10/CVX/LOINC/CPT with OID aliasing). Reconciliation is
  safety-biased: the highest criticality and any active status win.

### Master patient index

Fellegi–Sunter scoring (`src/mpi/match.ts`) over names (Jaro–Winkler, Soundex), birth date (with
day/month transposition), gender, postal code, phone, email and same-system identifiers. Patient
access compares each new source identity to the patient's anchor and flags `review`/`mismatch`, which
catches a portal account sharing a family member's records. Backend cohorts and feeds block on birth
date or Soundex and link to an existing patient on a confident match, otherwise create `im_*`
patients. Manual decisions (`confirmed`/`rejected`) persist across re-pulls.

### Exports

A run covers `(watermark, high-water mark]` fixed at start. FHIR destinations get transaction bundles
of `PUT` entries (falling back to per-resource PUTs to isolate bad resources); object storage gets one
NDJSON (or zipped) file per patient and source, Patient line first, rewritten in full. Ids outside the
FHIR grammar are replaced by stable hashes with references rewritten; optional per-source namespacing
prevents cross-source id collisions. Item failures make a run `partial` (retryable from the run);
destination-level failures fail the run and keep the watermark. Disabling then re-enabling catches up.

### Webhooks

Events: `patient_session.completed`, `connection.token_refresh_failed`, `connection.disconnected`,
`records.sync.completed`, `records.sync.failed`, `export.run.completed`, `export.run.failed`,
`ehr_launch.completed`. Header `InfiniMed-Signature: t=…,v1=hex(HMAC-SHA256(secret, "${t}.${body}"))`.
Nine attempts over about 3.6 days (0, 1m, 5m, 30m, 2h, 12h, 24h×3), 5 s timeout, auto-disable on
exhaustion, manual redelivery rate-limited to once per minute per event.

### Clinician workflow

- **SMART EHR launch**: the EHR opens `/smart/launch/{workspace}?iss&launch`; InfiniMed resolves the
  source by `iss`, completes authorization with its (or your) provider registration, stores the
  tokens and redirects the clinician to your app with `im_launch=lc_*`. Your backend reads the
  context and proxies FHIR reads through `/v1/launch-contexts/{id}/fhir/...`; it never holds EHR
  tokens.
- **CDS Hooks**: discovery passes through your service list; invocations are forwarded with an
  InfiniMed-signed JWT (verify against our JWKS), optionally cached per patient/user/hook, and fail
  open to an empty card list. Inbound EHR JWTs are verified when trusted issuers are configured.

### Backend sync

`backend.kickoff` gets a `client_credentials` token with a signed assertion and starts
`Group/{id}/$export` (`_type`, `_since` = previous `transactionTime`); `backend.poll` honours
`Retry-After`/`X-Progress`; `backend.download` streams NDJSON (Patients first), links each Patient
through the MPI and stores resources per patient. Configure organizations and Group IDs per workspace;
an hourly scheduler starts daily syncs.

### MCP server

`/mcp` (Streamable HTTP, stateless) accepts an OAuth access token or an API key. The authorization
server implements Protected Resource Metadata (RFC 9728), AS metadata (RFC 8414), dynamic client
registration (RFC 7591), PKCE, resource indicators (RFC 8707), consent with per-capability checkboxes
(`connect`, `records:read`, `manage`), rotating refresh tokens and dashboard revocation. Eleven
tools; read-only and destructive annotations; every call audited.

## Security model

- API keys are bearer secrets stored as SHA-256 hashes, prefixed by environment, optionally scoped
  and expiring; per-key token-bucket rate limiting; `last_used_at` tracking.
- Dashboard: scrypt passwords, opaque session tokens (hashed), HttpOnly SameSite=Lax cookies, a
  required custom CSRF header on mutations, role checks on every route, login throttling.
- OAuth to vendors: PKCE everywhere, single-use 15-minute state, private_key_jwt with RS384 keys
  published at `/.well-known/jwks.json` (rotation by appending keys), id_token signature verification
  when the vendor publishes a JWKS.
- Outbound requests to customer-supplied URLs are SSRF-guarded (https, DNS resolution checked against
  private, loopback, link-local and CGNAT ranges in production).
- Hosted pages ship a strict CSP, no third-party assets, `no-store` caching and `no-referrer`.
- PHI never goes to logs (structured logger redacts token-like keys; call sites log identifiers only).
  HL7v2 bodies are sealed at rest. Every PHI read through the API, dashboard or MCP is audited.

## Scaling notes

- Horizontal: stateless API nodes behind a load balancer; workers scale independently.
- The in-process rate limiters (API keys, per-source token buckets) are per node; at multi-node scale
  move them to a shared store (Redis/Postgres) so vendor budgets are global.
- `fhir_resources` grows fastest; partition by `workspace_id` hash or move cold history to object
  storage at large scale. Bulk downloads are streamed.
