import { createHash } from "node:crypto";
import { comp, componentOf, fieldRaw, hl7DateTime, repetitions, segment, segments, type Message, type Segment } from "./parser.js";

/**
 * HL7 v2 -> FHIR R4 mapping (subset aligned with the HL7 v2-to-FHIR IG):
 *   PID -> Patient          PV1 -> Encounter           OBR -> DiagnosticReport
 *   OBX -> Observation      AL1 -> AllergyIntolerance  DG1 -> Condition
 * Supported events: ADT^A01/A02/A03/A04/A08/A28/A31 and ORU^R01. Resource ids are deterministic
 * hashes of (feed, natural key) so re-sent messages update rather than duplicate.
 */

type R = Record<string, unknown> & { resourceType: string; id: string };

const hid = (...parts: string[]) => createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);

const CODE_SYSTEMS: Record<string, string> = {
  LN: "http://loinc.org",
  LOINC: "http://loinc.org",
  SCT: "http://snomed.info/sct",
  SNM: "http://snomed.info/sct",
  "I10": "http://hl7.org/fhir/sid/icd-10-cm",
  "I10C": "http://hl7.org/fhir/sid/icd-10-cm",
  "ICD10": "http://hl7.org/fhir/sid/icd-10-cm",
  "I9C": "http://hl7.org/fhir/sid/icd-9-cm",
  RXNORM: "http://www.nlm.nih.gov/research/umls/rxnorm",
  CVX: "http://hl7.org/fhir/sid/cvx",
  UCUM: "http://unitsofmeasure.org",
};

function cwe(msg: Message, rep: string) {
  const code = componentOf(msg, rep, 1);
  const display = componentOf(msg, rep, 2);
  const sys = componentOf(msg, rep, 3);
  const altCode = componentOf(msg, rep, 4);
  const altDisplay = componentOf(msg, rep, 5);
  const altSys = componentOf(msg, rep, 6);
  const coding = [];
  if (code) coding.push({ ...(CODE_SYSTEMS[sys.toUpperCase()] ? { system: CODE_SYSTEMS[sys.toUpperCase()] } : sys ? { system: `urn:hl7v2:${sys}` } : {}), code, ...(display ? { display } : {}) });
  if (altCode) coding.push({ ...(CODE_SYSTEMS[altSys.toUpperCase()] ? { system: CODE_SYSTEMS[altSys.toUpperCase()] } : altSys ? { system: `urn:hl7v2:${altSys}` } : {}), code: altCode, ...(altDisplay ? { display: altDisplay } : {}) });
  return { ...(coding.length ? { coding } : {}), ...(display || altDisplay ? { text: display || altDisplay } : {}) };
}

const GENDER: Record<string, string> = { M: "male", F: "female", O: "other", U: "unknown", A: "other", N: "unknown" };

export function patientFromPid(msg: Message, pid: Segment, feedKey: string): { patient: R; identifiers: { system: string; value: string }[] } {
  const identifiers = repetitions(msg, pid, 3)
    .map((rep) => {
      const value = componentOf(msg, rep, 1);
      const authority = componentOf(msg, rep, 4) || componentOf(msg, rep, 4, 2);
      const type = componentOf(msg, rep, 5);
      return value ? { value, system: authority ? `urn:hl7v2:assigning-authority:${authority}` : `urn:hl7v2:feed:${feedKey}`, type } : null;
    })
    .filter((x): x is { value: string; system: string; type: string } => !!x);
  const primary = identifiers[0];
  const id = hid(feedKey, "Patient", primary ? `${primary.system}|${primary.value}` : fieldRaw(pid, 5) + fieldRaw(pid, 7));
  const names = repetitions(msg, pid, 5).map((rep) => ({
    family: componentOf(msg, rep, 1) || undefined,
    given: [componentOf(msg, rep, 2), componentOf(msg, rep, 3)].filter(Boolean),
    ...(componentOf(msg, rep, 5) ? { prefix: [componentOf(msg, rep, 5)] } : {}),
    use: componentOf(msg, rep, 7) === "L" || !componentOf(msg, rep, 7) ? "official" : "usual",
  }));
  const addresses = repetitions(msg, pid, 11).map((rep) => ({
    line: [componentOf(msg, rep, 1), componentOf(msg, rep, 2)].filter(Boolean),
    city: componentOf(msg, rep, 3) || undefined,
    state: componentOf(msg, rep, 4) || undefined,
    postalCode: componentOf(msg, rep, 5) || undefined,
    country: componentOf(msg, rep, 6) || undefined,
  }));
  const telecom = [
    ...repetitions(msg, pid, 13).map((rep) => {
      const number = componentOf(msg, rep, 1) || [componentOf(msg, rep, 6), componentOf(msg, rep, 7)].filter(Boolean).join("");
      const email = componentOf(msg, rep, 4);
      return email ? { system: "email", value: email } : number ? { system: "phone", value: number, use: "home" } : null;
    }),
    ...repetitions(msg, pid, 14).map((rep) => {
      const number = componentOf(msg, rep, 1) || [componentOf(msg, rep, 6), componentOf(msg, rep, 7)].filter(Boolean).join("");
      return number ? { system: "phone", value: number, use: "work" } : null;
    }),
  ].filter(Boolean);
  const birth = hl7DateTime(comp(msg, pid, 7));
  const patient: R = {
    resourceType: "Patient",
    id,
    identifier: identifiers.map((i) => ({ system: i.system, value: i.value, ...(i.type ? { type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: i.type }] } } : {}) })),
    name: names.filter((n) => n.family || n.given.length),
    ...(GENDER[comp(msg, pid, 8)] ? { gender: GENDER[comp(msg, pid, 8)] } : {}),
    ...(birth ? { birthDate: birth.slice(0, 10) } : {}),
    ...(addresses.length ? { address: addresses } : {}),
    ...(telecom.length ? { telecom } : {}),
    ...(comp(msg, pid, 30) === "Y" ? { deceasedBoolean: true } : {}),
  };
  return { patient, identifiers: identifiers.map(({ system, value }) => ({ system, value })) };
}

