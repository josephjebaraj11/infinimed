import { randomBytes, createHash } from "node:crypto";

/** RFC 7636 PKCE with S256. The verifier is 128 URL-safe characters (96 random bytes). */
export function createPkcePair() {
  const verifier = randomBytes(96).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" as const };
}

export function pkceChallengeFor(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}
