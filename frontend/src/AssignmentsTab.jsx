import { useEffect, useMemo, useState } from "react";
import { api } from "./api";

/**
 * Renders a family-wide assignment chain diagram.  Each US family member is
 * its own column; assignment events flow top-down.  Same-assignee nodes
 * across columns share a color so you can visually trace owners across the
 * family.
 */
export default function AssignmentsTab({ portfolioId }) {
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState("");
  const [data,    setData]    = useState(null);

  useEffect(() => {
    if (!portfolioId) return;
    let alive = true;
    setLoading(true);
    setError("");
    api.getPortfolioAssignments(portfolioId)
      .then((d) => { if (alive) setData(d); })
      .catch((err) => { if (alive) setError(err.message || "Failed to load assignments"); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [portfolioId]);

  // Build a stable color map for unique assignee/assignor names
  const colorMap = useMemo(() => {
    if (!data) return new Map();
    const names = new Set();
    (data.members || []).forEach((m) => {
      (m.assignments || []).forEach((a) => {
        (a.assignees || []).forEach((x) => x.name && names.add(x.name));
        (a.assignors || []).forEach((x) => x.name && names.add(x.name));
      });
    });
    const palette = [
      "#1565c0", "#2e7d32", "#c62828", "#6a1b9a", "#ef6c00", "#00838f",
      "#455a64", "#4e342e", "#00695c", "#827717", "#ad1457", "#283593",
    ];
    const m = new Map();
    let i = 0;
    Array.from(names).sort().forEach((n) => {
      m.set(n, palette[i % palette.length]);
      i += 1;
    });
    return m;
  }, [data]);

  if (loading) return <div style={s.loading}>Loading assignment chain…</div>;
  if (error)   return <div style={s.error}>{error}</div>;
  if (!data)   return null;

  const members = data.members || [];
  if (members.length === 0) {
    return <div style={s.empty}>No US family members found to query for assignments.</div>;
  }

  return (
    <div style={s.wrap}>
      {/* Summary band: unique current assignees */}
      {data.unique_assignees && data.unique_assignees.length > 0 && (
        <div style={s.summary}>
          <span style={s.summaryLabel}>Current assignee(s) across family:</span>
          {data.unique_assignees.map((n) => (
            <span key={n} style={{ ...s.assigneeChip, background: colorMap.get(n) || "#888" }}>
              {n}
            </span>
          ))}
        </div>
      )}

      {/* Horizontal scroller of per-member columns */}
      <div style={s.scroller}>
        {members.map((m) => (
          <MemberColumn key={m.app_num} member={m} colorMap={colorMap} />
        ))}
      </div>
    </div>
  );
}

function MemberColumn({ member, colorMap }) {
  const { display_number, status, app_num, assignments, current_assignees } = member;
  const statusStyle = {
    granted:   { bg: "#e8f5e9", fg: "#2e7d32" },
    pending:   { bg: "#e3f2fd", fg: "#1565c0" },
    abandoned: { bg: "#f5f5f5", fg: "#757575" },
  }[status] || { bg: "#f5f5f5", fg: "#666" };

  return (
    <div style={s.column}>
      <div style={s.colHeader}>
        <div style={s.colTitle}>{display_number}</div>
        <div style={s.colMeta}>
          <span style={{ ...s.statusPill, background: statusStyle.bg, color: statusStyle.fg }}>
            {status}
          </span>
          <span style={{ fontSize: 11, color: "#666" }}>App #{formatAppNum(app_num)}</span>
        </div>
        {current_assignees && current_assignees.length > 0 && (
          <div style={s.colCurrent}>
            <span style={s.currentLabel}>Current:</span>
            {current_assignees.map((n) => (
              <span key={n} style={{ ...s.assigneeChipSmall, background: colorMap.get(n) || "#888" }}>
                {n}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Chain */}
      {(!assignments || assignments.length === 0) ? (
        <div style={s.noChain}>No recorded assignments</div>
      ) : (
        <div style={s.chain}>
          {assignments.map((a, i) => (
            <AssignmentNode key={i} a={a} colorMap={colorMap} isLast={i === assignments.length - 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function AssignmentNode({ a, colorMap, isLast }) {
  const conveyanceShort = (a.conveyance || "").replace(/ASSIGNMENT OF ASSIGNOR'?S? INTEREST/i, "Assignment")
    .replace(/SECURITY (AGREEMENT|INTEREST)/i, "Security Interest")
    .replace(/MERGER/i, "Merger")
    .trim();

  return (
    <div style={{ position: "relative" }}>
      <div style={s.node}>
        <div style={s.nodeHeader}>
          <span style={s.nodeDate}>{a.recorded_date || "—"}</span>
          <span style={s.nodeConv}>{conveyanceShort}</span>
        </div>
        {a.assignors && a.assignors.length > 0 && (
          <div style={s.partyBlock}>
            <div style={s.partyLabel}>From</div>
            {a.assignors.map((p, i) => (
              <div key={i} style={s.partyRow}>
                <span style={{ ...s.dot, background: colorMap.get(p.name) || "#bbb" }} />
                <span style={s.partyName}>{p.name}</span>
              </div>
            ))}
          </div>
        )}
        {a.assignees && a.assignees.length > 0 && (
          <div style={s.partyBlock}>
            <div style={s.partyLabel}>To</div>
            {a.assignees.map((p, i) => (
              <div key={i} style={s.partyRow}>
                <span style={{ ...s.dot, background: colorMap.get(p.name) || "#bbb" }} />
                <span style={s.partyName}>{p.name}</span>
                {p.city && <span style={s.partyLocn}> — {p.city}{p.state ? `, ${p.state}` : ""}</span>}
              </div>
            ))}
          </div>
        )}
        <div style={s.nodeFooter}>
          {a.reel_frame && <span style={s.reelFrame}>Reel/Frame {a.reel_frame}</span>}
          {a.document_url && (
            <a href={a.document_url} target="_blank" rel="noopener" style={s.docLink}>
              View recorded doc ↗
            </a>
          )}
        </div>
      </div>
      {!isLast && <div style={s.connector} />}
    </div>
  );
}

function formatAppNum(app) {
  const s = String(app || "").replace(/\D/g, "");
  if (s.length === 8) return `${s.slice(0, 2)}/${s.slice(2, 5)},${s.slice(5)}`;
  return app || "";
}

const s = {
  wrap:      { padding: "16px", background: "#fafbfd", minHeight: "60vh" },
  loading:   { padding: 32, textAlign: "center", color: "#666" },
  error:     { padding: 14, background: "#fdecea", color: "#c62828", borderRadius: 8 },
  empty:     { padding: 32, textAlign: "center", color: "#888" },

  summary:   { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8,
               marginBottom: 14, padding: "10px 14px", background: "#fff",
               border: "1px solid #e0e0e0", borderRadius: 10 },
  summaryLabel: { fontSize: 13, fontWeight: 700, color: "#1a1a2e", marginRight: 4 },
  assigneeChip: { padding: "4px 10px", borderRadius: 12, color: "#fff",
                  fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" },
  assigneeChipSmall: { padding: "2px 8px", borderRadius: 10, color: "#fff",
                  fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" },

  scroller:  { display: "flex", gap: 14, overflowX: "auto", paddingBottom: 12 },

  column:    { minWidth: 260, maxWidth: 280, flexShrink: 0, display: "flex",
               flexDirection: "column" },
  colHeader: { background: "#fff", borderRadius: 10, border: "1px solid #e0e0e0",
               padding: "10px 12px", marginBottom: 10 },
  colTitle:  { fontWeight: 700, fontSize: 14, color: "#1a1a2e" },
  colMeta:   { display: "flex", gap: 8, alignItems: "center", marginTop: 4, flexWrap: "wrap" },
  statusPill:{ padding: "2px 8px", borderRadius: 10, fontSize: 11, fontWeight: 600 },
  colCurrent:{ marginTop: 8, display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" },
  currentLabel: { fontSize: 11, color: "#666", fontWeight: 600, marginRight: 2 },

  noChain:   { padding: "20px 12px", textAlign: "center", color: "#aaa", fontSize: 12,
               fontStyle: "italic", background: "#fff", borderRadius: 10,
               border: "1px dashed #e0e0e0" },

  chain:     { display: "flex", flexDirection: "column" },
  node:      { background: "#fff", borderRadius: 10, border: "1px solid #e0e0e0",
               padding: 10, marginBottom: 0 },
  nodeHeader:{ display: "flex", justifyContent: "space-between", marginBottom: 6 },
  nodeDate:  { fontSize: 11, color: "#666", fontWeight: 600 },
  nodeConv:  { fontSize: 11, fontWeight: 700, color: "#1a73e8",
               textTransform: "uppercase", letterSpacing: ".03em" },
  partyBlock:{ marginTop: 4 },
  partyLabel:{ fontSize: 10, color: "#888", textTransform: "uppercase",
               letterSpacing: ".06em", fontWeight: 700 },
  partyRow:  { display: "flex", alignItems: "center", gap: 5, marginTop: 2 },
  dot:       { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  partyName: { fontSize: 12, color: "#1a1a2e", fontWeight: 500 },
  partyLocn: { fontSize: 11, color: "#888" },
  nodeFooter:{ marginTop: 8, display: "flex", justifyContent: "space-between",
               alignItems: "center", flexWrap: "wrap", gap: 6 },
  reelFrame: { fontSize: 10, color: "#888", fontFamily: "monospace" },
  docLink:   { fontSize: 11, color: "#1a73e8", textDecoration: "none", fontWeight: 600 },

  connector: { width: 2, height: 14, background: "#bfdbfe", margin: "2px auto",
               borderRadius: 1 },
};
