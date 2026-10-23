import { useState } from "react";
import { api, put } from "../api";
import { Badge, CopyField, ErrorBox, Loading, Modal, useAction, useLoad } from "../components";
import { useSession } from "../session";

type Tile = {
  vendor: string;
  display_name: string;
  surface: "patient_access" | "clinical_workflow" | "backend" | "network";
  category: string;
  configurable: boolean;
  enabled: boolean;
  credential_mode: "managed" | "custom";
  managed_available: boolean;
  status?: string;
  client_id?: string | null;
  has_client_secret?: boolean;
  token_auth_method?: string;
  requires_client_secret?: boolean;
  scopes?: string[];
  settings?: { app_launch_url: string | null; cds_endpoint: string | null; cds_caching_seconds: number; organizations: { source_id: string; group_ids: string[] }[]; backend_schedule_hour_utc: number };
  urls?: { redirect_uri?: string; jwks_uri: string; launch_url?: string; cds_hooks_url?: string };
  notes?: string | null;
  note?: string;
};

const SURFACES: [Tile["surface"], string, string][] = [
  ["patient_access", "Patient access", "Patients sign in to their portal and approve your app (SMART on FHIR standalone launch)."],
  ["clinical_workflow", "Clinical workflows", "Your app inside the EHR: SMART App Launch and CDS Hooks."],
  ["backend", "Backend", "Server-to-server sync with SMART Backend Services and FHIR Bulk Data."],
  ["network", "Network", "Cross-organization exchange (CommonWell, Carequality, TEFCA)."],
];

export function Connections() {
  const { workspace } = useSession();
  const tiles = useLoad(() => api<{ data: Tile[] }>("/connections"), [workspace?.id]);
  const [editing, setEditing] = useState<Tile | null>(null);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Connections</h1>
          <span className="muted">Start with InfiniMed-managed credentials, then switch any tile to your own app registration.</span>
        </div>
      </div>
      <ErrorBox error={tiles.error} />
      {!tiles.data ? (
        <Loading />
      ) : (
        SURFACES.map(([surface, title, blurb]) => (
          <section key={surface} style={{ marginBottom: 20 }}>
            <h2>{title}</h2>
            <p className="muted small">{blurb}</p>
            <div className="grid cols-3">
              {tiles.data!.data
                .filter((t) => t.surface === surface)
                .map((t) => (
                  <div className="card tile" key={`${t.vendor}:${t.surface}`}>
                    <div className="head">
                      <strong>{t.display_name}</strong>
                      {t.configurable ? <Badge status={t.enabled ? (t.status ?? "managed") : "disabled"} /> : <Badge status="managed setup" />}
                    </div>
                    <span className="muted small">
                      {t.configurable ? (t.credential_mode === "custom" ? `Your app · ${t.client_id ?? "client id missing"}` : t.managed_available ? "InfiniMed credentials" : "No managed credentials: bring your own") : t.note}
                    </span>
                    {t.configurable && (
                      <div>
                        <button className="secondary" onClick={() => setEditing(t)}>
                          Configure
                        </button>
                      </div>
                    )}
                  </div>
                ))}
            </div>
          </section>
        ))
      )}
      {editing && <EditTile tile={editing} onClose={() => setEditing(null)} onSaved={async () => (await tiles.reload(), setEditing(null))} />}
    </>
  );
}

