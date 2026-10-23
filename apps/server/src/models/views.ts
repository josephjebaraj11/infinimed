import { codings, displayOf, firstCode, normalizeText, SYSTEMS, type CodeableConcept } from "./terminology.js";
import type { StoredResource } from "./resolver.js";

/**
 * Clinical models: one row per clinical fact, reconciled across every connected source.
 *
 * Rows from different sources describing the same thing (same coded substance, same diagnosis,
 * same vaccine on the same day...) merge into one row whose `sources` list keeps every original
 * reference. Merging is deliberately safety-biased: an allergy keeps the highest criticality any
 * source reported and an active status from any source wins, so reconciliation can never hide a
 * risk that one source recorded.
 */

export type SourceRef = { source: string; reference: string; last_updated: string | null };
export type ModelRow = Record<string, unknown> & { key: string; sources: SourceRef[] };

export const MODEL_NAMES = [
  "allergies",
  "conditions",
  "medications",
  "immunizations",
  "procedures",
  "encounters",
  "labs",
  "vitals",
  "documents",
  "coverage",
  "claims",
] as const;
export type ModelName = (typeof MODEL_NAMES)[number];

const ref = (r: Record<string, unknown>) => `${r.resourceType}/${r.id}`;
const lastUpdated = (r: Record<string, unknown>) => ((r.meta as { lastUpdated?: string } | undefined)?.lastUpdated ?? null);
const day = (s: unknown) => (typeof s === "string" ? s.slice(0, 10) : null);
const statusCode = (cc: unknown) => codings(cc as CodeableConcept)[0]?.code ?? null;

function codeKey(cc: CodeableConcept | undefined, preferred: string[]): { key: string; codes: { system: string; code: string; display?: string }[] } {
  const all = codings(cc);
  const best = firstCode(cc, preferred);
  if (best && preferred.includes(best.system)) return { key: `${best.system}|${best.code}`, codes: all };
  return { key: `text|${normalizeText(displayOf(cc) ?? "")}`, codes: all };
}

function merge(rows: Map<string, ModelRow>, key: string, row: Omit<ModelRow, "key" | "sources">, src: SourceRef, combine?: (a: ModelRow, b: Omit<ModelRow, "key" | "sources">) => void) {
  const existing = rows.get(key);
  if (!existing) {
    rows.set(key, { key, ...row, sources: [src] });
    return;
  }
  if (!existing.sources.some((s) => s.reference === src.reference && s.source === src.source)) existing.sources.push(src);
  combine?.(existing, row);
}

const CRITICALITY_RANK: Record<string, number> = { low: 1, "unable-to-assess": 2, high: 3 };

function allergies(resources: StoredResource[]) {
  const rows = new Map<string, ModelRow>();
  for (const { sourceId, resource: r } of resources) {
    if (r.resourceType !== "AllergyIntolerance") continue;
    const verification = statusCode(r.verificationStatus);
    if (verification === "entered-in-error") continue;
    const { key, codes } = codeKey(r.code as CodeableConcept, [SYSTEMS.rxnorm, SYSTEMS.snomed]);
    const reactions = ((r.reaction as { manifestation?: CodeableConcept[]; severity?: string }[] | undefined) ?? []).flatMap((x) =>
      (x.manifestation ?? []).map((m) => ({ manifestation: displayOf(m), severity: x.severity ?? null })),
    );
    merge(
      rows,
      key,
      {
        substance: displayOf(r.code as CodeableConcept),
        codes,
        category: (r.category as string[] | undefined) ?? [],
        criticality: (r.criticality as string) ?? null,
        clinical_status: statusCode(r.clinicalStatus),
        verification_status: verification,
        reactions,
        recorded: (r.recordedDate as string) ?? (r.onsetDateTime as string) ?? null,
      },
      { source: sourceId, reference: ref(r), last_updated: lastUpdated(r) },
      (a, b) => {
        if ((CRITICALITY_RANK[String(b.criticality)] ?? 0) > (CRITICALITY_RANK[String(a.criticality)] ?? 0)) a.criticality = b.criticality;
        if (b.clinical_status === "active") a.clinical_status = "active";
        if (a.verification_status !== "confirmed" && b.verification_status === "confirmed") a.verification_status = "confirmed";
        const seen = new Set((a.reactions as { manifestation: string }[]).map((x) => x.manifestation));
        for (const x of b.reactions as { manifestation: string }[]) if (!seen.has(x.manifestation)) (a.reactions as unknown[]).push(x);
        if (String(b.recorded ?? "") > String(a.recorded ?? "")) a.recorded = b.recorded;
      },
    );
  }
  return rows;
}

