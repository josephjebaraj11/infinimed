import { useState } from "react";
import { api, fmtDate } from "../api";
import { Empty, ErrorBox, Loading, useLoad } from "../components";
import { useSession } from "../session";

type Entry = { id: string; actorType: string; actorId: string | null; action: string; targetType: string | null; targetId: string | null; metadata: Record<string, unknown>; ip: string | null; createdAt: string };

export function AuditLog() {
  const { workspace, canAdmin } = useSession();
  const [before, setBefore] = useState<string | null>(null);
  const log = useLoad(() => (canAdmin ? api<{ data: Entry[] }>(`/audit?limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`) : Promise.resolve({ data: [] as Entry[] })), [workspace?.id, before]);
  if (!canAdmin) return <div className="card">The audit log is available to admins and owners.</div>;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <span className="muted">Security-relevant actions: keys, credentials, record reads, MCP tool calls, deletes.</span>
        </div>
      </div>
      <ErrorBox error={log.error} />
      <div className="card table-wrap">
        {!log.data ? (
          <Loading />
        ) : !log.data.data.length ? (
          <Empty>No entries.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {log.data.data.map((e) => (
                <tr key={e.id}>
                  <td className="muted small">{fmtDate(e.createdAt)}</td>
                  <td className="small">
                    {e.actorType}
                    <div className="mono muted">{e.actorId}</div>
                  </td>
                  <td>
                    <code>{e.action}</code>
                  </td>
                  <td className="mono small">{e.targetId}</td>
                  <td className="small muted">{Object.keys(e.metadata).length ? JSON.stringify(e.metadata) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {log.data && log.data.data.length === 100 && (
        <button className="secondary" onClick={() => setBefore(log.data!.data[log.data!.data.length - 1]!.createdAt)}>
          Older entries
        </button>
      )}
    </>
  );
}
