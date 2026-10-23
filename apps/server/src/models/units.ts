/**
 * Unit normalisation for the clinical concepts. Each concept has a canonical UCUM unit; source
 * values in another unit are converted with the factor (or function) below. Unknown units are not
 * guessed: the measurement is reported as unconvertible rather than silently mis-scaled.
 */

const ALIAS: Record<string, string> = {
  kg: "kg",
  kilogram: "kg",
  kilograms: "kg",
  g: "g",
  gram: "g",
  "[lb_av]": "[lb_av]",
  lb: "[lb_av]",
  lbs: "[lb_av]",
  pound: "[lb_av]",
  pounds: "[lb_av]",
  "[oz_av]": "[oz_av]",
  oz: "[oz_av]",
  cm: "cm",
  m: "m",
  mm: "mm",
  "[in_i]": "[in_i]",
  in: "[in_i]",
  inch: "[in_i]",
  inches: "[in_i]",
  "[ft_i]": "[ft_i]",
  ft: "[ft_i]",
  "kg/m2": "kg/m2",
  "kg/m^2": "kg/m2",
  "kg/m²": "kg/m2",
  "mm[hg]": "mm[Hg]",
  mmhg: "mm[Hg]",
  "mm hg": "mm[Hg]",
  "/min": "/min",
  "{beats}/min": "/min",
  "beats/min": "/min",
  bpm: "/min",
  "{breaths}/min": "/min",
  "breaths/min": "/min",
  cel: "Cel",
  "°c": "Cel",
  degc: "Cel",
  c: "Cel",
  "[degf]": "[degF]",
  "°f": "[degF]",
  degf: "[degF]",
  f: "[degF]",
  "%": "%",
  percent: "%",
  "mg/dl": "mg/dL",
  "mmol/l": "mmol/L",
  "meq/l": "mmol/L",
  "mmol/mol": "mmol/mol",
  "umol/l": "umol/L",
  "µmol/l": "umol/L",
  "μmol/l": "umol/L",
  "g/dl": "g/dL",
  "g/l": "g/L",
  "mg/l": "mg/L",
  "ng/ml": "ng/mL",
  "ng/dl": "ng/dL",
  "ng/l": "ng/L",
  "pg/ml": "pg/mL",
  "pmol/l": "pmol/L",
  "nmol/l": "nmol/L",
  "u/l": "U/L",
  "iu/l": "U/L",
  "[iu]/l": "U/L",
  "10*3/ul": "10*3/uL",
  "10^3/ul": "10*3/uL",
  "x10e3/ul": "10*3/uL",
  "k/ul": "10*3/uL",
  "thou/ul": "10*3/uL",
  "10*9/l": "10*3/uL",
  "10^9/l": "10*3/uL",
  "m[iu]/l": "m[IU]/L",
  "miu/l": "m[IU]/L",
  "uiu/ml": "m[IU]/L",
  "µiu/ml": "m[IU]/L",
  "u[iu]/ml": "m[IU]/L",
  "ml/min/{1.73_m2}": "mL/min/{1.73_m2}",
  "ml/min/1.73m2": "mL/min/{1.73_m2}",
  "ml/min/1.73 m2": "mL/min/{1.73_m2}",
  "ml/min": "mL/min/{1.73_m2}",
  "mg/g": "mg/g",
  "mg/g{creat}": "mg/g",
  "{inr}": "{INR}",
  inr: "{INR}",
  ratio: "{INR}",
  "{score}": "{score}",
  score: "{score}",
  "1": "1",
};

export function canonicalUnit(raw: string | undefined | null): string | null {
  if (raw === undefined || raw === null) return null;
  const key = raw.trim().toLowerCase();
  if (key === "") return null;
  return ALIAS[key] ?? ALIAS[key.replace(/\s+/g, "")] ?? raw.trim();
}

type Converter = number | ((v: number) => number);

/** conversions[canonicalTarget][fromUnit] */
const CONVERSIONS: Record<string, Record<string, Converter>> = {
  kg: { g: 0.001, "[lb_av]": 0.45359237, "[oz_av]": 0.028349523125 },
  cm: { m: 100, mm: 0.1, "[in_i]": 2.54, "[ft_i]": 30.48 },
  Cel: { "[degF]": (f) => ((f - 32) * 5) / 9 },
  "%": { "mmol/mol": (v) => 0.09148 * v + 2.152 },
  "mg/dL": {},
  "g/dL": { "g/L": 0.1 },
  "mg/L": { "mg/dL": 10 },
  "ng/dL": { "pmol/L": 1 / 12.87 },
  "ng/mL": { "nmol/L": 1 / 2.496, "ng/L": 0.001 },
  "U/L": {},
  "10*3/uL": {},
  "mmol/L": {},
};

/** Analyte-specific mg/dL <-> mmol/L or umol/L factors. */
export const MOLAR_TO_MG_DL: Record<string, number> = {
  glucose: 18.016,
  total_cholesterol: 38.67,
  ldl: 38.67,
  hdl: 38.67,
  triglycerides: 88.57,
  calcium: 4.008,
};
export const UMOL_TO_MG_DL: Record<string, number> = {
  creatinine: 1 / 88.42,
  bilirubin_total: 1 / 17.1,
};

export function convert(value: number, from: string | null, to: string, conceptCode: string): number | null {
  const fromUnit = canonicalUnit(from);
  if (fromUnit === to) return value;
  if (fromUnit === null) return null;
  if (to === "mg/dL") {
    if (fromUnit === "mmol/L" && MOLAR_TO_MG_DL[conceptCode]) return value * MOLAR_TO_MG_DL[conceptCode]!;
    if (fromUnit === "umol/L" && UMOL_TO_MG_DL[conceptCode]) return value * UMOL_TO_MG_DL[conceptCode]!;
    return null;
  }
  if (to === "g/dL" && fromUnit === "mmol/L" && conceptCode === "hemoglobin") return value * 1.611;
  const c = CONVERSIONS[to]?.[fromUnit];
  if (c === undefined) return null;
  return typeof c === "number" ? value * c : c(value);
}

export const round = (v: number, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;
