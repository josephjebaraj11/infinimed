import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { InfiniMed } from "../../../packages/sdk/src/index.js";
import { completeSyntheticLogin, setupWorkspace, startReceiver, startTestServer, type TestServer } from "./harness.js";

let server: TestServer;
let sdk: InfiniMed;
let dash: Awaited<ReturnType<typeof setupWorkspace>>["dash"];
let workspaceId: string;
let app: Awaited<ReturnType<typeof startReceiver>>;
let cds: Awaited<ReturnType<typeof startReceiver>>;
let syntheticId: string;

beforeAll(async () => {
  server = await startTestServer();
  ({ sdk, dash, workspaceId } = await setupWorkspace(server));
  syntheticId = (await sdk.sources.list({ q: "synthetic" })).data[0]!.id;
  app = await startReceiver();
  cds = await startReceiver((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.method === "GET") {
      res.end(JSON.stringify({ services: [{ id: "a1c-check", hook: "patient-view", title: "HbA1c gap", description: "Flags overdue HbA1c" }] }));
    } else {
      const body = JSON.parse(req.body) as { context?: { patientId?: string } };
      res.end(JSON.stringify({ cards: [{ summary: `Patient ${body.context?.patientId} is due for HbA1c`, indicator: "warning", source: { label: "Acme CDS" } }] }));
    }
  });
});

afterAll(async () => {
  await app?.close();
  await cds?.close();
  await server?.close();
});

describe("clinician workflow", () => {
  test("connection tile exposes the values to share with the EHR", async () => {
    const tile = await dash.ok<{ urls: { launch_url: string; cds_hooks_url: string; redirect_uri: string; jwks_uri: string } }>("/connections/synthetic/clinical_workflow");
    expect(tile.urls.launch_url).toBe(`${server.url}/smart/launch/${workspaceId}`);
    expect(tile.urls.cds_hooks_url).toBe(`${server.url}/cds-services/${workspaceId}`);
    expect(tile.urls.jwks_uri).toBe(`${server.url}/.well-known/jwks.json`);
    await dash.ok("/connections/synthetic/clinical_workflow", { settings: { app_launch_url: `${app.url}/launch`, cds_endpoint: cds.url, cds_caching_seconds: 30 } }, "PUT");
  });

  test("SMART EHR launch delivers a launch context and a scoped FHIR proxy", async () => {
    // The EHR opens the app from Marisol's chart.
    let res = await fetch(`${server.url}/synthetic/ehr-launch?workspace_id=${workspaceId}&patient=syn_1`, { redirect: "manual" });
    let location = res.headers.get("location")!;
    expect(location).toContain(`/smart/launch/${workspaceId}?iss=`);
    for (let hops = 0; hops < 5 && !location.startsWith(app.url); hops++) {
      res = await fetch(location, { redirect: "manual" });
      location = res.headers.get("location")!;
    }
    const handle = new URL(location).searchParams.get("im_launch")!;
    expect(handle).toMatch(/^lc_/);
    const ctx = await sdk.launchContexts.retrieve(handle);
    expect(ctx).toMatchObject({ status: "active", patient: "syn-1", encounter: "syn-1-enc-1" });
    expect(ctx.fhir_user).toContain("Practitioner/syn-prac-1");
    expect(ctx.context.need_patient_banner).toBe(true);
    const patient = await sdk.launchContexts.fhir<{ resourceType: string; id: string }>(handle, "Patient/syn-1");
    expect(patient).toMatchObject({ resourceType: "Patient", id: "syn-1" });
    const enc = await sdk.launchContexts.fhir<{ entry: unknown[] }>(handle, "Encounter", { patient: "syn-1" });
    expect(enc.entry.length).toBeGreaterThan(5);
  });

  test("CDS Hooks discovery and invocation are forwarded with a verifiable InfiniMed JWT", async () => {
    const discovery = (await (await fetch(`${server.url}/cds-services/${workspaceId}`)).json()) as { services: { id: string }[] };
    expect(discovery.services[0]!.id).toBe("a1c-check");
    const call = { hook: "patient-view", hookInstance: crypto.randomUUID(), context: { patientId: "syn-1", userId: "Practitioner/syn-prac-1" } };
    const res = await fetch(`${server.url}/cds-services/${workspaceId}/a1c-check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(call) });
    const body = (await res.json()) as { cards: { summary: string }[] };
    expect(body.cards[0]!.summary).toContain("syn-1");
    const forwarded = cds.captured.find((c) => c.method === "POST")!;
    const token = String(forwarded.headers.authorization).slice(7);
    const { payload } = await jwtVerify(token, createRemoteJWKSet(new URL(`${server.url}/.well-known/jwks.json`)), { issuer: server.url });
    expect(payload.workspace_id).toBe(workspaceId);
    // cached second call does not reach the customer service
    const before = cds.captured.length;
    await fetch(`${server.url}/cds-services/${workspaceId}/a1c-check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...call, hookInstance: crypto.randomUUID() }) });
    expect(cds.captured.length).toBe(before);
    const log = await dash.ok<{ data: { cached: boolean }[] }>("/cds-calls");
    expect(log.data.map((x) => x.cached)).toEqual([true, false]);
  });
});

