import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:5001";

/**
 * Family filing timeline + continuation diagram.  Each node is a US
 * application or patent placed horizontally so the CENTER of the tile
 * aligns with its filing date on the time axis.  Continuation edges
 * (CON / CIP / DIV / PRO) are drawn as curved arrows.  Node color
 * reflects status; provisional apps get a dashed border.
 *
 * Publication numbers link to the publication PDF; patent numbers link
 * to the patent PDF (both via the backend proxy).
 *
 * Print button renders the full SVG in landscape orientation, fitted
 * to the page width.
 */
export default function TimelineTab({ portfolioId }) {
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");
  const [data,    setData]    = useState(null);
  const svgRef = useRef(null);

  useEffect(() => {
    if (!portfolioId) return;
    let alive = true;
    setLoading(true);
    setError("");
    api.getPortfolioTimeline(portfolioId)
      .then((d) => { if (alive) setData(d); })
      .catch((err) => { if (alive) setError(err.message || "Failed to load timeline"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [portfolioId]);

  // ── Layout engine ────────────────────────────────────────────────
  const layout = useMemo(() => {
    if (!data) return null;
    const nodes = [...(data.nodes || [])];
    const edges = data.edges || [];
    if (nodes.length === 0)
      return { nodes: [], edges: [], width: 800, height: 200, tMin: 0, tMax: 0 };

    // Compute generation depth via BFS (Kahn topological)
    const incoming = new Map();
    const outgoing = new Map();
    nodes.forEach((n) => { incoming.set(n.app_num, 0); outgoing.set(n.app_num, []); });
    edges.forEach((e) => {
      if (incoming.has(e.from_app) && incoming.has(e.to_app)) {
        incoming.set(e.to_app, incoming.get(e.to_app) + 1);
        outgoing.get(e.from_app).push(e.to_app);
      }
    });
    const level = new Map();
    const queue = [];
    nodes.forEach((n) => {
      if (incoming.get(n.app_num) === 0) { level.set(n.app_num, 0); queue.push(n.app_num); }
    });
    while (queue.length) {
      const a = queue.shift();
      const lvl = level.get(a) + 1;
      (outgoing.get(a) || []).forEach((c) => {
        const cur = level.get(c);
        if (cur === undefined || cur < lvl) { level.set(c, lvl); queue.push(c); }
      });
    }

    // Time domain
    const parseDate = (s) => s ? new Date(s + "T00:00:00").getTime() : null;
    const times = nodes.map((n) => parseDate(n.filing_date)).filter(Boolean);
    const tMin = times.length ? Math.min(...times) : 0;
    const tMax = times.length ? Math.max(...times) : tMin + 365 * 86400000;

    // Sizing constants
    const NODE_W = 190, NODE_H = 82;
    const PAD_L = 110, PAD_R = 110;
    const H_PER_LEVEL = NODE_H + 50;
    const PAD_TOP = 40;

    // Calculate minimum width needed so tiles don't overlap at true-date positions.
    // We iterate: start with a base width, place tiles, check overlaps, expand if needed.
    let W = Math.max(1200, nodes.length * (NODE_W + 30) + PAD_L + PAD_R);
    const domain = tMax - tMin || 1;

    // Center-of-tile = date position on axis, so left edge = center - NODE_W/2
    const centerX = (n) => {
      const t = parseDate(n.filing_date);
      if (!t) return PAD_L + (W - PAD_L - PAD_R) / 2;
      return PAD_L + ((t - tMin) / domain) * (W - PAD_L - PAD_R);
    };

    // Place all nodes
    const sorted = [...nodes].sort((a, b) =>
      (level.get(a.app_num) ?? 0) - (level.get(b.app_num) ?? 0) ||
      (parseDate(a.filing_date) || 0) - (parseDate(b.filing_date) || 0)
    );

    let placed = sorted.map((n) => {
      const cx = centerX(n);
      const lvl = level.get(n.app_num) ?? 0;
      return { ...n, cx, x: cx - NODE_W / 2, y: PAD_TOP + lvl * H_PER_LEVEL, level: lvl };
    });

    // Nudge overlapping nodes within same level (minimal displacement from true date).
    // Push right only when tiles overlap, preserving left-to-right filing order.
    const maxLevel = Math.max(0, ...placed.map((p) => p.level));
    for (let lvl = 0; lvl <= maxLevel; lvl++) {
      const grp = placed.filter((p) => p.level === lvl).sort((a, b) => a.cx - b.cx);
      for (let i = 1; i < grp.length; i++) {
        const minX = grp[i - 1].x + NODE_W + 16;
        if (grp[i].x < minX) {
          grp[i].x = minX;
          grp[i].cx = grp[i].x + NODE_W / 2;
        }
      }
    }

    const height = PAD_TOP + (maxLevel + 1) * H_PER_LEVEL + 20;
    const maxX = Math.max(W, ...placed.map((p) => p.x + NODE_W + 20));

    return { nodes: placed, edges, width: maxX + PAD_R, height, tMin, tMax,
             NODE_W, NODE_H, PAD_L, PAD_R };
  }, [data]);

  // ── Print handler ────────────────────────────────────────────────
  function handlePrint() {
    const svg = svgRef.current;
    if (!svg) return;
    const svgData = new XMLSerializer().serializeToString(svg);
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(`<!DOCTYPE html>
<html><head><title>Patent Family Timeline</title>
<style>
  @page { size: landscape; margin: 0.4in; }
  @media print {
    body { margin: 0; }
    svg { width: 100% !important; height: auto !important; }
  }
  body { margin: 0; display: flex; align-items: center; justify-content: center;
         min-height: 100vh; background: #fff; }
  svg { width: 100%; height: auto; max-height: 100vh; }
</style></head><body>${svgData}</body></html>`);
    win.document.close();
    // Give the browser a moment to render, then trigger print
    setTimeout(() => { win.print(); }, 400);
  }

  if (loading) return <div style={s.loading}>Loading family timeline...</div>;
  if (error)   return <div style={s.error}>{error}</div>;
  if (!data || !layout || layout.nodes.length === 0) {
    return <div style={s.empty}>No US family members to plot.</div>;
  }

  const { nodes, edges, width, height, NODE_W, NODE_H, PAD_L, PAD_R } = layout;
  const nodeById = new Map(nodes.map((n) => [n.app_num, n]));

  // Year tick marks on the time axis
  const years = [];
  if (layout.tMin && layout.tMax) {
    const domain = layout.tMax - layout.tMin || 1;
    const axisW = width - PAD_L - PAD_R;
    const y0 = new Date(layout.tMin).getFullYear();
    const y1 = new Date(layout.tMax).getFullYear();
    for (let y = y0; y <= y1 + 1; y++) {
      const t = new Date(`${y}-01-01T00:00:00`).getTime();
      const x = PAD_L + ((t - layout.tMin) / domain) * axisW;
      if (x >= PAD_L - 10 && x <= width - PAD_R + 10) years.push({ y, x });
    }
  }

  return (
    <div style={s.wrap}>
      <div style={s.toolbar}>
        <div style={s.legend}>
          <LegendChip color="#2e7d32" label="Granted" />
          <LegendChip color="#1565c0" label="Pending" />
          <LegendChip color="#9e9e9e" label="Abandoned / Unknown" />
          <LegendChip color="#fff" border="#8b5cf6" label="Provisional (dashed)" />
          <span style={s.legendMeta}>CON=continuation, CIP=CIP, DIV=divisional, PRO=provisional</span>
        </div>
        <button onClick={handlePrint} style={s.printBtn} title="Print timeline in landscape orientation">
          🖨 Print
        </button>
      </div>
      <div style={s.scroller}>
        <svg ref={svgRef} width={width} height={height}
             style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 10 }}
             xmlns="http://www.w3.org/2000/svg">
          {/* Defs for link styling */}
          <defs>
            <marker id="arrowCON" markerWidth="8" markerHeight="6" refX="4" refY="3" orient="auto">
              <polygon points="0,0 8,3 0,6" fill="#1565c0" />
            </marker>
            <marker id="arrowCIP" markerWidth="8" markerHeight="6" refX="4" refY="3" orient="auto">
              <polygon points="0,0 8,3 0,6" fill="#6a1b9a" />
            </marker>
            <marker id="arrowDIV" markerWidth="8" markerHeight="6" refX="4" refY="3" orient="auto">
              <polygon points="0,0 8,3 0,6" fill="#00695c" />
            </marker>
            <marker id="arrowPRO" markerWidth="8" markerHeight="6" refX="4" refY="3" orient="auto">
              <polygon points="0,0 8,3 0,6" fill="#ef6c00" />
            </marker>
            <marker id="arrowDEF" markerWidth="8" markerHeight="6" refX="4" refY="3" orient="auto">
              <polygon points="0,0 8,3 0,6" fill="#555" />
            </marker>
          </defs>

          {/* Year axis */}
          {years.map((yr) => (
            <g key={yr.y}>
              <line x1={yr.x} y1={24} x2={yr.x} y2={height} stroke="#e8e8e8" strokeWidth="1" />
              <text x={yr.x} y={16} fontSize="11" fill="#999" textAnchor="middle" fontWeight="600">{yr.y}</text>
            </g>
          ))}

          {/* Edges (drawn before nodes so they appear behind) */}
          {edges.map((e, i) => {
            const a = nodeById.get(e.from_app);
            const b = nodeById.get(e.to_app);
            if (!a || !b) return null;
            const x1 = a.cx;
            const y1 = a.y + NODE_H;
            const x2 = b.cx;
            const y2 = b.y;
            const midY = (y1 + y2) / 2;
            const d = `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`;
            const color = relationColor(e.relation);
            const markerId = `arrow${({"CON":"CON","CIP":"CIP","DIV":"DIV","PRO":"PRO"})[e.relation] || "DEF"}`;
            return (
              <g key={i}>
                <path d={d} stroke={color} strokeWidth="1.8" fill="none" opacity="0.7"
                      markerEnd={`url(#${markerId})`} />
                <text x={(x1 + x2) / 2 + (x1 === x2 ? 0 : 0)} y={midY - 5}
                      fontSize="10" fill={color} textAnchor="middle" fontWeight="700">
                  {e.relation || ""}
                </text>
              </g>
            );
          })}

          {/* Nodes */}
          {nodes.map((n) => (
            <NodeCard key={n.app_num} node={n} w={NODE_W} h={NODE_H} />
          ))}
        </svg>
      </div>
    </div>
  );
}


// ── Node tile ────────────────────────────────────────────────────────
function NodeCard({ node, w, h }) {
  const c = statusColor(node.status, node.is_provisional);
  const dash = node.is_provisional ? "4 3" : "none";
  const x = node.x, y = node.y;

  // Build PDF URL for the publication number
  const pubClean = (node.pub_num || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const pdfUrl = pubClean ? `${API_BASE}/api/pdf/${pubClean}` : "";

  // For granted patents, the display is the formatted patent number.
  // For pending, display is the app number and we show pub_num separately.
  const isGranted = node.status === "granted";
  const isPending = node.status === "pending" || (node.status === "unknown" && !node.grant_date);

  // Format pub number for display: US20260059078A1 -> US 2026/0059078 A1
  const fmtPub = formatUsPub(node.pub_num || "");

  return (
    <g>
      {/* Drop shadow */}
      <rect x={x + 1} y={y + 2} width={w} height={h} rx={8} fill="rgba(0,0,0,0.06)" />
      {/* Card background */}
      <rect x={x} y={y} width={w} height={h} rx={8}
            fill={c.bg} stroke={c.border} strokeWidth="2" strokeDasharray={dash} />

      {/* Line 1: App/patent number */}
      {isGranted && pdfUrl ? (
        <a href={pdfUrl} target="_blank" rel="noopener">
          <text x={x + w / 2} y={y + 18} fontSize="13" fontWeight="700" fill={c.fg}
                textAnchor="middle" textDecoration="underline" style={{ cursor: "pointer" }}>
            {node.display}
          </text>
        </a>
      ) : (
        <text x={x + w / 2} y={y + 18} fontSize="13" fontWeight="700" fill={c.fg} textAnchor="middle">
          {node.display}
        </text>
      )}

      {/* Line 2: Publication number (pending apps) or app number (granted) */}
      {isPending && fmtPub && pdfUrl ? (
        <a href={pdfUrl} target="_blank" rel="noopener">
          <text x={x + w / 2} y={y + 32} fontSize="10" fill="#1a73e8" textAnchor="middle"
                textDecoration="underline" style={{ cursor: "pointer" }}>
            {fmtPub}
          </text>
        </a>
      ) : isPending && fmtPub ? (
        <text x={x + w / 2} y={y + 32} fontSize="10" fill="#666" textAnchor="middle">{fmtPub}</text>
      ) : isGranted && node.app_num ? (
        <text x={x + w / 2} y={y + 32} fontSize="10" fill="#666" textAnchor="middle">
          App: {formatApp(node.app_num)}
        </text>
      ) : null}

      {/* Line 3: Filed date */}
      <text x={x + w / 2} y={y + 48} fontSize="10" fill="#555" textAnchor="middle">
        Filed {node.filing_date || "\u2014"}
      </text>

      {/* Line 4: Grant date or status hint */}
      {node.grant_date ? (
        <text x={x + w / 2} y={y + 62} fontSize="10" fill="#555" textAnchor="middle">
          Granted {node.grant_date}
        </text>
      ) : !node.in_portfolio ? (
        <text x={x + w / 2} y={y + 62} fontSize="9" fill="#bbb" textAnchor="middle" fontStyle="italic">
          from continuity
        </text>
      ) : (
        <text x={x + w / 2} y={y + 62} fontSize="9" fill="#888" textAnchor="middle">
          {node.status === "pending" ? "pending" : node.status || ""}
        </text>
      )}

      {/* Thin date marker line from center to axis area */}
      <line x1={node.cx} y1={y + h} x2={node.cx} y2={y + h + 6}
            stroke={c.border} strokeWidth="1" opacity="0.4" />
    </g>
  );
}


// ── Helpers ──────────────────────────────────────────────────────────
function formatUsPub(pub) {
  const clean = (pub || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
  const m = clean.match(/^US(\d{4})(\d{7})([A-Z]\d?)$/);
  if (m) return `US ${m[1]}/${m[2]} ${m[3]}`;
  return "";
}

function formatApp(appNum) {
  const digits = (appNum || "").replace(/\D/g, "");
  if (digits.length === 8) return `${digits.slice(0, 2)}/${digits.slice(2, 5)},${digits.slice(5)}`;
  return appNum || "";
}

function LegendChip({ color, border, label }) {
  return (
    <span style={s.legendItem}>
      <span style={{ display: "inline-block", width: 12, height: 12, background: color,
                     border: `2px solid ${border || color}`, borderRadius: 3 }} />
      {label}
    </span>
  );
}

function statusColor(status, provisional) {
  if (provisional) return { bg: "#fff", border: "#8b5cf6", fg: "#5b21b6" };
  const map = {
    granted:   { bg: "#e8f5e9", border: "#2e7d32", fg: "#1b5e20" },
    pending:   { bg: "#e3f2fd", border: "#1565c0", fg: "#0d47a1" },
    abandoned: { bg: "#fafafa", border: "#9e9e9e", fg: "#616161" },
    unknown:   { bg: "#fafafa", border: "#9e9e9e", fg: "#616161" },
  };
  return map[status] || map.unknown;
}

function relationColor(relation) {
  const map = { CON: "#1565c0", CIP: "#6a1b9a", DIV: "#00695c", PRO: "#ef6c00" };
  return map[relation] || "#555";
}

const s = {
  wrap:    { padding: 16, background: "#fafbfd", minHeight: "60vh" },
  loading: { padding: 32, textAlign: "center", color: "#666" },
  error:   { padding: 14, background: "#fdecea", color: "#c62828", borderRadius: 8 },
  empty:   { padding: 32, textAlign: "center", color: "#888" },

  toolbar: { display: "flex", justifyContent: "space-between", alignItems: "flex-start",
             gap: 12, marginBottom: 12 },
  legend:  { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14,
             fontSize: 12, color: "#555", flex: 1 },
  legendItem: { display: "inline-flex", alignItems: "center", gap: 5 },
  legendMeta: { fontSize: 11, color: "#888" },
  printBtn: { padding: "6px 14px", borderRadius: 7, border: "1px solid #d0d7de",
              background: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600,
              color: "#333", whiteSpace: "nowrap", flexShrink: 0 },

  scroller:{ overflowX: "auto", overflowY: "auto", maxHeight: "76vh",
             borderRadius: 10 },
};
