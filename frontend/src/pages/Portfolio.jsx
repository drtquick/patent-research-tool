import { useEffect, useState, useRef } from "react";
import { api } from "../api";
import PrintBar from "../PrintBar";

const STATUS_COLORS = {
  granted:   "#2e7d32",
  pending:   "#f57c00",
  rejected:  "#c62828",
  abandoned: "#757575",
  expired:   "#795548",
  unknown:   "#9e9e9e",
};

const FLAG = {
  US: "🇺🇸", WO: "🌍", EP: "🇪🇺", CN: "🇨🇳", JP: "🇯🇵",
  KR: "🇰🇷", AU: "🇦🇺", CA: "🇨🇦", GB: "🇬🇧", DE: "🇩🇪",
  FR: "🇫🇷", IT: "🇮🇹", ES: "🇪🇸", IN: "🇮🇳", BR: "🇧🇷",
  MX: "🇲🇽", RU: "🇷🇺", SE: "🇸🇪", NL: "🇳🇱", CH: "🇨🇭",
  IL: "🇮🇱", ZA: "🇿🇦", SG: "🇸🇬", NZ: "🇳🇿", AT: "🇦🇹",
  BE: "🇧🇪", PL: "🇵🇱", FI: "🇫🇮", NO: "🇳🇴", DK: "🇩🇰",
  PT: "🇵🇹", HU: "🇭🇺", CZ: "🇨🇿", RO: "🇷🇴", TR: "🇹🇷",
  UA: "🇺🇦", MY: "🇲🇾", TW: "🇹🇼", AR: "🇦🇷", CL: "🇨🇱",
  CO: "🇨🇴", EG: "🇪🇬", MA: "🇲🇦", SA: "🇸🇦", AE: "🇦🇪",
};

const STATUS_LEGEND = [
  { key: "granted",   label: "Granted",   color: "#2e7d32" },
  { key: "pending",   label: "Pending",   color: "#f57c00" },
  { key: "abandoned", label: "Abandoned", color: "#757575" },
  { key: "expired",   label: "Expired",   color: "#795548" },
  { key: "rejected",  label: "Rejected",  color: "#c62828" },
  { key: "unknown",   label: "Unknown",   color: "#9e9e9e" },
];