const ENCOUNTER_CLASS: Record<string, { code: string; display: string }> = {
  I: { code: "IMP", display: "inpatient encounter" },
  O: { code: "AMB", display: "ambulatory" },
  E: { code: "EMER", display: "emergency" },
  P: { code: "PRENC", display: "pre-admission" },
  R: { code: "AMB", display: "ambulatory" },
  B: { code: "OBSENC", display: "observation encounter" },
};

function encounterFromPv1(msg: Message, pv1: Segment, patientId: string, feedKey: string, event: string): R | null {
  const visit = comp(msg, pv1, 19);
  const admit = hl7DateTime(comp(msg, pv1, 44));
  if (!visit && !admit) return null;
  const discharge = hl7DateTime(comp(msg, pv1, 45));
  const cls = ENCOUNTER_CLASS[comp(msg, pv1, 2)] ?? { code: "AMB", display: "ambulatory" };
  const status = event === "A03" || discharge ? "finished" : event === "A11" ? "cancelled" : "in-progress";
  const location = [comp(msg, pv1, 3, 1), comp(msg, pv1, 3, 2), comp(msg, pv1, 3, 3), comp(msg, pv1, 3, 4)].filter(Boolean).join(" ");
  const attending = [comp(msg, pv1, 7, 3), comp(msg, pv1, 7, 2)].filter(Boolean).join(" ");
  return {
    resourceType: "Encounter",
    id: hid(feedKey, "Encounter", visit || `${patientId}|${admit}`),
    status,
    class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", ...cls },
    subject: { reference: `Patient/${patientId}` },
    ...(visit ? { identifier: [{ system: `urn:hl7v2:feed:${feedKey}:visit`, value: visit }] } : {}),
    ...(admit || discharge ? { period: { ...(admit ? { start: admit } : {}), ...(discharge ? { end: discharge } : {}) } } : {}),
    ...(location ? { location: [{ location: { display: location } }] } : {}),
    ...(attending ? { participant: [{ individual: { display: attending } }] } : {}),
  };
}

const OBX_STATUS: Record<string, string> = { F: "final", C: "corrected", P: "preliminary", X: "cancelled", D: "entered-in-error", R: "registered", I: "registered", W: "entered-in-error" };
const INTERPRETATION: Record<string, string> = { H: "H", L: "L", HH: "HH", LL: "LL", A: "A", AA: "AA", N: "N" };

function observationFromObx(msg: Message, obx: Segment, ctx: { patientId: string; feedKey: string; reportKey: string; effective?: string; category?: string }): R | null {
  const valueType = comp(msg, obx, 2);
  const code = cwe(msg, repetitions(msg, obx, 3)[0] ?? "");
  const setId = comp(msg, obx, 1) || comp(msg, obx, 4) || JSON.stringify(code);
  const raw = repetitions(msg, obx, 5);
  const unitRep = repetitions(msg, obx, 6)[0] ?? "";
  const unit = componentOf(msg, unitRep, 1);
  const effective = hl7DateTime(comp(msg, obx, 14)) ?? ctx.effective;
  const value: Record<string, unknown> = {};
  if (valueType === "NM" && raw[0] !== undefined && raw[0] !== "") {
    const n = Number(componentOf(msg, raw[0]!, 1));
    if (Number.isFinite(n)) value.valueQuantity = { value: n, ...(unit ? { unit, system: "http://unitsofmeasure.org", code: unit } : {}) };
  } else if (valueType === "SN" && raw[0]) {
    const comparator = componentOf(msg, raw[0], 1);
    const n = Number(componentOf(msg, raw[0], 2));
    if (Number.isFinite(n)) value.valueQuantity = { value: n, ...(["<", ">", "<=", ">="].includes(comparator) ? { comparator } : {}), ...(unit ? { unit, code: unit, system: "http://unitsofmeasure.org" } : {}) };
  } else if ((valueType === "CE" || valueType === "CWE" || valueType === "CNE") && raw[0]) {
    value.valueCodeableConcept = cwe(msg, raw[0]);
  } else if (raw.length) {
    const text = raw.map((r) => componentOf(msg, r, 1)).join("\n");
    if (text) value.valueString = text;
  }
  const flag = comp(msg, obx, 8);
  const range = comp(msg, obx, 7);
  return {
    resourceType: "Observation",
    id: hid(ctx.feedKey, "Observation", ctx.reportKey, setId),
    status: OBX_STATUS[comp(msg, obx, 11)] ?? "final",
    category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: ctx.category ?? "laboratory" }] }],
    code,
    subject: { reference: `Patient/${ctx.patientId}` },
    ...(effective ? { effectiveDateTime: effective } : {}),
    ...value,
    ...(INTERPRETATION[flag] ? { interpretation: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", code: INTERPRETATION[flag] }] }] } : {}),
    ...(range ? { referenceRange: [{ text: range }] } : {}),
  };
}

