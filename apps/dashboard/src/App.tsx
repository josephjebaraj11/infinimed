import { useCallback, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api, ApiError, type Me } from "./api";
import { Loading } from "./components";
import { Session, type SessionCtx } from "./session";
import { AcceptInvite, Login, Signup } from "./pages/Auth";
import { Overview } from "./pages/Overview";
import { Patients } from "./pages/Patients";
import { PatientDetail } from "./pages/PatientDetail";
import { Connections } from "./pages/Connections";
import { Sources } from "./pages/Sources";
import { Exports, ExportDetail } from "./pages/Exports";
import { Webhooks, WebhookDetail } from "./pages/Webhooks";
import { ApiKeys } from "./pages/ApiKeys";
import { Activity } from "./pages/Activity";
import { Team } from "./pages/Team";
import { Settings } from "./pages/Settings";
import { McpAccess } from "./pages/Mcp";
import { AuditLog } from "./pages/Audit";

const NAV: { group: string; items: [string, string][] }[] = [
  { group: "Data", items: [["/", "Overview"], ["/patients", "Patients"], ["/sources", "Source directory"]] },
  { group: "Integrations", items: [["/connections", "Connections"], ["/exports", "Exports"], ["/webhooks", "Webhooks"], ["/activity", "Activity"]] },
  { group: "Developers", items: [["/api-keys", "API keys"], ["/mcp", "MCP server"]] },
  { group: "Workspace", items: [["/team", "Team"], ["/settings", "Settings"], ["/audit", "Audit log"]] },
];

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<"loading" | "anon" | "ready">("loading");
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>("/me"));
      setState("ready");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setState("anon");
      else throw err;
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (state === "loading") return <Loading />;
  if (state === "anon" || !me) {
    return (
      <Routes>
        <Route path="/signup" element={<Signup onDone={refresh} />} />
        <Route path="/accept-invite" element={<Login onDone={refresh} />} />
        <Route path="*" element={<Login onDone={refresh} />} />
      </Routes>
    );
  }

  const workspace = me.workspaces.find((w) => w.id === me.active_workspace_id) ?? null;
  const ctx: SessionCtx = {
    me,
    workspace,
    refresh,
    switchWorkspace: async (id) => {
      await api(`/workspaces/${id}/switch`, { body: {} });
      await refresh();
      navigate("/");
    },
    canAdmin: workspace?.role === "owner" || workspace?.role === "admin",
  };

  return (
    <Session.Provider value={ctx}>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark" aria-hidden /> InfiniMed
          </div>
          <div className="ws-switch">
            <select
              aria-label="Workspace"
              value={workspace?.id ?? ""}
              onChange={(e) => (e.target.value === "__new" ? navigate("/settings?new=1") : void ctx.switchWorkspace(e.target.value))}
            >
              {me.workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} · {w.environment}
                </option>
              ))}
              <option value="__new">+ New workspace…</option>
            </select>
          </div>
          {NAV.map((g) => (
            <nav className="nav" key={g.group} aria-label={g.group}>
              <div className="nav-group">{g.group}</div>
              {g.items.map(([to, label]) => (
                <NavLink key={to} to={to} end={to === "/"}>
                  {label}
                </NavLink>
              ))}
            </nav>
          ))}
          <div className="spacer" />
          <div className="small muted" style={{ padding: "8px 10px" }}>
            {me.user.email}
            <br />
            <button
              className="link"
              onClick={async () => {
                await api("/auth/logout", { body: {} });
                setMe(null);
                setState("anon");
              }}
            >
              Sign out
            </button>
          </div>
        </aside>
        <main className="main">
          {!workspace ? (
            <div className="card">
              <h2>No workspace selected</h2>
              <p className="muted">Create a workspace in Settings or ask a teammate to invite you.</p>
            </div>
          ) : (
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/patients" element={<Patients />} />
              <Route path="/patients/:id" element={<PatientDetail />} />
              <Route path="/sources" element={<Sources />} />
              <Route path="/connections" element={<Connections />} />
              <Route path="/exports" element={<Exports />} />
              <Route path="/exports/:id" element={<ExportDetail />} />
              <Route path="/webhooks" element={<Webhooks />} />
              <Route path="/webhooks/:id" element={<WebhookDetail />} />
              <Route path="/activity" element={<Activity />} />
              <Route path="/api-keys" element={<ApiKeys />} />
              <Route path="/mcp" element={<McpAccess />} />
              <Route path="/team" element={<Team />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/audit" element={<AuditLog />} />
              <Route path="/accept-invite" element={<AcceptInvite />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          )}
        </main>
      </div>
    </Session.Provider>
  );
}
