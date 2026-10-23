import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, del, fmtAgo, fmtDate, type Connection, type Patient } from "../api";
import { Badge, CopyField, Empty, ErrorBox, Json, Loading, useAction, useLoad } from "../components";
import { useSession } from "../session";

type Detail = {
  patient: Patient;
  sessions: { id: string; status: string; mode: string; created_at: string; connections: Connection[] }[];
  pulls: { id: string; connectionId: string; trigger: string; status: string; total: number; created: number; updated: number; errors: number; errorCode: string | null; errorMessage: string | null; details: Record<string, unknown>; durationMs: number | null; createdAt: string }[];
  auth_events: { id: string; step: string; status: string; errorCode: string | null; errorDescription: string | null; sourceId: string | null; createdAt: string }[];
  record_stats: { resource_type: string; source_id: string; n: number }[];
  identities: { id: string; source_id: string; fhir_patient_id: string; match_status: string; match_probability: number | null; match_details: Record<string, unknown> }[];
  can_magic_link: boolean;
};

type Fact = { code: string; display: string; value: number | string | null; unit: string | null; effective: string | null; status: string; resolved_by: string; count: number; provenance: { reference: string; source: string }[] };

const MODELS = ["allergies", "conditions", "medications", "labs", "vitals", "immunizations", "procedures", "encounters", "documents", "coverage", "claims"];
const TABS = ["Summary", "Clinical models", "Connections", "Sessions", "Pull history", "Authorization", "Identity", "Raw records"] as const;

