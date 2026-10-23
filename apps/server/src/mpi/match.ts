/**
 * Probabilistic record linkage (Fellegi–Sunter). Each comparable attribute contributes a log2
 * likelihood ratio weight: agreement adds log2(m/u), disagreement adds log2((1-m)/(1-u)), missing
 * data adds nothing. m = P(agree | same person), u = P(agree | different people). Names are compared
 * with Jaro–Winkler so typos and nicknames score partially; dates tolerate day/month transposition.
 *
 * The weights below are conservative defaults for US demographic data; tune m/u per deployment
 * from labelled pairs (see docs/ARCHITECTURE.md, "Master patient index").
 */

export type Demographics = {
  family: string[];
  given: string[];
  birthDate: string | null;
  gender: string | null;
  postalCodes: string[];
  addressLines: string[];
  phones: string[];
  emails: string[];
  identifiers: { system: string; value: string }[];
  soundexFamily: string[];
};

export type MatchResult = {
  score: number;
  probability: number;
  status: "match" | "review" | "mismatch";
  fields: Record<string, { outcome: "agree" | "partial" | "disagree" | "missing"; weight: number }>;
};

export const THRESHOLDS = { match: 14, review: 5 };

const w = (m: number, u: number) => ({ agree: Math.log2(m / u), disagree: Math.log2((1 - m) / (1 - u)) });
const WEIGHTS = {
  family: w(0.95, 0.01),
  given: w(0.9, 0.02),
  birthDate: w(0.97, 0.0004),
  gender: w(0.98, 0.5),
  postal: w(0.75, 0.01),
  phone: w(0.6, 0.0001),
  email: w(0.6, 0.00001),
};

export function normalizeName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, "")
    .replace(/['-]/g, "")
    .trim();
}

export function soundex(name: string): string {
  const s = normalizeName(name).replace(/[^a-z]/g, "");
  if (!s) return "";
  const codes: Record<string, string> = { b: "1", f: "1", p: "1", v: "1", c: "2", g: "2", j: "2", k: "2", q: "2", s: "2", x: "2", z: "2", d: "3", t: "3", l: "4", m: "5", n: "5", r: "6" };
  let out = s[0]!.toUpperCase();
  let prev = codes[s[0]!] ?? "";
  for (let i = 1; i < s.length && out.length < 4; i++) {
    const ch = s[i]!;
    const code = codes[ch] ?? "";
    if (code && code !== prev) out += code;
    if (ch !== "h" && ch !== "w") prev = code;
  }
  return out.padEnd(4, "0");
}

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length ? 1 : 0;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatch = new Array<boolean>(a.length).fill(false);
  const bMatch = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length) && a[i] === b[i]; i++) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

const digits = (s: string) => s.replace(/\D/g, "");

/** Extracts comparable demographics from a FHIR R4 Patient resource. */
export function demographicsFromPatient(p: Record<string, unknown>): Demographics {
  const names = (p.name as { family?: string; given?: string[]; use?: string }[] | undefined) ?? [];
  const family = [...new Set(names.map((n) => normalizeName(n.family ?? "")).filter(Boolean))];
  const given = [...new Set(names.flatMap((n) => (n.given ?? []).map(normalizeName)).filter(Boolean))];
  const telecom = (p.telecom as { system?: string; value?: string }[] | undefined) ?? [];
  const addresses = (p.address as { postalCode?: string; line?: string[] }[] | undefined) ?? [];
  const identifiers = ((p.identifier as { system?: string; value?: string }[] | undefined) ?? [])
    .filter((i) => i.system && i.value && i.system !== "urn:infinimed:patient-id")
    .map((i) => ({ system: i.system!, value: i.value!.trim() }));
  return {
    family,
    given,
    birthDate: typeof p.birthDate === "string" ? p.birthDate.slice(0, 10) : null,
    gender: typeof p.gender === "string" ? p.gender : null,
    postalCodes: [...new Set(addresses.map((a) => (a.postalCode ?? "").slice(0, 5)).filter((z) => /^\d{5}$/.test(z)))],
    addressLines: [...new Set(addresses.flatMap((a) => a.line ?? []).map((l) => l.toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean))],
    phones: [...new Set(telecom.filter((t) => t.system === "phone" || t.system === "sms").map((t) => digits(t.value ?? "").slice(-10)).filter((d) => d.length === 10))],
    emails: [...new Set(telecom.filter((t) => t.system === "email").map((t) => (t.value ?? "").toLowerCase().trim()).filter(Boolean))],
    identifiers,
    soundexFamily: [...new Set(family.map(soundex).filter(Boolean))],
  };
}

