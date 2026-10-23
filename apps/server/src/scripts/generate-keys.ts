import { randomBytes } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";

/**
 * Generates production secrets:
 *   MASTER_KEY         - 32 random bytes (base64) sealing tokens and credentials at rest
 *   SIGNING_KEYS_JSON  - an RS384 private JWK array for client assertions and platform JWTs
 * Store both in your secret manager. To rotate the signing key, append a new JWK to the array
 * (the last one signs), redeploy, and remove the old key once vendors have refreshed your JWKS.
 */
const { privateKey, publicKey } = await generateKeyPair("RS384", { modulusLength: 2048, extractable: true });
const pub = await exportJWK(publicKey);
const priv = await exportJWK(privateKey);
const kid = await calculateJwkThumbprint(pub, "sha256");
Object.assign(priv, { kid, alg: "RS384", use: "sig" });

console.log(`MASTER_KEY=${randomBytes(32).toString("base64")}`);
console.log(`SIGNING_KEYS_JSON='${JSON.stringify([priv])}'`);
console.error(`\nkid ${kid}. Never commit these values; load them from your secret manager.`);
