import { useEffect, useState } from "react";
import { api } from "../api";

const STATUS_COLORS = {
  granted: "#2e7d32", pending: "#f57c00", rejected: "#c62828",
  abandoned: "#757575", unknown: "#9e9e9e",
};

export default function Portfolio() {
  const [patents, setPatents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [viewing, setViewing] = useState(null); // full patent with dashboard_html
  const [viewLoading, setViewLoading] = useState(false);

  useEffect(() => { fetchPortfolio(); }, []);

  async function fetchPortfolio() {
    setLoading(true);
    try {
      const data = await api.listPortfolios();
      setPatents(data.portfolios || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleView(id) {
    setViewLoading(true);
    try {
      const data = await api.getPortfolio(id);
      setViewing(data);
    } catch (err) {
      alert(err.message);
    } finally {
      setViewLoading(false);
    }
  }

  async function handleDelete(id) {
    if (!confirm("Remove this patent from your portfolio?")) return;
    try {
      await api.deletePortfolio(id);
      setPatents((prev) => prev.filter((p) => p.id !== id));
      if (viewing?.id === id) setViewing(null);
    } catch (err) {
      alert(err.message);
    }
  }

  if (viewing) {
    return (
      <div style={styles.page}>
        <button style={styles.backBtn} onClick={() => setViewing(null)}>
          ← Back to Portfolio
        </button>
        <iframe
          title="Patent Dashboard"
          style={styles.iframe}
          srcDoc={viewing.dashboard_html}
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <h2 style={styles.heading}>My Portfolio</h2>
      {loading && <p style={{ color: "#666" }}>Loading…</p>}
      {error && <div style={styles.error}>{error}</div>}
      {!loading && patents.length === 0 && (
        <div style={styles.empty}>
          No patents saved yet. Use Search to find a patent and save it.
        </div>
      )}
      <div style={styles.grid}>
        {patents.map((p) => (
          <div key={p.id} style={styles.card}>
            <div style={styles.cardHeader}>
              <span style={styles.number}>{p.patent_number}</span>
              <span style={{ ...styles.badge, background: "#e3f2fd", color: "#1565c0" }}>
                {p.family_size || "?"} members
              </span>
            </div>
            <p style={styles.title}>{p.title || "—"}</p>
            <div style={styles.jurisdictions}>
              {(p.family || []).slice(0, 8).map((m, i) => (
                <span
                  key={i}
                  style={{
                    ...styles.cc,
                    background: STATUS_COLORS[m.status] || "#9e9e9e",
                  }}
                  title={`${m.country}: ${m.status}`}
                >
                  {m.country}
                </span>
              ))}
              {(p.family || []).length > 8 && (
                <span style={{ fontSize: 12, color: "#999" }}>
                  +{p.family.length - 8} more
                </span>
              )}
            </div>
            <div style={styles.cardActions}>
              <button
                style={styles.viewBtn}
                onClick={() => handleView(p.id)}
                disabled={viewLoading}
              >
                View Dashboard
              </button>
              <button style={styles.deleteBtn} onClick={() => handleDelete(p.id)}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const styles = {
  page: { padding: "2rem", maxWidth: 1100, margin: "0 auto" },
  heading: { marginTop: 0, color: "#1a1a2e" },
  error: { padding: "12px 16px", background: "#fdecea", borderRadius: 8,
    color: "#d32f2f", marginBottom: 16 },
  empty: { padding: "2rem", textAlign: "center", color: "#888",
    background: "#f8f9fa", borderRadius: 10, border: "1px dashed #ddd" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
    gap: 16 },
  card: { background: "#fff", borderRadius: 10, padding: "1.2rem",
    border: "1px solid #e0e0e0", boxShadow: "0 2px 6px rgba(0,0,0,.05)" },
  cardHeader: { display: "flex", justifyContent: "space-between",
    alignItems: "center", marginBottom: 6 },
  number: { fontWeight: 700, color: "#1a73e8", fontSize: 15 },
  badge: { fontSize: 12, padding: "2px 8px", borderRadius: 12, fontWeight: 600 },
  title: { margin: "0 0 10px", fontSize: 13, color: "#444",
    lineHeight: 1.4, maxHeight: 38, overflow: "hidden" },
  jurisdictions: { display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 12 },
  cc: { padding: "2px 7px", borderRadius: 4, color: "#fff", fontSize: 11, fontWeight: 700 },
  cardActions: { display: "flex", gap: 8, marginTop: 4 },
  viewBtn: { flex: 1, padding: "8px", borderRadius: 8, background: "#1a73e8",
    color: "#fff", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600 },
  deleteBtn: { padding: "8px 14px", borderRadius: 8, background: "#fff",
    color: "#d32f2f", border: "1px solid #f5c6cb", cursor: "pointer", fontSize: 13 },
  backBtn: { marginBottom: 16, padding: "8px 16px", borderRadius: 8,
    background: "#f0f4f8", border: "1px solid #d0d7de", cursor: "pointer", fontSize: 14 },
  iframe: { width: "100%", height: "88vh", border: "none", display: "block",
    borderRadius: 8, border: "1px solid #e0e0e0" },
};
