import { beforeAll, describe, expect, test } from "vitest";
import { buildConfig, setConfig } from "../src/config.js";
import { resetCryptoCache, seal, unseal, hashPassword, verifyPassword } from "../src/lib/crypto.js";
import { decodeCursor, encodeCursor, parseLimit } from "../src/lib/cursor.js";
import { isPrivateAddress } from "../src/lib/http.js";
import { signPayload, verifySignature } from "../src/webhooks/signing.js";
import { compareDemographics, demographicsFromPatient, jaroWinkler, soundex } from "../src/mpi/match.js";
import { parseMessage, hl7DateTime, unescape } from "../src/hl7v2/parser.js";
import { mapMessage } from "../src/hl7v2/to-fhir.js";
import { buildAck } from "../src/hl7v2/ack.js";
import { convert } from "../src/models/units.js";
import { resolveFacts } from "../src/models/resolver.js";
import { buildModel } from "../src/models/views.js";
import { stableId, transformForExport } from "../src/exports/transform.js";
import { stableStringify } from "../src/services/records.js";
import { collectReferences } from "../src/fhir/client.js";
import { generateSyntheticPatient } from "../src/synthetic/generator.js";
import { constructEvent, InfiniMedSignatureError, parseReturnUrl } from "../../../packages/sdk/src/index.js";

beforeAll(() => {
  setConfig(buildConfig({ NODE_ENV: "test", PGLITE_DIR: "memory://" }));
  resetCryptoCache();
});

describe("crypto", () => {
  test("seal/unseal round trip with AAD binding", () => {
    const env = seal("refresh-token-value", "connection:abc");
    expect(env.startsWith("v1.")).toBe(true);
    expect(unseal(env, "connection:abc")).toBe("refresh-token-value");
    expect(() => unseal(env, "connection:other")).toThrow();
  });
  test("password hashing", async () => {
    const h = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong password!!", h)).toBe(false);
  });
});

describe("cursors", () => {
  test("round trip, tamper and filter binding", () => {
    const c = encodeCursor({ k: "records:p1", p: 42, s: 100, f: "abc" });
    expect(decodeCursor(c, "records:p1", "abc").p).toBe(42);
    expect(() => decodeCursor(c, "records:p2", "abc")).toThrow(/Invalid or expired cursor/);
    expect(() => decodeCursor(c, "records:p1", "different")).toThrow(/different filters/);
    expect(() => decodeCursor(c.slice(0, -2) + "xx", "records:p1", "abc")).toThrow();
  });
  test("expired cursor", () => {
    const c = encodeCursor({ k: "x", p: 1 }, -1);
    expect(() => decodeCursor(c, "x")).toThrow(/expired/);
  });
  test("limit parsing", () => {
    expect(parseLimit(undefined)).toBe(10);
    expect(parseLimit("100")).toBe(100);
    expect(() => parseLimit("101")).toThrow();
    expect(() => parseLimit("0")).toThrow();
  });
});

describe("SSRF guard", () => {
  test("private ranges", () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "192.168.1.1", "127.0.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:10.0.0.1"]) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "2001:4860:4860::8888"]) expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe("webhook signatures", () => {
  test("server signing verifies with the SDK", async () => {
    const body = JSON.stringify({ id: "evt_1", object: "event", type: "records.sync.completed", api_version: "2026-10-01", created_at: new Date().toISOString(), data: { object: { patient_id: "p" } } });
    const { header } = signPayload("whsec_test", body);
    expect(verifySignature("whsec_test", body, header)).toBeNull();
    const evt = await constructEvent(body, header, "whsec_test");
    expect(evt.type).toBe("records.sync.completed");
  });
  test("failure reasons", async () => {
    const body = '{"id":"evt_1","object":"event","type":"x","data":{}}';
    const reason = async (h: string | null, secret = "s", raw = body) => {
      try {
        await constructEvent(raw, h, secret);
        return "ok";
      } catch (e) {
        return (e as InfiniMedSignatureError).reason;
      }
    };
    expect(await reason(null)).toBe("missing_header");
    expect(await reason("garbage")).toBe("malformed_header");
    expect(await reason(signPayload("s", body, Math.floor(Date.now() / 1000) - 1000).header)).toBe("timestamp_expired");
    expect(await reason(signPayload("other", body).header)).toBe("signature_mismatch");
    expect(await reason(signPayload("s", body + " ").header, "s", body)).toBe("signature_mismatch");
    expect(await reason(signPayload("s", "not json").header, "s", "not json")).toBe("malformed_body");
  });
});

