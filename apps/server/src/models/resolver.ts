import { CONCEPT_BY_CODE, CONCEPTS, type Concept } from "./concepts.js";
import { codings, displayOf, SYSTEMS, type CodeableConcept } from "./terminology.js";
import { convert, round } from "./units.js";

/**
 * Resolves clinical concepts ("latest BMI", "mean HbA1c this year") from a patient's records across
 * every connected source, and explains each answer with provenance back to the source resources.
 *
 * Steps per concept: find Observations (or panel components) carrying one of the concept's LOINC
 * codes; drop entered-in-error / cancelled results; convert to the canonical unit; merge the same
 * measurement reported by several sources (same minute, same value) into one with multi-source
 * provenance; then aggregate. BMI falls back to a derived value from weight and height.
 */

export type Aggregate = "latest" | "earliest" | "min" | "max" | "mean" | "count" | "all";

export type Provenance = {
  reference: string;
  source: string;
  performer: string | null;
  effective: string | null;
  value: number | string | null;
  unit: string | null;
  coding: { system: string; code: string } | null;
};

export type Measurement = {
  effective: string | null;
  value: number | string;
  unit: string;
  implausible?: boolean;
  provenance: Provenance[];
};

export type Fact = {
  subject: string;
  code: string;
  display: string;
  category: string;
  aggregate: Aggregate;
  status: "hasValue" | "noValue";
  resolved_by: "direct" | "derived" | "none";
  value: number | string | null;
  unit: string | null;
  effective: string | null;
  count: number;
  series?: Measurement[];
  provenance: Provenance[];
  issues?: string[];
};

export type StoredResource = { sourceId: string; resource: Record<string, unknown> };

const EXCLUDED_STATUS = new Set(["entered-in-error", "cancelled"]);
const LOINC_SYSTEM = SYSTEMS.loinc;

function effectiveOf(r: Record<string, unknown>): string | null {
  const v = (r.effectiveDateTime as string) ?? (r.effectivePeriod as { start?: string })?.start ?? (r.effectiveInstant as string) ?? (r.issued as string);
  return typeof v === "string" ? v : null;
}

function performerOf(r: Record<string, unknown>): string | null {
  const p = (r.performer as { display?: string; reference?: string }[] | undefined)?.[0];
  return p?.display ?? p?.reference ?? null;
}

function loincIn(cc: CodeableConcept | undefined, codes: string[]) {
  return codings(cc).find((c) => c.system === LOINC_SYSTEM && codes.includes(c.code)) ?? null;
}

type RawValue = { value: number | string; unit: string | null };

function quantityOf(x: Record<string, unknown>): RawValue | null {
  const q = x.valueQuantity as { value?: number; unit?: string; code?: string } | undefined;
  if (q && typeof q.value === "number") return { value: q.value, unit: q.code ?? q.unit ?? null };
  if (typeof x.valueInteger === "number") return { value: x.valueInteger, unit: null };
  const cc = x.valueCodeableConcept as CodeableConcept | undefined;
  if (cc) return { value: displayOf(cc) ?? "", unit: null };
  if (typeof x.valueString === "string") {
    const n = Number(x.valueString.replace(/[<>=\s]/g, ""));
    return Number.isFinite(n) && /^[<>=\s]*[\d.]+$/.test(x.valueString) ? { value: n, unit: null } : { value: x.valueString, unit: null };
  }
  return null;
}

/** Extracts all raw measurements of one concept from one Observation (direct or panel component). */
function extract(concept: Concept, obs: Record<string, unknown>, sourceId: string): { raw: RawValue; prov: Provenance }[] {
  if (obs.resourceType !== "Observation" || EXCLUDED_STATUS.has(String(obs.status))) return [];
  const out: { raw: RawValue; prov: Provenance }[] = [];
  const effective = effectiveOf(obs);
  const reference = `Observation/${obs.id}`;
  const direct = loincIn(obs.code as CodeableConcept, concept.loinc);
  if (direct) {
    const raw = quantityOf(obs);
    if (raw) out.push({ raw, prov: { reference, source: sourceId, performer: performerOf(obs), effective, value: raw.value, unit: raw.unit, coding: { system: direct.system, code: direct.code } } });
  }
  for (const comp of (obs.component as Record<string, unknown>[] | undefined) ?? []) {
    const hit = loincIn(comp.code as CodeableConcept, concept.loinc);
    if (!hit) continue;
    const raw = quantityOf(comp);
    if (raw) out.push({ raw, prov: { reference, source: sourceId, performer: performerOf(obs), effective, value: raw.value, unit: raw.unit, coding: { system: hit.system, code: hit.code } } });
  }
  return out;
}

