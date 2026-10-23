import { useState } from "react";
import { api, del, fmtAgo } from "../api";
import { Badge, CopyField, Empty, ErrorBox, Loading, Modal, useAction, useLoad } from "../components";
import { useSession } from "../session";

type Key = { id: string; name: string; redacted: string; scopes: string[]; status: string; created_at: string; last_used_at: string | null; expires_at: string | null; secret?: string };

export function ApiKeys() {
  const { workspace, canAdmin, me } = useSession();
  const keys = useLoad(() => api<{ data: Key[] }>("/api-keys"), [workspace?.id]);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const action = useAction();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>API keys</h1>
          <span className="muted">
            Server-side secrets for the REST API, SDK and MCP server. {workspace?.environment === "sandbox" ? "Sandbox keys start with im_sk_sbx_." : "Production keys start with im_sk_live_."}
          </span>
        </div>
        {canAdmin && <button onClick={() => setCreating(true)}>Create API key</button>}
      </div>
      <ErrorBox error={keys.error ?? action.error} />
      {secret && (
        <div className="card secret-box">
          <strong>Copy your key now.</strong> It is shown only once. Store it in your server's secret manager; never ship it to a browser or mobile app.
          <CopyField value={secret} />
          <pre className="json" style={{ marginTop: 8 }}>{`curl ${me.public_url}/v1/patients \\\n  -H "Authorization: Bearer ${secret.slice(0, 14)}…"`}</pre>
        </div>
      )}
      <div className="card table-wrap">
        {!keys.data ? (
          <Loading />
        ) : !keys.data.data.length ? (
          <Empty>No API keys.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key</th>
                <th>Scopes</th>
                <th>Status</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.data.data.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td className="mono small">{k.redacted}</td>
                  <td className="small">{k.scopes.join(", ")}</td>
                  <td>
                    <Badge status={k.status} />
                  </td>
                  <td className="muted">{fmtAgo(k.last_used_at)}</td>
                  <td>
                    {canAdmin && (
                      <div className="row">
                        {k.status === "active" && (
                          <button className="secondary" onClick={async () => confirm(`Revoke "${k.name}"? Requests using it fail immediately.`) && (await action.run(() => api(`/api-keys/${k.id}/revoke`, { body: {} }))) && keys.reload()}>
                            Revoke
                          </button>
                        )}
                        {k.status !== "active" && (
                          <button className="secondary" onClick={async () => (await action.run(() => del(`/api-keys/${k.id}`))) && keys.reload()}>
                            Delete
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && (
        <CreateKey
          scopes={me.api_key_scopes}
          onClose={() => setCreating(false)}
          onCreated={async (k) => {
            setCreating(false);
            setSecret(k.secret!);
            await keys.reload();
          }}
        />
      )}
    </>
  );
}

function CreateKey({ scopes, onClose, onCreated }: { scopes: string[]; onClose: () => void; onCreated: (k: Key) => void }) {
  const [name, setName] = useState("");
  const [full, setFull] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [expires, setExpires] = useState("");
  const action = useAction();
  return (
    <Modal
      title="Create API key"
      onClose={onClose}
      actions={
        <>
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            disabled={action.pending || !name || (!full && !picked.length)}
            onClick={async () => {
              const k = await action.run(() => api<Key>("/api-keys", { body: { name, scopes: full ? ["*"] : picked, expires_in_days: expires ? Number(expires) : undefined } }));
              if (k) onCreated(k);
            }}
          >
            Create
          </button>
        </>
      }
    >
      <ErrorBox error={action.error} />
      <label htmlFor="kname">Name</label>
      <input id="kname" value={name} onChange={(e) => setName(e.target.value)} placeholder="Production backend" />
      <label className="row" style={{ fontWeight: 400 }}>
        <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} style={{ width: "auto" }} /> Full access
      </label>
      {!full && (
        <div className="grid cols-2" style={{ gap: 4 }}>
          {scopes.map((s) => (
            <label key={s} className="row" style={{ fontWeight: 400, margin: 0 }}>
              <input type="checkbox" style={{ width: "auto" }} checked={picked.includes(s)} onChange={(e) => setPicked(e.target.checked ? [...picked, s] : picked.filter((x) => x !== s))} /> <code>{s}</code>
            </label>
          ))}
        </div>
      )}
      <label htmlFor="exp">Expires after (days, optional)</label>
      <input id="exp" type="number" min={1} max={730} value={expires} onChange={(e) => setExpires(e.target.value)} />
    </Modal>
  );
}
