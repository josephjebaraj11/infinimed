import { useState } from "react";
import { api } from "../api";
import { Badge, Empty, ErrorBox, Loading, useLoad } from "../components";
import { useSession } from "../session";

type Source = { id: string; name: string; type: string; category: string; fhir_base_url: string | null; city: string | null; state: string | null; surfaces: string[]; connectable: boolean };

export function Sources() {
  const { workspace } = useSession();
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const page = useLoad(
    () => api<{ data: Source[]; next_cursor: string | null }>(`/sources?limit=50${query ? `&q=${encodeURIComponent(query)}` : ""}${cursor ? `&starting_after=${cursor}` : ""}`),
    [workspace?.id, query, cursor],
  );
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Source directory</h1>
          <span className="muted">Every EHR, payer and sandbox this workspace can reach, with the surfaces each supports.</span>
        </div>
      </div>
      <form
        className="row"
        style={{ marginBottom: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          setCursor(null);
          setQuery(q);
        }}
      >
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, vendor or city" style={{ maxWidth: 360 }} aria-label="Search sources" />
        <button type="submit" className="secondary">
          Search
        </button>
      </form>
      <ErrorBox error={page.error} />
      <div className="card table-wrap">
        {page.loading && !page.data ? (
          <Loading />
        ) : !page.data?.data.length ? (
          <Empty>No sources match.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Vendor</th>
                <th>Surfaces</th>
                <th>FHIR base URL</th>
                <th>Connectable</th>
              </tr>
            </thead>
            <tbody>
              {page.data.data.map((s) => (
                <tr key={s.id}>
                  <td>
                    {s.name}
                    <div className="mono small muted">{s.id}</div>
                  </td>
                  <td>
                    {s.type} <span className="muted small">({s.category})</span>
                  </td>
                  <td className="small">{s.surfaces.join(", ")}</td>
                  <td className="mono small" style={{ maxWidth: 360, overflowWrap: "anywhere" }}>
                    {s.fhir_base_url}
                  </td>
                  <td>
                    <Badge status={s.connectable ? "active" : "not_configured"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {page.data?.next_cursor && (
        <button className="secondary" onClick={() => setCursor(page.data!.next_cursor)}>
          Next page
        </button>
      )}
    </>
  );
}