export function measurementsFor(concept: Concept, resources: StoredResource[]): { measurements: Measurement[]; issues: string[] } {
  const issues: string[] = [];
  const merged = new Map<string, Measurement>();
  for (const { sourceId, resource } of resources) {
    for (const { raw, prov } of extract(concept, resource, sourceId)) {
      let value: number | string;
      if (concept.valueType === "quantity") {
        if (typeof raw.value !== "number") {
          issues.push(`${prov.reference}: non-numeric value`);
          continue;
        }
        const unitIn = raw.unit ?? concept.unit;
        const converted = convert(raw.value, unitIn, concept.unit, concept.code);
        if (converted === null) {
          issues.push(`${prov.reference}: cannot convert unit "${unitIn}" to ${concept.unit}`);
          continue;
        }
        value = round(converted, 2);
      } else {
        value = String(raw.value);
      }
      const minute = prov.effective ? prov.effective.slice(0, 16) : "unknown";
      const key = `${minute}|${value}`;
      const existing = merged.get(key);
      if (existing) {
        if (!existing.provenance.some((p) => p.reference === prov.reference && p.source === prov.source)) existing.provenance.push(prov);
        continue;
      }
      const implausible =
        typeof value === "number" && concept.plausible ? value < concept.plausible[0] || value > concept.plausible[1] : false;
      merged.set(key, { effective: prov.effective, value, unit: concept.unit, ...(implausible ? { implausible } : {}), provenance: [prov] });
    }
  }
  const measurements = [...merged.values()].sort((a, b) => (a.effective ?? "").localeCompare(b.effective ?? ""));
  return { measurements, issues };
}

function aggregate(ms: Measurement[], how: Aggregate): { value: number | string | null; effective: string | null; used: Measurement[] } {
  const usable = ms.filter((m) => !m.implausible);
  if (usable.length === 0) return { value: null, effective: null, used: [] };
  const numeric = usable.filter((m) => typeof m.value === "number");
  switch (how) {
    case "latest": {
      const m = usable[usable.length - 1]!;
      return { value: m.value, effective: m.effective, used: [m] };
    }
    case "earliest": {
      const m = usable[0]!;
      return { value: m.value, effective: m.effective, used: [m] };
    }
    case "min":
    case "max": {
      if (!numeric.length) return { value: null, effective: null, used: [] };
      const m = numeric.reduce((a, b) => ((how === "min" ? (b.value as number) < (a.value as number) : (b.value as number) > (a.value as number)) ? b : a));
      return { value: m.value, effective: m.effective, used: [m] };
    }
    case "mean": {
      if (!numeric.length) return { value: null, effective: null, used: [] };
      const mean = numeric.reduce((s, m) => s + (m.value as number), 0) / numeric.length;
      return { value: round(mean, 2), effective: numeric[numeric.length - 1]!.effective, used: numeric };
    }
    case "count":
      return { value: usable.length, effective: usable[usable.length - 1]!.effective, used: usable };
    case "all":
      return { value: null, effective: usable[usable.length - 1]!.effective, used: usable };
  }
}

function inWindow(m: Measurement, from?: string, to?: string) {
  if (!m.effective) return !from && !to;
  if (from && m.effective < from) return false;
  if (to && m.effective > to) return false;
  return true;
}

export function resolveFacts(args: {
  subject: string;
  resources: StoredResource[];
  codes?: string[];
  aggregate?: Aggregate;
  from?: string;
  to?: string;
}): Fact[] {
  const how = args.aggregate ?? "latest";
  const concepts = (args.codes?.length ? args.codes : CONCEPTS.map((c) => c.code)).map((code) => {
    const c = CONCEPT_BY_CODE.get(code);
    if (!c) throw new Error(`unknown concept: ${code}`);
    return c;
  });
  const observations = args.resources.filter((r) => r.resource.resourceType === "Observation");
  const facts: Fact[] = [];
  const cache = new Map<string, Measurement[]>();
  const series = (c: Concept) => {
    let s = cache.get(c.code);
    if (!s) {
      s = measurementsFor(c, observations).measurements.filter((m) => inWindow(m, args.from, args.to));
      cache.set(c.code, s);
    }
    return s;
  };

  for (const concept of concepts) {
    const { issues } = measurementsFor(concept, observations);
    const ms = series(concept);
    let agg = aggregate(ms, how);
    let resolvedBy: Fact["resolved_by"] = agg.used.length ? "direct" : "none";
    let provenance = agg.used.flatMap((m) => m.provenance);

    if (concept.code === "bmi" && agg.used.length === 0 && (how === "latest" || how === "earliest")) {
      // Derive BMI = weight (kg) / height (m)^2 from the nearest weight and height.
      const weight = aggregate(series(CONCEPT_BY_CODE.get("body_weight")!), "latest");
      const height = aggregate(series(CONCEPT_BY_CODE.get("body_height")!), "latest");
      if (typeof weight.value === "number" && typeof height.value === "number" && height.value > 0) {
        agg = { value: round(weight.value / (height.value / 100) ** 2, 1), effective: weight.effective, used: [...weight.used, ...height.used] };
        resolvedBy = "derived";
        provenance = agg.used.flatMap((m) => m.provenance);
      }
    }

    facts.push({
      subject: args.subject,
      code: concept.code,
      display: concept.display,
      category: concept.category,
      aggregate: how,
      status: agg.used.length ? "hasValue" : "noValue",
      resolved_by: resolvedBy,
      value: how === "all" ? null : agg.value,
      unit: agg.used.length ? concept.unit || null : null,
      effective: agg.effective,
      count: ms.length,
      ...(how === "all" ? { series: agg.used } : {}),
      provenance,
      ...(issues.length ? { issues: issues.slice(0, 20) } : {}),
    });
  }
  return facts;
}
