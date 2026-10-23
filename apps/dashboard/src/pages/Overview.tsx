import { Link } from "react-router-dom";
import { api, fmtAgo } from "../api";
import { Badge, ErrorBox, Loading, Stat, useLoad } from "../components";
import { useSession } from "../session";

type OverviewData = {
  patients: number;
  active_patients: number;
  active_connections: number;
  needs_reconnect: number;
  records: number;
  pulls_24h: number;
  failed_pulls_24h: number;
  failing_webhook_deliveries: number;
  export_destinations: number;
};

export function Overview() {
  const { workspace } = useSession();
  const stats = useLoad(() => api<OverviewData>("/overview"), [workspace?.id]);
  const events = useLoad(() => api<{ data: { id: string; type: string; created_at: string }[] }>("/events?limit=12"), [workspace?.id]);
  const attention = useLoad(() => api<{ data: { patient_id: string; id: string; status: string; failure_code: string | null; failure_at: string | null }[] }>("/connections-needing-attention"), [workspace?.id]);
  const s = stats.data;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{workspace?.name}</h1>
          <span className="muted">
            {workspace?.environment === "sandbox" ? "Sandbox workspace: synthetic patients and vendor sandboxes." : "Production workspace: live credentials and patient data."}
          </span>
        </div>
        <Badge status={workspace?.environment} />
      </div>
      <ErrorBox error={stats.error} />
      {!s ? (
        <Loading />
      ) : (
        <div className="grid cols-4">
          <Stat label="Patients" value={s.patients} />
          <Stat label="Active patients (billable)" value={s.active_patients} />
          <Stat label="Active connections" value={s.active_connections} />
          <Stat label="Stored records" value={s.records.toLocaleString()} />
          <Stat label="Pulls in the last 24h" value={s.pulls_24h} />
          <Stat label="Failed pulls (24h)" value={s.failed_pulls_24h} tone={s.failed_pulls_24h ? "bad" : undefined} />
          <Stat label="Connections needing reconnect" value={s.needs_reconnect} tone={s.needs_reconnect ? "bad" : undefined} />
          <Stat label="Failing webhook deliveries" value={s.failing_webhook_deliveries} tone={s.failing_webhook_deliveries ? "bad" : undefined} />
        </div>
      )}
      <div className="grid cols-2">
        <div className="card">
          <h2>Needs attention</h2>
          {!attention.data?.data.length ? (
            <p className="muted">No connections need reconnecting.</p>
          ) : (
            <table>
              <tbody>
                {attention.data.data.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/patients/${encodeURIComponent(c.patient_id)}`}>{c.patient_id}</Link>
                    </td>
                    <td>
                      <Badge status={c.status} />
                    </td>
                    <td className="muted">{fmtAgo(c.failure_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="card">
          <h2>Recent events</h2>
          {!events.data?.data.length ? (
            <p className="muted">No events yet. Connect a patient to see activity.</p>
          ) : (
            <table>
              <tbody>
                {events.data.data.map((e) => (
                  <tr key={e.id}>
                    <td className="mono">{e.type}</td>
                    <td className="muted">{fmtAgo(e.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {workspace?.environment === "sandbox" && s?.patients === 0 && (
        <div className="card">
          <h2>Get started</h2>
          <ol>
            <li>
              Load sample patients from <Link to="/patients">Patients</Link>, or connect one through the Synthetic Hospital.
            </li>
            <li>
              Create an <Link to="/api-keys">API key</Link> and start a patient session from your backend.
            </li>
            <li>
              Add a <Link to="/webhooks">webhook</Link> and an <Link to="/exports">export destination</Link>.
            </li>
          </ol>
        </div>
      )}
    </>
  );
}
