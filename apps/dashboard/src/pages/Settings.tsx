import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, patch } from "../api";
import { Badge, ErrorBox, Loading, useAction, useLoad } from "../components";
import { useSession } from "../session";

type Ws = { id: string; name: string; environment: string; plan: string; branding: { display_name?: string; primary_color?: string; logo_url?: string; support_email?: string }; features: Record<string, boolean>; role: string };

export function Settings() {
  const { workspace, canAdmin, refresh, switchWorkspace } = useSession();
  const ws = useLoad(() => api<Ws>("/workspace"), [workspace?.id]);
  const billing = useLoad(() => api<{ plan: string; quota: number | null; active_patients: number; environment: string }>("/billing"), [workspace?.id]);
  const [branding, setBranding] = useState<Ws["branding"]>({});
  const [name, setName] = useState("");
  const save = useAction();
  const create = useAction();
  const [params] = useSearchParams();
  const [newWs, setNewWs] = useState({ name: "", environment: "sandbox" });

  useEffect(() => {
    if (ws.data) {
      setBranding(ws.data.branding);
      setName(ws.data.name);
    }
  }, [ws.data]);

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
      </div>
      <ErrorBox error={ws.error} />
      {!ws.data ? (
        <Loading />
      ) : (
        <div className="grid cols-2">
          <div className="card">
            <h2>Workspace and branding</h2>
            <p className="muted small">The hosted connection page uses your name, color and logo so patients approve your app, not ours.</p>
            <ErrorBox error={save.error} />
            <label htmlFor="wsname">Workspace name</label>
            <input id="wsname" value={name} onChange={(e) => setName(e.target.value)} disabled={!canAdmin} />
            <label htmlFor="dn">Display name on patient pages</label>
            <input id="dn" value={branding.display_name ?? ""} onChange={(e) => setBranding({ ...branding, display_name: e.target.value })} disabled={!canAdmin} />
            <label htmlFor="color">Primary color</label>
            <div className="row">
              <input id="color" value={branding.primary_color ?? "#2f5bea"} onChange={(e) => setBranding({ ...branding, primary_color: e.target.value })} style={{ maxWidth: 140 }} disabled={!canAdmin} />
              <span style={{ width: 28, height: 28, borderRadius: 6, background: branding.primary_color ?? "#2f5bea", display: "inline-block" }} aria-hidden />
            </div>
            <label htmlFor="logo">Logo URL (https)</label>
            <input id="logo" value={branding.logo_url ?? ""} onChange={(e) => setBranding({ ...branding, logo_url: e.target.value })} disabled={!canAdmin} />
            <label htmlFor="support">Support email</label>
            <input id="support" value={branding.support_email ?? ""} onChange={(e) => setBranding({ ...branding, support_email: e.target.value })} disabled={!canAdmin} />
            {canAdmin && (
              <div style={{ marginTop: 12 }}>
                <button
                  disabled={save.pending}
                  onClick={async () => {
                    if (await save.run(() => patch("/workspace", { name, branding }))) {
                      await ws.reload();
                      await refresh();
                    }
                  }}
                >
                  Save
                </button>
              </div>
            )}
          </div>
          <div>
            <div className="card">
              <h2>Plan</h2>
              {billing.data && (
                <>
                  <p>
                    <Badge status={billing.data.plan} /> <Badge status={billing.data.environment} />
                  </p>
                  <p>
                    {billing.data.active_patients} active patients {billing.data.quota !== null ? `of ${billing.data.quota.toLocaleString()} included` : "(no cap)"}.
                  </p>
                  <p className="muted small">A patient becomes active the first time records are pulled for them.</p>
                </>
              )}
              <h3 style={{ marginTop: 12 }}>Features</h3>
              <div className="grid cols-2" style={{ gap: 4 }}>
                {Object.entries(ws.data.features).map(([f, on]) => (
                  <div key={f} className="small">
                    {on ? "✓" : "—"} {f.replace(/_/g, " ")}
                  </div>
                ))}
              </div>
            </div>
            <div className="card" id="new">
              <h2>New workspace</h2>
              {params.get("new") && <p className="muted small">Create a separate workspace for production or another product.</p>}
              <ErrorBox error={create.error} />
              <label htmlFor="nwname">Name</label>
              <input id="nwname" value={newWs.name} onChange={(e) => setNewWs({ ...newWs, name: e.target.value })} />
              <label htmlFor="nwenv">Environment</label>
              <select id="nwenv" value={newWs.environment} onChange={(e) => setNewWs({ ...newWs, environment: e.target.value })}>
                <option value="sandbox">Sandbox</option>
                <option value="production">Production</option>
              </select>
              <div style={{ marginTop: 12 }}>
                <button
                  disabled={!newWs.name || create.pending}
                  onClick={async () => {
                    const r = await create.run(() => api<{ id: string }>("/workspaces", { body: newWs }));
                    if (r) await switchWorkspace(r.id);
                  }}
                >
                  Create workspace
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
