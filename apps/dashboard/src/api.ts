/** Thin client for the dashboard API. Cookie session; mutations carry the CSRF header. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly param: string | null = null,
  ) {
    super(message);
  }
}

let workspaceOverride: string | null = null;
export function setWorkspaceOverride(id: string | null) {
  workspaceOverride = id;
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers["X-InfiniMed-CSRF"] = "1";
  }
  if (workspaceOverride) headers["X-Workspace-Id"] = workspaceOverride;
  const res = await fetch(`/dashboard-api${path}`, { method, headers, credentials: "same-origin", body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = json.error ?? {};
    throw new ApiError(res.status, e.code ?? `http_${res.status}`, e.message ?? `Request failed (${res.status})`, e.param ?? null);
  }
  return json as T;
}

export const del = <T = unknown>(path: string) => api<T>(path, { method: "DELETE" });
export const put = <T = unknown>(path: string, body: unknown) => api<T>(path, { method: "PUT", body });
export const patch = <T = unknown>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body });

export type Me = {
  user: { id: string; email: string; name: string | null };
  workspaces: { id: string; name: string; environment: "sandbox" | "production"; plan: string; role: "owner" | "admin" | "member" }[];
  active_workspace_id: string | null;
  api_key_scopes: string[];
  public_url: string;
};

export type Connection = {
  id: string;
  source_id: string;
  surface: string;
  status: string;
  failure_code: string | null;
  failure_description: string | null;
  failure_at: string | null;
  last_pull_at: string | null;
  created_at: string;
  facility: { id: string; name: string; type: string; logo_url: string | null } | null;
};

export type Patient = {
  id: string;
  email: string | null;
  name: string | null;
  metadata: Record<string, unknown>;
  activated_at: string | null;
  created_at: string;
  connections: Connection[];
};

export const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : "—");
export const fmtAgo = (s: string | null | undefined) => {
  if (!s) return "—";
  const secs = Math.round((Date.now() - new Date(s).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
};
