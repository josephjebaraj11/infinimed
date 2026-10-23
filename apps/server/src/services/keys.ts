import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import { config } from "../config.js";
import { randomToken } from "../lib/ids.js";

/**
 * Platform signing keys. One RSA keypair (RS384, the algorithm athenahealth and healow require and
 * Epic/Cerner accept) signs:
 *   - SMART `client_assertion` JWTs (private_key_jwt) for patient, clinician and backend flows
 *   - InfiniMed-issued access tokens for the MCP server
 *   - CDS Hooks forwarding JWTs
 * The public halves are published at /.well-known/jwks.json. Rotation: add a new key (it becomes
 * active because it is newest), keep the old one published until every relying party refreshed.
 */

export const SIGNING_ALG = "RS384";

type StoredKey = { kid: string; privateJwk: JWK; publicJwk: JWK; createdAt: string };

let keys: StoredKey[] | undefined;
const importedPrivate = new Map<string, CryptoKey>();

async function generate(): Promise<StoredKey> {
  const { privateKey, publicKey } = await generateKeyPair(SIGNING_ALG, { modulusLength: 2048, extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);
  const kid = await calculateJwkThumbprint(publicJwk, "sha256");
  Object.assign(publicJwk, { kid, alg: SIGNING_ALG, use: "sig" });
  Object.assign(privateJwk, { kid, alg: SIGNING_ALG, use: "sig" });
  return { kid, privateJwk, publicJwk, createdAt: new Date().toISOString() };
}

function publicFromPrivate(jwk: JWK): JWK {
  const { d, p, q, dp, dq, qi, ...pub } = jwk as JWK & Record<string, unknown>;
  void d, p, q, dp, dq, qi;
  return { ...pub, use: "sig", alg: (jwk.alg as string) ?? SIGNING_ALG };
}

export async function loadSigningKeys(): Promise<StoredKey[]> {
  if (keys) return keys;
  const cfg = config();
  if (cfg.signingKeysJson) {
    const parsed = JSON.parse(cfg.signingKeysJson) as JWK[];
    keys = await Promise.all(
      parsed.map(async (jwk, i) => {
        const pub = publicFromPrivate(jwk);
        const kid = jwk.kid ?? (await calculateJwkThumbprint(pub, "sha256"));
        return { kid, privateJwk: { ...jwk, kid }, publicJwk: { ...pub, kid }, createdAt: new Date(i).toISOString() };
      }),
    );
  } else if (cfg.isTest) {
    keys = [await generate()];
  } else {
    if (cfg.isProduction) throw new Error("SIGNING_KEYS_JSON is required in production");
    mkdirSync(cfg.signingKeysDir, { recursive: true });
    const files = readdirSync(cfg.signingKeysDir).filter((f) => f.endsWith(".json"));
    if (files.length === 0) {
      const k = await generate();
      writeFileSync(path.join(cfg.signingKeysDir, `${k.createdAt.replace(/[:.]/g, "-")}.json`), JSON.stringify(k), { mode: 0o600 });
      files.push(...readdirSync(cfg.signingKeysDir).filter((f) => f.endsWith(".json")));
    }
    keys = files.map((f) => JSON.parse(readFileSync(path.join(cfg.signingKeysDir, f), "utf8")) as StoredKey);
  }
  keys.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return keys;
}

export async function rotateSigningKey(): Promise<StoredKey> {
  const cfg = config();
  const k = await generate();
  if (!cfg.signingKeysJson && !cfg.isTest && existsSync(cfg.signingKeysDir)) {
    writeFileSync(path.join(cfg.signingKeysDir, `${k.createdAt.replace(/[:.]/g, "-")}.json`), JSON.stringify(k), { mode: 0o600 });
  }
  (await loadSigningKeys()).push(k);
  return k;
}

export async function activeKey(): Promise<{ kid: string; key: CryptoKey }> {
  const all = await loadSigningKeys();
  const k = all[all.length - 1]!;
  let imported = importedPrivate.get(k.kid);
  if (!imported) {
    imported = (await importJWK(k.privateJwk, SIGNING_ALG)) as CryptoKey;
    importedPrivate.set(k.kid, imported);
  }
  return { kid: k.kid, key: imported };
}

export async function publicJwks(): Promise<{ keys: JWK[] }> {
  return { keys: (await loadSigningKeys()).map((k) => k.publicJwk) };
}

/**
 * SMART client assertion (RFC 7523 / SMART Backend Services): iss=sub=client_id, aud=token endpoint,
 * short expiry, unique jti, signed with the active key and its kid in the header.
 */
export async function createClientAssertion(clientId: string, tokenEndpoint: string): Promise<string> {
  const { kid, key } = await activeKey();
  return new SignJWT({})
    .setProtectedHeader({ alg: SIGNING_ALG, kid, typ: "JWT", jku: config().jwksUrl })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(tokenEndpoint)
    .setJti(randomToken(24))
    .setIssuedAt()
    .setExpirationTime("4m")
    .sign(key);
}

export async function signPlatformJwt(claims: Record<string, unknown>, opts: { audience: string; expiresIn: string; subject?: string }) {
  const { kid, key } = await activeKey();
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: SIGNING_ALG, kid, typ: "JWT" })
    .setIssuer(config().publicUrl)
    .setAudience(opts.audience)
    .setJti(randomToken(16))
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn);
  if (opts.subject) jwt.setSubject(opts.subject);
  return jwt.sign(key);
}

/** Reset (tests). */
export function resetSigningKeys() {
  keys = undefined;
  importedPrivate.clear();
}
