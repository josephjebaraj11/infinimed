import { InfiniMedError } from "./errors.js";
import { PageRequest } from "./pagination.js";
import { constructEvent, generateTestHeader } from "./webhooks.js";
import type {
  Connection,
  Fact,
  LaunchContext,
  Page,
  Patient,
  PatientSession,
  RecordsPage,
  Source,
  WebhookEndpoint,
  WebhookEventRecord,
} from "./types.js";

export type ClientOptions = {
  /** Defaults to https://api.infinimed.dev. */
  baseUrl?: string;
  /** Retries for 429, 502, 503, 504 and network failures. Default 3. */
  maxNetworkRetries?: number;
  timeoutMs?: number;
  /** Pin the API version (InfiniMed-Version header). */
  apiVersion?: string;
  fetch?: typeof fetch;
};

type Query = Record<string, string | number | boolean | undefined | null>;

const RETRYABLE = new Set([429, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

function qs(q?: Query) {
  if (!q) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

/**
 * InfiniMed API client. Keep the API key on your server: never ship it to browsers or mobile apps.
 *
 *   const im = new InfiniMed(process.env.INFINIMED_API_KEY!);
 *   const session = await im.patientSessions.create({ patient_id: "user_42", return_url: "https://app.example.com/connected" });
 */
export class InfiniMed {
  static webhooks = { constructEvent, generateTestHeader };

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly apiVersion?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, opts: ClientOptions = {}) {
    if (!apiKey) throw new Error("InfiniMed: an API key is required");
    if (typeof window !== "undefined" && typeof (globalThis as { document?: unknown }).document !== "undefined") {
      console.warn("InfiniMed: the SDK appears to run in a browser. API keys are server-side secrets.");
    }
    this.apiKey = apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.infinimed.dev").replace(/\/+$/, "");
    this.maxRetries = opts.maxNetworkRetries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.apiVersion = opts.apiVersion;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Low-level request with retries. Paths are relative to /v1. */
  async request<T>(method: string, path: string, init: { body?: unknown; rawBody?: string; contentType?: string; accept?: string; idempotencyKey?: string } = {}): Promise<T> {
    const url = `${this.baseUrl}/v1${path}`;
    const idempotencyKey = method === "POST" ? (init.idempotencyKey ?? crypto.randomUUID()) : undefined;
    let attempt = 0;
    for (;;) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: init.accept ?? "application/json",
        "User-Agent": "infinimed-sdk-ts/1.0.0",
      };
      if (this.apiVersion) headers["InfiniMed-Version"] = this.apiVersion;
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
      let body: string | undefined;
      if (init.rawBody !== undefined) {
        body = init.rawBody;
        headers["Content-Type"] = init.contentType ?? "text/plain";
      } else if (init.body !== undefined) {
        body = JSON.stringify(init.body);
        headers["Content-Type"] = "application/json";
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, body, signal: controller.signal });
      } catch (err) {
        clearTimeout(timer);
        if (attempt < this.maxRetries) {
          await sleep(Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250);
          attempt++;
          continue;
        }
        throw err;
      }
      clearTimeout(timer);
      const retryAfterHeader = res.headers.get("retry-after");
      const retryAfter = retryAfterHeader && Number.isFinite(Number(retryAfterHeader)) ? Number(retryAfterHeader) : null;
      if (RETRYABLE.has(res.status) && attempt < this.maxRetries) {
        await res.text().catch(() => undefined);
        const wait = retryAfter !== null ? retryAfter * 1000 : Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250;
        await sleep(wait);
        attempt++;
        continue;
      }
      const text = await res.text();
      if (!res.ok) {
        let envelope: { error?: { type?: string; code?: string; message?: string; param?: string | null; request_id?: string; doc_url?: string } } = {};
        try {
          envelope = JSON.parse(text);
        } catch {
          // non-JSON error body
        }
        const e = envelope.error ?? {};
        throw new InfiniMedError({
          type: e.type ?? (res.status >= 500 ? "api_error" : "invalid_request_error"),
          code: e.code ?? `http_${res.status}`,
          message: e.message ?? (text.slice(0, 200) || `HTTP ${res.status}`),
          param: e.param ?? null,
          requestId: e.request_id ?? res.headers.get("x-request-id"),
          docUrl: e.doc_url ?? null,
          statusCode: res.status,
          retryAfter,
        });
      }
      if (init.accept && !init.accept.includes("json")) return text as T;
      return (text ? JSON.parse(text) : {}) as T;
    }
  }

  private list<T, P extends Page<T> = Page<T>>(path: string, query?: Query) {
    return new PageRequest<T, P>((startingAfter) => this.request<P>("GET", `${path}${qs({ ...query, starting_after: startingAfter })}`));
  }

  readonly patients = {
    create: (params: { patient_id: string; email?: string; name?: string; metadata?: Record<string, unknown> }) => this.request<Patient>("POST", "/patients", { body: params }),
    retrieve: (id: string) => this.request<Patient>("GET", `/patients/${enc(id)}`),
    update: (id: string, params: { email?: string | null; name?: string | null; metadata?: Record<string, unknown> }) => this.request<Patient>("PUT", `/patients/${enc(id)}`, { body: params }),
    delete: (id: string) => this.request<{ id: string; resource_type: "patient"; deleted: true }>("DELETE", `/patients/${enc(id)}`),
    list: (params: { limit?: number; email?: string } = {}) => this.list<Patient>("/patients", params),
    /** The patient's stored FHIR resources, snapshot-paginated. */
    records: (id: string, params: { count?: number; type?: string; since?: string; starting_after?: string } = {}) =>
      this.request<RecordsPage>("GET", `/patients/${enc(id)}/records${qs(params)}`),
    /** Iterates every record across pages. */
    allRecords: (id: string, params: { count?: number; type?: string; since?: string } = {}) =>
      new PageRequest<RecordsPage["data"][number], RecordsPage>((startingAfter) => this.request<RecordsPage>("GET", `/patients/${enc(id)}/records${qs({ ...params, starting_after: startingAfter })}`)),
    ingestRecords: (id: string, bundle: unknown, opts: { sourceLabel?: string } = {}) =>
      this.request<{ object: "ingest_result"; source_id: string; connection_id: string; created: number; updated: number; unchanged: number; pull_id: string }>("POST", `/patients/${enc(id)}/records${qs({ source_label: opts.sourceLabel })}`, { body: bundle }),
    listPatientSessions: (id: string, params: { limit?: number } = {}) => this.list<PatientSession>(`/patients/${enc(id)}/patient-sessions`, params),
    disconnectConnection: (id: string, connectionId: string) =>
      this.request<{ id: string; resource_type: "connection"; disconnected: true }>("DELETE", `/patients/${enc(id)}/connections/${enc(connectionId)}`),
    pull: (id: string, connectionId: string) => this.request<{ queued: boolean }>("POST", `/patients/${enc(id)}/connections/${enc(connectionId)}/pull`),
    facts: (id: string, params: { concepts?: string[]; aggregate?: "latest" | "earliest" | "min" | "max" | "mean" | "count" | "all"; from?: string; to?: string } = {}) =>
      this.request<{ object: "list"; data: Fact[] }>("GET", `/patients/${enc(id)}/facts${qs({ ...params, concepts: params.concepts?.join(",") })}`),
    model: <Row = Record<string, unknown>>(id: string, model: string) => this.request<{ object: "list"; resource_type: string; data: Row[] }>("GET", `/patients/${enc(id)}/models/${enc(model)}`),
    identities: (id: string) => this.request<Page<Record<string, unknown>>>("GET", `/patients/${enc(id)}/identities`),
    pulls: (id: string) => this.request<Page<Record<string, unknown>>>("GET", `/patients/${enc(id)}/pulls`),
    authEvents: (id: string) => this.request<Page<Record<string, unknown>>>("GET", `/patients/${enc(id)}/auth-events`),
  };

  readonly patientSessions = {
    /** Starts a session; send the patient's browser to `session.url`. */
    create: (params: {
      patient_id: string;
      return_url: string;
      patient_email?: string;
      patient_name?: string;
      source_id?: string;
      recommended_source_ids?: string[];
      return_button_label?: string;
      metadata?: Record<string, unknown>;
      expires_in?: number;
    }) => this.request<PatientSession & { url: string }>("POST", "/patient-sessions", { body: params }),
    retrieve: (id: string) => this.request<PatientSession>("GET", `/patient-sessions/${enc(id)}`),
  };

  readonly sources = {
    list: (params: { q?: string; type?: string; surface?: string; limit?: number } = {}) => this.list<Source>("/sources", params),
    /** Accepts a `src_*` id or a FHIR base URL. */
    retrieve: (idOrBaseUrl: string) => this.request<Source>("GET", `/sources/${enc(idOrBaseUrl)}`),
  };

  readonly webhooks = {
    create: (params: { url: string; events: string[]; description?: string; metadata?: Record<string, unknown> }) => this.request<WebhookEndpoint & { secret: string }>("POST", "/webhooks", { body: params }),
    retrieve: (id: string) => this.request<WebhookEndpoint>("GET", `/webhooks/${enc(id)}`),
    list: (params: { limit?: number; status?: "active" | "disabled" } = {}) => this.list<WebhookEndpoint>("/webhooks", params),
    update: (id: string, params: { url?: string; events?: string[]; description?: string | null; metadata?: Record<string, unknown>; status?: "active" | "disabled" }) =>
      this.request<WebhookEndpoint>("PATCH", `/webhooks/${enc(id)}`, { body: params }),
    delete: (id: string) => this.request<{ id: string; deleted: true }>("DELETE", `/webhooks/${enc(id)}`),
    rotateSecret: (id: string) => this.request<WebhookEndpoint & { secret: string }>("POST", `/webhooks/${enc(id)}/rotate-secret`),
    listEvents: (id: string, params: { limit?: number } = {}) => this.list<WebhookEventRecord>(`/webhooks/${enc(id)}/events`, params),
  };

  readonly events = {
    redeliver: (eventId: string, params: { endpoint_id?: string } = {}) => this.request<WebhookEventRecord>("POST", `/events/${enc(eventId)}/redeliver`, { body: params }),
    list: (params: { type?: string; limit?: number } = {}) => this.list<{ id: string; type: string; created_at: string; data: { object: unknown } }>("/events", params),
  };

  readonly launchContexts = {
    retrieve: (id: string) => this.request<LaunchContext>("GET", `/launch-contexts/${enc(id)}`),
    /** Read FHIR from the EHR through the launch-scoped proxy, e.g. fhir(id, "Patient/123"). */
    fhir: <T = Record<string, unknown>>(id: string, path: string, query?: Query) => this.request<T>("GET", `/launch-contexts/${enc(id)}/fhir/${path}${qs(query)}`, { accept: "application/fhir+json, application/json" }),
  };

  readonly exports = {
    list: () => this.request<Page<Record<string, unknown>>>("GET", "/export-destinations"),
    create: (params: Record<string, unknown>) => this.request<Record<string, unknown>>("POST", "/export-destinations", { body: params }),
    retrieve: (id: string) => this.request<Record<string, unknown>>("GET", `/export-destinations/${enc(id)}`),
    update: (id: string, params: Record<string, unknown>) => this.request<Record<string, unknown>>("PATCH", `/export-destinations/${enc(id)}`, { body: params }),
    delete: (id: string) => this.request<{ id: string; deleted: true }>("DELETE", `/export-destinations/${enc(id)}`),
    retryRun: (id: string, runId: string) => this.request<{ queued: boolean }>("POST", `/export-destinations/${enc(id)}/runs/${enc(runId)}/retry`),
  };

  readonly backendSyncs = {
    create: (params: { source_id: string; group_id: string; full?: boolean }) => this.request<Record<string, unknown>>("POST", "/backend-syncs", { body: params }),
    retrieve: (id: string) => this.request<Record<string, unknown>>("GET", `/backend-syncs/${enc(id)}`),
    list: () => this.request<Page<Record<string, unknown>>>("GET", "/backend-syncs"),
  };

  readonly ingest = {
    /** Sends one HL7v2 message; returns the ACK. */
    hl7v2: (message: string, opts: { feed?: string; createPatients?: boolean } = {}) =>
      this.request<{ object: "hl7v2_ack"; ack: string; accepted: boolean; patient_id?: string }>("POST", `/ingest/hl7v2${qs({ feed: opts.feed, create_patients: opts.createPatients })}`, {
        rawBody: message,
        contentType: "x-application/hl7-v2+er7",
        accept: "application/json",
      }).then((r) => (typeof r === "string" ? (JSON.parse(r) as { object: "hl7v2_ack"; ack: string; accepted: boolean; patient_id?: string }) : r)),
  };

  readonly concepts = {
    list: () => this.request<{ object: "list"; data: { code: string; display: string; category: string; unit: string | null; loinc: string[] }[] }>("GET", "/concepts"),
  };
}

export type { Connection };