describe("backend population sync (SMART Backend Services + Bulk Data)", () => {
  test("bulk export links existing patients through the MPI and creates the rest", async () => {
    // Marisol already connected through patient access under the customer's own id.
    const session = await sdk.patientSessions.create({ patient_id: "user_marisol", patient_name: "Marisol Ventura", source_id: syntheticId, return_url: "https://app.example.com/c" });
    await completeSyntheticLogin(server, session.url, { patientRow: "syn_1" });
    await server.worker.drain();

    await dash.ok("/connections/synthetic/backend", { settings: { organizations: [{ source_id: syntheticId, group_ids: ["all-patients"] }] } }, "PUT");
    const sync = (await sdk.backendSyncs.create({ source_id: syntheticId, group_id: "all-patients" })) as { id: string; status: string };
    expect(sync.status).toBe("queued");
    await server.worker.drain(60_000);
    // Polling is deferred with Retry-After; wait for completion.
    let state = (await sdk.backendSyncs.retrieve(sync.id)) as { status: string; patients_seen: number; resources_seen: number };
    for (let i = 0; i < 50 && state.status !== "completed" && state.status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 200));
      await server.worker.drain(60_000);
      state = (await sdk.backendSyncs.retrieve(sync.id)) as typeof state;
    }
    expect(state.status).toBe("completed");
    expect(state.patients_seen).toBe(10);

    const all = await sdk.patients.list({ limit: 100 }).toArray();
    const backendCreated = all.filter((p) => p.id.startsWith("im_bk_"));
    expect(backendCreated).toHaveLength(9); // Marisol was matched to user_marisol, not duplicated
    const marisol = await sdk.patients.retrieve("user_marisol");
    expect(marisol.connections.map((c) => c.surface).sort()).toEqual(["backend", "patient_access"]);
    const recs = await sdk.patients.records(backendCreated[0]!.id, { type: "Condition", count: 50 });
    expect(recs.data.length).toBeGreaterThan(0);
  });
});

describe("HL7v2 and external FHIR ingestion", () => {
  const msg = (control: string, value: string, pid = "PID|1||H-7788^^^ACMEHOSP^MR||Nwosu^Adaeze||19850606|F|||9 Elm St^^Austin^TX^73301") =>
    [
      `MSH|^~\\&|LIS|ACME|INFINIMED|ACME|20260901120000||ORU^R01|${control}|P|2.5.1`,
      pid,
      "OBR|1|O1|F1|4548-4^HbA1c^LN|||20260901100000",
      `OBX|1|NM|4548-4^Hemoglobin A1c^LN||${value}|%|4.0-5.6|H|||F`,
    ].join("\r");

  test("ORU with create_patients creates the patient and returns an AA ack; repeats match by identifier", async () => {
    const r1 = await sdk.ingest.hl7v2(msg("C1", "6.9"), { feed: "acme-lis", createPatients: true });
    expect(r1.accepted).toBe(true);
    expect(r1.ack).toContain("MSA|AA|C1");
    const r2 = await sdk.ingest.hl7v2(msg("C2", "7.4"), { feed: "acme-lis" });
    expect(r2.patient_id).toBe(r1.patient_id);
    const facts = await sdk.patients.facts(r1.patient_id!, { concepts: ["hba1c"], aggregate: "all" });
    expect(facts.data[0]!.series!.map((s) => s.value)).toEqual([7.4]); // same OBR/OBX ids: the update replaced the value
    const rejected = await sdk.ingest.hl7v2("not hl7").catch((e) => e as { statusCode: number });
    expect((rejected as { statusCode: number }).statusCode).toBe(400);
    const unknown = await sdk.ingest.hl7v2(msg("C3", "7").replace("H-7788", "H-0000").replace("Nwosu^Adaeze", "Nobody^Known"), { feed: "acme-lis" }).catch((e) => e as { statusCode: number });
    expect((unknown as { statusCode: number }).statusCode).toBe(422);
  });

  test("a feed message for someone already known from another source links to that patient (MPI)", async () => {
    // Kwame Asante was imported by the backend bulk sync above; the lab feed knows him by a different MRN.
    const r = await sdk.ingest.hl7v2(msg("K1", "6.1", "PID|1||LAB-555^^^OTHERLAB^MR||Asante^Kwame||19900130|M|||1 Peachtree St^^Atlanta^GA^30303"), { feed: "other-lab", createPatients: true });
    expect(r.accepted).toBe(true);
    expect(r.patient_id).toMatch(/^im_bk_/);
    const p = await sdk.patients.retrieve(r.patient_id!);
    expect(p.connections.map((c) => c.surface).sort()).toEqual(["backend", "feed"]);
  });

  test("external FHIR bundles join the patient record", async () => {
    await sdk.patients.create({ patient_id: "ext-1", name: "Lucia Ferraro" });
    const result = await sdk.patients.ingestRecords("ext-1", {
      resourceType: "Bundle",
      type: "collection",
      entry: [
        { resource: { resourceType: "Patient", id: "x1", name: [{ family: "Ferraro", given: ["Lucia"] }], birthDate: "1949-09-09" } },
        { resource: { resourceType: "AllergyIntolerance", id: "x2", code: { coding: [{ system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: "7980", display: "Penicillin" }] }, patient: { reference: "Patient/x1" }, criticality: "high" } },
      ],
    }, { sourceLabel: "partner-api" });
    expect(result.created).toBe(2);
    const allergies = await sdk.patients.model<{ substance: string; criticality: string }>("ext-1", "allergies");
    expect(allergies.data[0]).toMatchObject({ substance: "Penicillin", criticality: "high" });
    await expect(sdk.patients.ingestRecords("ext-1", { resourceType: "Bundle", entry: [{ resource: { resourceType: "Observation" } }] })).rejects.toMatchObject({ code: "invalid_data" });
  });
});
