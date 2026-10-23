import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { config } from "../config.js";

/**
 * Secrets at rest (OAuth tokens, client secrets, export credentials, webhook signing secrets) are
 * sealed with AES-256-GCM under a key derived from MASTER_KEY. The envelope carries a version tag
 * so keys can be rotated: `v1.<iv>.<tag>.<ciphertext>` (base64url segments).
 *
 * Production deployments should source MASTER_KEY from a KMS/secret manager; see docs/GAPS.md.
 */

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

function derivedKey(purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", config().masterKey, Buffer.alloc(0), `infinimed:${purpose}`, 32));
}

let sealKey: Buffer | undefined;
function getSealKey() {
  if (!sealKey) sealKey = derivedKey("seal:v1");
  return sealKey;
}

/** Reset cached derived keys (used by tests that swap configuration). */
export function resetCryptoCache() {
  sealKey = undefined;
  cursorKey = undefined;
}

export function seal(plaintext: string, aad = ""): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getSealKey(), iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function unseal(envelope: string, aad = ""): string {
  const [version, iv, tag, ct] = envelope.split(".");
  if (version !== "v1" || !iv || !tag || ct === undefined) throw new Error("Unrecognized sealed envelope");
  const decipher = createDecipheriv("aes-256-gcm", getSealKey(), Buffer.from(iv, "base64url"));
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

export const sealJson = (value: unknown, aad = "") => seal(JSON.stringify(value), aad);
export const unsealJson = <T>(envelope: string, aad = ""): T => JSON.parse(unseal(envelope, aad)) as T;

export const sealOptional = (value: string | null | undefined, aad = "") =>
  value === null || value === undefined || value === "" ? null : seal(value, aad);
export const unsealOptional = (value: string | null | undefined, aad = "") =>
  value ? unseal(value, aad) : null;

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sha256Base64Url(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("base64url");
}

export function hmacSha256Hex(key: string | Buffer, data: string | Buffer): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

let cursorKey: Buffer | undefined;
export function cursorSigningKey(): Buffer {
  if (!cursorKey) cursorKey = derivedKey("cursor:v1");
  return cursorKey;
}

// Password hashing for dashboard users: scrypt with per-user salt, parameters encoded in the hash.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, "base64url");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