/** Demographics for a customer-side patient (name and email only). */
export function demographicsFromApp(p: { name?: string | null; email?: string | null }): Demographics {
  const parts = (p.name ?? "").trim().split(/\s+/).filter(Boolean);
  const family = parts.length > 1 ? [normalizeName(parts[parts.length - 1]!)] : [];
  const given = parts.length > 0 ? [normalizeName(parts[0]!)] : [];
  return {
    family,
    given,
    birthDate: null,
    gender: null,
    postalCodes: [],
    addressLines: [],
    phones: [],
    emails: p.email ? [p.email.toLowerCase()] : [],
    identifiers: [],
    soundexFamily: family.map(soundex),
  };
}

function bestSimilarity(a: string[], b: string[]) {
  let best = 0;
  for (const x of a) for (const y of b) best = Math.max(best, jaroWinkler(x, y));
  return best;
}

function compareDates(a: string, b: string): "agree" | "partial" | "disagree" {
  if (a === b) return "agree";
  const [ay, am, ad] = a.split("-");
  const [by, bm, bd] = b.split("-");
  if (ay === by && am === bd && ad === bm) return "partial"; // day/month transposed
  const sameCount = [ay === by, am === bm, ad === bd].filter(Boolean).length;
  return sameCount === 2 ? "partial" : "disagree";
}

export function compareDemographics(a: Demographics, b: Demographics): MatchResult {
  const fields: MatchResult["fields"] = {};
  let score = 0;
  const add = (name: string, outcome: MatchResult["fields"][string]["outcome"], weight: number) => {
    fields[name] = { outcome, weight: Math.round(weight * 100) / 100 };
    score += weight;
  };

  if (a.family.length && b.family.length) {
    const sim = bestSimilarity(a.family, b.family);
    if (sim >= 0.99) add("family", "agree", WEIGHTS.family.agree);
    else if (sim >= 0.9) add("family", "partial", WEIGHTS.family.agree * 0.6);
    else if (a.soundexFamily.some((s) => b.soundexFamily.includes(s))) add("family", "partial", WEIGHTS.family.agree * 0.3);
    else add("family", "disagree", WEIGHTS.family.disagree);
  } else add("family", "missing", 0);

  if (a.given.length && b.given.length) {
    const sim = bestSimilarity(a.given, b.given);
    if (sim >= 0.99) add("given", "agree", WEIGHTS.given.agree);
    else if (sim >= 0.88) add("given", "partial", WEIGHTS.given.agree * 0.6);
    else if (a.given.some((x) => b.given.some((y) => x[0] === y[0] && (x.length === 1 || y.length === 1)))) add("given", "partial", 1);
    else add("given", "disagree", WEIGHTS.given.disagree);
  } else add("given", "missing", 0);

  if (a.birthDate && b.birthDate) {
    const outcome = compareDates(a.birthDate, b.birthDate);
    add("birthDate", outcome, outcome === "agree" ? WEIGHTS.birthDate.agree : outcome === "partial" ? 3 : WEIGHTS.birthDate.disagree);
  } else add("birthDate", "missing", 0);

  if (a.gender && b.gender && a.gender !== "unknown" && b.gender !== "unknown") {
    add("gender", a.gender === b.gender ? "agree" : "disagree", a.gender === b.gender ? WEIGHTS.gender.agree : WEIGHTS.gender.disagree);
  } else add("gender", "missing", 0);

  if (a.postalCodes.length && b.postalCodes.length) {
    const agree = a.postalCodes.some((z) => b.postalCodes.includes(z));
    // People move: a different postal code is weak evidence against.
    add("postalCode", agree ? "agree" : "disagree", agree ? WEIGHTS.postal.agree : -1.5);
  } else add("postalCode", "missing", 0);

  if (a.phones.length && b.phones.length) {
    const agree = a.phones.some((p) => b.phones.includes(p));
    add("phone", agree ? "agree" : "disagree", agree ? WEIGHTS.phone.agree : -1);
  } else add("phone", "missing", 0);

  if (a.emails.length && b.emails.length) {
    const agree = a.emails.some((e) => b.emails.includes(e));
    add("email", agree ? "agree" : "disagree", agree ? WEIGHTS.email.agree : -0.5);
  } else add("email", "missing", 0);

  // Identifiers only compare within the same assigning system (an MRN from one hospital means
  // nothing at another). A shared system with a different value is strong evidence against.
  let idOutcome: MatchResult["fields"][string]["outcome"] = "missing";
  let idWeight = 0;
  for (const x of a.identifiers) {
    for (const y of b.identifiers) {
      if (x.system !== y.system) continue;
      if (x.value === y.value) {
        idOutcome = "agree";
        idWeight = 15;
      } else if (idOutcome !== "agree") {
        idOutcome = "disagree";
        idWeight = -6;
      }
    }
  }
  add("identifier", idOutcome, idWeight);

  const probability = 1 / (1 + 2 ** -(score - (THRESHOLDS.match + THRESHOLDS.review) / 2));
  const status = score >= THRESHOLDS.match ? "match" : score >= THRESHOLDS.review ? "review" : "mismatch";
  return { score: Math.round(score * 100) / 100, probability: Math.round(probability * 1000) / 1000, status, fields };
}
