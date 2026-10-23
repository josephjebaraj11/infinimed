import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, fmtAgo, type Patient } from "../api";
import { Badge, Empty, ErrorBox, Loading, Modal, useAction, useLoad } from "../components";
import { useSession } from "../session";

export function Patients() {
  const { workspace, canAdmin } = useSession();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const list = useLoad(() => api<{ data: Patient[]; has_more: boolean }>(`/patients?limit=100${query ? `&q=${encodeURIComponent(query)}` : ""}`), [workspace?.id, query]);
  const [creating, setCreating] = useState(false);
  const samples = useAction();
  const navigate = useNavigate();

  return (
    <>
      <div className="page-head">
        <h1>Patients</h1>
        <div className="row">
          {canAdmin && workspace?.environment === "sandbox" && (
            <button
              className="secondary"
              disabled={samples.pending}
              onClick={async () => {
                await samples.run(() => api("/sample-patients", { body: {} }));
                await list.reload();
              }}
            >
              {samples.pending ? "Loading…" : "Load sample patients"}
            </button>
          )}
          {canAdmin && <button onClick={() => setCreating(true)}>Add patient</button>}
        </div>
      </div>
      <ErrorBox error={list.error ?? samples.error} />
      <form
        className="row"
        style={{ marginBottom: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
      >
        <input type="search" placeholder="Search by patient id, name or email" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 360 }} aria-label="Search patients" />
        <button type="submit" className="secondary">
          Search
        </button>
      </form>
      <div className="card table-wrap">
        {list.loading && !list.data ? (
          <Loading />
        ) : !list.data?.data.length ? (
          <Empty>No patients yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Patient id</th>
                <th>Name</th>
                <th>Connections</th>
                <th>Activated</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {list.data.data.map((p) => (
                <tr key={p.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/patients/${encodeURIComponent(p.id)}`)}>
                  <td className="mono">
                    <Link to={`/patients/${encodeURIComponent(p.id)}`} onClick={(e) => e.stopPropagation()}>
                      {p.id}
                    </Link>
                  </td>
                  <td>{p.name ?? <span className="muted">—</span>}</td>
                  <td>
                    <div className="row">
                      {p.connections.length === 0 && <span className="muted">none</span>}
                      {p.connections.slice(0, 4).map((c) => (
                        <span key={c.id} title={c.facility?.name}>
                          <Badge status={c.status} /> <span className="small">{c.facility?.name}</span>
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="muted">{fmtAgo(p.activated_at)}</td>
                  <td className="muted">{fmtAgo(p.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && <CreatePatient onClose={() => setCreating(false)} onCreated={(id) => navigate(`/patients/${encodeURIComponent(id)}`)} />}
    </>
  );
}

function CreatePatient({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [form, setForm] = useState({ patient_id: "", name: "", email: "" });
  const action = useAction();
  return (
    <Modal
      title="Add patient"
      onClose={onClose}
      actions={
        <>
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            disabled={action.pending || !form.patient_id}
            onClick={async () => {
              const p = await action.run(() => api<Patient>("/patients", { body: { patient_id: form.patient_id, name: form.name || undefined, email: form.email || undefined } }));
              if (p) onCreated(p.id);
            }}
          >
            Create
          </button>
        </>
      }
    >
      <ErrorBox error={action.error} />
      <label htmlFor="pid">Patient id</label>
      <input id="pid" value={form.patient_id} onChange={(e) => setForm({ ...form, patient_id: e.target.value })} placeholder="user_42" />
      <div className="field-hint">A stable id from your system (user id, member id). Avoid emails.</div>
      <label htmlFor="pname">Name</label>
      <input id="pname" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <label htmlFor="pemail">Email</label>
      <input id="pemail" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
    </Modal>
  );
}
