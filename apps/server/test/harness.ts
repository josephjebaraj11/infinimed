import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { buildConfig, setConfig } from "../src/config.js";
import { resetCryptoCache } from "../src/lib/crypto.js";
import { resetSigningKeys } from "../src/services/keys.js";
import { resetManagedCredentials } from "../src/services/credentials.js";
import { bootstrap } from "../src/bootstrap.js";
import { createApp } from "../src/app.js";
import { closeDb } from "../src/db/client.js";
import { startWorker, type WorkerHandle } from "../src/jobs/worker.js";
import { InfiniMed } from "../../../packages/sdk/src/index.js";

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export type TestServer = {
  url: string;
  worker: WorkerHandle;
  close: () => Promise<void>;
};

export async function startTestServer(extraEnv: Record<string, string> = {}): Promise<TestServer> {
  const port = await freePort();
  const url = `http://localhost:${port}`;
  setConfig(
    buildConfig({
      NODE_ENV: "test",
      PORT: String(port),
      PUBLIC_URL: url,
      DASHBOARD_URL: "http://localhost:5173",
      PGLITE_DIR: "memory://",
      WORKER_INLINE: "false",
      ...extraEnv,
    }),
  );
  resetCryptoCache();
  resetSigningKeys();
  resetManagedCredentials();
  await bootstrap({ pgliteDir: "memory://" });
  const app = createApp();
  const server = serve({ fetch: app.fetch, port });
  const worker = startWorker({ concurrency: 4, pollMs: 40 });
  return {
    url,
    worker,
    close: async () => {
      await worker.stop();
      await new Promise<void>((r) => server.close(() => r()));
      await closeDb();
    },
  };
}

/** Minimal cookie-aware client for the dashboard API. */
export class DashboardClient {
  cookie = "";
  constructor(readonly base: string) {}
  async call<T = Record<string, unknown>>(path: string, body?: unknown, method?: string): Promise<{ status: number; json: T }> {
    const res = await fetch(`${this.base}/dashboard-api${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", "X-InfiniMed-CSRF": "1", Cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0]!;
    return { status: res.status, json: (await res.json()) as T };
  }
  async ok<T = Record<string, unknown>>(path: string, body?: unknown, method?: string): Promise<T> {
    const r = await this.call<T>(path, body, method);
    if (r.status >= 400) throw new Error(`${path} -> ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  }
}

/** Signs up a developer, creates a workspace and an API key; returns SDK + dashboard clients. */
export async function setupWorkspace(server: TestServer, environment: "sandbox" | "production" = "sandbox") {
  const dash = new DashboardClient(server.url);
  await dash.ok("/auth/signup", { email: `dev-${Math.random().toString(36).slice(2)}@example.com`, password: "correct horse battery", name: "Dev Tester", workspace_name: "Acme", environment });
  const me = await dash.ok<{ active_workspace_id: string }>("/me");
  const key = await dash.ok<{ secret: string; id: string }>("/api-keys", { name: "Test backend" });
  const sdk = new InfiniMed(key.secret, { baseUrl: server.url, maxNetworkRetries: 1 });
  return { dash, sdk, apiKey: key.secret, workspaceId: me.active_workspace_id };
}

/** Plays the patient in the browser: hosted page or direct link -> Synthetic Hospital login -> consent. */
export async function completeSyntheticLogin(server: TestServer, sessionUrl: string, opts: { sourceId?: string; patientRow?: string; deny?: boolean } = {}) {
  let authorizeUrl: string;
  if (sessionUrl.endsWith("/start")) {
    const r = await fetch(sessionUrl, { redirect: "manual" });
    authorizeUrl = r.headers.get("location")!;
  } else {
    const token = new URL(sessionUrl).pathname.split("/")[2]!;
    const r = await fetch(`${server.url}/connect/${token}/authorize`, { method: "POST", body: new URLSearchParams({ source_id: opts.sourceId! }), redirect: "manual" });
    authorizeUrl = r.headers.get("location")!;
  }
  const login = await (await fetch(authorizeUrl)).text();
  const req = /name="request" value="([^"]+)"/.exec(login)![1]!;
  const consentPage = await (await fetch(`${server.url}/synthetic/oauth/login`, { method: "POST", body: new URLSearchParams({ request: req, patient: opts.patientRow ?? "syn_1", password: "synthpass" }) })).text();
  const consent = /name="request" value="([^"]+)"/.exec(consentPage)![1]!;
  const r2 = await fetch(`${server.url}/synthetic/oauth/consent`, { method: "POST", body: new URLSearchParams({ request: consent, decision: opts.deny ? "deny" : "approve" }), redirect: "manual" });
  const callback = r2.headers.get("location")!;
  const r3 = await fetch(callback, { redirect: "manual" });
  return { finalRedirect: r3.headers.get("location"), status: r3.status, authorizeUrl };
}

export type Captured = { path: string; method: string; headers: IncomingMessage["headers"]; body: string };

/** Tiny HTTP receiver used as a webhook endpoint, S3 target or CDS service. */
export async function startReceiver(handler?: (req: Captured, res: ServerResponse) => void | Promise<void>) {
  const captured: Captured[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const entry: Captured = { path: req.url ?? "", method: req.method ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      captured.push(entry);
      if (handler) await handler(entry, res);
      else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://localhost:${port}`, captured, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 20_000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
