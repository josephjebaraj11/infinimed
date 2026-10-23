# InfiniMed

One integration layer for healthcare data. InfiniMed connects a product to EHRs, payers, sandboxes and
clinician workflows through the relationships the product already has, pulls records in the
background, reconciles them into one patient record with clinically meaningful models, and delivers
them to the systems where the team works.

| Surface | Unlocked by | What InfiniMed does |
| --- | --- | --- |
| **Patient access** | The patient | Hosted or embedded source search, SMART on FHIR standalone launch (PKCE, private_key_jwt / client secret / public), token storage and rolling refresh, background pulls, reconnect signals |
| **Clinician workflow** | A provider organization | SMART EHR launch on your behalf (launch context handle + scoped FHIR proxy), CDS Hooks gateway (discovery, signed forwarding, caching) |
| **Backend** | A provider organization | SMART Backend Services + FHIR Bulk Data `$export` with polling, streamed NDJSON, MPI-linked cohorts, scheduled incremental syncs |
| **Feeds** | Your interfaces | HL7v2 over HTTP (ADT, ORU) with ACKs; ingest FHIR bundles retrieved by other vendors |
| **Network** | A treatment relationship | Configuration surface and adapter boundary; exchange itself needs network membership (see [docs/GAPS.md](docs/GAPS.md)) |

On top of every surface: a master patient index, clinical domain models with provenance, exports to
FHIR servers and object storage, signed webhooks, a TypeScript SDK, an MCP server for AI assistants,
and a dashboard that works as a complete no-code control plane.

## Repository layout

```
apps/server      API, hosted patient pages, OAuth/SMART engine, worker, MCP server, Synthetic Hospital
apps/dashboard   React console (served by the API at /app in production)
packages/sdk     @infinimed/sdk, the TypeScript SDK
docs/            Architecture, API reference, gaps and requirements
```

## Quick start (no external services)

Requirements: Node 24.22+ and pnpm 9.

```bash
pnpm install
pnpm --filter @infinimed/dashboard build          # optional: the API serves it at /app
pnpm --filter @infinimed/server seed              # demo account, 10 sample patients, an API key
pnpm dev                                          # API + worker on http://localhost:4000
```

Without `DATABASE_URL`, the server runs on an embedded PostgreSQL (PGlite) under `.data/`, generates
development secrets, and seeds the catalog including the **Synthetic Hospital**, a complete SMART on
FHIR sandbox EHR served by InfiniMed itself. Open `http://localhost:4000/app/`, sign in with the seed
account, and explore.

Connect a patient end to end from your backend:

```ts
import { InfiniMed } from "@infinimed/sdk";

const im = new InfiniMed(process.env.INFINIMED_API_KEY!, { baseUrl: "http://localhost:4000" });

// 1. Start a session and send the patient's browser to session.url
const session = await im.patientSessions.create({
  patient_id: "user_42",
  return_url: "http://localhost:3000/connected",
  return_button_label: "Back to Acme",
});

// 2. After they return (or on the records.sync.completed webhook), read their data
const page = await im.patients.records("user_42", { count: 100 });
const facts = await im.patients.facts("user_42", { concepts: ["hba1c", "bmi"] });
const allergies = await im.patients.model("user_42", "allergies");
```

Search for "Synthetic Hospital" on the hosted page and sign in as any listed patient (password
`synthpass`). The public SMART Health IT sandbox is also preconfigured and works with no registration.

## Production

```bash
pnpm --filter @infinimed/server keys:generate     # MASTER_KEY and SIGNING_KEYS_JSON for your secret manager
cp .env.example .env                              # set PUBLIC_URL (https), DATABASE_URL, secrets
docker compose up --build                         # Postgres + API + worker (+ MinIO, HAPI for export testing)
```

The API and the worker are the same image; run more workers for throughput (`WORKER_INLINE=false` on
API nodes). Jobs use `FOR UPDATE SKIP LOCKED`, so workers scale horizontally on one database.
Vendor sources beyond the built-in sandboxes are loaded from published directories:

```bash
pnpm --filter @infinimed/server catalog:import --vendor epic --env production --url <Epic R4 endpoint bundle URL>
```

Read [docs/GAPS.md](docs/GAPS.md) before going live: production access to every EHR and payer requires
your own registrations, reviews and agreements, and several compliance controls live outside code.

## Testing

```bash
pnpm --filter @infinimed/server test     # 61 tests: unit + end-to-end over real HTTP
pnpm -r typecheck
```

The end-to-end suites start the full server on a random port with an in-memory database and drive
every surface through the SDK: patient access (hosted and direct, denial, refresh, rate limits,
quotas, idempotency, scopes, disconnect), exports (hosted FHIR, custom FHIR, S3 NDJSON/zip, outages and
recovery), SMART EHR launch, CDS Hooks, Bulk Data backend sync, HL7v2, MPI linkage, and the MCP server
(API key and full OAuth with dynamic client registration).

## Documentation

- [Architecture](docs/ARCHITECTURE.md): components, data model, every flow, security model, scaling
- [API reference](docs/API.md): REST endpoints, errors, pagination, idempotency, webhooks
- [SDK](packages/sdk/README.md)
- [Gaps, dependencies and requirements](docs/GAPS.md), including the feature parity matrix
