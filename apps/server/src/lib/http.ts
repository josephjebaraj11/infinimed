import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "../config.js";
import { ApiError } from "./errors.js";

/**
 * Outbound HTTP helpers. Customer-supplied URLs (webhook receivers, export destinations, CDS
 * endpoints) are validated against SSRF: https only (localhost allowed outside production), and
 * the resolved address must not be private, loopback, link-local or metadata space unless private
 * egress is explicitly allowed.
 */

const PRIVATE_V4 = [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["100.64.0.0", 10],
  ["0.0.0.0", 8],
] as const;

function v4ToInt(ip: string) {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const n = v4ToInt(ip);
    return PRIVATE_V4.some(([base, bits]) => {
      const mask = (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (v4ToInt(base) & mask);
    });
  }
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80")) return true;
  if (lower.startsWith("::ffff:")) return isPrivateAddress(lower.slice(7));
  return false;
}

export function isLocalhostUrl(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

export async function assertSafeOutboundUrl(
  raw: string,
  opts: { param?: string; allowHttpLocalhost?: boolean } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError("unsafe_url", "URL is not valid", { param: opts.param ?? "url" });
  }
  const cfg = config();
  const allowLocal = cfg.allowPrivateEgress;
  if (url.protocol !== "https:") {
    const localHttpOk = url.protocol === "http:" && isLocalhostUrl(url) && (opts.allowHttpLocalhost ?? !cfg.isProduction);
    if (!localHttpOk) throw new ApiError("unsafe_url", "URL must use https", { param: opts.param ?? "url" });
  }
  if (url.username || url.password) {
    throw new ApiError("unsafe_url", "URL must not embed credentials", { param: opts.param ?? "url" });
  }
  if (!allowLocal) {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
    if (addrs.length === 0) throw new ApiError("unsafe_url", "URL host does not resolve", { param: opts.param ?? "url" });
    if (addrs.some(isPrivateAddress)) {
      throw new ApiError("unsafe_url", "URL resolves to a private network address", { param: opts.param ?? "url" });
    }
  }
  return url;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
    readonly retryAfterSeconds: number | null,
  ) {
    super(`HTTP ${status} from ${new URL(url).origin}`);
    this.name = "HttpError";
  }
}

export function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return null;
}

export async function fetchWithTimeout(input: string | URL, init: RequestInit & { timeoutMs?: number } = {}) {
  const { timeoutMs = 30_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    return await fetch(input, { ...rest, signal: rest.signal ?? controller.signal, redirect: rest.redirect ?? "manual" });
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reads a response body as text, truncated, without throwing on stream errors. */
export async function readTextSafe(res: Response, max = 4096): Promise<string> {
  try {
    const text = await res.text();
    return text.length > max ? text.slice(0, max) : text;
  } catch {
    return "";
  }
}