describe("return URL parsing", () => {
  test("hosted, success and failure", () => {
    expect(parseReturnUrl("https://a.example/c?patient_id=u1&patient_session_id=ps_1")).toEqual({ patient_id: "u1", patient_session_id: "ps_1" });
    expect(parseReturnUrl("https://a.example/c?patient_id=u1&patient_session_id=ps_1&success=true&source_id=src_1&connection_id=conn_1")).toMatchObject({ success: true, connection_id: "conn_1" });
    expect(parseReturnUrl("https://a.example/c?patient_id=u1&patient_session_id=ps_1&success=false&error=user_denied&error_description=x")).toMatchObject({ success: false, error: "user_denied" });
    expect(parseReturnUrl("https://a.example/c")).toBeNull();
  });
});

describe("MPI", () => {
  const base = { resourceType: "Patient", id: "a", name: [{ family: "Ventura", given: ["Marisol"] }], birthDate: "1968-03-14", gender: "female", address: [{ postalCode: "02139" }], telecom: [{ system: "phone", value: "555-010-1010" }] };
  test("string similarity", () => {
    expect(jaroWinkler("martha", "marhta")).toBeGreaterThan(0.95);
    expect(jaroWinkler("smith", "jones")).toBeLessThan(0.6);
    expect(soundex("Robert")).toBe("R163");
    expect(soundex("Rupert")).toBe("R163");
  });
  test("same person across sources with typos matches", () => {
    const other = { ...base, id: "b", name: [{ family: "Ventura", given: ["Marisol", "A"] }], address: [{ postalCode: "02139" }] };
    expect(compareDemographics(demographicsFromPatient(base), demographicsFromPatient(other)).status).toBe("match");
    const typo = { ...base, id: "c", name: [{ family: "Ventrua", given: ["Marisol"] }], telecom: [] };
    expect(compareDemographics(demographicsFromPatient(base), demographicsFromPatient(typo)).status).not.toBe("mismatch");
  });
  test("different person does not match", () => {
    const stranger = { resourceType: "Patient", id: "z", name: [{ family: "Okafor", given: ["Desmond"] }], birthDate: "1976-05-18", gender: "male", address: [{ postalCode: "77002" }] };
    expect(compareDemographics(demographicsFromPatient(base), demographicsFromPatient(stranger)).status).toBe("mismatch");
  });
  test("transposed day/month is partial evidence", () => {
    const swapped = { ...base, id: "d", birthDate: "1968-14-03".replace("14-03", "03-14") };
    expect(compareDemographics(demographicsFromPatient(base), demographicsFromPatient(swapped)).fields.birthDate!.outcome).toBe("agree");
  });
});

