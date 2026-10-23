import { useState } from "react";
import { api, fmtDate } from "../api";
import { Badge, Empty, ErrorBox, Json, Loading, useAction, useLoad } from "../components";
import { useSession } from "../session";

const TABS = ["Events", "Backend syncs", "HL7v2 feed", "CDS Hooks calls"] as const;

export function Activity() {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Events");
  return (
    <>
      <div className="page-head">
        <h1>Activity</h1>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === "Events" && <Events />}
      {tab === "Backend syncs" && <BackendSyncs />}
      {tab === "HL7v2 feed" && <Hl7 />}
      {tab === "CDS Hooks calls" && <Cds />}
    </>
  );
}

function Events() {
  const { workspace } = useSession();
  const ev = useLoad(() => api<{ data: { id: string; type: string; created_at: string; data: unknown }[] }>("/events?limit=100"), [workspace?.id]);
  if (!ev.data) return ev.loading ? <Loading /> : <ErrorBox error={ev.error} />;
  return (
    <div className="card">
      {!ev.data.data.length ? (
        <Empty>No events yet.</Empty>
      ) : (
        ev.data.data.map((e) => (
          <details key={e.id} style={{ marginBottom: 6 }}>
            <summary>
              <code>{e.type}</code> <span className="muted small">· {fmtDate(e.created_at)} · {e.id}</span>
            </summary>
            <Json value={e.data} />
          </details>
        ))
      )}
    </div>
  );
}

function BackendSyncs() {
  const { workspace, canAdmin } = useSession();
  const list = useLoad(() => api<{ data: { id: string; source_id: string; group_id: string; status: string; patients_seen: number; resources_seen: number; error_message: string | null; created_at: string }[] }>("/backend-syncs"), [workspace?.id]);
  const [form, setForm] = useState({ source_id: "", group_id: "" });
  const action = useAction();
  return (
    <>
      {canAdmin && (
        <div className="card">
          <h2>Start a population sync</h2>
          <p className="muted small">Runs a FHIR Bulk Data Group export with SMART Backend Services, links every patient through the MPI, and stores their records.</p>
          <ErrorBox error={action.error} />
          <div className="row">
            <input placeholder="Source id (src_…)" value={form.source_id} onChange={(e) => setForm({ ...form, source_id: e.target.value })} style={{ maxWidth: 280 }} aria-label="Source id" />
            <input placeholder="FHIR Group id" value={form.group_id} onChange={(e) => setForm({ ...form, group_id: e.target.value })} style={{ maxWidth: 220 }} aria-label="Group id" />
            <button disabled={!form.source_id || !form.group_id || action.pending} onClick={async () => (await action.run(() => api("/backend-syncs", { body: form }))) && list.reload()}>
              Start
            </button>
          </div>
        </div>
      )}
      <div className="card table-wrap">
        {!list.data ? (
          <Loading />
        ) : !list.data.data.length ? (
          <Empty>No backend syncs.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Source / group</th>
                <th>Status</th>
                <th>Patients</th>
                <th>Resources</th>
              </tr>
            </thead>
            <tbody>
              {list.data.data.map((s) => (
                <tr key={s.id}>
                  <td className="muted">{fmtDate(s.created_at)}</td>
                  <td className="mono small">
                    {s.source_id} / {s.group_id}
                  </td>
                  <td>
                    <Badge status={s.status} />
                    {s.error_message && <div className="small muted">{s.error_message}</div>}
                  </td>
                  <td>{s.patients_seen}</td>
                  <td>{s.resources_seen}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Hl7() {
  const { workspace, me } = useSession();
  const list = useLoad(() => api<{ data: { id: string; controlId: string | null; messageType: string | null; status: string; ackCode: string; resourcesCreated: number; error: string | null; createdAt: string }[] }>("/hl7-messages"), [workspace?.id]);
  return (
    <div className="card table-wrap">
      <p className="muted small">
        Send HL7v2 messages (ADT A01/A02/A03/A04/A08/A28/A31, ORU R01) to <code>POST {me.public_url}/v1/ingest/hl7v2?feed=name&create_patients=true</code> with an API key. Message bodies are stored encrypted.
      </p>
      {!list.data ? (
        <Loading />
      ) : !list.data.data.length ? (
        <Empty>No messages received.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Received</th>
              <th>Control id</th>
              <th>Type</th>
              <th>ACK</th>
              <th>Resources</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {list.data.data.map((m) => (
              <tr key={m.id}>
                <td className="muted">{fmtDate(m.createdAt)}</td>
                <td className="mono small">{m.controlId}</td>
                <td>{m.messageType}</td>
                <td>
                  <Badge status={m.ackCode} />
                </td>
                <td>{m.resourcesCreated}</td>
                <td className="small muted">{m.error}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Cds() {
  const { workspace } = useSession();
  const list = useLoad(() => api<{ data: { id: string; serviceId: string; hook: string | null; statusCode: number | null; cardCount: number | null; cached: boolean; durationMs: number | null; error: string | null; createdAt: string }[] }>("/cds-calls"), [workspace?.id]);
  return (
    <div className="card table-wrap">
      {!list.data ? (
        <Loading />
      ) : !list.data.data.length ? (
        <Empty>No CDS Hooks calls yet.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Service</th>
              <th>Hook</th>
              <th>Status</th>
              <th>Cards</th>
              <th>Latency</th>
            </tr>
          </thead>
          <tbody>
            {list.data.data.map((x) => (
              <tr key={x.id}>
                <td className="muted">{fmtDate(x.createdAt)}</td>
                <td className="mono small">{x.serviceId}</td>
                <td>{x.hook}</td>
                <td>
                  {x.statusCode ?? <Badge status="failed" />} {x.cached && <span className="badge info">cached</span>}
                  {x.error && <div className="small muted">{x.error}</div>}
                </td>
                <td>{x.cardCount}</td>
                <td className="muted">{x.durationMs} ms</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
