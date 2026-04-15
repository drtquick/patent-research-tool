import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";

/**
 * Portfolio-wide analytics dashboard. All charts are rendered with inline
 * SVG — no chart library dependency — to keep the bundle lean.
 */
export default function Analytics() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.getAnalytics()
      .then((d) => { if (alive) setData(d); })
      .catch((err) => { if (alive) setError(err.message || "Failed to load"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  if (loading) return <div style={s.page}><div style={s.loading}>Loading analytics…</div></div>;
  if (error)   return <div style={s.page}><div style={s.error}>{error}</div></div>;
  if (!data)   return null;

  const totalMembers = data.totals.members || 0;
  const status = data.status || {};

  return (
    <div style={s.page}>
      <h2 style={s.heading}>Portfolio Analytics</h2>

      {/* Top stat band */}
      <div style={s.statBand}>
        <Stat label="Families"        value={data.totals.families} color="#1a73e8" />
        <Stat label="Members"         value={totalMembers}          color="#1a1a2e" />
        <Stat label="Granted"         value={status.granted || 0}   color="#2e7d32" />
        <Stat label="Pending"         value={status.pending || 0}   color="#1565c0" />
        <Stat label="Abandoned"       value={status.abandoned || 0} color="#757575" />
      </div>

      {/* Deadline pressure */}
      <Card title="Deadline Pressure">
        <div style={s.windowRow}>
          <DeadlineBucket label="Overdue"    n={data.deadline_windows.overdue} color="#c62828" />
          <DeadlineBucket label="≤ 30 days"  n={data.deadline_windows["30"]}  color="#f57c00" />
          <DeadlineBucket label="31–60 days" n={data.deadline_windows["60"]}  color="#f9a825" />
          <DeadlineBucket label="61–90 days" n={data.deadline_windows["90"]}  color="#1976d2" />
        </div>
        <div style={{ marginTop: 18 }}>
          <div style={s.subLabel}>Next 25 upcoming deadlines</div>
          {data.upcoming.length === 0 ? (
            <div style={s.empty}>No upcoming deadlines on record.</div>
          ) : (
            <div style={s.upcomingList}>
              {data.upcoming.map((u, i) => (
                <div key={i}
                     style={s.upcomingRow}
                     onClick={() => navigate(`/portfolio?open=${encodeURIComponent(u.portfolio_id)}`)}
                >
                  <span style={{ ...s.pill, ...dayPill(u.days_out) }}>
                    {u.days_out < 0 ? `${-u.days_out}d late`
                      : `${u.days_out}d`}
                  </span>
                  <span style={s.upDate}>{u.date}</span>
                  <span style={s.upCountry}>{u.country}</span>
                  <span style={s.upPub}>{u.pub_num}</span>
                  <span style={s.upLabel}>{u.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* Jurisdictions */}
      <Card title="Jurisdictions">
        <HorizontalBars
          rows={(data.jurisdictions || []).map((j) => ({
            label: j.country || "??",
            value: j.count,
          }))}
          color="#1a73e8"
        />
      </Card>

      {/* Top assignees */}
      <Card title="Top Assignees (by families owned)">
        {(data.assignees || []).length === 0 ? (
          <div style={s.empty}>No assignees recorded in cached family data.</div>
        ) : (
          <HorizontalBars
            rows={data.assignees.map((a) => ({ label: a.name, value: a.family_count }))}
            color="#6a1b9a"
          />
        )}
      </Card>

      {/* Fee burden projection */}
      <Card title="Projected Fee Burden by Year">
        {(data.fee_burden || []).length === 0 ? (
          <div style={s.empty}>No projected fees to display.</div>
        ) : (
          <FeeBurdenChart rows={data.fee_burden} />
        )}
      </Card>
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div style={s.card}>
      <div style={s.cardTitle}>{title}</div>
      <div>{children}</div>
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div style={s.stat}>
      <div style={{ ...s.statValue, color }}>{value}</div>
      <div style={s.statLabel}>{label}</div>
    </div>
  );
}

function DeadlineBucket({ label, n, color }) {
  return (
    <div style={{ ...s.bucket, borderTop: `4px solid ${color}` }}>
      <div style={{ fontSize: 30, fontWeight: 800, color }}>{n}</div>
      <div style={{ fontSize: 12, color: "#555", marginTop: 2 }}>{label}</div>
    </div>
  );
}

function HorizontalBars({ rows, color }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div>
      {rows.slice(0, 12).map((r, i) => (
        <div key={i} style={s.barRow}>
          <div style={s.barLabel} title={r.label}>{r.label}</div>
          <div style={s.barTrack}>
            <div style={{ ...s.barFill, width: `${(r.value / max) * 100}%`, background: color }} />
          </div>
          <div style={s.barValue}>{r.value}</div>
        </div>
      ))}
    </div>
  );
}

function FeeBurdenChart({ rows }) {
  if (!rows || rows.length === 0) return null;
  const W = 640, H = 200, PAD_L = 48, PAD_R = 20, PAD_T = 20, PAD_B = 36;
  const max = Math.max(1, ...rows.map((r) => r.amount_usd));
  const xStep = rows.length > 1 ? (W - PAD_L - PAD_R) / (rows.length - 1) : 0;
  const yOf = (v) => PAD_T + (1 - v / max) * (H - PAD_T - PAD_B);

  const pts = rows.map((r, i) => ({ x: PAD_L + i * xStep, y: yOf(r.amount_usd), ...r }));
  const path = pts.map((p, i) => (i === 0 ? "M" : "L") + p.x + "," + p.y).join(" ");

  // Y ticks (4)
  const ticks = [];
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    ticks.push({ v, y: yOf(v) });
  }

  return (
    <svg width={W} height={H}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={PAD_L} y1={t.y} x2={W - PAD_R} y2={t.y} stroke="#f0f0f0" />
          <text x={PAD_L - 8} y={t.y + 3} fontSize="10" fill="#888" textAnchor="end">
            ${Math.round(t.v).toLocaleString()}
          </text>
        </g>
      ))}
      <path d={path} stroke="#1a73e8" strokeWidth="2" fill="none" />
      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r="3" fill="#1a73e8" />
          <text x={p.x} y={H - PAD_B + 14} fontSize="10" fill="#555" textAnchor="middle">{p.year}</text>
          <text x={p.x} y={p.y - 8} fontSize="10" fill="#1a73e8" textAnchor="middle" fontWeight="700">
            ${Math.round(p.amount_usd).toLocaleString()}
          </text>
        </g>
      ))}
    </svg>
  );
}

