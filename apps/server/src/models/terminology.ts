/**
 * Code system normalisation. Sources mix canonical URIs, HL7 OIDs and vendor spellings for the
 * same terminology; comparisons first map every system to its canonical URI.
 */

export const SYSTEMS = {
  loinc: "http://loinc.org",
  snomed: "http://snomed.info/sct",
  rxnorm: "http://www.nlm.nih.gov/research/umls/rxnorm",
  icd10cm: "http://hl7.org/fhir/sid/icd-10-cm",
  icd10: "http://hl7.org/fhir/sid/icd-10",
  icd9cm: "http://hl7.org/fhir/sid/icd-9-cm",
  cvx: "http://hl7.org/fhir/sid/cvx",
  cpt: "http://www.ama-assn.org/go/cpt",
  ndc: "http://hl7.org/fhir/sid/ndc",
  ucum: "http://unitsofmeasure.org",
  hcpcs: "https://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets",
} as const;

const ALIASES: Record<string, string> = {
  "urn:oid:2.16.840.1.113883.6.1": SYSTEMS.loinc,
  "http://loinc.org/": SYSTEMS.loinc,
  "urn:oid:2.16.840.1.113883.6.96": SYSTEMS.snomed,
  "http://snomed.info/sct/": SYSTEMS.snomed,
  "urn:oid:2.16.840.1.113883.6.88": SYSTEMS.rxnorm,
  "http://www.nlm.nih.gov/research/umls/rxnorm/": SYSTEMS.rxnorm,
  "urn:oid:2.16.840.1.113883.6.90": SYSTEMS.icd10cm,
  "urn:oid:2.16.840.1.113883.6.3": SYSTEMS.icd10,
  "urn:oid:2.16.840.1.113883.6.103": SYSTEMS.icd9cm,
  "urn:oid:2.16.840.1.113883.12.292": SYSTEMS.cvx,
  "urn:oid:2.16.840.1.113883.6.12": SYSTEMS.cpt,
  "urn:oid:2.16.840.1.113883.6.69": SYSTEMS.ndc,
  "urn:oid:2.16.840.1.113883.6.8": SYSTEMS.ucum,
  "urn:oid:2.16.840.1.113883.6.285": SYSTEMS.hcpcs,
};

export function canonicalSystem(system: string | undefined | null): string {
  if (!system) return "";
  const s = system.trim();
  return ALIASES[s] ?? ALIASES[s.toLowerCase()] ?? s.replace(/\/+$/, "");
}

export const SYSTEM_LABEL: Record<string, string> = {
  [SYSTEMS.loinc]: "LOINC",
  [SYSTEMS.snomed]: "SNOMED CT",
  [SYSTEMS.rxnorm]: "RxNorm",
  [SYSTEMS.icd10cm]: "ICD-10-CM",
  [SYSTEMS.icd10]: "ICD-10",
  [SYSTEMS.icd9cm]: "ICD-9-CM",
  [SYSTEMS.cvx]: "CVX",
  [SYSTEMS.cpt]: "CPT",
  [SYSTEMS.ndc]: "NDC",
};

export type Coding = { system?: string; code?: string; display?: string };
export type CodeableConcept = { coding?: Coding[]; text?: string };

export function codings(cc: CodeableConcept | undefined | null): { system: string; code: string; display?: string }[] {
  return (cc?.coding ?? [])
    .filter((c) => c.code)
    .map((c) => ({ system: canonicalSystem(c.system), code: String(c.code).trim(), display: c.display }));
}

export function hasCode(cc: CodeableConcept | undefined | null, system: string, codes: readonly string[]): boolean {
  return codings(cc).some((c) => c.system === system && codes.includes(c.code));
}

export function firstCode(cc: CodeableConcept | undefined | null, preferred: string[]): { system: string; code: string; display?: string } | null {
  const all = codings(cc);
  for (const sys of preferred) {
    const hit = all.find((c) => c.system === sys);
    if (hit) return hit;
  }
  return all[0] ?? null;
}

export function displayOf(cc: CodeableConcept | undefined | null): string | null {
  if (!cc) return null;
  return cc.text ?? cc.coding?.find((c) => c.display)?.display ?? cc.coding?.[0]?.code ?? null;
}

export function normalizeText(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
