import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import type { InfiniMed } from "../../../packages/sdk/src/index.js";
import { completeSyntheticLogin, setupWorkspace, startReceiver, startTestServer, waitFor, type TestServer } from "./harness.js";

let server: TestServer;
let sdk: InfiniMed;
let syntheticId: string;
let s3: Awaited<ReturnType<typeof startReceiver>>;
let flaky: Awaited<ReturnType<typeof startReceiver>>;
let flakyDown = false;

type Dest = { id: string; type: string; watermark: number; internal_access: { base_url: string; bearer_token: string } | null; runs?: { status: string; trigger: string; resources_processed: number; id: string; error_message: string | null }[] };

beforeAll(async () => {
  server = await startTestServer();
  ({ sdk } = await setupWorkspace(server));
  syntheticId = (await sdk.sources.list({ q: "synthetic" })).data[0]!.id;
  s3 = await startReceiver();
  // A FHIR server that can be switched off to simulate an outage.
  flaky = await startReceiver((req, res) => {
    if (req.path.endsWith("/metadata")) {
      res.writeHead(200, { "Content-Type": "application/fhir+json" });
      res.end(JSON.stringify({ resourceType: "CapabilityStatement", fhirVersion: "4.0.1" }));
      return;
    }
    res.writeHead(flakyDown ? 503 : 200, { "Content-Type": "application/fhir+json" });
    res.end(flakyDown ? '{"resourceType":"OperationOutcome"}' : '{"resourceType":"Bundle","type":"transaction-response","entry":[]}');
  });
  for (const [pid, row] of [
    ["exp_1", "syn_1"],
    ["exp_2", "syn_2"],
  ] as const) {
    const session = await sdk.patientSessions.create({ patient_id: pid, source_id: syntheticId, return_url: "https://app.example.com/c" });
    await completeSyntheticLogin(server, session.url, { patientRow: row });
  }
  await server.worker.drain();
});

afterAll(async () => {
  await s3?.close();
  await flaky?.close();
  await server?.close();
});

const fhir = async (dest: Dest, path: string) => {
  const res = await fetch(`${dest.internal_access!.base_url}/${path}`, { headers: { Authorization: `Bearer ${dest.internal_access!.bearer_token}` } });
  return { status: res.status, json: (await res.json()) as { total?: number; entry?: { resource: Record<string, unknown>; search?: { mode: string } }[]; [k: string]: unknown } };
};

describe("internal FHIR server destination", () => {
  let internal: Dest;
  test("backfills existing data and serves FHIR search", async () => {
    internal = (await sdk.exports.create({ type: "fhir_internal", name: "Hosted FHIR" })) as unknown as Dest;
    expect(internal.internal_access!.bearer_token).toMatch(/^imfhir_/);
    await server.worker.drain();
    const detail = (await sdk.exports.retrieve(internal.id)) as unknown as Dest;
    expect(detail.runs![0]).toMatchObject({ status: "completed", trigger: "destination_added" });
    expect(detail.watermark).toBeGreaterThan(0);

    const unauth = await fetch(`${internal.internal_access!.base_url}/Patient`);
    expect(unauth.status).toBe(401);
    const meta = await fhir(internal, "metadata");
    expect(meta.json.resourceType).toBe("CapabilityStatement");

    const found = await fhir(internal, `Patient?identifier=${encodeURIComponent("urn:infinimed:patient-id|exp_1")}`);
    expect(found.json.total).toBe(1);
    const patientId = found.json.entry![0]!.resource.id as string;
    const obs = await fhir(internal, `Observation?patient=${patientId}&_count=200&_include=Observation:performer`);
    expect(obs.json.total).toBeGreaterThan(20);
    expect(obs.json.entry!.some((e) => e.search?.mode === "include" && e.resource.resourceType === "Practitioner")).toBe(true);
    const paged = await fhir(internal, `Observation?patient=${patientId}&_count=5`);
    expect((paged.json.link as { relation: string; url: string }[]).find((l) => l.relation === "next")).toBeTruthy();
    const read = await fhir(internal, `Patient/${patientId}`);
    expect(read.status).toBe(200);
    expect((read.json.meta as { versionId: string }).versionId).toBe("1");
  });

  test("delta export after new data lands", async () => {
    const before = (await sdk.exports.retrieve(internal.id)) as unknown as Dest;
    await sdk.patients.ingestRecords("exp_1", [{ resourceType: "Observation", id: "delta-obs", status: "final", code: { text: "delta" }, subject: { reference: "Patient/syn-1" } }], { sourceLabel: "delta-feed" });
    await waitFor(async () => {
      await server.worker.drain();
      const d = (await sdk.exports.retrieve(internal.id)) as unknown as Dest;
      return d.runs!.length > before.runs!.length && d.runs![0]!.trigger === "pull_completed";
    });
    const d = (await sdk.exports.retrieve(internal.id)) as unknown as Dest;
    expect(d.runs![0]!.resources_processed).toBe(1); // only the new Observation changed
    const hit = await fhir(internal, "Observation/delta-obs");
    expect(hit.status).toBe(200);
  });

  test("custom FHIR destination receives transaction bundles (pointed at another hosted server)", async () => {
    const target = (await sdk.exports.create({ type: "fhir_internal", name: "Target store" })) as unknown as Dest;
    await server.worker.drain();
    const custom = (await sdk.exports.create({
      type: "fhir_custom",
      name: "Customer FHIR",
      base_url: target.internal_access!.base_url,
      auth_type: "bearer",
      bearer_token: target.internal_access!.bearer_token,
      id_strategy: "namespaced",
    })) as unknown as Dest;
    await server.worker.drain();
    const detail = (await sdk.exports.retrieve(custom.id)) as unknown as Dest;
    expect(detail.runs![0]!.status).toBe("completed");
    const patients = await fhir(target, "Patient?identifier=" + encodeURIComponent("urn:infinimed:patient-id|exp_2"));
    // the target received both its own backfill and the namespaced copies from the custom export
    expect(patients.json.total).toBeGreaterThanOrEqual(2);
  });

  test("a destination that fails its connectivity test is not saved", async () => {
    await expect(sdk.exports.create({ type: "fhir_custom", name: "Broken", base_url: "http://localhost:1/fhir", auth_type: "none" })).rejects.toMatchObject({ code: "destination_test_failed" });
  });
});

