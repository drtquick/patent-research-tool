import { useEffect, useMemo, useState } from "react";
import { api } from "./api";

/**
 * Aggregated prior-art citations across the US family. Two views:
 *   - Matrix: one row per unique reference, one column per US family member,
 *     dot marks show which references each member cites.
 *   - Per-member: one column per US member with the full reference list.
 */
export default function PriorArtTab({ portfolioId }) {
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");
  const [data,    setData]    = useState(null);
  const [view,    setView]    = useState("matrix");

  useEffect(() => {
    if (!portfolioId) return;
    let alive = true;
    setLoading(true);
    setError("");
    api.getPortfolioPriorArt(portfolioId)
      .then((d) => { if (alive) setData(d); })
      .catch((err) => { if (alive) setError(err.message || "Failed to load prior art"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [portfolioId]);

  if (loading) return <div style={s.loading}>Loading prior-art citations from EPO biblio…</div>;
  if (error)   return <div style={s.error}>{error}</div>;
  if (!data)   return null;

  const members = data.members || [];
  const refs    = data.dedup_references || [];

  if (members.length === 0) {
    return <div style={s.empty}>No US family members found.</div>;
  }

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <div>
          <strong>{refs.length}</strong> unique references cited across <strong>{members.length}</strong> US family member{members.length === 1 ? "" : "s"}.
        </div>
        <div style={s.toggle}>
          <button
            style={{ ...s.toggleBtn, ...(view === "matrix" ? s.toggleActive : {}) }}
            onClick={() => setView("matrix")}
          >
            Matrix
          </button>
          <button
            style={{ ...s.toggleBtn, ...(view === "per" ? s.toggleActive : {}) }}
            onClick={() => setView("per")}
          >
            Per-Member
          </button>
        </div>
      </div>

      {view === "matrix"
        ? <MatrixView members={members} refs={refs} />
        : <PerMemberView members={members} />
      }
    </div>
  );
}

function MatrixView({ members, refs }) {
  const memberKey = (m) => m.pub_num;
  const citedSet = useMemo(() => {
    const map = new Map();
    refs.forEach((r) => map.set(r.key, new Set(r.citing_members)));
    return map;
  }, [refs]);

  return (
    <div style={s.scroller}>
      <table style={s.matrix}>
        <thead>
          <tr>
            <th style={s.colRefHdr}>Reference</th>
            <th style={s.colCat}>Cat.</th>
            {members.map((m) => (
              <th key={memberKey(m)} style={s.colMemberHdr} title={m.pub_num}>
                <div style={{ transform: "rotate(-20deg)", display: "inline-block",
                              transformOrigin: "left bottom", whiteSpace: "nowrap" }}>
                  {m.display_number}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {refs.map((r) => (
            <tr key={r.key}>
              <td style={s.cellRef}>
                <div>
                  {r.type === "patent" ? (
                    <a
                      href={`https://worldwide.espacenet.com/patent/search?q=pn%3D${encodeURIComponent((r.country||"") + (r.number||""))}`}
                      target="_blank"
                      rel="noopener"
                      style={s.refLink}
                    >
                      {r.display}
                    </a>
                  ) : (
                    <span style={{ fontSize: 12, color: "#444" }}>{r.display}</span>
                  )}
                  <span style={s.typePill}>{r.type === "patent" ? "Pat" : "NPL"}</span>
                </div>
              </td>
              <td style={s.colCat}>
                {r.category && (
                  <span style={{ ...s.catPill, ...catStyle(r.category) }}>{r.category}</span>
                )}
              </td>
              {members.map((m) => {
                const hit = citedSet.get(r.key)?.has(m.pub_num);
                return (
                  <td key={memberKey(m)} style={s.cellDot}>
                    {hit && <span style={s.dot} />}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PerMemberView({ members }) {
  return (
    <div style={s.scroller}>
      {members.map((m) => (
        <div key={m.pub_num} style={s.column}>
          <div style={s.colHeader}>
            <div style={s.colTitle}>{m.display_number}</div>
            <div style={s.colMeta}>
              {m.references.length} references &middot; {m.status}
            </div>
          </div>
          {m.references.length === 0 ? (
            <div style={s.noRefs}>No references extracted.</div>
          ) : (
            m.references.map((r, i) => (
              <div key={i} style={s.refCard}>
                <div style={s.refCardTop}>
                  <span style={s.refCardTitle}>{r.display}</span>
                  {r.category && (
                    <span style={{ ...s.catPill, ...catStyle(r.category) }}>{r.category}</span>
                  )}
                </div>
                <div style={s.refCardMeta}>
                  {r.type === "patent" ? "Patent" : "NPL"}
                  {r.cited_by ? ` · cited by ${r.cited_by}` : ""}
                  {r.cited_phase ? ` · ${r.cited_phase}` : ""}
                  {r.date ? ` · ${r.date}` : ""}
                </div>
              </div>
            ))
          )}
        </div>
      ))}
    </div>
  );
}

function catStyle(cat) {
  // EPO relevance categories: X=highly relevant, Y=relevant w/combo, A=background
  const map = {
    X:  { background: "#c62828", color: "#fff" },
    Y:  { background: "#ef6c00", color: "#fff" },
    A:  { background: "#607d8b", color: "#fff" },
    P:  { background: "#6a1b9a", color: "#fff" },
    T:  { background: "#00695c", color: "#fff" },
    D:  { background: "#455a64", color: "#fff" },
    E:  { background: "#0277bd", color: "#fff" },
  };
  return map[cat[0]?.toUpperCase()] || { background: "#9e9e9e", color: "#fff" };
}

const s = {
  wrap:    { padding: 16, background: "#fafbfd", minHeight: "60vh" },
  loading: { padding: 32, textAlign: "center", color: "#666" },
  error:   { padding: 14, background: "#fdecea", color: "#c62828", borderRadius: 8 },
  empty:   { padding: 32, textAlign: "center", color: "#888" },

  header:  { display: "flex", justifyContent: "space-between", alignItems: "center",
             marginBottom: 12, fontSize: 13, color: "#444" },
  toggle:  { display: "inline-flex", borderRadius: 6, overflow: "hidden",
             border: "1px solid #d0d7de" },
  toggleBtn: { padding: "6px 12px", background: "#fff", border: "none",
             cursor: "pointer", fontSize: 12, fontWeight: 600, color: "#555" },
  toggleActive: { background: "#1a73e8", color: "#fff" },

  scroller:{ overflowX: "auto", overflowY: "auto", maxHeight: "72vh",
             background: "#fff", borderRadius: 10, border: "1px solid #e0e0e0",
             display: "flex", gap: 12, padding: 10 },

  // Matrix
  matrix:    { borderCollapse: "collapse", fontSize: 12, width: "100%" },
  colRefHdr: { padding: "10px 8px", background: "#f8f9fa", borderBottom: "1px solid #e0e0e0",
             textAlign: "left", position: "sticky", top: 0, zIndex: 2, minWidth: 260 },
  colCat:    { padding: "6px 4px", background: "#f8f9fa", borderBottom: "1px solid #e0e0e0",
             textAlign: "center", position: "sticky", top: 0, zIndex: 2, minWidth: 36 },
  colMemberHdr: { padding: "22px 6px 6px", background: "#f8f9fa",
             borderBottom: "1px solid #e0e0e0", fontSize: 11, fontWeight: 600,
             position: "sticky", top: 0, zIndex: 2, minWidth: 90, height: 80 },
  cellRef: { padding: "8px 8px", borderBottom: "1px solid #f0f0f0", verticalAlign: "top" },
  cellDot: { padding: 6, borderBottom: "1px solid #f0f0f0", textAlign: "center" },
  dot:     { display: "inline-block", width: 10, height: 10, borderRadius: "50%",
             background: "#1a73e8" },
  refLink: { color: "#1a73e8", fontWeight: 600, textDecoration: "none", fontSize: 12 },
  typePill:{ marginLeft: 6, padding: "1px 6px", background: "#eef3fb",
             color: "#1a73e8", borderRadius: 10, fontSize: 10, fontWeight: 700 },
  catPill: { padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700 },

  // Per-member columns
  column:  { minWidth: 280, maxWidth: 320, flexShrink: 0 },
  colHeader: { padding: "10px 12px", background: "#f8f9fa", borderRadius: 8,
             marginBottom: 8 },
  colTitle:{ fontWeight: 700, fontSize: 13, color: "#1a1a2e" },
  colMeta: { fontSize: 11, color: "#666", marginTop: 2 },
  noRefs:  { padding: 14, textAlign: "center", color: "#aaa", fontStyle: "italic",
             fontSize: 12 },
  refCard: { padding: "8px 10px", border: "1px solid #e5e7eb", borderRadius: 6,
             marginBottom: 6, background: "#fff" },
  refCardTop: { display: "flex", justifyContent: "space-between", alignItems: "center",
             gap: 6, marginBottom: 3 },
  refCardTitle: { fontSize: 12, fontWeight: 600, color: "#1a1a2e",
             overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
             maxWidth: 220 },
  refCardMeta: { fontSize: 10, color: "#777" },
};