function dayPill(d) {
  if (d < 0)   return { background: "#fdecea", color: "#c62828" };
  if (d <= 30) return { background: "#fff3e0", color: "#e65100" };
  if (d <= 60) return { background: "#fff8e1", color: "#8d6e00" };
  return { background: "#e8f0fe", color: "#1565c0" };
}

const s = {
  page:    { padding: "1.5rem", maxWidth: 1100, margin: "0 auto" },
  loading: { padding: 40, textAlign: "center", color: "#666" },
  error:   { padding: 14, background: "#fdecea", color: "#c62828", borderRadius: 8 },
  heading: { marginTop: 0, marginBottom: 16, color: "#1a1a2e" },
  empty:   { padding: "14px 10px", textAlign: "center", color: "#aaa",
             fontStyle: "italic", fontSize: 13 },

  statBand:{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
             gap: 10, marginBottom: 16 },
  stat:    { background: "#fff", border: "1px solid #e0e0e0", borderRadius: 10,
             padding: "14px 16px" },
  statValue: { fontSize: 28, fontWeight: 800, letterSpacing: "-0.02em" },
  statLabel: { fontSize: 12, color: "#666", marginTop: 2,
               textTransform: "uppercase", letterSpacing: ".08em" },

  card:    { background: "#fff", border: "1px solid #e0e0e0", borderRadius: 12,
             padding: 18, marginBottom: 16 },
  cardTitle: { fontSize: 14, fontWeight: 700, color: "#1a1a2e", marginBottom: 14 },

  windowRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
               gap: 10 },
  bucket:    { background: "#fafbfd", borderRadius: 8, padding: "16px 18px",
               textAlign: "center" },
  subLabel:  { fontSize: 12, color: "#666", textTransform: "uppercase",
               letterSpacing: ".06em", marginBottom: 6, fontWeight: 700 },

  upcomingList: { display: "flex", flexDirection: "column", gap: 2 },
  upcomingRow:  { display: "grid",
               gridTemplateColumns: "72px 100px 36px 180px 1fr",
               gap: 10, padding: "8px 10px", borderRadius: 6,
               cursor: "pointer", fontSize: 12, alignItems: "center",
               transition: "background 0.15s" },
  pill:        { padding: "2px 8px", borderRadius: 10, fontSize: 11,
                 fontWeight: 700, textAlign: "center" },
  upDate:      { color: "#555", fontFamily: "monospace" },
  upCountry:   { color: "#777", fontWeight: 600 },
  upPub:       { color: "#1a73e8", fontWeight: 600 },
  upLabel:     { color: "#1a1a2e", overflow: "hidden",
                 textOverflow: "ellipsis", whiteSpace: "nowrap" },

  barRow:   { display: "grid", gridTemplateColumns: "180px 1fr 60px",
              gap: 10, alignItems: "center", marginBottom: 6, fontSize: 12 },
  barLabel: { color: "#555", overflow: "hidden", textOverflow: "ellipsis",
              whiteSpace: "nowrap" },
  barTrack: { height: 14, background: "#eef2f7", borderRadius: 7, overflow: "hidden" },
  barFill:  { height: "100%", borderRadius: 7, transition: "width 0.3s" },
  barValue: { fontWeight: 700, color: "#1a1a2e", textAlign: "right" },
};