function conditions(resources: StoredResource[]) {
  const rows = new Map<string, ModelRow>();
  for (const { sourceId, resource: r } of resources) {
    if (r.resourceType !== "Condition") continue;
    if (statusCode(r.verificationStatus) === "entered-in-error") continue;
    const { key, codes } = codeKey(r.code as CodeableConcept, [SYSTEMS.snomed, SYSTEMS.icd10cm, SYSTEMS.icd10, SYSTEMS.icd9cm]);
    merge(
      rows,
      key,
      {
        display: displayOf(r.code as CodeableConcept),
        codes,
        clinical_status: statusCode(r.clinicalStatus),
        category: ((r.category as CodeableConcept[] | undefined) ?? []).map((c) => codings(c)[0]?.code ?? displayOf(c)),
        onset: (r.onsetDateTime as string) ?? (r.onsetPeriod as { start?: string })?.start ?? null,
        abatement: (r.abatementDateTime as string) ?? null,
        recorded: (r.recordedDate as string) ?? null,
      },
      { source: sourceId, reference: ref(r), last_updated: lastUpdated(r) },
      (a, b) => {
        if (b.clinical_status === "active") a.clinical_status = "active";
        if (b.onset && (!a.onset || String(b.onset) < String(a.onset))) a.onset = b.onset;
      },
    );
  }
  return rows;
}

function medications(resources: StoredResource[]) {
  const meds = new Map<string, Record<string, unknown>>();
  for (const { resource } of resources) if (resource.resourceType === "Medication") meds.set(`Medication/${resource.id}`, resource);
  const rows = new Map<string, ModelRow>();
  for (const { sourceId, resource: r } of resources) {
    if (!["MedicationRequest", "MedicationStatement", "MedicationDispense"].includes(String(r.resourceType))) continue;
    if (["entered-in-error", "cancelled"].includes(String(r.status))) continue;
    let cc = r.medicationCodeableConcept as CodeableConcept | undefined;
    const medRef = (r.medicationReference as { reference?: string; display?: string } | undefined)?.reference;
    if (!cc && medRef) cc = meds.get(medRef)?.code as CodeableConcept | undefined;
    if (!cc && (r.medicationReference as { display?: string })?.display) cc = { text: (r.medicationReference as { display: string }).display };
    const { key, codes } = codeKey(cc, [SYSTEMS.rxnorm, SYSTEMS.ndc, SYSTEMS.snomed]);
    const dosage = ((r.dosageInstruction as { text?: string }[] | undefined) ?? (r.dosage as { text?: string }[] | undefined) ?? [])[0]?.text ?? null;
    const date = (r.authoredOn as string) ?? (r.whenHandedOver as string) ?? (r.effectiveDateTime as string) ?? (r.effectivePeriod as { start?: string })?.start ?? null;
    merge(
      rows,
      key,
      { display: displayOf(cc), codes, status: (r.status as string) ?? null, intent: (r.intent as string) ?? null, dosage, last_date: date, kinds: [r.resourceType] },
      { source: sourceId, reference: ref(r), last_updated: lastUpdated(r) },
      (a, b) => {
        if (String(b.last_date ?? "") > String(a.last_date ?? "")) {
          a.last_date = b.last_date;
          a.status = b.status;
          a.dosage = b.dosage ?? a.dosage;
        }
        if (b.status === "active") a.status = "active";
        for (const k of b.kinds as string[]) if (!(a.kinds as string[]).includes(k)) (a.kinds as string[]).push(k);
      },
    );
  }
  return rows;
}

function immunizations(resources: StoredResource[]) {
  const rows = new Map<string, ModelRow>();
  for (const { sourceId, resource: r } of resources) {
    if (r.resourceType !== "Immunization" || r.status === "entered-in-error") continue;
    const { key, codes } = codeKey(r.vaccineCode as CodeableConcept, [SYSTEMS.cvx, SYSTEMS.ndc]);
    const date = (r.occurrenceDateTime as string) ?? null;
    merge(
      rows,
      `${key}|${day(date)}`,
      { vaccine: displayOf(r.vaccineCode as CodeableConcept), codes, date, status: r.status ?? null, lot_number: r.lotNumber ?? null },
      { source: sourceId, reference: ref(r), last_updated: lastUpdated(r) },
    );
  }
  return rows;
}

