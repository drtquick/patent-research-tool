import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * Claims Summary tab.  Columns = US family members, rows = identifier +
 * AI summary + independent claim text. First load is table-only (cheap);
 * hit "Generate AI summary" to run the comparative Claude analysis.
 */
export default function ClaimsTab({ portfolioId }) {
  const [loading,      setLoading]     = useState(true);
  const [summarizing,  setSummarizing] = useState(false);
  const [error,        setError]       = useState("");
  const [data,         setData]        = useState(null);

  function load({ summary = false } = {}) {
    if (!portfolioId) return;
    if (summary) setSummarizing(true); else setLoading(true);
    setError("");
    api.getPortfolioClaims(portfolioId, { summary })
      .then((d) => setData(d))
      .catch((err) => setError(err.message || "Failed to load claims"))
      .finally(() => { setLoading(false); setSummarizing(false); });
  }

  useEffect(() => {
    load({ summary: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portfolioId]);

  if (loading) return <div style={s.loading}>Extracting independent claims from IFW (this takes 30–60s on first load)…</div>;
  if (error)   return <div style={s.error}>{error}</div>;
  if (!data)   return null;

  const allMembers = data.members || [];
  const members = allMembers.filter((m) => m.claims && m.claims.length > 0);
  const emptyMembers = allMembers.filter((m) => !m.claims || m.claims.length === 0);

  if (allMembers.length === 0) {
    return <div style={s.empty}>No active US family members found. Claims extraction requires at least one pending or granted US member.</div>;
  }

  // Build a dense row set: for every member, up to the longest claim list length
  const maxRows = members.reduce((n, m) => Math.max(n, m.claims.length), 0);

  return (
    <div style={s.wrap}>
      <div style={s.header}>
        <div>
          <strong>{members.length}</strong> US member{members.length === 1 ? "" : "s"} · independent claims only
        </div>
        <button
          onClick={() => load({ summary: true })}
          disabled={summarizing}
          style={{ padding: "6px 14px", borderRadius: 6,
                   background: summarizing ? "#d1c4e9" : "#8b5cf6",
                   color: "#fff", border: "none", fontSize: 12, fontWeight: 700,
                   cursor: summarizing ? "wait" : "pointer" }}
          title="Ask Claude to compare the independent claims across the family"
        >
          {summarizing ? "Summarizing…" : (data.summary ? "🔄 Regenerate AI summary" : "🧠 Generate AI summary")}
        </button>
      </div>

      <div style={s.scroller}>
        <table style={s.table}>
          <thead>
            <tr>
              {members.map((m) => (
                <th key={m.pub_num} style={s.thNumber}>
                  <div style={s.headNum}>{m.display_number}</div>
                  <div style={s.headMeta}>
                    <span style={{ ...s.pill, ...statusStyle(m.status) }}>{m.status}</span>
                    {m.app_num && <span style={s.appHint}>App {formatApp(m.app_num)}</span>}
                  </div>
                </th>
              ))}
            </tr>
            {data.summary && (
              <tr>
                <th colSpan={members.length} style={s.summaryCell}>
                  <div style={s.summaryLabel}>AI summary · comparing independent claims</div>
                  <div style={s.summaryText}>{data.summary}</div>
                </th>
              </tr>
            )}
          </thead>
          <tbody>
            {Array.from({ length: maxRows }).map((_, rowIdx) => (
              <tr key={rowIdx}>
                {members.map((m) => {
                  const c = m.claims[rowIdx];
                  return (
                    <td key={m.pub_num + "_" + rowIdx} style={s.claimCell}>
                      {c ? (
                        <>
                          <div style={s.claimNum}>Claim {c.num}</div>
                          <div style={s.claimText}>{c.text}</div>
                        </>
                      ) : (
                        <div style={{ color: "#ccc", fontSize: 12 }}>—</div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {emptyMembers.length > 0 && (
        <div style={s.emptySection}>
          <div style={s.emptySectionTitle}>
            Claims not yet extracted ({emptyMembers.length} member{emptyMembers.length === 1 ? "" : "s"})
          </div>
          <div style={s.emptySectionHint}>
            These members had no claims data available. This may be due to API rate limits or because claim documents
            have not yet been published. Reload the tab to retry.
          </div>
          <div style={s.emptyList}>
            {emptyMembers.map((m) => (
              <span key={m.pub_num || m.app_num} style={s.emptyChip}>
                {m.display_number || m.app_num}
                <span style={{ ...s.pill, ...statusStyle(m.status), marginLeft: 4 }}>{m.status}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {members.length === 0 && emptyMembers.length > 0 && (
        <div style={s.retryBox}>
          Claims extraction is running. If you just opened this tab, the first load may take 1-2 minutes
          for families with many continuations. Reload the page to check for updated results.
        </div>
      )}
    </div>
  );
}

function formatApp(app) {
  const s = String(app || "").replace(/\D/g, "");
  if (s.length === 8) return `${s.slice(0, 2)}/${s.slice(2, 5)},${s.slice(5)}`;
  return app || "";
}

function statusStyle(status) {
  const map = {
    granted: { background: "#e8f5e9", color: "#2e7d32" },
    pending: { background: "#e3f2fd", color: "#1565c0" },
    unknown: { background: "#f5f5f5", color: "#666" },
  };
  return map[status] || map.unknown;
}

const s = {
  wrap:    { padding: 16, background: "#fafbfd", minHeight: "60vh" },
  loading: { padding: 32, textAlign: "center", color: "#666" },
  error:   { padding: 14, background: "#fdecea", color: "#c62828", borderRadius: 8 },
  empty:   { padding: 32, textAlign: "center", color: "#888" },

  header:  { display: "flex", justifyContent: "space-between", alignItems: "center",
             marginBottom: 10, fontSize: 13, color: "#444" },

  scroller:{ overflowX: "auto", overflowY: "auto", maxHeight: "76vh",
             background: "#fff", borderRadius: 10, border: "1px solid #e0e0e0" },
  table:   { borderCollapse: "collapse", fontSize: 12, minWidth: "100%" },
  thNumber:{ padding: "12px 14px", borderBottom: "2px solid #1a73e8", background: "#f8f9fa",
             textAlign: "left", verticalAlign: "top", minWidth: 320, maxWidth: 420,
             position: "sticky", top: 0, zIndex: 2 },
  headNum: { fontWeight: 700, fontSize: 14, color: "#1a1a2e" },
  headMeta:{ marginTop: 4, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" },
  pill:    { padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600 },
  appHint: { fontSize: 11, color: "#666" },

  summaryCell: { padding: "14px 16px", background: "#faf5ff",
                 borderBottom: "1px solid #e9d5ff", position: "sticky", top: 48,
                 zIndex: 1 },
  summaryLabel: { fontSize: 11, fontWeight: 700, color: "#6b21a8",
                  textTransform: "uppercase", letterSpacing: ".06em",
                  marginBottom: 6 },
  summaryText:  { fontSize: 13, color: "#333", lineHeight: 1.55, whiteSpace: "pre-wrap" },

  claimCell: { padding: "12px 14px", borderBottom: "1px solid #f0f0f0",
               verticalAlign: "top", minWidth: 320, maxWidth: 420 },
  claimNum:  { fontSize: 11, fontWeight: 700, color: "#1a73e8",
               textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 },
  claimText: { fontSize: 12, color: "#1a1a2e", whiteSpace: "pre-wrap", lineHeight: 1.5 },

  emptySection: { marginTop: 14, padding: "14px 16px", background: "#fff8e1",
                  borderRadius: 10, border: "1px solid #ffe0b2" },
  emptySectionTitle: { fontSize: 13, fontWeight: 700, color: "#e65100", marginBottom: 4 },
  emptySectionHint: { fontSize: 12, color: "#666", marginBottom: 8 },
  emptyList: { display: "flex", flexWrap: "wrap", gap: 8 },
  emptyChip: { display: "inline-flex", alignItems: "center", padding: "4px 10px",
               background: "#fff", borderRadius: 6, border: "1px solid #e0e0e0",
               fontSize: 12, fontWeight: 600, color: "#333" },
  retryBox: { marginTop: 14, padding: "16px 20px", background: "#e3f2fd",
              borderRadius: 10, border: "1px solid #90caf9",
              fontSize: 13, color: "#1565c0", textAlign: "center" },
};