export function PatientDetail() {
  const { id = "" } = useParams();
  const { canAdmin } = useSession();
  const navigate = useNavigate();
  const detail = useLoad(() => api<Detail>(`/patients/${encodeURIComponent(id)}`), [id]);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Summary");
  const action = useAction();
  const [magic, setMagic] = useState<string | null>(null);

  if (detail.loading && !detail.data) return <Loading />;
  if (!detail.data) return <ErrorBox error={detail.error} />;
  const d = detail.data;
  const total = d.record_stats.reduce((n, s) => n + Number(s.n), 0);
  const review = d.identities.some((i) => i.match_status === "review" || i.match_status === "mismatch");

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="mono">{d.patient.id}</h1>
          <span className="muted">
            {d.patient.name ?? "Unnamed"} {d.patient.email ? `· ${d.patient.email}` : ""} · {total} records · created {fmtAgo(d.patient.created_at)}
          </span>
        </div>
        <div className="row">
          {review && <Badge status="review" />}
          {canAdmin && d.can_magic_link && (
            <button className="secondary" onClick={async () => setMagic((await action.run(() => api<{ url: string }>(`/patients/${encodeURIComponent(id)}/magic-link`, { body: {} })))?.url ?? null)}>
              Generate magic link
            </button>
          )}
          {canAdmin && (
            <button
              className="danger"
              onClick={async () => {
                if (!confirm(`Permanently delete ${d.patient.id} and all retrieved records?`)) return;
                if (await action.run(() => del(`/patients/${encodeURIComponent(id)}`))) navigate("/patients");
              }}
            >
              Delete
            </button>
          )}
        </div>
      </div>
      <ErrorBox error={action.error} />
      {magic && (
        <div className="card">
          <CopyField label="Patient portal sign-in link (valid 24 hours, sandbox only)" value={magic} />
        </div>
      )}
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      {tab === "Summary" && <Summary id={id} stats={d.record_stats} />}
      {tab === "Clinical models" && <Models id={id} />}
      {tab === "Connections" && <Connections id={id} conns={d.patient.connections} canAdmin={canAdmin} onChange={detail.reload} />}
      {tab === "Sessions" && (
        <div className="card table-wrap">
          {!d.sessions.length ? (
            <Empty>No patient sessions.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {d.sessions.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.id}</td>
                    <td>{s.mode}</td>
                    <td>
                      <Badge status={s.status} />
                    </td>
                    <td>
                      {s.connections.map((c) => (
                        <div key={c.id}>
                          {c.facility?.name}: <Badge status={c.status} /> {c.failure_code && <span className="muted small">{c.failure_code}</span>}
                        </div>
                      ))}
                    </td>
                    <td className="muted">{fmtDate(s.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {tab === "Pull history" && (
        <div className="card table-wrap">
          {!d.pulls.length ? (
            <Empty>No pulls yet.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Trigger</th>
                  <th>Status</th>
                  <th>Resources</th>
                  <th>Duration</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {d.pulls.map((p) => (
                  <tr key={p.id}>
                    <td className="muted">{fmtDate(p.createdAt)}</td>
                    <td>{p.trigger}</td>
                    <td>
                      <Badge status={p.status} />
                      {p.errorCode && <div className="small muted">{p.errorCode}</div>}
                    </td>
                    <td>
                      {p.total} <span className="muted small">({p.created} new, {p.updated} changed, {p.errors} errors)</span>
                    </td>
                    <td className="muted">{p.durationMs ? `${(p.durationMs / 1000).toFixed(1)}s` : "—"}</td>
                    <td>
                      <details>
                        <summary className="small">per resource</summary>
                        <Json value={p.details} />
                        {p.errorMessage && <div className="alert bad small">{p.errorMessage}</div>}
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {tab === "Authorization" && (
        <div className="card table-wrap">
          <p className="muted small">Every step of every sign-in attempt: portal redirect, callback, token exchange and later refreshes. Quote the error code to support.</p>
          {!d.auth_events.length ? (
            <Empty>No authorization attempts.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Source</th>
                  <th>Step</th>
                  <th>Status</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {d.auth_events.map((e) => (
                  <tr key={e.id}>
                    <td className="muted">{fmtDate(e.createdAt)}</td>
                    <td className="mono small">{e.sourceId}</td>
                    <td>{e.step}</td>
                    <td>
                      <Badge status={e.status} />
                    </td>
                    <td>
                      {e.errorCode && <code>{e.errorCode}</code>} <span className="muted small">{e.errorDescription}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {tab === "Identity" && <Identities rows={d.identities} canAdmin={canAdmin} onChange={detail.reload} />}
      {tab === "Raw records" && <RawRecords id={id} />}
    </>
  );
}

function Summary({ id, stats }: { id: string; stats: Detail["record_stats"] }) {
  const facts = useLoad(() => api<{ data: Fact[] }>(`/patients/${encodeURIComponent(id)}/facts`), [id]);
  const byType = new Map<string, number>();
  for (const s of stats) byType.set(s.resource_type, (byType.get(s.resource_type) ?? 0) + Number(s.n));
  const known = facts.data?.data.filter((f) => f.status === "hasValue") ?? [];
  return (
    <div className="grid cols-2">
      <div className="card table-wrap">
        <h2>Latest clinical facts</h2>
        {facts.loading ? (
          <Loading />
        ) : !known.length ? (
          <Empty>No measurements yet.</Empty>
        ) : (
          <table>
            <tbody>
              {known.map((f) => (
                <tr key={f.code} title={f.provenance.map((p) => p.reference).join(", ")}>
                  <td>{f.display}</td>
                  <td>
                    <strong>{f.value}</strong> <span className="muted">{f.unit}</span> {f.resolved_by === "derived" && <span className="badge info">derived</span>}
                  </td>
                  <td className="muted small">
                    {f.effective?.slice(0, 10)} · {f.provenance.length} source record{f.provenance.length === 1 ? "" : "s"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h2>Records by type</h2>
        {!byType.size ? (
          <Empty>No records.</Empty>
        ) : (
          <table>
            <tbody>
              {[...byType.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([t, n]) => (
                  <tr key={t}>
                    <td>{t}</td>
                    <td style={{ textAlign: "right" }}>{n}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Models({ id }: { id: string }) {
  const [model, setModel] = useState("allergies");
  const rows = useLoad(() => api<{ data: Record<string, unknown>[] }>(`/patients/${encodeURIComponent(id)}/models/${model}`), [id, model]);
  const data = rows.data?.data ?? [];
  const columns = data.length ? Object.keys(data[0]!).filter((k) => !["key", "codes", "sources"].includes(k)) : [];
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <select value={model} onChange={(e) => setModel(e.target.value)} style={{ maxWidth: 220 }} aria-label="Model">
          {MODELS.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <span className="muted small">Reconciled across every connected source; each row lists the source records it came from.</span>
      </div>
      {rows.loading ? (
        <Loading />
      ) : !data.length ? (
        <Empty>No {model}.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c}>{c.replace(/_/g, " ")}</th>
                ))}
                <th>sources</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={String(r.key)}>
                  {columns.map((c) => (
                    <td key={c} className="small">
                      {renderCell(r[c])}
                    </td>
                  ))}
                  <td className="small">{(r.sources as unknown[]).length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function renderCell(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? Object.values(x as object).filter(Boolean).join(" ") : String(x))).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.slice(0, 10) : s;
}

function Connections({ id, conns, canAdmin, onChange }: { id: string; conns: Connection[]; canAdmin: boolean; onChange: () => Promise<void> }) {
  const action = useAction();
  return (
    <div className="card table-wrap">
      <ErrorBox error={action.error} />
      {!conns.length ? (
        <Empty>No connections. Start a patient session to connect a facility.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Facility</th>
              <th>Surface</th>
              <th>Status</th>
              <th>Last pull</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {conns.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.facility?.name}
                  <div className="mono small muted">{c.id}</div>
                </td>
                <td>{c.surface}</td>
                <td>
                  <Badge status={c.status} />
                  {c.failure_description && <div className="small muted">{c.failure_description}</div>}
                </td>
                <td className="muted">{fmtAgo(c.last_pull_at)}</td>
                <td>
                  {canAdmin && c.status === "active" && (
                    <div className="row">
                      {c.surface === "patient_access" && (
                        <button className="secondary" onClick={() => action.run(() => api(`/patients/${encodeURIComponent(id)}/connections/${c.id}/pull`, { body: {} }))}>
                          Pull now
                        </button>
                      )}
                      <button
                        className="secondary"
                        onClick={async () => {
                          if (!confirm("Disconnect this source? Access is revoked and its stored records are removed.")) return;
                          await action.run(() => del(`/patients/${encodeURIComponent(id)}/connections/${c.id}`));
                          await onChange();
                        }}
                      >
                        Disconnect
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Identities({ rows, canAdmin, onChange }: { rows: Detail["identities"]; canAdmin: boolean; onChange: () => Promise<void> }) {
  const action = useAction();
  return (
    <div className="card table-wrap">
      <p className="muted small">
        Each source's Patient record is compared with the first one linked (the anchor). A low match means the portal shared someone else's records, such as a family member's; confirm or reject before treating them as one person.
      </p>
      <ErrorBox error={action.error} />
      {!rows.length ? (
        <Empty>No source identities yet.</Empty>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Source patient</th>
              <th>Status</th>
              <th>Match probability</th>
              <th>Evidence</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="mono small">
                  {r.fhir_patient_id}
                  <div className="muted">{r.source_id}</div>
                </td>
                <td>
                  <Badge status={r.match_status} />
                </td>
                <td>{r.match_probability === null ? "—" : `${Math.round(r.match_probability * 100)}%`}</td>
                <td>
                  <details>
                    <summary className="small">fields</summary>
                    <Json value={r.match_details} />
                  </details>
                </td>
                <td>
                  {canAdmin && r.match_status !== "anchor" && (
                    <div className="row">
                      <button className="secondary" onClick={async () => (await action.run(() => api(`/identities/${r.id}/decision`, { body: { decision: "confirmed" } }))) && onChange()}>
                        Same person
                      </button>
                      <button className="secondary" onClick={async () => (await action.run(() => api(`/identities/${r.id}/decision`, { body: { decision: "rejected" } }))) && onChange()}>
                        Different person
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RawRecords({ id }: { id: string }) {
  const [type, setType] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const page = useLoad(
    () => api<{ data: { source: string; resource: Record<string, unknown> }[]; next_cursor: string | null }>(`/patients/${encodeURIComponent(id)}/records?count=50${type ? `&type=${type}` : ""}${cursor ? `&starting_after=${cursor}` : ""}`),
    [id, type, cursor],
  );
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <input placeholder="Filter types, e.g. Observation,Condition" value={type} onChange={(e) => (setCursor(null), setType(e.target.value))} style={{ maxWidth: 320 }} aria-label="Resource types" />
        {page.data?.next_cursor && (
          <button className="secondary" onClick={() => setCursor(page.data!.next_cursor)}>
            Next page
          </button>
        )}
      </div>
      {page.loading ? (
        <Loading />
      ) : (
        page.data?.data.map((r) => (
          <details key={`${r.source}-${r.resource.resourceType}-${r.resource.id}`} style={{ marginBottom: 6 }}>
            <summary className="mono small">
              {String(r.resource.resourceType)}/{String(r.resource.id)}
            </summary>
            <Json value={r.resource} />
          </details>
        ))
      )}
    </div>
  );
}