function procedures(resources: StoredResource[]) {
  const rows = new Map<string, ModelRow>();
  for (const { sourceId, resource: r } of resources) {
    if (r.resourceType !== "Procedure" || r.status === "entered-in-error") continue;
    const { key, codes } = codeKey(r.code as CodeableConcept, [SYSTEMS.snomed, SYSTEMS.cpt, SYSTEMS.hcpcs]);
    const date = (r.performedDateTime as string) ?? (r.performedPeriod as { start?: string })?.start ?? null;
    merge(rows, `${key}|${day(date)}`, { display: displayOf(r.code as CodeableConcept), codes, date, status: r.status ?? null }, { source: sourceId, reference: ref(r), last_updated: lastUpdated(r) });
  }
  return rows;
}

function encounters(resources: StoredResource[]) {
  const rows = new Map<string, ModelRow>();
  for (const { sourceId, resource: r } of resources) {
    if (r.resourceType !== "Encounter" || r.status === "entered-in-error") continue;
    const start = (r.period as { start?: string; end?: string } | undefined)?.start ?? null;
    const type = (r.type as CodeableConcept[] | undefined)?.[0];
    const cls = (r.class as { code?: string } | undefined)?.code ?? null;
    merge(
      rows,
      `${sourceId}|${r.id}`,
      {
        type: displayOf(type),
        class: cls,
        status: r.status ?? null,
        start,
        end: (r.period as { end?: string } | undefined)?.end ?? null,
        location: (r.location as { location?: { display?: string } }[] | undefined)?.[0]?.location?.display ?? null,
        provider: (r.participant as { individual?: { display?: string } }[] | undefined)?.[0]?.individual?.display ?? null,
        reason: displayOf((r.reasonCode as CodeableConcept[] | undefined)?.[0]),
      },
      { source: sourceId, reference: ref(r), last_updated: lastUpdated(r) },
    );
  }
  return rows;
}

function observationsBy(resources: StoredResource[], category: string) {
  const rows = new Map<string, ModelRow>();
  for (const { sourceId, resource: r } of resources) {
    if (r.resourceType !== "Observation" || ["entered-in-error", "cancelled"].includes(String(r.status))) continue;
    const cats = ((r.category as CodeableConcept[] | undefined) ?? []).flatMap((c) => codings(c).map((x) => x.code));
    if (!cats.includes(category)) continue;
    const { key, codes } = codeKey(r.code as CodeableConcept, [SYSTEMS.loinc]);
    const effective = (r.effectiveDateTime as string) ?? (r.effectivePeriod as { start?: string })?.start ?? (r.issued as string) ?? null;
    const q = r.valueQuantity as { value?: number; unit?: string; code?: string } | undefined;
    const value = q?.value ?? displayOf(r.valueCodeableConcept as CodeableConcept) ?? (r.valueString as string) ?? null;
    const components = ((r.component as Record<string, unknown>[] | undefined) ?? []).map((c) => ({
      display: displayOf(c.code as CodeableConcept),
      value: (c.valueQuantity as { value?: number })?.value ?? displayOf(c.valueCodeableConcept as CodeableConcept) ?? null,
      unit: (c.valueQuantity as { unit?: string; code?: string })?.unit ?? (c.valueQuantity as { code?: string })?.code ?? null,
    }));
    const range = (r.referenceRange as { low?: { value?: number }; high?: { value?: number }; text?: string }[] | undefined)?.[0];
    merge(
      rows,
      `${key}|${effective?.slice(0, 16) ?? "?"}|${value}`,
      {
        display: displayOf(r.code as CodeableConcept),
        codes,
        effective,
        value,
        unit: q?.unit ?? q?.code ?? null,
        components: components.length ? components : undefined,
        interpretation: displayOf((r.interpretation as CodeableConcept[] | undefined)?.[0]),
        reference_range: range ? (range.text ?? [range.low?.value, range.high?.value].filter((x) => x !== undefined).join("-")) || null : null,
        status: r.status ?? null,
      },
      { source: sourceId, reference: ref(r), last_updated: lastUpdated(r) },
    );
  }
  return rows;
}