export default function Portfolio() {
  const [patents, setPatents]             = useState([]);
  const [loading, setLoading]             = useState(true);
  const [error,   setError]               = useState("");
  const [viewing, setViewing]             = useState(null);
  const [viewLoading, setViewLoading]     = useState(false);
  const [viewingNumber, setViewingNumber] = useState(null);
  const iframeRef                         = useRef(null);

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

  async function handleView(patentNumber) {
    setViewLoading(true);
    setViewingNumber(patentNumber);
    try {
      const data = await api.search(patentNumber);
      setViewing(data);
    } catch (err) {
      alert(err.message);
      setViewingNumber(null);
    } finally {
      setViewLoading(false);
    }
  }

  async function handleDelete(id, patentNumber) {
    if (!confirm("Remove this patent from your portfolio?")) return;
    try {
      await api.deletePortfolio(id);
      setPatents((prev) => prev.filter((p) => p.id !== id));
      if (viewingNumber === patentNumber) { setViewing(null); setViewingNumber(null); }
    } catch (err) {
      alert(err.message);
    }
  }

  // Full-page loading overlay while fresh search runs (30-60s)
  if (viewLoading) {
    return (
      <div style={styles.page}>
        <div style={styles.loadingOverlay}>
          <div style={styles.spinner} />
          <p style={styles.loadingText}>
            Generating fresh dashboard for <strong>{viewingNumber}</strong>…
          </p>
          <p style={styles.loadingSubtext}>This may take 30–60 seconds</p>
        </div>
      </div>
    );
  }

  if (viewing) {
    return (
      <div style={styles.page}>
        <div style={styles.dashHeader}>
          <button
            style={styles.backBtn}
            onClick={() => { setViewing(null); setViewingNumber(null); }}
          >
            ← Back to Portfolio
          </button>
        </div>
        <div style={styles.iframeWrap}>
          <iframe
            ref={iframeRef}
            title="Patent Dashboard"
            style={styles.iframe}
            srcDoc={viewing.dashboard_html}
            sandbox="allow-scripts allow-same-origin"
          />
          <PrintBar iframeRef={iframeRef} />
        </div>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <h2 style={styles.heading}>My Portfolio</h2>

      {/* Status color legend */}
      <div style={styles.legend}>
        <span style={styles.legendTitle}>Status:</span>
        {STATUS_LEGEND.map(({ key, label, color }) => (
          <span key={key} style={styles.legendItem}>
            <span style={{ ...styles.legendDot, background: color }} />
            {label}
          </span>
        ))}
      </div>

      {loading && <p style={{ color: "#666" }}>Loading…</p>}
      {error   && <div style={styles.error}>{error}</div>}
      {!loading && patents.length === 0 && (
        <div style={styles.empty}>
          No patents saved yet. Use the search bar above to find a patent and save it.
        </div>
      )}

      <div style={styles.grid}>
        {patents.map((p) => {
          const family = p.family || [];
          const countryMap = new Map();
          for (const m of family) {
            const cc = m.country || "??";
            if (!countryMap.has(cc)) countryMap.set(cc, m.status || "unknown");
          }
          const countries = Array.from(countryMap.entries());

          return (
            <div key={p.id} style={styles.card}>
              <div style={styles.cardHeader}>
                <span style={styles.number}>{p.patent_number}</span>
                <span style={{ ...styles.badge, background: "#e3f2fd", color: "#1565c0" }}>
                  {p.family_size || "?"} members
                </span>
              </div>
              <p style={styles.title}>{p.title || "—"}</p>
              <div style={styles.jurisdictions}>
                {countries.map(([cc, st], i) => {
                  const flag = FLAG[cc] || "";
                  const bg   = STATUS_COLORS[st] || STATUS_COLORS.unknown;
                  return (
                    <span key={i} title={`${cc}: ${st}`} style={{ ...styles.cc, background: bg }}>
                      {flag || cc}
                    </span>
                  );
                })}
              </div>
              <div style={styles.cardActions}>
                <button style={styles.viewBtn} onClick={() => handleView(p.patent_number)}>
                  View Dashboard
                </button>
                <button style={styles.deleteBtn} onClick={() => handleDelete(p.id, p.patent_number)}>
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles = {
  page:    { padding: "2rem", maxWidth: 1100, margin: "0 auto" },
  heading: { marginTop: 0, color: "#1a1a2e" },
  legend:  { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14,
    padding: "10px 16px", background: "#f8f9fa", borderRadius: 8,
    border: "1px solid #e0e0e0", marginBottom: 20, fontSize: 13 },
  legendTitle: { fontWeight: 700, color: "#444", marginRight: 4 },
  legendItem:  { display: "flex", alignItems: "center", gap: 5, color: "#555" },
  legendDot:   { width: 12, height: 12, borderRadius: 3, flexShrink: 0 },
  error:   { padding: "12px 16px", background: "#fdecea", borderRadius: 8,
    color: "#d32f2f", marginBottom: 16 },
  empty:   { padding: "2rem", textAlign: "center", color: "#888",
    background: "#f8f9fa", borderRadius: 10, border: "1px dashed #ddd" },
  grid:    { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 16 },
  card:    { background: "#fff", borderRadius: 10, padding: "1.2rem",
    border: "1px solid #e0e0e0", boxShadow: "0 2px 6px rgba(0,0,0,.05)" },
  cardHeader:  { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  number:  { fontWeight: 700, color: "#1a73e8", fontSize: 15 },
  badge:   { fontSize: 12, padding: "2px 8px", borderRadius: 12, fontWeight: 600 },
  title:   { margin: "0 0 10px", fontSize: 13, color: "#444", lineHeight: 1.4,
    maxHeight: 38, overflow: "hidden" },
  jurisdictions: { display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 12 },
  cc:      { padding: "3px 7px", borderRadius: 4, color: "#fff",
    fontSize: 13, fontWeight: 600, lineHeight: 1 },
  cardActions: { display: "flex", gap: 8, marginTop: 4 },
  viewBtn:   { flex: 1, padding: "8px", borderRadius: 8, background: "#1a73e8",
    color: "#fff", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600 },
  deleteBtn: { padding: "8px 14px", borderRadius: 8, background: "#fff",
    color: "#d32f2f", border: "1px solid #f5c6cb", cursor: "pointer", fontSize: 13 },
  dashHeader:  { marginBottom: 12 },
  backBtn:     { padding: "8px 16px", borderRadius: 8, background: "#f0f4f8",
    border: "1px solid #d0d7de", cursor: "pointer", fontSize: 14 },
  iframeWrap:  { border: "1px solid #e0e0e0", borderRadius: 10, overflow: "hidden" },
  iframe:      { width: "100%", height: "85vh", border: "none", display: "block" },
  loadingOverlay: { display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "center", minHeight: "60vh", gap: 20 },
  spinner: { width: 48, height: 48, border: "5px solid #e0e0e0",
    borderTop: "5px solid #1a73e8", borderRadius: "50%",
    animation: "spin 1s linear infinite" },
  loadingText:    { fontSize: 18, color: "#1a1a2e", margin: 0, textAlign: "center" },
  loadingSubtext: { fontSize: 14, color: "#888", margin: 0 },
};
