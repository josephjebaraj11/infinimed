import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { ApiError } from "./api";

/** The InfiniMed mark: a medical cross wired into a neural network. Mirrors public/favicon.svg. */
export function Logo({ size = 22 }: { size?: number }) {
  const gradient = useId();
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2f5bea" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${gradient})`} />
      <path d="M13 13 9.5 9.5M19 13l3.5-3.5M13 19l-3.5 3.5M19 19l3.5 3.5" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" opacity="0.85" />
      <g fill="#fff">
        <circle cx="8.5" cy="8.5" r="2" />
        <circle cx="23.5" cy="8.5" r="2" />
        <circle cx="8.5" cy="23.5" r="2" />
        <circle cx="23.5" cy="23.5" r="2" />
        <rect x="13" y="6" width="6" height="20" rx="2" />
        <rect x="6" y="13" width="20" height="6" rx="2" />
      </g>
      <circle cx="16" cy="16" r="2.2" fill="#4f46e5" />
    </svg>
  );
}

/** Loads data with loading/error states and a reload function. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const run = useCallback(async () => {
    setLoading(true);
    try {
      setData(await load());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void run();
  }, [run]);
  return { data, error, loading, reload: run, setData };
}

export function Badge({ status }: { status: string | null | undefined }) {
  const s = status ?? "unknown";
  const tone = ["active", "completed", "success", "complete", "anchor", "match", "confirmed", "accepted", "managed", "custom", "AA"].includes(s)
    ? "ok"
    : ["failed", "refresh_failed", "disabled", "mismatch", "rejected", "error", "expired", "failure", "incomplete", "AR", "AE"].includes(s)
      ? "bad"
      : ["review", "partial", "queued", "running", "open", "polling", "downloading", "not_configured"].includes(s)
        ? "warn"
        : "info";
  return <span className={`badge ${tone}`}>{s.replace(/_/g, " ")}</span>;
}

export function Loading() {
  return <div className="empty">Loading…</div>;
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <div className="alert bad" role="alert">
      {error}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function CopyField({ value, label, secret }: { value: string; label?: string; secret?: boolean }) {
  const [shown, setShown] = useState(!secret);
  const [copied, setCopied] = useState(false);
  return (
    <div>
      {label && <label>{label}</label>}
      <div className="copy">
        <input readOnly value={shown ? value : "•".repeat(Math.min(32, value.length))} aria-label={label ?? "value"} />
        {secret && (
          <button type="button" className="secondary" onClick={() => setShown(!shown)}>
            {shown ? "Hide" : "Show"}
          </button>
        )}
        <button
          type="button"
          className="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children, actions }: { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="row">
          <h2 style={{ margin: 0 }}>{title}</h2>
          <span className="spacer" />
          <button className="secondary" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div style={{ marginTop: 12 }}>{children}</div>
        {actions && <div className="modal-actions">{actions}</div>}
      </div>
    </div>
  );
}

/** Runs an async action with pending state and error capture. */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.param ? ` (${err.param})` : ""}` : String(err));
      return undefined;
    } finally {
      setPending(false);
    }
  };
  return { pending, error, run, setError };
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "bad" | "ok" }) {
  return (
    <div className="card stat">
      <div className="value" style={tone === "bad" ? { color: "var(--bad)" } : undefined}>
        {value}
      </div>
      <div className="label">{label}</div>
    </div>
  );
}
