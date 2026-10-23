import { config } from "../config.js";

/**
 * Structured JSON logger. PHI must never be logged: callers pass identifiers (ids, codes, counts),
 * never resource bodies, names, or tokens. `redact` strips well-known sensitive keys defensively.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const SENSITIVE = /(token|secret|password|authorization|cookie|assertion|code_verifier|private)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  let threshold: Level = "info";
  try {
    threshold = config().logLevel;
    if (config().isTest && level !== "error") return;
  } catch {
    // config not yet initialised; fall back to info
  }
  if (LEVELS[level] < LEVELS[threshold]) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(redact(fields ?? {}) as object) });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};

export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { error: err.message, error_name: err.name, stack: err.stack?.split("\n").slice(0, 6).join(" | ") };
  return { error: String(err) };
}
