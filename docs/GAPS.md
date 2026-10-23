# Gaps, dependencies and requirements

InfiniMed was built from a study of the public MedBlocks Platform documentation (October 2026). This
document records what matches that capability set, what is partial or missing, and what a production
launch depends on that code cannot provide. Status key: **Done** (implemented and covered by tests),
**Partial** (implemented with stated limits), **Gap** (not implemented).

## Feature parity

### Patient access

| Capability | Status | Notes |
| --- | --- | --- |
| Hosted connection page with catalog search, recommended sources, branding, return button | Done | Server-rendered, strict CSP, live search |
| Direct mode ("your own UI"): session for one source, success/failure on the return URL | Done | `parseReturnUrl` in the SDK |
| Patients with customer ids; create-or-reuse on session start; metadata | Done | |
| SMART standalone launch: PKCE, private_key_jwt, client_secret_basic/post, public clients | Done | Verified live against the SMART Health IT sandbox and the Synthetic Hospital |
| Vendor specifics: Epic, Oracle Health, athenahealth, healow/eCW, MEDITECH, Aetna, UnitedHealthcare, CMS Blue Button | Partial | Implemented from published behaviour (auth method, scopes, `aud`, extra params, identity, query plans). **Not exercised against those vendors' sandboxes**: each needs your app registration first (see dependencies) |
| Background pull, query plans, reference following, scheduled re-pulls, rate-limit deferral | Done | |
| Token refresh with rolling refresh tokens, `refresh_failed` / `expired` states, reconnect events | Done | |
| Records read: snapshot pagination, `type` and `since` filters, 7-day cursors, source on each item | Done | |
| Disconnect (upstream revoke, records removed), delete patient | Done | |
| Auth event history, pull monitoring | Done | Dashboard and API |
| Wearables and mobile SDK | Gap | Listed as "coming soon" in the reference too. Needs HealthKit/Health Connect SDKs and device-data models |
| TEFCA Individual Access Services | Gap | Requires a QHIN relationship and identity proofing (IAL2) |

### Clinician workflow

| Capability | Status | Notes |
| --- | --- | --- |
| SMART EHR launch on the customer's behalf, launch-context handle, scoped FHIR proxy | Done | Tested end to end with the Synthetic Hospital's EHR launcher |
| CDS Hooks gateway: discovery passthrough, signed forwarding, caching, feedback, inbound JWT verification | Done | |
| SMART v2 granular scopes, `fhirContext` beyond patient/encounter | Partial | Scopes are configurable per tile; context fields pass through |
| Write-back to EHRs | Gap | Read-focused like the reference; vendor write APIs (and their review) are per use case |

### Backend and feeds

| Capability | Status | Notes |
| --- | --- | --- |
| SMART Backend Services (client_credentials + JWT assertion) | Done | |
| FHIR Bulk Data Group `$export`: kickoff, polling, streamed NDJSON, `_since` increments, scheduling | Done | Tested against the Synthetic Hospital's Bulk endpoint |
| Epic organization search and Group discovery UI | Partial | Organizations and Group IDs are entered as JSON on the Backend tile |
| HL7v2 ingestion over HTTP (ADT A01/02/03/04/08/28/31, ORU R01) with ACKs, MPI linking | Done | MLLP listener is not included (put an interface engine or MLLP-to-HTTPS bridge in front) |
| Ingest FHIR retrieved by other vendors | Done | `POST /v1/patients/{id}/records` |
| Sending HL7v2 to EHRs (Epic HL7v2-over-HTTP outbound) | Gap | |

### Network

| Capability | Status | Notes |
| --- | --- | --- |
| Configuration surface (tiles, use-case intake) | Partial | Tiles shown as "managed setup" |
| CommonWell / Carequality / TEFCA query and retrieve (IHE XCPD, XCA, FHIR-based TEFCA) | Gap | Needs network membership or a QHIN partner, certificates, permitted-purpose attestation, then the IHE SOAP/FHIR exchange implementation |
| Real-time ADT notifications | Gap | Not offered by the reference either |

### Data layer

| Capability | Status | Notes |
| --- | --- | --- |
| Master patient index (probabilistic) with review/confirm/reject | Done | Weights are sensible defaults; tune m/u probabilities on labelled pairs before relying on auto-linking at scale |
| Clinical facts with unit normalisation, cross-source dedup, provenance, derived BMI | Done | 47 concepts |
| Reconciled clinical models (11 tables) | Done | Safety-biased merges |
| "Thousands of clinical concepts" (openEHR-CKM-inspired library) | Gap | Extend `src/models/concepts.ts`; a terminology service (SNOMED/LOINC/RxNorm with value sets and maps) is the right next dependency |
| OCR and structuring of documents (PDF/images, C-CDA) | Gap | DocumentReference metadata and attachments are kept; parsing C-CDA into FHIR and OCR are not built |
| Output in OMOP CDM, Tuva input layer or openEHR | Gap | FHIR and NDJSON only |

