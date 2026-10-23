import { api, fmtAgo } from "../api";
import { Badge, CopyField, Empty, ErrorBox, Loading, useAction, useLoad } from "../components";
import { useSession } from "../session";

export function McpAccess() {
  const { workspace, me } = useSession();
  const grants = useLoad(() => api<{ data: { id: string; client_name: string; user_email: string; scopes: string[]; created_at: string; last_used_at: string | null; revoked_at: string | null }[] }>("/mcp/grants"), [workspace?.id]);
  const action = useAction();
  const url = `${me.public_url}/mcp`;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>MCP server</h1>
          <span className="muted">Let AI assistants search facilities, start connections and read records, behind a consent screen.</span>
        </div>
      </div>
      <div className="card">
        <CopyField label="Server URL" value={url} />
        <h3 style={{ marginTop: 16 }}>Connect a client</h3>
        <pre className="json">{`# Claude Code (browser sign-in and consent)
claude mcp add --transport http infinimed ${url}

# Codex
codex mcp add infinimed --url ${url} --oauth-resource ${url}

# Scripted access with an API key (no browser)
claude mcp add --transport http infinimed ${url} --header "Authorization: Bearer im_sk_..."`}</pre>
        <p className="muted small" style={{ marginTop: 8 }}>
          Claude and ChatGPT on the web: add a custom connector with the server URL and leave the OAuth fields blank. Users choose a workspace and untick any capability on the consent screen.
        </p>
      </div>
      <ErrorBox error={grants.error ?? action.error} />
      <div className="card table-wrap">
        <h2>Connected assistants</h2>
        {!grants.data ? (
          <Loading />
        ) : !grants.data.data.length ? (
          <Empty>No assistants connected to this workspace.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Assistant</th>
                <th>User</th>
                <th>Capabilities</th>
                <th>Last used</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {grants.data.data.map((g) => (
                <tr key={g.id}>
                  <td>{g.client_name}</td>
                  <td>{g.user_email}</td>
                  <td className="small">{g.scopes.join(", ")}</td>
                  <td className="muted">{fmtAgo(g.last_used_at)}</td>
                  <td>
                    {g.revoked_at ? (
                      <Badge status="revoked" />
                    ) : (
                      <button className="secondary" onClick={async () => confirm("Revoke this assistant? Its access expires within the hour.") && (await action.run(() => api(`/mcp/grants/${g.id}/revoke`, { body: {} }))) && grants.reload()}>
                        Revoke
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
