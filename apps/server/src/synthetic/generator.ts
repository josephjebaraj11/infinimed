/**
 * Deterministic synthetic patient generator for the Synthetic Hospital sandbox. Every patient is a
 * FHIR R4 collection Bundle spanning about three years: encounters, problems, vitals, labs (some in
 * SI units, some duplicated across the lab and vitals feeds, to exercise normalisation and
 * deduplication), medications, allergies, immunizations, procedures, reports and a clinical note.
 * No real person's data is used; names are invented.
 */

type R = Record<string, unknown> & { resourceType: string; id: string };

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SYNTHETIC_PASSWORD = "synthpass";

export const SYNTHETIC_PEOPLE = [
  { given: "Marisol", family: "Ventura", gender: "female", birth: "1968-03-14", zip: "02139", city: "Cambridge", state: "MA" },
  { given: "Theodore", family: "Baptiste", gender: "male", birth: "1955-11-02", zip: "60614", city: "Chicago", state: "IL" },
  { given: "Ingrid", family: "Sorensen", gender: "female", birth: "1981-07-23", zip: "98103", city: "Seattle", state: "WA" },
  { given: "Kwame", family: "Asante", gender: "male", birth: "1990-01-30", zip: "30303", city: "Atlanta", state: "GA" },
  { given: "Lucia", family: "Ferraro", gender: "female", birth: "1949-09-09", zip: "10001", city: "New York", state: "NY" },
  { given: "Desmond", family: "Okafor", gender: "male", birth: "1976-05-18", zip: "77002", city: "Houston", state: "TX" },
  { given: "Priya", family: "Raman", gender: "female", birth: "1987-12-04", zip: "94110", city: "San Francisco", state: "CA" },
  { given: "Harold", family: "Whitfield", gender: "male", birth: "1942-04-27", zip: "85004", city: "Phoenix", state: "AZ" },
  { given: "Naomi", family: "Takahashi", gender: "female", birth: "1999-08-15", zip: "97205", city: "Portland", state: "OR" },
  { given: "Elias", family: "Montgomery", gender: "male", birth: "1963-02-11", zip: "80202", city: "Denver", state: "CO" },
];

const CONDITIONS = [
  { snomed: "59621000", icd: "I10", display: "Essential hypertension" },
  { snomed: "44054006", icd: "E11.9", display: "Type 2 diabetes mellitus" },
  { snomed: "55822004", icd: "E78.5", display: "Hyperlipidemia" },
  { snomed: "195967001", icd: "J45.909", display: "Asthma" },
  { snomed: "414916001", icd: "E66.9", display: "Obesity" },
  { snomed: "40930008", icd: "E03.9", display: "Hypothyroidism" },
  { snomed: "370143000", icd: "F32.9", display: "Major depressive disorder" },
  { snomed: "239873007", icd: "M17.9", display: "Osteoarthritis of knee" },
  { snomed: "235595009", icd: "K21.9", display: "Gastroesophageal reflux disease" },
];

const MEDS_FOR: Record<string, { rxnorm: string; display: string; dose: string }[]> = {
  "59621000": [{ rxnorm: "29046", display: "lisinopril 10 MG Oral Tablet", dose: "Take 1 tablet by mouth daily" }, { rxnorm: "17767", display: "amlodipine 5 MG Oral Tablet", dose: "Take 1 tablet by mouth daily" }],
  "44054006": [{ rxnorm: "6809", display: "metformin 500 MG Oral Tablet", dose: "Take 1 tablet by mouth twice daily with meals" }],
  "55822004": [{ rxnorm: "83367", display: "atorvastatin 20 MG Oral Tablet", dose: "Take 1 tablet by mouth at bedtime" }],
  "195967001": [{ rxnorm: "435", display: "albuterol 90 MCG/ACTUAT Metered Dose Inhaler", dose: "2 puffs every 4-6 hours as needed" }],
  "40930008": [{ rxnorm: "10582", display: "levothyroxine 75 MCG Oral Tablet", dose: "Take 1 tablet by mouth every morning" }],
  "370143000": [{ rxnorm: "36437", display: "sertraline 50 MG Oral Tablet", dose: "Take 1 tablet by mouth daily" }],
  "239873007": [{ rxnorm: "5640", display: "ibuprofen 400 MG Oral Tablet", dose: "Take 1 tablet by mouth every 8 hours as needed" }],
  "235595009": [{ rxnorm: "7646", display: "omeprazole 20 MG Delayed Release Oral Capsule", dose: "Take 1 capsule by mouth daily before breakfast" }],
};