function EditTile({ tile, onClose, onSaved }: { tile: Tile; onClose: () => void; onSaved: () => Promise<void> }) {
  const { canAdmin } = useSession();
  const [mode, setMode] = useState(tile.credential_mode);
  const [enabled, setEnabled] = useState(tile.enabled);
  const [clientId, setClientId] = useState(tile.credential_mode === "custom" ? (tile.client_id ?? "") : "");
  const [secret, setSecret] = useState("");
  const [method, setMethod] = useState(tile.token_auth_method ?? "private_key_jwt");
  const [appUrl, setAppUrl] = useState(tile.settings?.app_launch_url ?? "");
  const [cds, setCds] = useState(tile.settings?.cds_endpoint ?? "");
  const [cacheSecs, setCacheSecs] = useState(String(tile.settings?.cds_caching_seconds ?? 0));
  const [orgs, setOrgs] = useState(JSON.stringify(tile.settings?.organizations ?? [], null, 2));
  const [hour, setHour] = useState(String(tile.settings?.backend_schedule_hour_utc ?? 2));
  const action = useAction();

  const save = async () => {
    const body: Record<string, unknown> = { enabled, credential_mode: mode, token_auth_method: method };
    if (mode === "custom") {
      body.client_id = clientId;
      if (secret) body.client_secret = secret;
    }
    if (tile.surface === "clinical_workflow") body.settings = { app_launch_url: appUrl, cds_endpoint: cds, cds_caching_seconds: Number(cacheSecs) };
    if (tile.surface === "backend") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(orgs);
      } catch {
        action.setError("Organizations must be valid JSON");
        return;
      }
      body.settings = { organizations: parsed, backend_schedule_hour_utc: Number(hour) };
    }
    const ok = await action.run(() => put(`/connections/${tile.vendor}/${tile.surface}`, body));
    if (ok) await onSaved();
  };

  return (
    <Modal
      title={`${tile.display_name} · ${tile.surface.replace("_", " ")}`}
      onClose={onClose}
      actions={
        canAdmin ? (
          <>
            <button className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button disabled={action.pending} onClick={save}>
              Save
            </button>
          </>
        ) : undefined
      }
    >
      <ErrorBox error={action.error} />
      {tile.notes && <div className="alert info small">{tile.notes}</div>}
      <h3>Share with the vendor</h3>
      {tile.urls?.redirect_uri && <CopyField label="Redirect URI" value={tile.urls.redirect_uri} />}
      {tile.urls?.jwks_uri && <CopyField label="JWKS URI" value={tile.urls.jwks_uri} />}
      {tile.urls?.launch_url && <CopyField label="SMART launch URL (give to the EHR administrator)" value={tile.urls.launch_url} />}
      {tile.urls?.cds_hooks_url && <CopyField label="CDS Hooks discovery URL" value={tile.urls.cds_hooks_url} />}
      {tile.scopes && (
        <>
          <label>Scopes requested</label>
          <code className="small">{tile.scopes.join(" ")}</code>
        </>
      )}
      <h3 style={{ marginTop: 18 }}>Credentials</h3>
      <label className="row" style={{ fontWeight: 400 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ width: "auto" }} /> Enabled
      </label>
      <label className="row" style={{ fontWeight: 400 }}>
        <input type="checkbox" checked={mode === "custom"} onChange={(e) => setMode(e.target.checked ? "custom" : "managed")} style={{ width: "auto" }} /> Use custom credentials (your own app registration)
      </label>
      {mode === "custom" && (
        <>
          <label htmlFor="cid">Client ID</label>
          <input id="cid" value={clientId} onChange={(e) => setClientId(e.target.value)} />
          <label htmlFor="method">Client authentication</label>
          <select id="method" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="private_key_jwt">private_key_jwt (JWKS, recommended)</option>
            <option value="client_secret_basic">client_secret_basic</option>
            <option value="client_secret_post">client_secret_post</option>
            <option value="none">none (public client + PKCE)</option>
          </select>
          {(method === "client_secret_basic" || method === "client_secret_post") && (
            <>
              <label htmlFor="secret">Client secret</label>
              <input id="secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={tile.has_client_secret ? "•••••• stored (leave blank to keep)" : ""} />
              <div className="field-hint">Stored encrypted. Never shown again.</div>
            </>
          )}
        </>
      )}
      {tile.surface === "clinical_workflow" && (
        <>
          <h3 style={{ marginTop: 18 }}>Your app</h3>
          <label htmlFor="app">App launch URL</label>
          <input id="app" value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://app.example.com/ehr/launch" />
          <div className="field-hint">After an EHR launch, clinicians land here with ?im_launch=lc_… Resolve it with GET /v1/launch-contexts/:id.</div>
          <label htmlFor="cds">CDS service base URL</label>
          <input id="cds" value={cds} onChange={(e) => setCds(e.target.value)} placeholder="https://cds.example.com" />
          <label htmlFor="cache">CDS response caching (seconds)</label>
          <input id="cache" type="number" min={0} max={3600} value={cacheSecs} onChange={(e) => setCacheSecs(e.target.value)} />
        </>
      )}
      {tile.surface === "backend" && (
        <>
          <h3 style={{ marginTop: 18 }}>Organizations and groups</h3>
          <label htmlFor="orgs">Organizations (JSON)</label>
          <textarea id="orgs" rows={6} value={orgs} onChange={(e) => setOrgs(e.target.value)} className="mono" />
          <div className="field-hint">[{"{"} "source_id": "src_…", "group_ids": ["…"] {"}"}]. Sandbox and production Group IDs usually differ.</div>
          <label htmlFor="hour">Daily sync hour (UTC)</label>
          <input id="hour" type="number" min={0} max={23} value={hour} onChange={(e) => setHour(e.target.value)} />
        </>
      )}
    </Modal>
  );
}