describe("HL7v2", () => {
  const ORU = [
    "MSH|^~\\&|LAB|ACMEHOSP|INFINIMED|ACME|20260901120000||ORU^R01|MSG00001|P|2.5.1",
    "PID|1||MRN12345^^^ACMEHOSP^MR||Ventura^Marisol^A||19680314|F|||12 Main St^^Cambridge^MA^02139||^^^marisol@example.com~6175550101",
    (() => {
      const pv1 = new Array<string>(46).fill("");
      pv1[0] = "PV1";
      pv1[1] = "1";
      pv1[2] = "O";
      pv1[3] = "CLINIC^101^A";
      pv1[7] = "1234^Adebayo^Grace";
      pv1[19] = "V0001";
      pv1[44] = "20260901110000";
      return pv1.join("|");
    })(),
    "OBR|1|ORD1|FIL1|24323-8^Comprehensive metabolic panel^LN|||20260901113000|||||||||||||||20260901120000|||F",
    "OBX|1|NM|4548-4^Hemoglobin A1c^LN||7.2|%^percent^UCUM|4.0-5.6|H|||F|||20260901113000",
    "OBX|2|NM|2345-7^Glucose^LN||8.1|mmol/L^mmol/L^UCUM|3.9-5.6|H|||F",
    "OBX|3|ST|8251-1^Comment^LN||Fasting \\T\\ hydrated||||||F",
    "AL1|1|DA|7980^Penicillin^RXNORM|SV|Hives",
    "DG1|1||E11.9^Type 2 diabetes mellitus^I10||20260901",
  ].join("\r");

  test("parser handles encoding characters and escapes", () => {
    const msg = parseMessage(ORU);
    expect(msg.encoding.component).toBe("^");
    expect(unescape("a\\F\\b\\S\\c\\T\\d", msg.encoding)).toBe("a|b^c&d");
    expect(hl7DateTime("20260901113000")).toBe("2026-09-01T11:30:00Z");
    expect(hl7DateTime("19680314")).toBe("1968-03-14");
  });

  test("ORU maps to Patient, Encounter, DiagnosticReport, Observations, Allergy, Condition", () => {
    const mapped = mapMessage(parseMessage(ORU), "feed1");
    expect(mapped.messageType).toBe("ORU");
    expect(mapped.patient.birthDate).toBe("1968-03-14");
    expect(mapped.patientIdentifiers[0]).toEqual({ system: "urn:hl7v2:assigning-authority:ACMEHOSP", value: "MRN12345" });
    const types = mapped.resources.map((r) => r.resourceType);
    expect(types).toEqual(expect.arrayContaining(["Encounter", "DiagnosticReport", "Observation", "AllergyIntolerance", "Condition"]));
    const a1c = mapped.resources.find((r) => r.resourceType === "Observation" && JSON.stringify(r.code).includes("4548-4"))!;
    expect((a1c.valueQuantity as { value: number }).value).toBe(7.2);
    const comment = mapped.resources.find((r) => r.resourceType === "Observation" && JSON.stringify(r.code).includes("8251-1"))!;
    expect(comment.valueString).toBe("Fasting & hydrated");
    const report = mapped.resources.find((r) => r.resourceType === "DiagnosticReport")!;
    expect((report.result as unknown[]).length).toBe(3);
    // deterministic ids: the same message maps to the same ids
    expect(mapMessage(parseMessage(ORU), "feed1").patient.id).toBe(mapped.patient.id);
  });

  test("ACK mirrors control id", () => {
    const ack = buildAck(parseMessage(ORU), "AA");
    expect(ack).toContain("MSA|AA|MSG00001");
    expect(ack.startsWith("MSH|^~\\&|INFINIMED")).toBe(true);
  });
});

describe("clinical models", () => {
  test("unit conversions", () => {
    expect(convert(220.462, "[lb_av]", "kg", "body_weight")).toBeCloseTo(100, 1);
    expect(convert(98.6, "[degF]", "Cel", "body_temperature")).toBeCloseTo(37, 1);
    expect(convert(53, "mmol/mol", "%", "hba1c")).toBeCloseTo(7.0, 1);
    expect(convert(5.5, "mmol/L", "mg/dL", "glucose")).toBeCloseTo(99.1, 0);
    expect(convert(88.42, "umol/L", "mg/dL", "creatinine")).toBeCloseTo(1, 2);
    expect(convert(5, "furlongs", "kg", "body_weight")).toBeNull();
  });

  const obs = (id: string, code: string, value: number, unit: string, effective: string, extra: Record<string, unknown> = {}) => ({
    resourceType: "Observation",
    id,
    status: "final",
    code: { coding: [{ system: "http://loinc.org", code }] },
    effectiveDateTime: effective,
    valueQuantity: { value, unit, code: unit },
    ...extra,
  });

  test("facts dedupe the same measurement across sources and keep provenance", () => {
    const resources = [
      { sourceId: "src_a", resource: obs("a1", "4548-4", 7.1, "%", "2026-01-10T10:00:00Z") },
      { sourceId: "src_b", resource: obs("b1", "4548-4", 7.1, "%", "2026-01-10T10:00:30Z") },
      { sourceId: "src_b", resource: obs("b2", "59261-8", 64, "mmol/mol", "2026-05-02T10:00:00Z") },
      { sourceId: "src_a", resource: obs("a2", "4548-4", 99, "%", "2026-06-01T10:00:00Z", { status: "entered-in-error" }) },
    ];
    const [latest] = resolveFacts({ subject: "Patient/u1", resources, codes: ["hba1c"] });
    expect(latest!.value).toBeCloseTo(8.0, 1);
    expect(latest!.count).toBe(2);
    const [mean] = resolveFacts({ subject: "Patient/u1", resources, codes: ["hba1c"], aggregate: "mean" });
    expect(mean!.provenance.length).toBe(3);
  });

  test("BMI is derived from weight and height when not recorded", () => {
    const resources = [
      { sourceId: "s", resource: obs("w", "29463-7", 80, "kg", "2026-02-01T10:00:00Z") },
      { sourceId: "s", resource: obs("h", "8302-2", 180, "cm", "2026-01-01T10:00:00Z") },
    ];
    const [bmi] = resolveFacts({ subject: "Patient/u1", resources, codes: ["bmi"] });
    expect(bmi).toMatchObject({ resolved_by: "derived", value: 24.7, status: "hasValue" });
  });

  test("blood pressure is read from panel components", () => {
    const panel = {
      resourceType: "Observation",
      id: "bp",
      status: "final",
      code: { coding: [{ system: "http://loinc.org", code: "85354-9" }] },
      effectiveDateTime: "2026-03-01T09:00:00Z",
      component: [
        { code: { coding: [{ system: "http://loinc.org", code: "8480-6" }] }, valueQuantity: { value: 138, code: "mm[Hg]" } },
        { code: { coding: [{ system: "urn:oid:2.16.840.1.113883.6.1", code: "8462-4" }] }, valueQuantity: { value: 88, code: "mm[Hg]" } },
      ],
    };
    const facts = resolveFacts({ subject: "Patient/u", resources: [{ sourceId: "s", resource: panel }], codes: ["bp_systolic", "bp_diastolic"] });
    expect(facts.map((f) => f.value)).toEqual([138, 88]);
  });

  test("allergy reconciliation never downgrades criticality or status", () => {
    const allergy = (id: string, criticality: string, status: string) => ({
      resourceType: "AllergyIntolerance",
      id,
      criticality,
      clinicalStatus: { coding: [{ code: status }] },
      code: { coding: [{ system: "urn:oid:2.16.840.1.113883.6.88", code: "7980", display: "Penicillin" }] },
      reaction: [{ manifestation: [{ text: id === "a" ? "Hives" : "Anaphylaxis" }] }],
    });
    const rows = buildModel("allergies", [
      { sourceId: "s1", resource: allergy("a", "low", "inactive") },
      { sourceId: "s2", resource: allergy("b", "high", "active") },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ criticality: "high", clinical_status: "active" });
    expect(rows[0]!.sources).toHaveLength(2);
    expect((rows[0]!.reactions as unknown[]).length).toBe(2);
  });

  test("synthetic generator is deterministic and complete", () => {
    const a = generateSyntheticPatient(0);
    const b = generateSyntheticPatient(0);
    expect(stableStringify(a.bundle)).toBe(stableStringify(b.bundle));
    const types = new Set((a.bundle.entry as { resource: { resourceType: string } }[]).map((e) => e.resource.resourceType));
    for (const t of ["Patient", "Encounter", "Observation", "Condition", "MedicationRequest", "AllergyIntolerance", "Immunization", "DiagnosticReport", "DocumentReference"]) expect(types.has(t)).toBe(true);
  });
});

