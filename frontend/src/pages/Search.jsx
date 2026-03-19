import { useState } from "react";
import { api } from "../api";

export default function Search() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSearch(e) {
    e.preventDefault();
    if (!query.trim()) return;
    setError(""); setResult(null); setSaved(false);
    setLoading(true);
    try {
      const data = await api.search(query.trim());
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

  return (
    <div style={styles.page}>
      <h2 style={styles.heading}>Search Patents</h2>
      <form onSubmit={handleSearch} style={styles.form}>
        <input
          style={styles.input}
          placeholder="Enter patent number (e.g. US 12,178,560)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button style={styles.btn} type="submit" disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

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
            title="Patent Dashboard"
            style={styles.iframe}
            srcDoc={result.dashboard_html}
            sandbox="allow-scripts allow-same-origin"
          />
        </div>
      )}
    </div>
  );
}

const styles = {
  page: { padding: "2rem", maxWidth: 1100, margin: "0 auto" },
  heading: { marginTop: 0, color: "#1a1a2e" },
  form: { display: "flex", gap: 10, marginBottom: 20 },
  input: { flex: 1, padding: "10px 14px", borderRadius: 8,
    border: "1px solid #d0d7de", fontSize: 15 },
  btn: { padding: "10px 22px", borderRadius: 8, background: "#1a73e8",
    color: "#fff", border: "none", fontSize: 15, cursor: "pointer", fontWeight: 600 },
  error: { padding: "12px 16px", background: "#fdecea", borderRadius: 8,
    color: "#d32f2f", marginBottom: 16 },
  resultWrap: { border: "1px solid #e0e0e0", borderRadius: 10, overflow: "hidden" },
  resultHeader: { display: "flex", justifyContent: "space-between",
    alignItems: "flex-start", padding: "14px 18px", background: "#f8f9fa",
    borderBottom: "1px solid #e0e0e0", gap: 12 },
  meta: { fontSize: 13, color: "#666", marginTop: 4 },
  saveBtn: { padding: "8px 18px", borderRadius: 8, background: "#34a853",
    color: "#fff", border: "none", cursor: "pointer", fontWeight: 600,
    whiteSpace: "nowrap", fontSize: 14 },
  savedBtn: { padding: "8px 18px", borderRadius: 8, background: "#e8f5e9",
    color: "#2e7d32", border: "1px solid #a5d6a7", fontWeight: 600,
    whiteSpace: "nowrap", fontSize: 14, cursor: "default" },
  iframe: { width: "100%", height: "85vh", border: "none", display: "block" },
};
