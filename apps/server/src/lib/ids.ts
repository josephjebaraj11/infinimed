import { randomBytes } from "node:crypto";

/**
 * Prefixed, time-sortable identifiers (ULID layout: 48-bit millisecond timestamp + 80 random bits,
 * Crockford base32). The prefix makes ids self-describing in logs and support tickets.
 */

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const ID_PREFIX = {
  workspace: "ws",
  user: "usr",
  membership: "mem",
  apiKey: "key",
  patient: "pat",
  patientSession: "ps",
  connection: "conn",
  source: "src",
  providerConfig: "pcfg",
  webhook: "wh",
  event: "evt",
  delivery: "dlv",
  destination: "dest",
  exportRun: "run",
  pull: "pull",
  launchContext: "lc",
  authEvent: "aev",
  audit: "aud",
  person: "per",
  identity: "idn",
  backendSync: "bsync",
  hl7Message: "hl7",
  mcpClient: "mcpc",
  mcpGrant: "mcpg",
  cdsCall: "cds",
  syntheticPatient: "syn",
  invitation: "inv",
} as const;

export type IdKind = keyof typeof ID_PREFIX;

function encodeTime(ms: number, length = 10): string {
  let out = "";
  let value = ms;
  for (let i = 0; i < length; i++) {
    out = ALPHABET[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(length = 16): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % 32];
  return out;
}

export function ulid(now = Date.now()): string {
  return encodeTime(now) + encodeRandom();
}

export function newId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}_${ulid()}`;
}

export function hasPrefix(id: string, kind: IdKind): boolean {
  return id.startsWith(`${ID_PREFIX[kind]}_`);
}

/** URL-safe random token, used for session links, bearer tokens and OAuth state. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