const ALLERGIES = [
  { system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: "7980", display: "Penicillin", category: "medication", criticality: "high", reaction: "Hives" },
  { system: "http://snomed.info/sct", code: "256349002", display: "Peanut", category: "food", criticality: "high", reaction: "Anaphylaxis" },
  { system: "http://snomed.info/sct", code: "111088007", display: "Latex", category: "environment", criticality: "low", reaction: "Contact dermatitis" },
  { system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: "2670", display: "Codeine", category: "medication", criticality: "low", reaction: "Nausea" },
];

const VACCINES = [
  { cvx: "140", display: "Influenza, seasonal, injectable, preservative free" },
  { cvx: "208", display: "COVID-19, mRNA, LNP-S, PF, 30 mcg/0.3 mL dose" },
  { cvx: "115", display: "Tdap" },
  { cvx: "187", display: "Zoster vaccine recombinant" },
];

const LOINC = "http://loinc.org";
const SNOMED = "http://snomed.info/sct";
const UCUM = "http://unitsofmeasure.org";
const OBS_CAT = "http://terminology.hl7.org/CodeSystem/observation-category";

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export function generateSyntheticPatient(index: number, baseUrlForOrg = "urn:infinimed:synthetic"): { bundle: R; patientId: string; username: string; displayName: string } {
  const person = SYNTHETIC_PEOPLE[index % SYNTHETIC_PEOPLE.length]!;
  const rnd = mulberry32(1000 + index * 7919);
  const pick = <T>(arr: T[]) => arr[Math.floor(rnd() * arr.length)]!;
  const between = (lo: number, hi: number, dp = 0) => Math.round((lo + rnd() * (hi - lo)) * 10 ** dp) / 10 ** dp;

  const pid = `syn-${index + 1}`;
  const resources: R[] = [];
  const subject = { reference: `Patient/${pid}` };
  const org: R = { resourceType: "Organization", id: "syn-org-1", name: "Synthetic Hospital", identifier: [{ system: baseUrlForOrg, value: "synthetic-hospital" }] };
  const practitioners: R[] = [
    { resourceType: "Practitioner", id: "syn-prac-1", name: [{ family: "Adebayo", given: ["Grace"], prefix: ["Dr."] }], identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "9990000011" }] },
    { resourceType: "Practitioner", id: "syn-prac-2", name: [{ family: "Lindqvist", given: ["Jonas"], prefix: ["Dr."] }], identifier: [{ system: "http://hl7.org/fhir/sid/us-npi", value: "9990000029" }] },
  ];
  const location: R = { resourceType: "Location", id: "syn-loc-1", name: "Synthetic Hospital Main Clinic", managingOrganization: { reference: "Organization/syn-org-1" } };
  resources.push(org, ...practitioners, location);

  const username = `${person.given}.${person.family}`.toLowerCase() + "@synthetic.infinimed.dev";
  resources.push({
    resourceType: "Patient",
    id: pid,
    meta: { profile: ["http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient"] },
    identifier: [{ system: "urn:oid:2.16.840.1.113883.3.9999.1", value: `MRN${100000 + index * 37}`, type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "MR" }] } }],
    name: [{ use: "official", family: person.family, given: [person.given] }],
    gender: person.gender,
    birthDate: person.birth,
    telecom: [
      { system: "phone", value: `555-01${String(10 + index).padStart(2, "0")}`, use: "home" },
      { system: "email", value: username },
    ],
    address: [{ line: [`${100 + index * 11} Example Street`], city: person.city, state: person.state, postalCode: person.zip, country: "US" }],
    managingOrganization: { reference: "Organization/syn-org-1" },
  });

  resources.push({
    resourceType: "Coverage",
    id: `${pid}-cov`,
    status: "active",
    beneficiary: subject,
    subscriberId: `SYN${200000 + index}`,
    payor: [{ display: "Synthetic Health Plan" }],
    class: [{ type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/coverage-class", code: "plan" }] }, value: "GOLD-PPO", name: "Gold PPO" }],
  });

  // Problems: 2-4 conditions, deterministic per patient.
  const nConditions = 2 + Math.floor(rnd() * 3);
  const chosen = [...CONDITIONS].sort(() => rnd() - 0.5).slice(0, nConditions);
  const now = new Date("2026-09-01T15:00:00Z");
  const start = new Date(now.getTime() - 3 * 365 * 86400_000);
  chosen.forEach((c, i) => {
    resources.push({
      resourceType: "Condition",
      id: `${pid}-cond-${i + 1}`,
      clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: "active" }] },
      verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }] },
      category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/condition-category", code: "problem-list-item" }] }],
      code: {
        coding: [
          { system: SNOMED, code: c.snomed, display: c.display },
          { system: "http://hl7.org/fhir/sid/icd-10-cm", code: c.icd, display: c.display },
        ],
        text: c.display,
      },
      subject,
      onsetDateTime: iso(new Date(start.getTime() - between(30, 2000) * 86400_000)).slice(0, 10),
      recordedDate: iso(start).slice(0, 10),
    });
    (MEDS_FOR[c.snomed] ?? []).forEach((m, j) => {
      resources.push({
        resourceType: "MedicationRequest",
        id: `${pid}-med-${i + 1}-${j + 1}`,
        status: "active",
        intent: "order",
        medicationCodeableConcept: { coding: [{ system: "http://www.nlm.nih.gov/research/umls/rxnorm", code: m.rxnorm, display: m.display }], text: m.display },
        subject,
        authoredOn: iso(start).slice(0, 10),
        requester: { reference: "Practitioner/syn-prac-1", display: "Dr. Grace Adebayo" },
        dosageInstruction: [{ text: m.dose }],
      });
    });
  });

  const nAllergies = 1 + Math.floor(rnd() * 2);
  [...ALLERGIES].sort(() => rnd() - 0.5).slice(0, nAllergies).forEach((a, i) => {
    resources.push({
      resourceType: "AllergyIntolerance",
      id: `${pid}-allergy-${i + 1}`,
      clinicalStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical", code: "active" }] },
      verificationStatus: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification", code: "confirmed" }] },
      category: [a.category],
      criticality: a.criticality,
      code: { coding: [{ system: a.system, code: a.code, display: a.display }], text: a.display },
      patient: subject,
      recordedDate: iso(start).slice(0, 10),
      reaction: [{ manifestation: [{ text: a.reaction }], severity: a.criticality === "high" ? "severe" : "mild" }],
    });
  });

  const hasDiabetes = chosen.some((c) => c.snomed === "44054006");
  const baseWeight = between(58, 112, 1);
  const height = person.gender === "male" ? between(168, 190, 1) : between(155, 175, 1);
  const smokingCodes = [
    { code: "266919005", display: "Never smoked tobacco" },
    { code: "8517006", display: "Ex-smoker" },
    { code: "449868002", display: "Smokes tobacco daily" },
  ];
  const smoking = pick(smokingCodes);

  const nEncounters = 8 + Math.floor(rnd() * 5);
  for (let e = 0; e < nEncounters; e++) {
    const when = new Date(start.getTime() + Math.floor(((e + rnd() * 0.5) / nEncounters) * (now.getTime() - start.getTime())));
    const encId = `${pid}-enc-${e + 1}`;
    const isEr = rnd() < 0.08;
    resources.push({
      resourceType: "Encounter",
      id: encId,
      status: "finished",
      class: { system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: isEr ? "EMER" : "AMB", display: isEr ? "emergency" : "ambulatory" },
      type: [{ coding: [{ system: SNOMED, code: isEr ? "50849002" : e === 0 ? "185349003" : "390906007", display: isEr ? "Emergency room admission" : e === 0 ? "Encounter for check up" : "Follow-up encounter" }] }],
      subject,
      participant: [{ individual: { reference: "Practitioner/syn-prac-1", display: "Dr. Grace Adebayo" } }],
      period: { start: iso(when), end: iso(new Date(when.getTime() + 30 * 60_000)) },
      location: [{ location: { reference: "Location/syn-loc-1", display: "Synthetic Hospital Main Clinic" } }],
      serviceProvider: { reference: "Organization/syn-org-1" },
    });
    const enc = { reference: `Encounter/${encId}` };
    const t = iso(when);
    const weight = Math.round((baseWeight + (e - nEncounters / 2) * between(-0.6, 0.6, 2)) * 10) / 10;
    const vital = (id: string, code: string, display: string, value: number, unit: string, ucum: string): R => ({
      resourceType: "Observation",
      id: `${pid}-${id}-${e + 1}`,
      status: "final",
      category: [{ coding: [{ system: OBS_CAT, code: "vital-signs" }] }],
      code: { coding: [{ system: LOINC, code, display }], text: display },
      subject,
      encounter: enc,
      effectiveDateTime: t,
      performer: [{ reference: "Practitioner/syn-prac-2", display: "Dr. Jonas Lindqvist" }],
      valueQuantity: { value, unit, system: UCUM, code: ucum },
    });
    // Alternate units across visits so unit normalisation has work to do.
    resources.push(
      e % 3 === 0
        ? vital("wt", "29463-7", "Body weight", Math.round(weight * 2.20462 * 10) / 10, "lb", "[lb_av]")
        : vital("wt", "29463-7", "Body weight", weight, "kg", "kg"),
    );
    if (e % 4 === 0) resources.push(vital("ht", "8302-2", "Body height", height, "cm", "cm"));
    if (e % 2 === 0) resources.push(vital("bmi", "39156-5", "Body mass index", Math.round((weight / (height / 100) ** 2) * 10) / 10, "kg/m2", "kg/m2"));
    resources.push(vital("hr", "8867-4", "Heart rate", Math.round(between(58, 96)), "/min", "/min"));
    resources.push(vital("rr", "9279-1", "Respiratory rate", Math.round(between(12, 20)), "/min", "/min"));
    resources.push(vital("spo2", "59408-5", "Oxygen saturation in Arterial blood by Pulse oximetry", Math.round(between(94, 100)), "%", "%"));
    resources.push(
      e % 2 === 0
        ? vital("temp", "8310-5", "Body temperature", between(36.4, 37.4, 1), "C", "Cel")
        : vital("temp", "8310-5", "Body temperature", between(97.5, 99.3, 1), "degF", "[degF]"),
    );
    const sys = Math.round(between(112, 152));
    resources.push({
      resourceType: "Observation",
      id: `${pid}-bp-${e + 1}`,
      status: "final",
      category: [{ coding: [{ system: OBS_CAT, code: "vital-signs" }] }],
      code: { coding: [{ system: LOINC, code: "85354-9", display: "Blood pressure panel with all children optional" }], text: "Blood pressure" },
      subject,
      encounter: enc,
      effectiveDateTime: t,
      component: [
        { code: { coding: [{ system: LOINC, code: "8480-6", display: "Systolic blood pressure" }] }, valueQuantity: { value: sys, unit: "mmHg", system: UCUM, code: "mm[Hg]" } },
        { code: { coding: [{ system: LOINC, code: "8462-4", display: "Diastolic blood pressure" }] }, valueQuantity: { value: Math.round(sys * between(0.58, 0.68, 2)), unit: "mmHg", system: UCUM, code: "mm[Hg]" } },
      ],
    });

    // Labs every other visit, grouped by a DiagnosticReport.
    if (e % 2 === 1) {
      const labs: R[] = [];
      const lab = (id: string, code: string, display: string, value: number, unit: string, ucum: string, low?: number, high?: number): R => {
        const r: R = {
          resourceType: "Observation",
          id: `${pid}-${id}-${e + 1}`,
          status: "final",
          category: [{ coding: [{ system: OBS_CAT, code: "laboratory" }] }],
          code: { coding: [{ system: LOINC, code, display }], text: display },
          subject,
          encounter: enc,
          effectiveDateTime: t,
          issued: iso(new Date(when.getTime() + 6 * 3600_000)),
          valueQuantity: { value, unit, system: UCUM, code: ucum },
          ...(low !== undefined && high !== undefined ? { referenceRange: [{ low: { value: low, unit }, high: { value: high, unit } }] } : {}),
        };
        if (low !== undefined && high !== undefined && (value < low || value > high)) {
          r.interpretation = [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", code: value > high ? "H" : "L" }] }];
        }
        labs.push(r);
        return r;
      };
      const a1c = hasDiabetes ? between(6.6, 9.4, 1) : between(4.9, 5.9, 1);
      if (e % 4 === 1) lab("a1c", "4548-4", "Hemoglobin A1c/Hemoglobin.total in Blood", a1c, "%", "%", 4, 5.6);
      else lab("a1c", "59261-8", "Hemoglobin A1c/Hemoglobin.total in Blood by IFCC protocol", Math.round(((a1c - 2.152) / 0.09148) * 10) / 10, "mmol/mol", "mmol/mol");
      const glucose = hasDiabetes ? between(130, 210) : between(78, 104);
      if (e % 3 === 0) lab("glu", "14749-6", "Glucose [Moles/volume] in Serum or Plasma", Math.round((glucose / 18.016) * 10) / 10, "mmol/L", "mmol/L", 3.9, 5.6);
      else lab("glu", "2345-7", "Glucose [Mass/volume] in Serum or Plasma", Math.round(glucose), "mg/dL", "mg/dL", 70, 99);
      lab("chol", "2093-3", "Cholesterol [Mass/volume] in Serum or Plasma", Math.round(between(160, 260)), "mg/dL", "mg/dL", 0, 200);
      lab("ldl", "13457-7", "Cholesterol in LDL [Mass/volume] in Serum or Plasma by calculation", Math.round(between(70, 170)), "mg/dL", "mg/dL", 0, 100);
      lab("hdl", "2085-9", "Cholesterol in HDL [Mass/volume] in Serum or Plasma", Math.round(between(35, 75)), "mg/dL", "mg/dL", 40, 200);
      lab("trig", "2571-8", "Triglyceride [Mass/volume] in Serum or Plasma", Math.round(between(80, 240)), "mg/dL", "mg/dL", 0, 150);
      lab("creat", "2160-0", "Creatinine [Mass/volume] in Serum or Plasma", between(0.7, 1.4, 2), "mg/dL", "mg/dL", 0.6, 1.3);
      lab("egfr", "98979-8", "Glomerular filtration rate/1.73 sq M.predicted [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine-based formula (CKD-EPI 2021)", Math.round(between(55, 105)), "mL/min/{1.73_m2}", "mL/min/{1.73_m2}", 60, 200);
      lab("hgb", "718-7", "Hemoglobin [Mass/volume] in Blood", between(11.8, 16.2, 1), "g/dL", "g/dL", 12, 17.5);
      lab("wbc", "6690-2", "Leukocytes [#/volume] in Blood by Automated count", between(4.2, 10.5, 1), "10*3/uL", "10*3/uL", 4, 11);
      lab("plt", "777-3", "Platelets [#/volume] in Blood by Automated count", Math.round(between(160, 380)), "10*3/uL", "10*3/uL", 150, 400);
      resources.push(...labs);
      resources.push({
        resourceType: "DiagnosticReport",
        id: `${pid}-dr-${e + 1}`,
        status: "final",
        category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: "LAB", display: "Laboratory" }] }],
        code: { coding: [{ system: LOINC, code: "24323-8", display: "Comprehensive metabolic 2000 panel - Serum or Plasma" }], text: "Lab panel" },
        subject,
        encounter: enc,
        effectiveDateTime: t,
        issued: iso(new Date(when.getTime() + 6 * 3600_000)),
        performer: [{ reference: "Organization/syn-org-1", display: "Synthetic Hospital Laboratory" }],
        result: labs.map((l) => ({ reference: `Observation/${l.id}` })),
      });
    }
    if (e === 0) {
      resources.push({
        resourceType: "Observation",
        id: `${pid}-smoking`,
        status: "final",
        category: [{ coding: [{ system: OBS_CAT, code: "social-history" }] }],
        code: { coding: [{ system: LOINC, code: "72166-2", display: "Tobacco smoking status" }] },
        subject,
        effectiveDateTime: t,
        valueCodeableConcept: { coding: [{ system: SNOMED, code: smoking.code, display: smoking.display }], text: smoking.display },
      });
      const note = `Annual exam for ${person.given} ${person.family}. Problems reviewed: ${chosen.map((c) => c.display).join(", ")}. Continue current medications. Return in 3 months.`;
      resources.push({
        resourceType: "DocumentReference",
        id: `${pid}-note-1`,
        status: "current",
        type: { coding: [{ system: LOINC, code: "11506-3", display: "Progress note" }] },
        category: [{ coding: [{ system: "http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category", code: "clinical-note" }] }],
        subject,
        date: t,
        author: [{ reference: "Practitioner/syn-prac-1", display: "Dr. Grace Adebayo" }],
        description: "Annual exam progress note",
        content: [{ attachment: { contentType: "text/plain", data: Buffer.from(note).toString("base64"), title: "Progress note" } }],
        context: { encounter: [enc] },
      });
      resources.push({
        resourceType: "Procedure",
        id: `${pid}-proc-1`,
        status: "completed",
        code: { coding: [{ system: SNOMED, code: "171207006", display: "Depression screening" }] },
        subject,
        encounter: enc,
        performedDateTime: t,
      });
    }
  }

  VACCINES.slice(0, 2 + Math.floor(rnd() * 3)).forEach((v, i) => {
    resources.push({
      resourceType: "Immunization",
      id: `${pid}-imm-${i + 1}`,
      status: "completed",
      vaccineCode: { coding: [{ system: "http://hl7.org/fhir/sid/cvx", code: v.cvx, display: v.display }], text: v.display },
      patient: subject,
      occurrenceDateTime: iso(new Date(start.getTime() + (i + 1) * 120 * 86400_000)),
      primarySource: true,
      lotNumber: `LOT${1000 + index * 10 + i}`,
    });
  });

  return {
    bundle: { resourceType: "Bundle", id: `${pid}-bundle`, type: "collection", entry: resources.map((resource) => ({ resource })) },
    patientId: pid,
    username,
    displayName: `${person.given} ${person.family}`,
  };
}
