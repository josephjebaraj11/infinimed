import { fetchWithTimeout, parseRetryAfter, readTextSafe, sleep } from "../lib/http.js";

/**
 * FHIR REST client used by pulls, backend sync and the launch-context proxy.
 *   - per-base token bucket that honours the vendor's published request budget
 *   - 401 -> one forced token refresh, then retry
 *   - 429 -> wait Retry-After when short; otherwise throw RateLimitedError so the job is deferred
 *   - 5xx / network errors -> bounded exponential backoff
 *   - Bundle paging follows `link[relation=next]` only on the same origin as the base URL
 */

export type FhirResource = { resourceType: string; id?: string; [key: string]: unknown };
export type Bundle = { resourceType: "Bundle"; type?: string; total?: number; entry?: { resource?: FhirResource; search?: { mode?: string } }[]; link?: { relation: string; url: string }[] };

export class FhirHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`FHIR ${status} for ${safePath(url)}`);
    this.name = "FhirHttpError";
  }
}

export class RateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`rate limited for ${retryAfterSeconds}s`);
    this.name = "RateLimitedError";
  }
}

function safePath(url: string) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "invalid-url";
  }
}

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(private readonly perMinute: number) {
    this.tokens = Math.max(1, Math.min(perMinute, 30));
  }
  async take() {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.perMinute, this.tokens + ((now - this.last) / 60_000) * this.perMinute);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this.tokens) / this.perMinute) * 60_000));
    }
  }
}

const buckets = new Map<string, TokenBucket>();
function bucketFor(base: string, perMinute: number) {
  const key = new URL(base).origin + new URL(base).pathname;
  let b = buckets.get(key);
  if (!b) {
    b = new TokenBucket(perMinute);
    buckets.set(key, b);
  }
  return b;
}

export type TokenProvider = (forceRefresh?: boolean) => Promise<string | null>;

export class FhirClient {
  readonly base: string;
  private readonly origin: string;
  requests = 0;

  constructor(
    base: string,
    private readonly token: TokenProvider,
    private readonly opts: { requestsPerMinute?: number; maxInlineWaitSeconds?: number; timeoutMs?: number; extraHeaders?: Record<string, string> } = {},
  ) {
    this.base = base.replace(/\/+$/, "");
    this.origin = new URL(this.base).origin;
  }

  async request(url: string, init: { method?: string; body?: string; headers?: Record<string, string>; accept?: string } = {}): Promise<Response> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      await bucketFor(this.base, this.opts.requestsPerMinute ?? 120).take();
      const tok = await this.token(false);
      const headers: Record<string, string> = {
        Accept: init.accept ?? "application/fhir+json",
        ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
        ...(this.opts.extraHeaders ?? {}),
        ...(init.headers ?? {}),
      };
      let res: Response;
      try {
        this.requests++;
        res = await fetchWithTimeout(url, { method: init.method ?? "GET", headers, body: init.body, timeoutMs: this.opts.timeoutMs ?? 60_000 });
      } catch (err) {
        if (attempt < 3) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw err;
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await readTextSafe(res, 256);
        const next = await this.token(true);
        if (next) continue;
      }
      if (res.status === 429) {
        const wait = parseRetryAfter(res.headers.get("retry-after")) ?? 30;
        await readTextSafe(res, 256);
        if (wait <= (this.opts.maxInlineWaitSeconds ?? 20) && attempt < 5) {
          await sleep(wait * 1000);
          continue;
        }
        throw new RateLimitedError(wait);
      }
      if (res.status >= 500 && attempt < 3) {
        await readTextSafe(res, 256);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      return res;
    }
  }

  async getJson<T = FhirResource>(urlOrPath: string): Promise<T> {
    const url = urlOrPath.startsWith("http") ? urlOrPath : `${this.base}/${urlOrPath.replace(/^\//, "")}`;
    const res = await this.request(url);
    if (!res.ok) throw new FhirHttpError(res.status, await readTextSafe(res, 2048), url);
    return (await res.json()) as T;
  }

  read(resourceType: string, id: string) {
    return this.getJson<FhirResource>(`${resourceType}/${encodeURIComponent(id)}`);
  }

  /** Runs a search and calls onPage for every page of matched resources. Returns totals. */
  async searchAll(
    resourceType: string,
    params: Record<string, string>,
    onPage: (resources: FhirResource[]) => Promise<void>,
    opts: { maxPages?: number; count?: number } = {},
  ): Promise<{ resources: number; pages: number; truncated: boolean }> {
    const qs = new URLSearchParams(params);
    if (opts.count && !qs.has("_count")) qs.set("_count", String(opts.count));
    let url: string | null = `${this.base}/${resourceType}?${qs.toString()}`;
    let pages = 0;
    let resources = 0;
    const maxPages = opts.maxPages ?? 200;
    const seenUrls = new Set<string>();
    while (url && pages < maxPages) {
      if (seenUrls.has(url)) break;
      seenUrls.add(url);
      const bundle: Bundle = await this.getJson<Bundle>(url);
      pages++;
      const matched = (bundle.entry ?? [])
        .filter((e) => e.resource && (e.search?.mode === undefined || e.search.mode === "match" || e.search.mode === "include"))
        .map((e) => e.resource!)
        // OperationOutcome entries carry warnings, not data.
        .filter((r) => r.resourceType !== "OperationOutcome");
      resources += matched.length;
      if (matched.length) await onPage(matched);
      const next: string | undefined = bundle.link?.find((l) => l.relation === "next")?.url;
      url = next && sameOrigin(next, this.origin) ? next : null;
    }
    return { resources, pages, truncated: !!url };
  }
}

function sameOrigin(url: string, origin: string) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Collects `Type/id` relative references anywhere inside a resource. */
export function collectReferences(resource: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(resource)) {
    for (const v of resource) collectReferences(v, out);
  } else if (resource && typeof resource === "object") {
    for (const [k, v] of Object.entries(resource)) {
      if (k === "reference" && typeof v === "string") {
        const m = /^(?:[a-z]+:\/\/[^\s]+\/)?([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})(?:\/_history\/.*)?$/.exec(v);
        if (m) out.add(`${m[1]}/${m[2]}`);
      } else if (typeof v === "object") collectReferences(v, out);
    }
  }
  return out;
}