describe("export transform", () => {
  test("non-conformant ids get stable hashes and references follow", () => {
    expect(stableId("Observation", "abc-123")).toBe("abc-123");
    const bad = "eLabs_123:456";
    const hashed = stableId("Observation", bad);
    expect(hashed).toMatch(/^x-[0-9a-f]{40}$/);
    expect(stableId("Observation", bad)).toBe(hashed);
    const out = transformForExport(
      { resourceType: "DiagnosticReport", id: "r1", result: [{ reference: `Observation/${bad}` }], subject: { reference: "Patient/p1" } },
      { externalPatientId: "u1", sourceId: "src_1", idStrategy: "source" },
    );
    expect((out.result as { reference: string }[])[0]!.reference).toBe(`Observation/${hashed}`);
    expect((out.meta as { source: string }).source).toBe("urn:infinimed:source:src_1");
  });
  test("namespaced ids avoid cross-source collisions", () => {
    const a = transformForExport({ resourceType: "Observation", id: "1" }, { externalPatientId: "u", sourceId: "src_a", idStrategy: "namespaced" });
    const b = transformForExport({ resourceType: "Observation", id: "1" }, { externalPatientId: "u", sourceId: "src_b", idStrategy: "namespaced" });
    expect(a.id).not.toBe(b.id);
  });
  test("Patient gets the customer's id", () => {
    const p = transformForExport({ resourceType: "Patient", id: "e1", identifier: [{ system: "urn:mrn", value: "1" }] }, { externalPatientId: "user_42", sourceId: "s", idStrategy: "source" });
    expect(p.identifier).toContainEqual({ system: "urn:infinimed:patient-id", value: "user_42" });
  });
  test("reference collection", () => {
    const refs = collectReferences({ subject: { reference: "Patient/1" }, performer: [{ reference: "https://ehr.example/fhir/Practitioner/9" }], contained: [{ reference: "#x" }] });
    expect([...refs].sort()).toEqual(["Patient/1", "Practitioner/9"]);
  });
});
