import { useEffect, useState } from "react";
import { api } from "../api";

const URGENCY = (daysLeft) => {
  if (daysLeft < 0) return { color: "#c62828", label: "OVERDUE" };
  if (daysLeft <= 30) return { color: "#d32f2f", label: `${daysLeft}d` };
  if (daysLeft <= 60) return { color: "#f57c00", label: `${daysLeft}d` };
  if (daysLeft <= 90) return { color: "#f9a825", label: `${daysLeft}d` };
  return { color: "#388e3c", label: `${daysLeft}d` };
};

function daysUntil(iso) {
  if (!iso) return null;
  const diff = new Date(iso) - new Date();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

export default function Alerts() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState(90);

  useEffect(() => { fetchAlerts(); }, [filter]);

  async function fetchAlerts() {
    setLoading(true);
    try {
      const data = await api.getAlerts(filter);
      setAlerts(data.alerts || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.page}>
      <div style={styles.headerRow}>
        <h2 style={styles.heading}>Deadline Alerts</h2>
        <div style={styles.filterGroup}>
          <label style={styles.filterLabel}>Show next</label>
          {[30, 60, 90, 180, 365].map((d) => (
            <button
              key={d}
              style={filter === d ? styles.filterActive : styles.filterBtn}
              onClick={() => setFilter(d)}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {loading && <p style={{ color: "#666" }}>Loading deadlines…</p>}
      {error && <div style={styles.error}>{error}</div>}

      {!loading && alerts.length === 0 && (
        <div style={styles.empty}>
          No deadlines in the next {filter} days across your portfolio.
        </div>
      )}

      <div style={styles.tableWrap}>
        {alerts.length > 0 && (
          <table style={styles.table}>
            <thead>
              <tr style={styles.thead}>
                <th style={styles.th}>Due</th>
                <th style={styles.th}>Days</th>
                <th style={styles.th}>Patent</th>
                <th style={styles.th}>Country</th>
                <th style={styles.th}>Type</th>
                <th style={styles.th}>Fee (USD)</th>
                <th style={styles.th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map((a, i) => {
                const days = daysUntil(a.due_date);
                const urg = URGENCY(days ?? 999);
                return (
                  <tr key={i} style={i % 2 === 0 ? styles.trEven : styles.trOdd}>
                    <td style={styles.td}>{a.due_date?.slice(0, 10) || "—"}</td>
                    <td style={{ ...styles.td, color: urg.color, fontWeight: 700 }}>
                      {urg.label}
                    </td>
                    <td style={styles.td}>
                      <div style={{ fontWeight: 600 }}>{a.patent_number}</div>
                      <div style={{ fontSize: 12, color: "#666", maxWidth: 220,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {a.title}
                      </div>
                    </td>
                    <td style={{ ...styles.td, fontWeight: 700 }}>{a.country}</td>
                    <td style={styles.td}>{a.label}</td>
                    <td style={styles.td}>
                      {a.amount_usd != null ? `$${a.amount_usd.toLocaleString()}` : "—"}
                      {a.amount_local != null && a.currency !== "USD" && (
                        <div style={{ fontSize: 11, color: "#888" }}>
                          {a.currency} {a.amount_local?.toLocaleString()}
                        </div>
                      )}
                    </td>
                    <td style={styles.td}>
                      <span style={{
                        ...styles.statusBadge,
                        background: a.status === "current" ? "#fff3e0" : "#e8f5e9",
                        color: a.status === "current" ? "#e65100" : "#2e7d32",
                      }}>
                        {a.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {alerts.length > 0 && (
        <div style={styles.summary}>
          <strong>Total fees due in next {filter} days: </strong>
          ${alerts.reduce((s, a) => s + (a.amount_usd || 0), 0).toLocaleString()} USD
          across {alerts.length} deadline{alerts.length !== 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}

const styles = {
  page: { padding: "2rem", maxWidth: 1100, margin: "0 auto" },
  headerRow: { display: "flex", justifyContent: "space-between",
    alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 8 },
  heading: { marginTop: 0, color: "#1a1a2e" },
  filterGroup: { display: "flex", alignItems: "center", gap: 6 },
  filterLabel: { fontSize: 13, color: "#666", marginRight: 4 },
  filterBtn: { padding: "4px 12px", borderRadius: 16, border: "1px solid #d0d7de",
    background: "#fff", cursor: "pointer", fontSize: 13 },
  filterActive: { padding: "4px 12px", borderRadius: 16, border: "none",
    background: "#1a73e8", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 700 },
  error: { padding: "12px 16px", background: "#fdecea", borderRadius: 8,
    color: "#d32f2f", marginBottom: 16 },
  empty: { padding: "2rem", textAlign: "center", color: "#888",
    background: "#f8f9fa", borderRadius: 10, border: "1px dashed #ddd" },
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 },
  thead: { background: "#1a1a2e", color: "#fff" },
  th: { padding: "10px 14px", textAlign: "left", fontWeight: 600,
    whiteSpace: "nowrap" },
  td: { padding: "10px 14px", verticalAlign: "middle" },
  trEven: { background: "#fff" },
  trOdd: { background: "#f8f9fa" },
  statusBadge: { padding: "2px 8px", borderRadius: 10, fontSize: 12, fontWeight: 600 },
  summary: { marginTop: 16, padding: "12px 16px", background: "#e3f2fd",
    borderRadius: 8, color: "#1565c0", fontSize: 14 },
};
