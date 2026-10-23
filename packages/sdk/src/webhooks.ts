import { InfiniMedSignatureError } from "./errors.js";
import type { WebhookEvent } from "./types.js";

/**
 * Webhook verification. `InfiniMed-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "${t}.${rawBody}">`.
 * Uses WebCrypto, so it runs on Node 18+, Bun, Deno, and edge runtimes. Always pass the raw body:
 * a re-serialized JSON body will not match.
 */

export const SIGNATURE_HEADER = "InfiniMed-Signature";

const encoder = new TextEncoder();

function toHex(buf: ArrayBuffer) {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function computeSignature(secret: string, timestamp: number, rawBody: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${rawBody}`)));
}

export async function constructEvent(
  rawBody: string | Uint8Array,
  signatureHeader: string | null | undefined,
  secret: string,
  opts: { tolerance?: number; now?: number } = {},
): Promise<WebhookEvent> {
  const body = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
  if (!signatureHeader) throw new InfiniMedSignatureError("missing_header");
  const parts: Record<string, string> = {};
  for (const kv of signatureHeader.split(",")) {
    const i = kv.indexOf("=");
    if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) throw new InfiniMedSignatureError("malformed_header");
  const tolerance = opts.tolerance ?? 300;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (Math.abs(now - t) > tolerance) throw new InfiniMedSignatureError("timestamp_expired");
  const expected = await computeSignature(secret, t, body);
  if (!constantTimeEqual(expected, v1)) throw new InfiniMedSignatureError("signature_mismatch");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new InfiniMedSignatureError("malformed_body");
  }
  const evt = parsed as Partial<WebhookEvent>;
  if (!evt || evt.object !== "event" || typeof evt.id !== "string" || typeof evt.type !== "string" || !evt.data || typeof evt.data !== "object") {
    throw new InfiniMedSignatureError("malformed_body");
  }
  return evt as WebhookEvent;
}

/** Signs a payload the way InfiniMed does: handy for unit-testing your receiver. */
export async function generateTestHeader(rawBody: string, secret: string, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${await computeSignature(secret, timestamp, rawBody)}`;
}
