import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import PrintBar from "../PrintBar";

export default function Search() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const ranQuery  = useRef(null);
  const iframeRef = useRef(null);

  // Run search whenever ?q= param changes (including on first load)
  useEffect(() => {
    const q = searchParams.get("q") || "";
    if (!q.trim() || q === ranQuery.current) return;
    ranQuery.current = q;
    runSearch(q.trim());
  }, [searchParams]);

  async function runSearch(q) {
    setError(""); setResult(null); setSaved(false);
    setLoading(true);
    try {
      const data = await api.search(q);
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!result) return;
    setSaving(true);
    try {
      await api.savePortfolio(result);
      setSaved(true);
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  const currentQuery = searchParams.get("q") || "";

  return (
    <div style={styles.page}>
      {/* Prompt when no query yet */}
      {!currentQuery && !loading && !result && (
        <div style={styles.empty}>
          Enter a patent number in the search bar above to get started.
          <div style={styles.hint}>e.g. US12178560 · EP1234567 · WO2021133786</div>
        </div>
      )}

      {loading && (
        <div style={styles.loadingWrap}>
          <div style={styles.spinner} />
          <span style={styles.loadingText}>
            Fetching family data for <strong>{currentQuery}</strong>…
            <br /><span style={styles.loadingSub}>This usually takes 20–60 seconds</span>
          </span>
        </div>
      )}

      {error && <div style={styles.error}>{error}</div>}

      {result && (
        <div style={styles.resultWrap}>
          <div style={styles.resultHeader}>
            <div>
              <strong>{result.patent_number}</strong> — {result.title}
              <div style={styles.meta}>
                {result.family_size} family members · {result.jurisdictions} jurisdictions ·{" "}
                {result.granted_count} granted · {result.pending_count} pending
              </div>
            </div>
            <button
              style={saved ? styles.savedBtn : styles.saveBtn}
              onClick={handleSave}
              disabled={saving || saved}
            >
              {saved ? "✓ Saved to Portfolio" : saving ? "Saving…" : "Save to Portfolio"}
            </button>
          </div>
          <iframe
            ref={iframeRef}
            title="Patent Dashboard"
            style={styles.iframe}
            srcDoc={result.dashboard_html}
            sandbox="allow-scripts allow-same-origin"
          />
          <PrintBar iframeRef={iframeRef} />
        </div>
      )}
    </div>
  );
}

const styles = {
  page: { padding: "1.5rem", maxWidth: 1200, margin: "0 auto" },
  empty: {
    marginTop: "6rem", textAlign: "center", color: "#888",
    fontSize: 16,
  },
  hint: { marginTop: 8, fontSize: 13, color: "#aaa", fontFamily: "monospace" },
  loadingWrap: {
    display: "flex", alignItems: "center", gap: 16,
    padding: "2rem", background: "#f8f9fa", borderRadius: 10,
    border: "1px dashed #ddd", marginTop: "2rem",
  },
  spinner: {
    width: 28, height: 28, borderRadius: "50%",
    border: "3px solid #e0e0e0", borderTopColor: "#1a73e8",
    animation: "spin 0.8s linear infinite", flexShrink: 0,
  },
  loadingText: { color: "#444", fontSize: 15, lineHeight: 1.6 },
  loadingSub: { fontSize: 12, color: "#888" },
  error: {
    padding: "12px 16px", background: "#fdecea", borderRadius: 8,
    color: "#d32f2f", marginTop: 16,
  },
  resultWrap: { border: "1px solid #e0e0e0", borderRadius: 10, overflow: "hidden", marginTop: 4 },
  resultHeader: {
    display: "flex", justifyContent: "space-between",
    alignItems: "flex-start", padding: "14px 18px", background: "#f8f9fa",
    borderBottom: "1px solid #e0e0e0", gap: 12,
  },
  meta: { fontSize: 13, color: "#666", marginTop: 4 },
  saveBtn: {
    padding: "8px 18px", borderRadius: 8, background: "#34a853",
    color: "#fff", border: "none", cursor: "pointer", fontWeight: 600,
    whiteSpace: "nowrap", fontSize: 14,
  },
  savedBtn: {
    padding: "8px 18px", borderRadius: 8, background: "#e8f5e9",
    color: "#2e7d32", border: "1px solid #a5d6a7", fontWeight: 600,
    whiteSpace: "nowrap", fontSize: 14, cursor: "default",
  },
  iframe: { width: "100%", height: "85vh", border: "none", display: "block" },
};
