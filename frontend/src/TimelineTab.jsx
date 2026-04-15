import { useEffect, useMemo, useState } from "react";
import { api } from "./api";

/**
 * Family filing timeline + continuation diagram.  Each node is a US
 * application or patent placed horizontally by filing date; continuation
 * edges (CON / CIP / DIV / PRO) are drawn as curved arrows linking parent
 * to child.  Node color reflects status; provisional apps get a dashed border.
 */
export default function TimelineTab({ portfolioId }) {
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");
  const [data,    setData]    = useState(null);

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

  // Layout: X by filing date, Y by generation depth (topological)
  const layout = useMemo(() => {
    if (!data) return null;
    const nodes = [...(data.nodes || [])];
    const edges = data.edges || [];
    if (nodes.length === 0) return { nodes: [], edges: [], width: 800, height: 200, xDomain: null };

    // Compute generation via BFS from nodes with no parent edges
    const incoming = new Map();    // app -> count of parents
    const outgoing = new Map();    // app -> list of child apps
    nodes.forEach((n) => { incoming.set(n.app_num, 0); outgoing.set(n.app_num, []); });
    edges.forEach((e) => {
      if (incoming.has(e.from_app) && incoming.has(e.to_app)) {
        incoming.set(e.to_app, incoming.get(e.to_app) + 1);
        outgoing.get(e.from_app).push(e.to_app);
      }
    });

    // Kahn-style topological ordering to get generation level
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
        if (cur === undefined || cur < lvl) {
          level.set(c, lvl);
          queue.push(c);
        }
      });
    }

    // Time → X
    const parseDate = (s) => s ? new Date(s + "T00:00:00").getTime() : null;
    const times = nodes.map((n) => parseDate(n.filing_date)).filter((t) => t);
    const tMin = times.length ? Math.min(...times) : 0;
    const tMax = times.length ? Math.max(...times) : tMin + 365 * 24 * 3600 * 1000;
    const PAD_X = 100, W = 1400, H_PER_LEVEL = 110, PAD_TOP = 40;
    const domain = tMax - tMin || 1;

    const xOf = (n) => {
      const t = parseDate(n.filing_date);
      if (!t) return PAD_X;
      return PAD_X + ((t - tMin) / domain) * (W - PAD_X * 2);
    };

    // Deconflict nodes that share the same (level, x-band) by nudging X
    const sortedByLvl = [...nodes].sort((a, b) =>
      (level.get(a.app_num) ?? 0) - (level.get(b.app_num) ?? 0) ||
      (parseDate(a.filing_date) || 0) - (parseDate(b.filing_date) || 0)
    );
    const placed = sortedByLvl.map((n, i) => {
      const lvl = level.get(n.app_num) ?? 0;
      return {
        ...n,
        x:     xOf(n),
        y:     PAD_TOP + lvl * H_PER_LEVEL,
        level: lvl,
      };
    });
    // Simple nudge to avoid overlap within same level
    const NODE_W = 170;
    for (let lvl = 0; lvl <= Math.max(0, ...placed.map((p) => p.level)); lvl++) {
      const group = placed.filter((p) => p.level === lvl).sort((a, b) => a.x - b.x);
      for (let i = 1; i < group.length; i++) {
        if (group[i].x < group[i - 1].x + NODE_W + 20) {
          group[i].x = group[i - 1].x + NODE_W + 20;
        }
      }
    }
    const height = PAD_TOP + (Math.max(0, ...placed.map((p) => p.level)) + 1) * H_PER_LEVEL;
    const maxX = Math.max(W, ...placed.map((p) => p.x + NODE_W));

    return { nodes: placed, edges, width: maxX + 40, height: height + 60,
             tMin, tMax };
  }, [data]);

  if (loading) return <div style={s.loading}>Loading family timeline…</div>;
  if (error)   return <div style={s.error}>{error}</div>;
  if (!data || !layout || layout.nodes.length === 0) {
    return <div style={s.empty}>No US family members to plot.</div>;
  }

  const { nodes, edges, width, height } = layout;
  const nodeById = new Map(nodes.map((n) => [n.app_num, n]));
  const NODE_W = 170, NODE_H = 64;

  // Year ticks
  const years = [];
  if (layout.tMin && layout.tMax) {
    const y0 = new Date(layout.tMin).getFullYear();
    const y1 = new Date(layout.tMax).getFullYear();
    for (let y = y0; y <= y1 + 1; y++) {
      const t = new Date(`${y}-01-01T00:00:00`).getTime();
      const x = 100 + ((t - layout.tMin) / (layout.tMax - layout.tMin || 1)) * (1400 - 200);
      if (x >= 100 && x <= width - 30) years.push({ y, x });
    }
  }

  return (
    <div style={s.wrap}>
      <div style={s.legend}>
        <LegendChip color="#2e7d32" label="Granted" />
        <LegendChip color="#1565c0" label="Pending" />
        <LegendChip color="#9e9e9e" label="Abandoned / Unknown" />
        <LegendChip color="#fff" border="#8b5cf6" label="Provisional (dashed)" />
        <span style={s.legendMeta}>Arrows: CON=continuation, CIP=continuation-in-part, DIV=divisional, PRO=provisional link</span>
      </div>
      <div style={s.scroller}>
        <svg width={width} height={height} style={{ background: "#fff", border: "1px solid #e0e0e0", borderRadius: 10 }}>
          {/* Year axis */}
          {years.map((yr) => (
            <g key={yr.y}>
              <line x1={yr.x} y1={0} x2={yr.x} y2={height} stroke="#f0f0f0" strokeDasharray="3 3" />
              <text x={yr.x} y={18} fontSize="11" fill="#888" textAnchor="middle">{yr.y}</text>
            </g>
          ))}

          {/* Edges */}
          {edges.map((e, i) => {
            const a = nodeById.get(e.from_app);
            const b = nodeById.get(e.to_app);
            if (!a || !b) return null;
            const x1 = a.x + NODE_W / 2;
            const y1 = a.y + NODE_H;
            const x2 = b.x + NODE_W / 2;
            const y2 = b.y;
            const midY = (y1 + y2) / 2;
            const d = `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`;
            const color = relationColor(e.relation);
            return (
              <g key={i}>
                <path d={d} stroke={color} strokeWidth="1.8" fill="none" opacity="0.8" />
                <polygon
                  points={`${x2 - 5},${y2 - 8} ${x2 + 5},${y2 - 8} ${x2},${y2 - 1}`}
                  fill={color}
                />
                <text x={(x1 + x2) / 2} y={midY - 4} fontSize="10" fill={color}
                      textAnchor="middle" fontWeight="700">
                  {e.relation || ""}
                </text>
              </g>
            );
          })}

          {/* Nodes */}
          {nodes.map((n) => (
            <NodeCard key={n.app_num} node={n} width={NODE_W} height={NODE_H} />
          ))}
        </svg>
      </div>
    </div>
  );
}

