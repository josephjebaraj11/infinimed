import { useState } from "react";
import { api, del, fmtAgo, patch } from "../api";
import { CopyField, ErrorBox, Loading, useAction, useLoad } from "../components";
import { useSession } from "../session";

export function Team() {
  const { workspace, canAdmin, me } = useSession();
  const members = useLoad(() => api<{ data: { user_id: string; email: string; name: string | null; role: string; joined_at: string }[] }>("/members"), [workspace?.id]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [invite, setInvite] = useState<string | null>(null);
  const action = useAction();
  const isOwner = workspace?.role === "owner";
  return (
    <>
      <div className="page-head">
        <h1>Team</h1>
      </div>
      <ErrorBox error={members.error ?? action.error} />
      {canAdmin && (
        <div className="card">
          <h2>Invite a teammate</h2>
          <div className="row">
            <input type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} style={{ maxWidth: 300 }} aria-label="Email" />
            <select value={role} onChange={(e) => setRole(e.target.value)} style={{ maxWidth: 140 }} aria-label="Role">
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              {isOwner && <option value="owner">Owner</option>}
            </select>
            <button disabled={!email || action.pending} onClick={async () => setInvite((await action.run(() => api<{ invite_url: string }>("/members/invitations", { body: { email, role } })))?.invite_url ?? null)}>
              Create invite link
            </button>
          </div>
          <p className="muted small" style={{ marginTop: 6 }}>
            Owners manage members and deletion; admins manage keys, credentials, exports and webhooks; members have read access.
          </p>
          {invite && <CopyField label="Send this link to your teammate (valid 7 days)" value={invite} />}
        </div>
      )}
      <div className="card table-wrap">
        {!members.data ? (
          <Loading />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Member</th>
                <th>Role</th>
                <th>Joined</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.data.data.map((m) => (
                <tr key={m.user_id}>
                  <td>
                    {m.name ?? m.email}
                    <div className="muted small">{m.email}</div>
                  </td>
                  <td>
                    {isOwner && m.user_id !== me.user.id ? (
                      <select value={m.role} onChange={async (e) => (await action.run(() => patch(`/members/${m.user_id}`, { role: e.target.value }))) && members.reload()} aria-label="Role">
                        <option value="member">member</option>
                        <option value="admin">admin</option>
                        <option value="owner">owner</option>
                      </select>
                    ) : (
                      m.role
                    )}
                  </td>
                  <td className="muted">{fmtAgo(m.joined_at)}</td>
                  <td>
                    {isOwner && m.user_id !== me.user.id && (
                      <button className="secondary" onClick={async () => confirm(`Remove ${m.email}?`) && (await action.run(() => del(`/members/${m.user_id}`))) && members.reload()}>
                        Remove
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