### Data out

| Capability | Status | Notes |
| --- | --- | --- |
| Hosted ("internal") FHIR R4 server with bearer token | Done | Read, search (identifier, patient, `_id`, `_lastUpdated`, `_include`, paging), write, transactions |
| Custom FHIR server (none, bearer, OAuth client credentials) with connectivity test | Done | |
| S3 and S3-compatible object storage, NDJSON or zipped | Done | Verified with SigV4 against a mock; test against your real bucket |
| Azure Blob (SAS URL) and GCS (S3 interoperability) | Partial | Implemented; not tested against real accounts |
| Backfill, delta, reactivation catch-up, manual retry, run history, export events | Done | |
| Propagating deletes (disconnects, deleted patients) to destinations | Gap | Exports are upserts only |
| Direct warehouse loaders (Snowflake, BigQuery, Databricks, Fabric, Redshift) | Gap | Land NDJSON in object storage and load from there |
| Webhooks: signed, retries over ~3.6 days, auto-disable, redelivery, secret rotation, delivery log | Done | |

### Platform

| Capability | Status | Notes |
| --- | --- | --- |
| Workspaces (sandbox/production), roles, invitations | Done | Invitations produce a link; no email is sent |
| API keys (environment prefixes, scopes, expiry, cap) | Done | |
| Error taxonomy, request ids, idempotency keys, API version header | Done | |
| Plans, feature gating (402), active-patient quota | Done | No payment processing; plan changes are a database update |
| TypeScript SDK | Done | Other languages: Gap |
| MCP server with OAuth 2.1 (DCR, PKCE, consent scopes) and API keys; audited tools | Done | |
| In-chat UI panel (MCP Apps) and Skills over MCP | Gap | Tools return structured content instead |
| Agent skill / plugin for coding assistants, `llms.txt` docs export | Gap | |
| Dashboard SSO (SAML/OIDC), MFA | Gap | Password login only |

## Dependencies that code cannot satisfy

1. **Vendor registrations and reviews (per surface, per environment).** Managed credentials are
   InfiniMed's own app registrations, so you must hold them before customers can use "managed" mode:
   - Epic on FHIR app (patients: USCDI v3 auto-distribution, then per-organization activation;
     clinicians and backend: per-customer approval), JWKS hosted at your `PUBLIC_URL`.
   - Oracle Health Code Console apps (Patient, Provider, System) and per-tenant activation by each
     hospital; JWKS registered on the Cerner Central system account.
   - athenahealth Certified-APIs app (self-serve to production), healow clinical app (per practice),
     MEDITECH Greenfield credentials and per-hospital registration.
   - Payers: CMS Blue Button production review (privacy policy, terms, live demo, 2 to 4 weeks), Aetna
     sandbox and production questionnaires, Optum FLEX app review for UnitedHealthcare.
   - Load each vendor's production endpoint directory into the catalog (`catalog:import`).
2. **Legal and compliance.** A US legal entity; BAAs with customers and with every subprocessor that
   touches PHI (cloud, logging, email); a HIPAA security program (risk analysis, policies, workforce
   training, incident response); SOC 2 Type II and/or ISO 27001 audits; published privacy policy and
   terms covering collection, use, sharing, retention after revocation, breach notification and sale
   of the company; a documented deletion SLA for revocations.
3. **Network exchange.** CommonWell or Carequality membership (or a QHIN partner under TEFCA),
   signed agreements, certificates, and a treatment or other permitted-purpose basis for every query.

## Production requirements (infrastructure and operations)

- **Secrets:** `MASTER_KEY` and `SIGNING_KEYS_JSON` from a KMS or secret manager (the app refuses to
  start in production without them). Prefer KMS envelope encryption for `MASTER_KEY`; consider an HSM
  for the signing key. Rotate signing keys by appending to the JWKS.
- **Database:** managed PostgreSQL 15+ with point-in-time recovery, encryption at rest, connection
  pooling; plan partitioning of `fhir_resources` at scale.
- **Network:** TLS everywhere, a WAF in front of public pages, an egress proxy or allowlist for
  vendor and customer URLs (the app also SSRF-checks), stable US egress IPs (some vendors allowlist).
- **Shared rate limiting:** API-key and per-vendor request budgets are per process today; use a
  shared limiter (Redis or Postgres) when running several nodes so vendor limits (for example healow's
  250 calls per minute per practice) hold globally.
- **Observability:** ship structured logs to a HIPAA-eligible sink, add metrics and traces
  (OpenTelemetry), alert on failed pulls, disabled webhook endpoints, failed export runs, rising
  `refresh_failed` rates and job queue depth.
- **Data lifecycle:** retention and deletion jobs aligned with your policies and payer requirements
  (for example deletion within 30 days of revocation); backups and disaster recovery tested.
- **Email:** a provider for invitations, magic links and reconnect prompts (links are shown in the
  dashboard today).
- **Security testing:** penetration test of hosted pages, OAuth flows and the MCP server before launch.