function documents(resources: StoredResource[]) {
  const rows = new Map<string, ModelRow>();
  for (const { sourceId, resource: r } of resources) {
    if (r.resourceType !== "DocumentReference" || r.status === "entered-in-error") continue;
    const master = (r.masterIdentifier as { value?: string } | undefined)?.value;
    const attachments = ((r.content as { attachment?: { contentType?: string; url?: string; title?: string; size?: number } }[] | undefined) ?? []).map((c) => ({
      content_type: c.attachment?.contentType ?? null,
      url: c.attachment?.url ?? null,
      title: c.attachment?.title ?? null,
      size: c.attachment?.size ?? null,
    }));
    merge(
      rows,
      master ? `master|${master}` : `${sourceId}|${r.id}`,
      {
        type: displayOf(r.type as CodeableConcept),
        category: displayOf((r.category as CodeableConcept[] | undefined)?.[0]),
        date: (r.date as string) ?? null,
        description: (r.description as string) ?? null,
        author: (r.author as { display?: string }[] | undefined)?.[0]?.display ?? null,
        attachments,
      },
      { source: sourceId, reference: ref(r), last_updated: lastUpdated(r) },
    );
  }
  return rows;
}

function coverage(resources: StoredResource[]) {
  const rows = new Map<string, ModelRow>();
  for (const { sourceId, resource: r } of resources) {
    if (r.resourceType !== "Coverage") continue;
    const payor = (r.payor as { display?: string; reference?: string }[] | undefined)?.[0];
    const plan = ((r.class as { type?: CodeableConcept; value?: string; name?: string }[] | undefined) ?? []).find((c) => codings(c.type)[0]?.code === "plan");
    merge(
      rows,
      `${normalizeText(payor?.display ?? payor?.reference ?? "")}|${r.subscriberId ?? r.id}`,
      {
        payor: payor?.display ?? payor?.reference ?? null,
        plan: plan?.name ?? plan?.value ?? null,
        status: r.status ?? null,
        type: displayOf(r.type as CodeableConcept),
        subscriber_id: r.subscriberId ?? null,
        period: r.period ?? null,
      },
      { source: sourceId, reference: ref(r), last_updated: lastUpdated(r) },
    );
  }
  return rows;
}

function claims(resources: StoredResource[]) {
  const rows = new Map<string, ModelRow>();
  for (const { sourceId, resource: r } of resources) {
    if (r.resourceType !== "ExplanationOfBenefit") continue;
    const total = ((r.total as { category?: CodeableConcept; amount?: { value?: number; currency?: string } }[] | undefined) ?? []).map((t) => ({
      category: codings(t.category)[0]?.code ?? displayOf(t.category),
      amount: t.amount?.value ?? null,
      currency: t.amount?.currency ?? null,
    }));
    const diagnoses = ((r.diagnosis as { diagnosisCodeableConcept?: CodeableConcept }[] | undefined) ?? []).map((d) => firstCode(d.diagnosisCodeableConcept, [SYSTEMS.icd10cm, SYSTEMS.icd10])).filter(Boolean);
    merge(
      rows,
      `${sourceId}|${r.id}`,
      {
        type: displayOf(r.type as CodeableConcept),
        status: r.status ?? null,
        billable_period: r.billablePeriod ?? null,
        provider: (r.provider as { display?: string } | undefined)?.display ?? null,
        outcome: r.outcome ?? null,
        totals: total,
        diagnoses,
      },
      { source: sourceId, reference: ref(r), last_updated: lastUpdated(r) },
    );
  }
  return rows;
}

const SORT: Partial<Record<ModelName, string>> = {
  allergies: "recorded",
  conditions: "onset",
  medications: "last_date",
  immunizations: "date",
  procedures: "date",
  encounters: "start",
  labs: "effective",
  vitals: "effective",
  documents: "date",
};

export function buildModel(name: ModelName, resources: StoredResource[]): ModelRow[] {
  const builders: Record<ModelName, (r: StoredResource[]) => Map<string, ModelRow>> = {
    allergies,
    conditions,
    medications,
    immunizations,
    procedures,
    encounters,
    labs: (r) => observationsBy(r, "laboratory"),
    vitals: (r) => observationsBy(r, "vital-signs"),
    documents,
    coverage,
    claims,
  };
  const rows = [...builders[name](resources).values()];
  const field = SORT[name];
  if (field) rows.sort((a, b) => String(b[field] ?? "").localeCompare(String(a[field] ?? "")));
  return rows;
}

/** Types each model reads, so callers fetch only what is needed. */
export const MODEL_SOURCES: Record<ModelName, string[]> = {
  allergies: ["AllergyIntolerance"],
  conditions: ["Condition"],
  medications: ["MedicationRequest", "MedicationStatement", "MedicationDispense", "Medication"],
  immunizations: ["Immunization"],
  procedures: ["Procedure"],
  encounters: ["Encounter"],
  labs: ["Observation"],
  vitals: ["Observation"],
  documents: ["DocumentReference"],
  coverage: ["Coverage"],
  claims: ["ExplanationOfBenefit"],
};