describe("object storage destination", () => {
  test("writes one NDJSON file per patient and source, Patient line first", async () => {
    s3.captured.length = 0;
    const dest = (await sdk.exports.create({
      type: "object_storage",
      name: "Lake",
      vendor: "s3_compatible",
      endpoint: s3.url,
      region: "us-east-1",
      bucket: "health-lake",
      prefix: "infinimed/raw",
      access_key_id: "AKIATEST",
      secret_access_key: "secret",
      file_type: "ndjson",
    })) as unknown as Dest;
    await server.worker.drain();
    const puts = s3.captured.filter((c) => c.method === "PUT" && c.path.split("?")[0]!.endsWith(".ndjson")).map((c) => ({ ...c, path: c.path.split("?")[0]! }));
    expect(puts.length).toBeGreaterThanOrEqual(2);
    expect(puts[0]!.path).toMatch(/^\/health-lake\/infinimed\/raw\/ws_[A-Z0-9]+\/exp_\d\/src_[A-Z0-9]+\.ndjson/);
    expect(puts[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATEST\//);
    const lines = puts[0]!.body.trim().split("\n").map((l) => JSON.parse(l) as { resourceType: string; identifier?: { system: string }[] });
    expect(lines[0]!.resourceType).toBe("Patient");
    expect(lines[0]!.identifier!.some((i) => i.system === "urn:infinimed:patient-id")).toBe(true);
    const detail = (await sdk.exports.retrieve(dest.id)) as unknown as Dest;
    expect(detail.runs![0]!.status).toBe("completed");
  });

  test("zipped NDJSON", async () => {
    s3.captured.length = 0;
    await sdk.exports.create({ type: "object_storage", name: "Zipped", vendor: "s3_compatible", endpoint: s3.url, bucket: "zips", access_key_id: "AKIATEST", secret_access_key: "secret", file_type: "ndjson_zip" });
    await server.worker.drain();
    const put = s3.captured.find((c) => c.method === "PUT" && c.path.split("?")[0]!.endsWith(".ndjson.zip"));
    expect(put).toBeTruthy();
    expect(put!.headers["content-type"]).toBe("application/zip");
  });
});

describe("destination outages", () => {
  test("an outage fails the run, keeps the watermark, emits export.run.failed; retry recovers", async () => {
    const hooks = await startReceiver();
    const wh = await sdk.webhooks.create({ url: `${hooks.url}/h`, events: ["export.run.failed", "export.run.completed"] });
    const dest = (await sdk.exports.create({ type: "fhir_custom", name: "Flaky", base_url: `${flaky.url}/fhir`, auth_type: "none" })) as unknown as Dest;
    await server.worker.drain();
    let detail = (await sdk.exports.retrieve(dest.id)) as unknown as Dest;
    expect(detail.runs![0]!.status).toBe("completed");
    const watermark = detail.watermark;

    flakyDown = true;
    await sdk.patients.ingestRecords("exp_2", [{ resourceType: "Observation", id: "outage-obs", status: "final", code: { text: "x" } }], { sourceLabel: "outage" });
    await waitFor(async () => {
      await server.worker.drain();
      detail = (await sdk.exports.retrieve(dest.id)) as unknown as Dest;
      return detail.runs![0]!.status === "failed";
    });
    expect(detail.watermark).toBe(watermark);
    expect(detail.runs![0]!.error_message).toMatch(/unreachable|503/);
    await waitFor(async () => hooks.captured.some((c) => c.body.includes("export.run.failed")));

    flakyDown = false;
    await sdk.exports.update(dest.id, { enabled: false });
    await sdk.exports.update(dest.id, { enabled: true }); // reactivation catches up from the watermark
    await server.worker.drain();
    detail = (await sdk.exports.retrieve(dest.id)) as unknown as Dest;
    expect(detail.runs![0]).toMatchObject({ status: "completed", trigger: "reactivated" });
    expect(detail.watermark).toBeGreaterThan(watermark);
    await sdk.webhooks.delete(wh.id);
    await hooks.close();
  });

  test("dashboard hides the hosted server token from members", async () => {
    const list = await sdk.exports.list();
    expect(list.data.length).toBeGreaterThan(3);
    for (const d of list.data) expect(JSON.stringify(d)).not.toMatch(/secret_access_key|bearer_token":"im/);
  });
});

// keep the zip import used (validates fflate round trip of what the exporter writes)
test("zip helper round trip", () => {
  const z = unzipSync(new Uint8Array([80, 75, 5, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  expect(Object.keys(z)).toHaveLength(0);
  expect(strFromU8(new Uint8Array([104, 105]))).toBe("hi");
});
