import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { InfiniMed, InfiniMedError, constructEvent, isInfiniMedError } from "../../../packages/sdk/src/index.js";
import { db } from "../src/db/client.js";
import { connections, syntheticTokens, workspaces } from "../src/db/schema.js";
import { getAccessToken } from "../src/services/connections.js";
import { syntheticFaults } from "../src/synthetic/routes.js";
import { completeSyntheticLogin, setupWorkspace, startReceiver, startTestServer, waitFor, type TestServer } from "./harness.js";

let server: TestServer;
let sdk: InfiniMed;
let apiKey: string;
let workspaceId: string;
let dash: Awaited<ReturnType<typeof setupWorkspace>>["dash"];
let receiver: Awaited<ReturnType<typeof startReceiver>>;
let webhookSecret: string;
let syntheticId: string;

beforeAll(async () => {
  server = await startTestServer();
  ({ sdk, apiKey, workspaceId, dash } = await setupWorkspace(server));
  receiver = await startReceiver();
  const endpoint = await sdk.webhooks.create({ url: `${receiver.url}/hooks`, events: ["*"], description: "test receiver" });
  webhookSecret = endpoint.secret;
  const sources = await sdk.sources.list({ q: "synthetic" });
  syntheticId = sources.data[0]!.id;
});

afterAll(async () => {
  await receiver?.close();
  await server?.close();
});

async function connectPatient(patientId: string, opts: { patientRow?: string; name?: string } = {}) {
  const session = await sdk.patientSessions.create({ patient_id: patientId, patient_name: opts.name, source_id: syntheticId, return_url: "https://app.example.com/connected" });
  const result = await completeSyntheticLogin(server, session.url, { patientRow: opts.patientRow });
  await server.worker.drain();
  return { session, result };
}

describe("catalog", () => {
  test("search, filter and retrieve by id or FHIR base URL", async () => {
    const page = await sdk.sources.list({ q: "epic" });
    expect(page.data.some((s) => s.type === "epic")).toBe(true);
    const syn = await sdk.sources.retrieve(syntheticId);
    expect(syn.name).toBe("Synthetic Hospital");
    const byUrl = await sdk.sources.retrieve(syn.fhir_base_url!);
    expect(byUrl.id).toBe(syntheticId);
    const all = await sdk.sources.list({ limit: 2 }).toArray(50);
    expect(all.length).toBeGreaterThan(2);
    // sandbox workspaces never see production sources
    expect(all.every((s) => s.environment === "sandbox")).toBe(true);
  });
});

