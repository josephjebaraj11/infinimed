import { createHmac } from "node:crypto";
import { ApiError } from "./errors.js";
import { cursorSigningKey, safeEqual } from "./crypto.js";

/**
 * Opaque, tamper-proof pagination cursors. The payload is compact JSON, base64url-encoded and
 * HMAC-signed. Cursors expire 7 days after the page that issued them; each new page issues fresh
 * cursors so a read that keeps going never expires. Filters are bound into the cursor so a read
 * keeps the same filters from first page to last.
 */

export const CURSOR_TTL_SECONDS = 7 * 24 * 60 * 60;

export type CursorPayload = {
  /** resource kind the cursor belongs to (e.g. "records", "patients") */
  k: string;
  /** position: the last-seen sort key */
  p: string | number;
  /** snapshot high-water mark, when the list is snapshot-consistent */
  s?: number;
  /** hash of the filters the cursor was issued for */
  f?: string;
  /** expiry, unix seconds */
  e: number;
};

function sign(body: string): string {
  return createHmac("sha256", cursorSigningKey()).update(body).digest("base64url").slice(0, 22);
}

export function encodeCursor(payload: Omit<CursorPayload, "e">, ttlSeconds = CURSOR_TTL_SECONDS): string {
  const full: CursorPayload = { ...payload, e: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function decodeCursor(cursor: string, kind: string, filterHash?: string): CursorPayload {
  const invalid = () => new ApiError("bad_request", "Invalid or expired cursor", { param: "starting_after" });
  const dot = cursor.lastIndexOf(".");
  if (dot <= 0) throw invalid();
  const body = cursor.slice(0, dot);
  const mac = cursor.slice(dot + 1);
  if (!safeEqual(sign(body), mac)) throw invalid();
  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    throw invalid();
  }
  if (payload.k !== kind) throw invalid();
  if (payload.e < Math.floor(Date.now() / 1000)) throw invalid();
  if ((payload.f ?? undefined) !== (filterHash ?? undefined)) {
    throw new ApiError("bad_request", "Cursor was issued for different filters", { param: "starting_after" });
  }
  return payload;
}

export function parseLimit(raw: string | undefined | null, fallback = 10, max = 100): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new ApiError("bad_request", `limit must be an integer between 1 and ${max}`, { param: "limit" });
  }
  return n;
}

export type Page<T> = {
  object: "list";
  data: T[];
  has_more: boolean;
  next_cursor: string | null;
};

export function page<T>(data: T[], hasMore: boolean, nextCursor: string | null): Page<T> {
  return { object: "list", data, has_more: hasMore, next_cursor: hasMore ? nextCursor : null };
}