function NodeCard({ node, width, height }) {
  const c = statusColor(node.status, node.is_provisional);
  const dash = node.is_provisional ? "4 3" : "none";
  const x = node.x, y = node.y;
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx={8}
            fill={c.bg} stroke={c.border} strokeWidth="2" strokeDasharray={dash} />
      <text x={x + 10} y={y + 20} fontSize="13" fontWeight="700" fill={c.fg}>{node.display}</text>
      <text x={x + 10} y={y + 36} fontSize="10" fill="#555">Filed {node.filing_date || "—"}</text>
      {node.grant_date && (
        <text x={x + 10} y={y + 50} fontSize="10" fill="#555">Granted {node.grant_date}</text>
      )}
      {!node.grant_date && !node.in_portfolio && (
        <text x={x + 10} y={y + 50} fontSize="10" fill="#bbb" fontStyle="italic">from continuity</text>
      )}
    </g>
  );
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
  const map = {
    CON:  "#1565c0",
    CIP:  "#6a1b9a",
    DIV:  "#00695c",
    PRO:  "#ef6c00",
  };
  return map[relation] || "#555";
}

const s = {
  wrap:    { padding: 16, background: "#fafbfd", minHeight: "60vh" },
  loading: { padding: 32, textAlign: "center", color: "#666" },
  error:   { padding: 14, background: "#fdecea", color: "#c62828", borderRadius: 8 },
  empty:   { padding: 32, textAlign: "center", color: "#888" },

  legend:  { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14,
             marginBottom: 12, fontSize: 12, color: "#555" },
  legendItem: { display: "inline-flex", alignItems: "center", gap: 5 },
  legendMeta: { fontSize: 11, color: "#888", marginLeft: "auto" },

  scroller:{ overflowX: "auto", overflowY: "auto", maxHeight: "76vh",
             borderRadius: 10 },
};