export type MappedMessage = {
  messageType: string;
  event: string;
  controlId: string;
  patient: R;
  patientIdentifiers: { system: string; value: string }[];
  resources: R[];
};

export function mapMessage(msg: Message, feedKey: string): MappedMessage {
  const msh = segment(msg, "MSH")!;
  const type = comp(msg, msh, 9, 1);
  const event = comp(msg, msh, 9, 2);
  const controlId = comp(msg, msh, 10);
  const pid = segment(msg, "PID");
  if (!pid) throw new Error("message has no PID segment");
  const { patient, identifiers } = patientFromPid(msg, pid, feedKey);
  const resources: R[] = [];

  const pv1 = segment(msg, "PV1");
  const encounter = pv1 ? encounterFromPv1(msg, pv1, patient.id, feedKey, event) : null;
  if (encounter) resources.push(encounter);

  for (const al1 of segments(msg, "AL1")) {
    const allergen = cwe(msg, repetitions(msg, al1, 3)[0] ?? "");
    const severity = comp(msg, al1, 4);
    resources.push({
      resourceType: "AllergyIntolerance",
      id: hid(feedKey, "AllergyIntolerance", patient.id, JSON.stringify(allergen)),
      clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical", code: "active" }] },
      code: allergen,
      patient: { reference: `Patient/${patient.id}` },
      ...(severity === "SV" ? { criticality: "high" } : severity === "MI" ? { criticality: "low" } : {}),
      ...(comp(msg, al1, 5) ? { reaction: [{ manifestation: [{ text: comp(msg, al1, 5) }] }] } : {}),
    });
  }

  for (const dg1 of segments(msg, "DG1")) {
    const dx = cwe(msg, repetitions(msg, dg1, 3)[0] ?? "");
    resources.push({
      resourceType: "Condition",
      id: hid(feedKey, "Condition", patient.id, JSON.stringify(dx)),
      category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "encounter-diagnosis" }] }],
      code: dx,
      subject: { reference: `Patient/${patient.id}` },
      ...(encounter ? { encounter: { reference: `Encounter/${encounter.id}` } } : {}),
      ...(hl7DateTime(comp(msg, dg1, 5)) ? { recordedDate: hl7DateTime(comp(msg, dg1, 5)) } : {}),
    });
  }

  // ORU: each OBR groups the OBX segments that follow it.
  let currentReport: R | null = null;
  let reportKey = "";
  let reportEffective: string | undefined;
  for (const seg of msg.segments) {
    if (seg.name === "OBR") {
      reportKey = comp(msg, seg, 3) || comp(msg, seg, 2) || `${controlId}|${comp(msg, seg, 1)}`;
      reportEffective = hl7DateTime(comp(msg, seg, 7));
      currentReport = {
        resourceType: "DiagnosticReport",
        id: hid(feedKey, "DiagnosticReport", reportKey),
        status: OBX_STATUS[comp(msg, seg, 25)] ?? "final",
        category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: comp(msg, seg, 24) || "LAB" }] }],
        code: cwe(msg, repetitions(msg, seg, 4)[0] ?? ""),
        subject: { reference: `Patient/${patient.id}` },
        ...(encounter ? { encounter: { reference: `Encounter/${encounter.id}` } } : {}),
        ...(reportEffective ? { effectiveDateTime: reportEffective } : {}),
        ...(hl7DateTime(comp(msg, seg, 22)) ? { issued: hl7DateTime(comp(msg, seg, 22)) } : {}),
        result: [] as { reference: string }[],
      };
      resources.push(currentReport);
    } else if (seg.name === "OBX") {
      const obs = observationFromObx(msg, seg, { patientId: patient.id, feedKey, reportKey: reportKey || controlId, effective: reportEffective });
      if (!obs) continue;
      if (encounter) obs.encounter = { reference: `Encounter/${encounter.id}` };
      resources.push(obs);
      if (currentReport) (currentReport.result as { reference: string }[]).push({ reference: `Observation/${obs.id}` });
    }
  }
  return { messageType: type, event, controlId, patient, patientIdentifiers: identifiers, resources };
}

export const SUPPORTED_EVENTS = new Set(["ADT^A01", "ADT^A02", "ADT^A03", "ADT^A04", "ADT^A08", "ADT^A28", "ADT^A31", "ORU^R01"]);
