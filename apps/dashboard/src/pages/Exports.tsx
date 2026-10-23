import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, del, fmtAgo, fmtDate, patch } from "../api";
import { Badge, CopyField, Empty, ErrorBox, Json, Loading, Modal, useAction, useLoad } from "../components";
import { useSession } from "../session";

type Destination = { id: string; name: string; type: string; config: Record<string, unknown>; enabled: boolean; watermark: number; last_exported_at: string | null; created_at: string };
type Run = { id: string; trigger: string; status: string; patients_processed: number; resources_processed: number; error_count: number; error_message: string | null; failed_items: unknown[]; started_at: string | null; finished_at: string | null; created_at: string };

const TYPE_LABEL: Record<string, string> = { fhir_internal: "Internal FHIR server", fhir_custom: "Custom FHIR server", object_storage: "Object storage" };

export function Exports() {
  const { workspace, canAdmin } = useSession();
  const list = useLoad(() => api<{ data: Destination[] }>("/exports"), [workspace?.id]);
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Exports</h1>
          <span className="muted">Deliver records to a FHIR server or object storage. A full backfill runs first, then deltas after every pull.</span>
        </div>
        {canAdmin && <button onClick={() => setAdding(true)}>Add destination</button>}
      </div>
      <ErrorBox error={list.error} />
      <div className="card table-wrap">
        {!list.data ? (
          <Loading />
        ) : !list.data.data.length ? (
          <Empty>No export destinations.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Status</th>
                <th>Last export</th>
              </tr>
            </thead>
            <tbody>
              {list.data.data.map((d) => (
                <tr key={d.id}>
                  <td>
                    <Link to={`/exports/${d.id}`}>{d.name}</Link>
                  </td>
                  <td>{TYPE_LABEL[d.type] ?? d.type}</td>
                  <td>
                    <Badge status={d.enabled ? "active" : "disabled"} />
                  </td>
                  <td className="muted">{fmtAgo(d.last_exported_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {adding && <AddDestination onClose={() => setAdding(false)} onCreated={(id) => navigate(`/exports/${id}`)} />}
    </>
  );
}

function AddDestination({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [type, setType] = useState("fhir_internal");
  const [f, setF] = useState<Record<string, string>>({ name: "", auth_type: "none", vendor: "aws", file_type: "ndjson", id_strategy: "source" });
  const action = useAction();
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const input = (k: string, label: string, opts: { type?: string; placeholder?: string } = {}) => (
    <>
      <label htmlFor={k}>{label}</label>
      <input id={k} type={opts.type ?? "text"} value={f[k] ?? ""} onChange={set(k)} placeholder={opts.placeholder} />
    </>
  );
  return (
    <Modal
      title="Add export destination"
      onClose={onClose}
      actions={
        <>
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            disabled={action.pending || !f.name}
            onClick={async () => {
              const body: Record<string, unknown> = { type, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "")) };
              const d = await action.run(() => api<Destination>("/exports", { body }));
              if (d) onCreated(d.id);
            }}
          >
            {action.pending ? "Testing connection…" : "Test and save"}
          </button>
        </>
      }
    >
      <ErrorBox error={action.error} />
      <label htmlFor="type">Destination type</label>
      <select id="type" value={type} onChange={(e) => setType(e.target.value)}>
        <option value="fhir_internal">Internal FHIR server (hosted by InfiniMed)</option>
        <option value="fhir_custom">Custom FHIR R4 server</option>
        <option value="object_storage">Object storage (S3, S3-compatible, Azure Blob)</option>
      </select>
      {input("name", "Name")}
      {type !== "object_storage" && (
        <>
          <label htmlFor="ids">Resource ids</label>
          <select id="ids" value={f.id_strategy} onChange={set("id_strategy")}>
            <option value="source">Keep source ids</option>
            <option value="namespaced">Namespace ids per source (avoids collisions)</option>
          </select>
        </>
      )}
      {type === "fhir_custom" && (
        <>
          {input("base_url", "FHIR base URL", { placeholder: "https://fhir.example.com/r4" })}
          <label htmlFor="auth">Authentication</label>
          <select id="auth" value={f.auth_type} onChange={set("auth_type")}>
            <option value="none">None</option>
            <option value="bearer">Bearer token</option>
            <option value="client_credentials">OAuth 2.0 client credentials</option>
          </select>
          {f.auth_type === "bearer" && input("bearer_token", "Bearer token", { type: "password" })}
          {f.auth_type === "client_credentials" && (
            <>
              {input("token_url", "Token endpoint")}
              {input("client_id", "Client ID")}
              {input("client_secret", "Client secret", { type: "password" })}
              {input("scope", "Scope (optional)")}
            </>
          )}
        </>
      )}
      {type === "object_storage" && (
        <>
          <label htmlFor="vendor">Provider</label>
          <select id="vendor" value={f.vendor} onChange={set("vendor")}>
            <option value="aws">Amazon S3</option>
            <option value="s3_compatible">S3-compatible (MinIO, R2, Wasabi, GCS interop)</option>
            <option value="azure_blob">Azure Blob Storage (SAS URL)</option>
          </select>
          {f.vendor === "azure_blob" ? (
            input("sas_url", "Container SAS URL", { type: "password" })
          ) : (
            <>
              {f.vendor === "s3_compatible" && input("endpoint", "Endpoint", { placeholder: "https://minio.example.com" })}
              {input("region", "Region", { placeholder: "us-east-1" })}
              {input("bucket", "Bucket")}
              {input("access_key_id", "Access key ID")}
              {input("secret_access_key", "Secret access key", { type: "password" })}
            </>
          )}
          {input("prefix", "Key prefix (optional)", { placeholder: "infinimed/" })}
          <label htmlFor="ft">File type</label>
          <select id="ft" value={f.file_type} onChange={set("file_type")}>
            <option value="ndjson">NDJSON</option>
            <option value="ndjson_zip">Zipped NDJSON</option>
          </select>
        </>
      )}
    </Modal>
  );
}

export function ExportDetail() {
  const { id = "" } = useParams();
  const { canAdmin } = useSession();
  const navigate = useNavigate();
  const d = useLoad(() => api<Destination & { runs: Run[]; internal_access: { base_url: string; bearer_token: string | null } | null }>(`/exports/${id}`), [id]);
  const action = useAction();
  if (!d.data) return d.loading ? <Loading /> : <ErrorBox error={d.error} />;
  const dest = d.data;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{dest.name}</h1>
          <span className="muted">
            {TYPE_LABEL[dest.type]} · created {fmtAgo(dest.created_at)}
          </span>
        </div>
        {canAdmin && (
          <div className="row">
            <button className="secondary" onClick={async () => (await action.run(() => patch(`/exports/${id}`, { enabled: !dest.enabled }))) && d.reload()}>
              {dest.enabled ? "Disable" : "Enable"}
            </button>
            <button
              className="danger"
              onClick={async () => {
                if (confirm("Delete this destination? Records already delivered stay where they are.") && (await action.run(() => del(`/exports/${id}`)))) navigate("/exports");
              }}
            >
              Delete
            </button>
          </div>
        )}
      </div>
      <ErrorBox error={action.error} />
      {dest.internal_access && (
        <div className="card">
          <h2>Access the hosted FHIR server</h2>
          <CopyField label="FHIR base URL" value={dest.internal_access.base_url} />
          {dest.internal_access.bearer_token && <CopyField label="Bearer token" value={dest.internal_access.bearer_token} secret />}
          <p className="muted small" style={{ marginTop: 8 }}>
            Find a patient by your id: <code>GET {dest.internal_access.base_url}/Patient?identifier=urn:infinimed:patient-id|{"{patient_id}"}</code>
          </p>
        </div>
      )}
      <div className="card">
        <h2>Configuration</h2>
        <Json value={dest.config} />
      </div>
      <div className="card table-wrap">
        <h2>Runs</h2>
        {!dest.runs.length ? (
          <Empty>No runs yet.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Trigger</th>
                <th>Status</th>
                <th>Patients</th>
                <th>Resources</th>
                <th>Errors</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {dest.runs.map((r) => (
                <tr key={r.id}>
                  <td className="muted">{fmtDate(r.started_at ?? r.created_at)}</td>
                  <td>{r.trigger.replace(/_/g, " ")}</td>
                  <td>
                    <Badge status={r.status} />
                    {r.error_message && <div className="small muted">{r.error_message}</div>}
                  </td>
                  <td>{r.patients_processed}</td>
                  <td>{r.resources_processed}</td>
                  <td>{r.error_count}</td>
                  <td>
                    {canAdmin && (r.status === "failed" || r.status === "partial") && (
                      <button className="secondary" onClick={async () => (await action.run(() => api(`/exports/${id}/runs/${r.id}/retry`, { body: {} }))) && d.reload()}>
                        Retry
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
