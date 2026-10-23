import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, del, fmtAgo, fmtDate, patch } from "../api";
import { Badge, CopyField, Empty, ErrorBox, Loading, Modal, useAction, useLoad } from "../components";
import { useSession } from "../session";

type Endpoint = { id: string; url: string; events: string[]; description: string | null; status: string; api_version: string; created_at: string; secret?: string };
type Delivery = { id: string; type: string; attempts: number; next_attempt_at: string | null; delivered_at: string | null; last_status_code: number | null; last_response_body: string | null; last_error: string | null; created_at: string };

const EVENT_TYPES = [
  "patient_session.completed",
  "connection.token_refresh_failed",
  "connection.disconnected",
  "records.sync.completed",
  "records.sync.failed",
  "export.run.completed",
  "export.run.failed",
  "ehr_launch.completed",
];

export function Webhooks() {
  const { workspace, canAdmin } = useSession();
  const list = useLoad(() => api<{ data: Endpoint[] }>("/webhooks"), [workspace?.id]);
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<Endpoint | null>(null);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Webhooks</h1>
          <span className="muted">Signed event deliveries with retries over about 3.6 days. Endpoints auto-disable after the last retry fails.</span>
        </div>
        {canAdmin && <button onClick={() => setAdding(true)}>Add endpoint</button>}
      </div>
      <ErrorBox error={list.error} />
      {secret && (
        <div className="card secret-box">
          <strong>Save this signing secret now.</strong> It is shown only once.
          <CopyField value={secret.secret!} />
        </div>
      )}
      <div className="card table-wrap">
        {!list.data ? (
          <Loading />
        ) : !list.data.data.length ? (
          <Empty>No webhook endpoints.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>URL</th>
                <th>Events</th>
                <th>Status</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {list.data.data.map((e) => (
                <tr key={e.id}>
                  <td className="mono small">
                    <Link to={`/webhooks/${e.id}`}>{e.url}</Link>
                  </td>
                  <td className="small">{e.events.join(", ")}</td>
                  <td>
                    <Badge status={e.status} />
                  </td>
                  <td className="muted">{fmtAgo(e.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {adding && (
        <AddEndpoint
          onClose={() => setAdding(false)}
          onCreated={async (ep) => {
            setAdding(false);
            setSecret(ep);
            await list.reload();
          }}
        />
      )}
    </>
  );
}

function AddEndpoint({ onClose, onCreated }: { onClose: () => void; onCreated: (ep: Endpoint) => void }) {
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [all, setAll] = useState(true);
  const [events, setEvents] = useState<string[]>([]);
  const action = useAction();
  return (
    <Modal
      title="Add webhook endpoint"
      onClose={onClose}
      actions={
        <>
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            disabled={action.pending || !url || (!all && !events.length)}
            onClick={async () => {
              const ep = await action.run(() => api<Endpoint>("/webhooks", { body: { url, description: description || undefined, events: all ? ["*"] : events } }));
              if (ep) onCreated(ep);
            }}
          >
            Create
          </button>
        </>
      }
    >
      <ErrorBox error={action.error} />
      <label htmlFor="url">Endpoint URL</label>
      <input id="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://api.example.com/infinimed/webhook" />
      <label htmlFor="desc">Description</label>
      <input id="desc" value={description} onChange={(e) => setDescription(e.target.value)} />
      <label className="row" style={{ fontWeight: 400 }}>
        <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} style={{ width: "auto" }} /> All events
      </label>
      {!all &&
        EVENT_TYPES.map((t) => (
          <label key={t} className="row" style={{ fontWeight: 400, margin: "4px 0" }}>
            <input type="checkbox" style={{ width: "auto" }} checked={events.includes(t)} onChange={(e) => setEvents(e.target.checked ? [...events, t] : events.filter((x) => x !== t))} /> <code>{t}</code>
          </label>
        ))}
    </Modal>
  );
}

export function WebhookDetail() {
  const { id = "" } = useParams();
  const { canAdmin } = useSession();
  const navigate = useNavigate();
  const d = useLoad(() => api<{ endpoint: Endpoint; deliveries: { data: Delivery[] } }>(`/webhooks/${id}`), [id]);
  const action = useAction();
  const [rotated, setRotated] = useState<string | null>(null);
  if (!d.data) return d.loading ? <Loading /> : <ErrorBox error={d.error} />;
  const { endpoint, deliveries } = d.data;
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="mono" style={{ fontSize: 17 }}>
            {endpoint.url}
          </h1>
          <span className="muted">
            {endpoint.description ?? "Webhook endpoint"} · API version {endpoint.api_version}
          </span>
        </div>
        {canAdmin && (
          <div className="row">
            <Badge status={endpoint.status} />
            <button className="secondary" onClick={async () => (await action.run(() => patch(`/webhooks/${id}`, { status: endpoint.status === "active" ? "disabled" : "active" }))) && d.reload()}>
              {endpoint.status === "active" ? "Disable" : "Re-enable"}
            </button>
            <button
              className="secondary"
              onClick={async () => {
                if (!confirm("Rotate the signing secret? The old secret stops verifying immediately.")) return;
                const r = await action.run(() => api<Endpoint>(`/webhooks/${id}/rotate-secret`, { body: {} }));
                if (r?.secret) setRotated(r.secret);
              }}
            >
              Rotate secret
            </button>
            <button className="danger" onClick={async () => confirm("Delete this endpoint?") && (await action.run(() => del(`/webhooks/${id}`))) && navigate("/webhooks")}>
              Delete
            </button>
          </div>
        )}
      </div>
      <ErrorBox error={action.error} />
      {rotated && (
        <div className="card secret-box">
          <strong>New signing secret.</strong> Deploy it now; the previous secret no longer verifies.
          <CopyField value={rotated} />
        </div>
      )}
      <div className="card table-wrap">
        <h2>Recent deliveries</h2>
        {!deliveries.data.length ? (
          <Empty>No deliveries yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Event</th>
                <th>Type</th>
                <th>Attempts</th>
                <th>Last status</th>
                <th>Delivered</th>
                <th>Next attempt</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {deliveries.data.map((x) => (
                <tr key={x.id + x.type}>
                  <td className="mono small">{x.id}</td>
                  <td className="mono small">{x.type}</td>
                  <td>{x.attempts}</td>
                  <td>
                    {x.last_status_code ?? "—"}
                    {x.last_error && <div className="small muted">{x.last_error}</div>}
                  </td>
                  <td className="muted">{x.delivered_at ? fmtDate(x.delivered_at) : "—"}</td>
                  <td className="muted">{x.next_attempt_at ? fmtDate(x.next_attempt_at) : "—"}</td>
                  <td>
                    {canAdmin && (
                      <button className="secondary" onClick={async () => (await action.run(() => api(`/events/${x.id}/redeliver`, { body: { endpoint_id: id } }))) && d.reload()}>
                        Redeliver
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