describe("patient access, direct mode", () => {
  test("connect, pull, read records, events", async () => {
    const { session, result } = await connectPatient("user_42", { name: "Marisol Ventura" });
    expect(result.status).toBe(302);
    const back = new URL(result.finalRedirect!);
    expect(back.origin).toBe("https://app.example.com");
    expect(back.searchParams.get("success")).toBe("true");
    expect(back.searchParams.get("patient_session_id")).toBe(session.id);

    const patient = await sdk.patients.retrieve("user_42");
    expect(patient.connections).toHaveLength(1);
    expect(patient.connections[0]).toMatchObject({ status: "active", facility: { name: "Synthetic Hospital" } });
    expect(patient.activated_at).not.toBeNull();

    const s = await sdk.patientSessions.retrieve(session.id);
    expect(s.status).toBe("complete");

    const first = await sdk.patients.records("user_42", { count: 25 });
    expect(first.data[0]!.resource.resourceType).toBe("Patient");
    expect(first.data[0]!.resource.identifier).toContainEqual({ system: "urn:infinimed:patient-id", value: "user_42" });
    const all = await sdk.patients.allRecords("user_42", { count: 50 }).toArray();
    expect(new Set(all.map((r) => `${r.resource.resourceType}/${r.resource.id}`)).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(100);
    // references were followed
    expect(all.some((r) => r.resource.resourceType === "Practitioner")).toBe(true);

    const filtered = await sdk.patients.records("user_42", { type: "Condition,AllergyIntolerance", count: 100 });
    expect(filtered.data.every((r) => ["Condition", "AllergyIntolerance"].includes(r.resource.resourceType))).toBe(true);

    await waitFor(async () => receiver.captured.filter((c) => c.path === "/hooks").length >= 2);
    const types = [];
    for (const c of receiver.captured) {
      const evt = await constructEvent(c.body, c.headers["infinimed-signature"] as string, webhookSecret);
      types.push(evt.type);
    }
    expect(types).toEqual(expect.arrayContaining(["patient_session.completed", "records.sync.completed"]));
  });

  test("snapshot pagination: records added mid-read do not shift pages; filters are bound to the cursor", async () => {
    const page1 = await sdk.patients.records("user_42", { count: 10 });
    await sdk.patients.ingestRecords("user_42", { resourceType: "Bundle", type: "collection", entry: [{ resource: { resourceType: "Observation", id: "late-1", status: "final", code: { text: "x" } } }] }, { sourceLabel: "lab-feed" });
    const seen = new Set(page1.data.map((d) => d.resource.id));
    let cursor = page1.next_cursor;
    while (cursor) {
      const next = await sdk.patients.records("user_42", { count: 50, starting_after: cursor });
      for (const d of next.data) {
        expect(seen.has(d.resource.id)).toBe(false);
        seen.add(d.resource.id);
      }
      cursor = next.next_cursor;
    }
    expect(seen.has("late-1")).toBe(false);
    const fresh = await sdk.patients.allRecords("user_42", { count: 100 }).toArray();
    expect(fresh.some((d) => d.resource.id === "late-1")).toBe(true);
    await expect(sdk.patients.records("user_42", { count: 10, type: "Condition", starting_after: page1.next_cursor! })).rejects.toMatchObject({ code: "bad_request" });
  });

  test("since filter returns only later changes", async () => {
    const since = new Date().toISOString();
    await sdk.patients.ingestRecords("user_42", [{ resourceType: "Observation", id: "late-2", status: "final", code: { text: "y" } }], { sourceLabel: "lab-feed" });
    const page = await sdk.patients.records("user_42", { since, count: 100 });
    expect(page.data.map((d) => d.resource.id)).toEqual(["late-2"]);
    await expect(sdk.patients.records("user_42", { since: "yesterday" })).rejects.toMatchObject({ code: "bad_request", param: "since" });
  });

  test("facts and models", async () => {
    const facts = await sdk.patients.facts("user_42", { concepts: ["bmi", "hba1c", "body_weight", "bp_systolic"] });
    for (const f of facts.data) {
      expect(f.status).toBe("hasValue");
      expect(f.provenance.length).toBeGreaterThan(0);
      expect(f.provenance[0]!.source).toBe(syntheticId);
    }
    const weight = facts.data.find((f) => f.code === "body_weight")!;
    expect(weight.unit).toBe("kg");
    const series = await sdk.patients.facts("user_42", { concepts: ["body_weight"], aggregate: "all" });
    expect(series.data[0]!.series!.length).toBeGreaterThan(5);
    const meds = await sdk.patients.model("user_42", "medications");
    expect(meds.data.length).toBeGreaterThan(0);
    const conditions = await sdk.patients.model<{ codes: { system: string }[] }>("user_42", "conditions");
    expect(conditions.data[0]!.codes.some((c) => c.system === "http://snomed.info/sct")).toBe(true);
    await expect(sdk.patients.model("user_42", "nope")).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("patient access, hosted mode and failures", () => {
  test("hosted search page, recommended sources, denial, completion", async () => {
    const session = await sdk.patientSessions.create({ patient_id: "user_99", recommended_source_ids: [syntheticId], return_url: "https://app.example.com/back", return_button_label: "Back to Acme" });
    expect(session.mode).toBe("hosted");
    const page = await (await fetch(session.url)).text();
    expect(page).toContain("Suggested for you");
    expect(page).toContain("Synthetic Hospital");
    const denied = await completeSyntheticLogin(server, session.url, { sourceId: syntheticId, deny: true });
    expect(denied.finalRedirect).toContain("failed=");
    const s = await sdk.patientSessions.retrieve(session.id);
    expect(s.connections[0]).toMatchObject({ status: "failed", failure_code: "user_denied" });
    const ok = await completeSyntheticLogin(server, session.url, { sourceId: syntheticId, patientRow: "syn_2" });
    expect(ok.finalRedirect).toContain("connected=");
    const token = new URL(session.url).pathname.split("/")[2];
    const done = await (await fetch(`${server.url}/connect/${token}/complete`, { method: "POST" })).text();
    expect(done).toContain("Back to Acme");
    expect(done).toContain("patient_session_id=");
    const after = await sdk.patients.retrieve("user_99");
    // the failed attempt was superseded by the successful connection
    expect(after.connections.map((c) => c.status)).toEqual(["active"]);
  });

  test("validation errors use the error envelope", async () => {
    await expect(sdk.patientSessions.create({ patient_id: "x", return_url: "ftp://nope" })).rejects.toMatchObject({ type: "invalid_request_error", param: "return_url" });
    await expect(sdk.patientSessions.create({ patient_id: "x", return_url: "https://a.example", source_id: syntheticId, recommended_source_ids: [syntheticId] })).rejects.toMatchObject({ code: "bad_request" });
    await expect(sdk.patientSessions.create({ patient_id: "x", return_url: "https://a.example", source_id: "src_missing" })).rejects.toMatchObject({ code: "resource_not_found" });
    await expect(sdk.patients.create({ patient_id: "im_reserved" })).rejects.toMatchObject({ code: "invalid_data" });
    await sdk.patients.create({ patient_id: "dup-1" });
    const err = await sdk.patients.create({ patient_id: "dup-1" }).catch((e) => e);
    expect(isInfiniMedError(err)).toBe(true);
    expect(err).toMatchObject({ code: "external_id_already_exists", statusCode: 409 });
    expect((err as InfiniMedError).requestId).toBeTruthy();
    const bad = new InfiniMed("im_sk_sbx_wrong", { baseUrl: server.url, maxNetworkRetries: 0 });
    await expect(bad.patients.list()).rejects.toMatchObject({ code: "invalid_api_key", statusCode: 401 });
    const res = await fetch(`${server.url}/v1/patients`, { headers: { Authorization: `Bearer ${apiKey}`, "InfiniMed-Version": "1999-01-01" } });
    expect(res.status).toBe(400);
  });

  test("MPI flags a connection whose demographics do not match the patient", async () => {
    await connectPatient("user_mpi", { name: "Marisol Ventura", patientRow: "syn_1" });
    const s2 = await sdk.patientSessions.create({ patient_id: "user_mpi", source_id: syntheticId, return_url: "https://app.example.com/x" });
    await completeSyntheticLogin(server, s2.url, { patientRow: "syn_6" });
    await server.worker.drain();
    const ids = await sdk.patients.identities("user_mpi");
    const statuses = ids.data.map((i) => i.match_status);
    expect(statuses).toContain("anchor");
    expect(statuses).toContain("mismatch");
  });
});

describe("tokens and resilience", () => {
  test("rolling refresh keeps access alive; a dead refresh token marks refresh_failed and emits an event", async () => {
    const p = await sdk.patients.retrieve("user_42");
    const connId = p.connections.find((c) => c.facility?.type === "synthetic")!.id;
    await db().update(connections).set({ accessTokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(connections.id, connId));
    const before = (await db().select().from(connections).where(eq(connections.id, connId)))[0]!;
    await getAccessToken(connId);
    const after = (await db().select().from(connections).where(eq(connections.id, connId)))[0]!;
    expect(after.refreshTokenEnc).not.toBe(before.refreshTokenEnc);
    expect(after.accessTokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    // Revoke every refresh token at the synthetic hospital, then force a refresh.
    await db().update(syntheticTokens).set({ consumedAt: new Date() }).where(eq(syntheticTokens.kind, "refresh"));
    await db().update(connections).set({ accessTokenExpiresAt: new Date(Date.now() - 1000) }).where(eq(connections.id, connId));
    await expect(getAccessToken(connId)).rejects.toThrow(/refresh_failed/);
    const p2 = await sdk.patients.retrieve("user_42");
    expect(p2.connections.find((c) => c.id === connId)!.status).toBe("refresh_failed");
    // the external feed connection is untouched
    expect(p2.connections.filter((c) => c.facility?.type === "external").every((c) => c.status === "active")).toBe(true);
    await server.worker.drain();
    await waitFor(async () => {
      for (const c of receiver.captured) {
        const evt = await constructEvent(c.body, c.headers["infinimed-signature"] as string, webhookSecret);
        if (evt.type === "connection.token_refresh_failed" && evt.data.object.id === connId) return true;
      }
      return false;
    });
    // auth event trail records the failure
    const events = await sdk.patients.authEvents("user_42");
    expect(events.data.some((e) => e.step === "refresh" && e.status === "failure")).toBe(true);
  });

  test("source rate limits defer the pull instead of failing it; forbidden resource types are skipped", async () => {
    syntheticFaults.rateLimitOnce = true;
    syntheticFaults.failSearchFor.add("Device");
    const { session } = await connectPatient("user_rl", { patientRow: "syn_3" });
    void session;
    await waitFor(async () => (await sdk.patients.retrieve("user_rl")).activated_at, 30_000);
    const pulls = await sdk.patients.pulls("user_rl");
    const pull = pulls.data[0]!;
    expect(pull.status).toBe("completed");
    expect((pull.details as Record<string, { skipped?: boolean; status?: number }>).Device).toMatchObject({ skipped: true, status: 403 });
    syntheticFaults.failSearchFor.clear();
  });

  test("manual pull and disconnect", async () => {
    const p = await sdk.patients.retrieve("user_99");
    const connId = p.connections[0]!.id;
    const queued = await sdk.patients.pull("user_99", connId);
    expect(queued.queued).toBe(true);
    await server.worker.drain();
    const recordsBefore = await sdk.patients.records("user_99", { count: 5 });
    expect(recordsBefore.data.length).toBeGreaterThan(0);
    const result = await sdk.patients.disconnectConnection("user_99", connId);
    expect(result).toEqual({ id: connId, resource_type: "connection", disconnected: true });
    const recordsAfter = await sdk.patients.records("user_99", { count: 5 });
    expect(recordsAfter.data).toHaveLength(0);
    expect((await sdk.patients.retrieve("user_99")).connections[0]!.status).toBe("disconnected");
  });

  test("idempotency keys replay the original response", async () => {
    const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": "abc-123" };
    const body = JSON.stringify({ patient_id: "idem-1" });
    const r1 = await fetch(`${server.url}/v1/patients`, { method: "POST", headers, body });
    const r2 = await fetch(`${server.url}/v1/patients`, { method: "POST", headers, body });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    const r3 = await fetch(`${server.url}/v1/patients`, { method: "POST", headers, body: JSON.stringify({ patient_id: "idem-2" }) });
    expect(r3.status).toBe(400);
  });

  test("API key scopes are enforced", async () => {
    const key = await dash.ok<{ secret: string }>("/api-keys", { name: "read only", scopes: ["patients:read"] });
    const ro = new InfiniMed(key.secret, { baseUrl: server.url, maxNetworkRetries: 0 });
    await ro.patients.list();
    await expect(ro.patients.create({ patient_id: "nope" })).rejects.toMatchObject({ code: "insufficient_scope", statusCode: 403 });
  });

  test("free-plan quota blocks new patient activation with billing_error", async () => {
    await db().update(workspaces).set({ environment: "sandbox", patientQuotaOverride: 1 }).where(eq(workspaces.id, workspaceId));
    await connectPatient("user_quota", { patientRow: "syn_4" });
    const pulls = await sdk.patients.pulls("user_quota");
    expect(pulls.data[0]).toMatchObject({ status: "failed", error_code: "quota_exceeded" });
    await db().update(workspaces).set({ patientQuotaOverride: null }).where(eq(workspaces.id, workspaceId));
  });

  test("delete patient removes everything", async () => {
    const res = await sdk.patients.delete("user_rl");
    expect(res.deleted).toBe(true);
    await expect(sdk.patients.retrieve("user_rl")).rejects.toMatchObject({ statusCode: 404 });
  });
});
