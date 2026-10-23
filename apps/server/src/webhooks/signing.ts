import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature scheme.
 *   InfiniMed-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${rawBody}`>
 * Receivers recompute the HMAC over the raw body with their endpoint secret, compare in constant
 * time, and reject timestamps outside a tolerance window (default 300 s) to stop replays.
 */

export const SIGNATURE_HEADER = "InfiniMed-Signature";

export function signPayload(secret: string, rawBody: string, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return { header: `t=${timestamp},v1=${v1}`, timestamp, v1 };
}

export type VerifyFailure = "missing_header" | "malformed_header" | "timestamp_expired" | "signature_mismatch";

export function verifySignature(secret: string, rawBody: string, header: string | null | undefined, toleranceSeconds = 300): VerifyFailure | null {
  if (!header) return "missing_header";
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return "malformed_header";
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > toleranceSeconds) return "timestamp_expired";
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  const actual = Buffer.from(v1, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return "signature_mismatch";
  return null;
}
