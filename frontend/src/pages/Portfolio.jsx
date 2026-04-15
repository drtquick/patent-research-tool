import { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import PrintBar from "../PrintBar";
import AssignmentsTab from "../AssignmentsTab";
import PriorArtTab from "../PriorArtTab";
import ClaimsTab from "../ClaimsTab";
import TimelineTab from "../TimelineTab";
import DocumentsPanel from "../DocumentsPanel";
import { useIsMobile } from "../useIsMobile";

/** Inline confirmation modal — replaces browser confirm() */
function ConfirmModal({ patent, onConfirm, onCancel }) {
  return (
    <div style={modal.overlay}>
      <div style={modal.box}>
        <div style={modal.icon}>🗑️</div>
        <h3 style={modal.title}>Remove from Portfolio?</h3>
        <p style={modal.body}>
          This will remove <strong>{patent}</strong> and all its saved data
          from your portfolio. This cannot be undone.
        </p>
        <div style={modal.actions}>
          <button style={modal.cancelBtn} onClick={onCancel}>Keep it</button>
          <button style={modal.confirmBtn} onClick={onConfirm}>Yes, remove</button>
        </div>
      </div>
    </div>
  );
}

const modal = {
  overlay:    { position: "fixed", inset: 0, background: "rgba(0,0,0,.45)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 },
  box:        { background: "#fff", borderRadius: 14, padding: "2rem",
    maxWidth: 400, width: "90%", boxShadow: "0 20px 60px rgba(0,0,0,.25)",
    textAlign: "center" },
  icon:       { fontSize: 40, marginBottom: 12 },
  title:      { margin: "0 0 10px", fontSize: 18, color: "#1a1a2e" },
  body:       { margin: "0 0 24px", fontSize: 14, color: "#555", lineHeight: 1.6 },
  actions:    { display: "flex", gap: 12, justifyContent: "center" },
  cancelBtn:  { padding: "10px 24px", borderRadius: 8, border: "1px solid #d0d7de",
    background: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 600, color: "#444" },
  confirmBtn: { padding: "10px 24px", borderRadius: 8, border: "none",
    background: "#d32f2f", color: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 700 },
};

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

function _timeAgo(isoStr) {
  if (!isoStr) return "";
  const ms   = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1)  return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function renderAnalysisMarkdown(r, pubNum) {
  const lines = [];
  lines.push(`# Office Action Analysis — ${pubNum}`);
  lines.push("");
  if (r.oa_type)       lines.push(`**Type:** ${r.oa_type}`);
  if (r.mailing_date)  lines.push(`**Mailed:** ${r.mailing_date}`);
  if (r.response_deadline_short)
    lines.push(`**Response due:** ${r.response_deadline_short}${r.response_deadline_extended && r.response_deadline_extended !== r.response_deadline_short ? ` (extendable to ${r.response_deadline_extended})` : ""}`);
  lines.push("");
  if (r.overview) { lines.push("## Overview", r.overview, ""); }
  if (r.rejections && r.rejections.length) {
    lines.push(`## Rejections (${r.rejections.length})`);
    r.rejections.forEach((rj, i) => {
      lines.push(`### ${i + 1}. ${rj.section || rj.type || ""}`);
      if (rj.claims_affected) lines.push(`_Claims affected:_ ${rj.claims_affected}`);
      if (rj.summary) lines.push(rj.summary);
      if (rj.key_argument) lines.push(`> ${rj.key_argument}`);
      lines.push("");
    });
  }
  if (r.cited_prior_art && r.cited_prior_art.length) {
    lines.push(`## Cited Prior Art (${r.cited_prior_art.length})`);
    r.cited_prior_art.forEach((c) => {
      lines.push(`- **${c.reference}** — ${c.relevance || ""}`);
    });
    lines.push("");
  }
  if (r.suggested_response_strategies && r.suggested_response_strategies.length) {
    lines.push(`## Response Strategies`);
    r.suggested_response_strategies.forEach((s) => {
      lines.push(`- **${s.strategy}** (${s.likelihood_of_success || "?"})`);
      if (s.details) lines.push(`  ${s.details}`);
    });
    lines.push("");
  }
  if (r.attorney_flags && r.attorney_flags.length) {
    lines.push(`## Attorney Flags`);
    r.attorney_flags.forEach((f) => lines.push(`- ${f}`));
    lines.push("");
  }
  if (r.pdf_url) lines.push(`---\n[Download Original OA PDF](${r.pdf_url})`);
  return lines.join("\n");
}

function renderAnalysisPrintable(r, pubNum) {
  const esc = (s) => String(s || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let body = `<h1>Office Action Analysis — ${esc(pubNum)}</h1>`;
  body += `<p>`;
  if (r.oa_type)       body += `<strong>Type:</strong> ${esc(r.oa_type)} &nbsp; `;
  if (r.mailing_date)  body += `<strong>Mailed:</strong> ${esc(r.mailing_date)} &nbsp; `;
  if (r.response_deadline_short) {
    body += `<strong>Response due:</strong> ${esc(r.response_deadline_short)}`;
    if (r.response_deadline_extended && r.response_deadline_extended !== r.response_deadline_short)
      body += ` (extendable to ${esc(r.response_deadline_extended)})`;
  }
  body += `</p>`;
  if (r.overview)      body += `<h2>Overview</h2><p>${esc(r.overview)}</p>`;
  if (r.rejections && r.rejections.length) {
    body += `<h2>Rejections (${r.rejections.length})</h2>`;
    r.rejections.forEach((rj, i) => {
      body += `<div style="margin:10px 0;padding:10px;border-left:4px solid #c62828;background:#fff5f5"><strong>${i + 1}. ${esc(rj.section || rj.type || "")}</strong>`;
      if (rj.claims_affected) body += `<br><em>Claims:</em> ${esc(rj.claims_affected)}`;
      if (rj.summary)         body += `<p>${esc(rj.summary)}</p>`;
      if (rj.key_argument)    body += `<p style="color:#555;font-style:italic">Examiner's argument: ${esc(rj.key_argument)}</p>`;
      body += `</div>`;
    });
  }
  if (r.cited_prior_art && r.cited_prior_art.length) {
    body += `<h2>Cited Prior Art</h2><ul>`;
    r.cited_prior_art.forEach((c) => {
      body += `<li><strong>${esc(c.reference)}</strong>${c.relevance ? " — " + esc(c.relevance) : ""}</li>`;
    });
    body += `</ul>`;
  }
  if (r.suggested_response_strategies && r.suggested_response_strategies.length) {
    body += `<h2>Response Strategies</h2>`;
    r.suggested_response_strategies.forEach((s) => {
      body += `<div style="margin:8px 0;padding:10px;border-left:4px solid #2e7d32;background:#f1f8f4"><strong>${esc(s.strategy)}</strong> <em>(${esc(s.likelihood_of_success || "?")})</em>`;
      if (s.details) body += `<p>${esc(s.details)}</p>`;
      body += `</div>`;
    });
  }
  if (r.attorney_flags && r.attorney_flags.length) {
    body += `<h2>Attorney Flags</h2><ul>`;
    r.attorney_flags.forEach((f) => body += `<li>${esc(f)}</li>`);
    body += `</ul>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>OA Analysis — ${esc(pubNum)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:780px;margin:20px auto;padding:0 20px;color:#1a1a2e;line-height:1.55}h1{margin-top:0}h2{border-bottom:1px solid #e0e0e0;padding-bottom:4px;margin-top:24px}@media print{body{margin:10mm}}</style>
</head><body>${body}</body></html>`;
}

export default function Portfolio() {
  const isMobile  = useIsMobile();
  const navigate  = useNavigate();
  const [patents, setPatents]             = useState([]);
  const [loading, setLoading]             = useState(true);
  const [error,   setError]               = useState("");
  const [viewing, setViewing]             = useState(null);
  const [viewLoading, setViewLoading]     = useState(false);
  const [viewingNumber, setViewingNumber] = useState(null);
  const [viewingId, setViewingId]         = useState(null);
  const [familyName, setFamilyName]       = useState("");
  const [nameTimer, setNameTimer]         = useState(null);
  const [loadingMsg, setLoadingMsg]       = useState("");
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [docsPanel,    setDocsPanel]     = useState(null); // { portfolioId, patentNumber, usAppNum }
  const [aiPanel,      setAiPanel]       = useState(null); // { portfolioId, pubNum, patentNumber }
  const [aiResult,     setAiResult]      = useState(null);
  const [aiLoading,    setAiLoading]     = useState(false);
  const [aiError,      setAiError]       = useState("");
  const [refreshError, setRefreshError] = useState("");

  // ── Combine mode (multi-family dashboards) ──────────────────────────────
  const [groups, setGroups]             = useState([]);
  const [combineMode, setCombineMode]   = useState(false);
  const [selectedIds, setSelectedIds]   = useState([]);      // ad-hoc selection
  const [viewingGroup, setViewingGroup] = useState(null);    // { id, name, dashboard_html } or ad-hoc preview
  const [groupSaveName, setGroupSaveName] = useState("");
  const groupIframeRef = useRef(null);

  // ── Dashboard tab (Family Dashboard vs Assignments vs …) ─────────────────
  const [activeTab, setActiveTab] = useState("dashboard");

  const iframeRef         = useRef(null);
  const notesRef          = useRef({});   // always-current notes for the open dashboard
  const viewingIdRef      = useRef(null); // always-current portfolio doc ID
  const viewingNumberRef  = useRef(null); // always-current patent number
  const viewingFamilyRef  = useRef([]);   // always-current family array (for US app num lookup)
  const setDocsPanelRef   = useRef(setDocsPanel); // stable ref so handleIframeLoad can call it
  const notesTimerRef     = useRef(null); // debounce handle

  // Keep mutable refs in sync with state
  useEffect(() => { viewingNumberRef.current = viewingNumber; }, [viewingNumber]);
  useEffect(() => { viewingFamilyRef.current = viewing?.family || []; }, [viewing]);
  useEffect(() => { setDocsPanelRef.current = setDocsPanel; }, [setDocsPanel]);

  useEffect(() => { fetchPortfolio(); fetchGroups(); }, []);

  async function fetchGroups() {
    try {
      const data = await api.listPatenteeGroups();
      setGroups(data.groups || []);
    } catch { /* groups are optional; ignore */ }
  }

  function toggleSelected(id) {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  }

  async function handleCombinePreview() {
    if (selectedIds.length < 2) {
      alert("Select at least two patent families to combine.");
      return;
    }
    setViewLoading(true);
    setLoadingMsg(`Combining ${selectedIds.length} families…`);
    try {
      const data = await api.previewPatenteeGroup(selectedIds, "Combined preview");
      setViewingGroup({ id: null, name: data.name, dashboard_html: data.dashboard_html,
                        portfolio_ids: data.portfolio_ids });
      setViewLoading(false);
    } catch (err) {
      setViewLoading(false);
      alert(err.message);
    }
  }

  async function handleSaveGroup() {
    const name = (groupSaveName || "").trim();
    if (!name) { alert("Give the group a name first."); return; }
    const ids = viewingGroup?.portfolio_ids?.length ? viewingGroup.portfolio_ids : selectedIds;
    if (!ids || ids.length < 2) { alert("Select at least two families to save."); return; }
    try {
      const created = await api.createPatenteeGroup(name, ids);
      setGroups((prev) => [{
        id: created.id, name: created.name, portfolio_ids: created.portfolio_ids,
        updated_at: new Date().toISOString(),
      }, ...prev]);
      setGroupSaveName("");
      alert(`Saved group "${name}".`);
    } catch (err) {
      alert(err.message);
    }
  }

  async function handleOpenGroup(groupId) {
    setViewLoading(true);
    setLoadingMsg("Loading combined dashboard…");
    try {
      const data = await api.getPatenteeGroupDashboard(groupId);
      setViewingGroup({ id: groupId, name: data.name, dashboard_html: data.dashboard_html,
                        portfolio_ids: data.portfolio_ids });
      setViewLoading(false);
    } catch (err) {
      setViewLoading(false);
      alert(err.message);
    }
  }

  async function handleDeleteGroup(groupId) {
    if (!confirm("Delete this group? (Does not delete the underlying patents.)")) return;
    try {
      await api.deletePatenteeGroup(groupId);
      setGroups((prev) => prev.filter((g) => g.id !== groupId));
    } catch (err) {
      alert(err.message);
    }
  }

  // Listen for per-tile postMessages from the dashboard iframe (Files + AI)
  useEffect(() => {
    function onMessage(e) {
      if (e.data?.type === "open-tile-files") {
        const pubNum  = e.data.pubNum;
        const usEntry = (viewing?.family || []).find((m) => m.country === "US");
        setDocsPanel({
          portfolioId:  viewingId,
          patentNumber: viewingNumber,
          usAppNum:     usEntry?.app_num || "",
          tilePubNum:   pubNum,
        });
      } else if (e.data?.type === "open-tile-ai") {
        const pubNum = e.data.pubNum;
        handleAiAnalyze(viewingId, pubNum, viewingNumber);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [viewing, viewingId, viewingNumber]);

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

  async function _doSearch(portfolioId, patentNumber) {
    // Run a fresh scrape and persist the result back to Firestore cache
    const data = await api.search(patentNumber);
    api.refreshPortfolio(portfolioId, {
      dashboard_html: data.dashboard_html,
      family:         data.family,
    }).catch(() => {});
    setViewing(data);
    setViewLoading(false);
  }

  async function handleView(portfolioId, patentNumber) {
    const entry = patents.find(p => p.id === portfolioId);
    setFamilyName(entry?.family_name || "");
    notesRef.current     = entry?.notes || {};
    viewingIdRef.current = portfolioId;
    setViewingId(portfolioId);
    setViewingNumber(patentNumber);
    setViewLoading(true);

    try {
      // ── Cache-first: fetch from Firestore (fast) ──────────────────────────
      setLoadingMsg("Loading dashboard…");
      const cached = await api.getPortfolio(portfolioId);
      const cacheTs = cached.refreshed_at || cached.saved_at;
      const ageMs   = cacheTs ? Date.now() - new Date(cacheTs).getTime() : Infinity;
      const MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

      if (cached.dashboard_html && ageMs < MAX_AGE) {
        // Cache hit — serve instantly, no scraping needed
        setViewing(cached);
        setViewLoading(false);
        return;
      }

      // ── Cache miss / stale — run full scrape ──────────────────────────────
      setLoadingMsg(`Generating fresh dashboard for ${patentNumber}…`);
      await _doSearch(portfolioId, patentNumber);
    } catch (err) {
      alert(err.message);
      setViewingNumber(null);
      setViewingId(null);
      setViewLoading(false);
    }
  }

  // Primary refresh — pulls fresh data from USPTO ODP (no Google Patents needed).
  // Falls back to a full GP re-scrape only if the ODP refresh itself fails.
  async function handleRefresh() {
    if (!viewingNumber || !viewingId) return;
    const prevViewing = viewing;
    setViewing(null);
    setViewLoading(true);
    setRefreshError("");
    setLoadingMsg(`Refreshing data from USPTO for ${viewingNumber}…`);
    try {
      const data = await api.dataRefreshPortfolio(viewingId);
      setViewing(data);
      setViewLoading(false);
    } catch (err) {
      // ODP refresh failed — restore cached dashboard, show error
      setViewing(prevViewing);
      setViewLoading(false);
      setLoadingMsg("");
      setRefreshError(`Refresh failed: ${err.message}`);
      setTimeout(() => setRefreshError(""), 12000);
    }
  }

  // Force full re-scrape from Google Patents (use when ODP refresh misses family data)
  async function handleForceScrape() {
    if (!viewingNumber || !viewingId) return;
    const prevViewing = viewing;
    setViewing(null);
    setViewLoading(true);
    setRefreshError("");
    setLoadingMsg(`Re-scraping from source for ${viewingNumber}…`);
    try {
      await _doSearch(viewingId, viewingNumber);
    } catch (err) {
      setViewing(prevViewing);
      setViewLoading(false);
      setLoadingMsg("");
      setRefreshError(`Re-scrape failed: ${err.message}`);
      setTimeout(() => setRefreshError(""), 12000);
    }
  }

  function handleNameChange(e) {
    const name = e.target.value;
    setFamilyName(name);
    // Update local patents list immediately so the name persists in-session
    setPatents(prev =>
      prev.map(p => p.id === viewingIdRef.current ? { ...p, family_name: name } : p)
    );
    // Debounced save
    clearTimeout(nameTimer);
    setNameTimer(setTimeout(() => {
      const id = viewingIdRef.current;
      if (id) api.updatePortfolioName(id, name).catch(() => {});
    }, 700));
  }

  // Called when the dashboard iframe finishes loading — inject saved notes and
  // attach input listeners so changes are saved back to Firestore (debounced).
  const handleIframeLoad = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;

    // Inject any previously saved notes into the textareas
    Object.entries(notesRef.current).forEach(([pubNum, text]) => {
      if (!text) return;
      const ta = doc.querySelector(`.notes-ta[data-pub-num="${pubNum}"]`);
      if (ta) ta.value = text;
    });

    // Inject a Files button for any card that doesn't already have one.
    // Older cached dashboards were generated before the button existed in tracker.py;
    // this ensures every tile always has the button regardless of cache age.
    doc.querySelectorAll(".card").forEach((card) => {
      if (card.querySelector(".tile-files-btn")) return; // new HTML already has it
      const ta = card.querySelector(".notes-ta");
      if (!ta) return;
      const pubNum = ta.dataset.pubNum;
      if (!pubNum) return;
      const btn = doc.createElement("button");
      btn.className = "tile-files-btn";
      btn.textContent = "📎 Files";
      btn.style.cssText =
        "margin-top:.6rem;padding:5px 12px;border-radius:6px;cursor:pointer;" +
        "background:#f0f4f8;border:1px solid #d0d7de;font-size:.75rem;color:#1a1a2e;" +
        "font-weight:600;display:inline-flex;align-items:center;gap:4px;";
      btn.addEventListener("click", () => {
        const usEntry = (viewingFamilyRef.current || []).find((m) => m.country === "US");
        setDocsPanelRef.current({
          portfolioId:  viewingIdRef.current,
          patentNumber: viewingNumberRef.current,
          usAppNum:     usEntry?.app_num || "",
          tilePubNum:   pubNum,
        });
      });
      card.appendChild(btn);
    });

    // Wire up listeners — save on every keystroke (debounced 800 ms)
    doc.querySelectorAll(".notes-ta").forEach((ta) => {
      ta.addEventListener("input", () => {
        const pubNum = ta.dataset.pubNum;
        const text   = ta.value;
        // Update the notes ref immediately (used in the save closure)
        notesRef.current = { ...notesRef.current, [pubNum]: text };
        // Also update local patents state so re-opening retains notes without a refetch
        setPatents((prev) =>
          prev.map((p) =>
            p.id === viewingIdRef.current
              ? { ...p, notes: notesRef.current }
              : p
          )
        );
        clearTimeout(notesTimerRef.current);
        notesTimerRef.current = setTimeout(() => {
          const id = viewingIdRef.current;
          if (id) api.savePortfolioNotes(id, notesRef.current).catch(() => {});
        }, 800);
      });
    });
  }, []);

  function handleDelete(id, patentNumber) {
    // Show styled in-page modal instead of browser confirm()
    setConfirmTarget({ id, patentNumber });
  }

  async function confirmDelete() {
    const { id, patentNumber } = confirmTarget;
    setConfirmTarget(null);
    try {
      await api.deletePortfolio(id);
      setPatents((prev) => prev.filter((p) => p.id !== id));
      if (viewingNumber === patentNumber) { setViewing(null); setViewingNumber(null); setViewingId(null); }
    } catch (err) {
      alert(err.message);
    }
  }

  // ── AI Office Action Analysis ─────────────────────────────────────────
  async function handleAiAnalyze(portfolioId, pubNum, patentNumber) {
    setAiPanel({ portfolioId, pubNum, patentNumber: patentNumber || pubNum });
    setAiResult(null);
    setAiError("");
    setAiLoading(true);
    try {
      const result = await api.aiAnalyzeOA(portfolioId, pubNum);
      setAiResult(result);
    } catch (err) {
      setAiError(err.message || "OA analysis failed");
    } finally {
      setAiLoading(false);
    }
  }

  function handlePrintAnalysis() {
    // Open a new window containing a printable version of the analysis.
    if (!aiResult || aiResult.error) return;
    const w = window.open("", "_blank", "width=900,height=1000");
    if (!w) return;
    const h = renderAnalysisPrintable(aiResult, aiPanel?.pubNum || "");
    w.document.write(h);
    w.document.close();
    setTimeout(() => w.print(), 400);
  }

  function handleDownloadAnalysisMarkdown() {
    if (!aiResult || aiResult.error) return;
    const md = renderAnalysisMarkdown(aiResult, aiPanel?.pubNum || "");
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `OA-analysis-${aiPanel?.pubNum || "patent"}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function handleRefreshAi() {
    if (!aiPanel) return;
    setAiResult(null);
    setAiError("");
    setAiLoading(true);
    try {
      const result = await api.aiAnalyzeOA(aiPanel.portfolioId, aiPanel.pubNum);
      setAiResult(result);
    } catch (err) {
      setAiError(err.message || "OA analysis failed");
    } finally {
      setAiLoading(false);
    }
  }

  // Full-page loading overlay while fresh search runs (30-60s)
  if (viewLoading) {
    const isScrape = loadingMsg.startsWith("Generating") || loadingMsg.startsWith("Refresh");
    return (
      <div style={styles.page}>
        <div style={styles.loadingOverlay}>
          <div style={styles.spinner} />
          <p style={styles.loadingText}>{loadingMsg || "Loading…"}</p>
          {isScrape && (
            <p style={styles.loadingSubtext}>This may take 30–60 seconds</p>
          )}
        </div>
      </div>
    );
  }

  if (viewingGroup) {
    return (
      <div style={styles.page}>
        <div style={styles.dashHeader}>
          <button
            style={styles.backBtn}
            onClick={() => setViewingGroup(null)}
          >
            ← Back
          </button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong style={{ fontSize: 15 }}>{viewingGroup.name}</strong>
            <span style={{ marginLeft: 8, color: "#666", fontSize: 13 }}>
              ({viewingGroup.portfolio_ids?.length || 0} families)
            </span>
          </div>
          {!viewingGroup.id && (
            <>
              <input
                style={styles.nameInput}
                placeholder="Name this group to save it…"
                value={groupSaveName}
                onChange={(e) => setGroupSaveName(e.target.value)}
              />
              <button style={styles.viewBtn} onClick={handleSaveGroup}>
                💾 Save Group
              </button>
            </>
          )}
          {viewingGroup.id && (
            <button
              style={{ ...styles.deleteBtn }}
              onClick={() => handleDeleteGroup(viewingGroup.id).then(() => setViewingGroup(null))}
              title="Delete this saved group"
            >
              Delete Group
            </button>
          )}
        </div>
        <div style={styles.iframeWrap}>
          <iframe
            ref={groupIframeRef}
            title="Combined Dashboard"
            style={styles.iframe}
            srcDoc={viewingGroup.dashboard_html}
            sandbox="allow-scripts allow-same-origin allow-modals allow-popups"
          />
        </div>
      </div>
    );
  }

  if (viewing) {
    return (
      <div style={styles.page}>
        {confirmTarget && (
          <ConfirmModal
            patent={confirmTarget.patentNumber}
            onConfirm={confirmDelete}
            onCancel={() => setConfirmTarget(null)}
          />
        )}
        {docsPanel && (
          <DocumentsPanel
            portfolioId={docsPanel.portfolioId}
            patentNumber={docsPanel.patentNumber}
            usAppNum={docsPanel.usAppNum}
            tilePubNum={docsPanel.tilePubNum}
            onClose={() => setDocsPanel(null)}
          />
        )}
        {/* AI Office Action Analysis Panel */}
        {aiPanel && (
          <div style={aiStyles.overlay} onClick={() => { setAiPanel(null); setAiResult(null); setAiError(""); }}>
            <div style={aiStyles.panel} onClick={(e) => e.stopPropagation()}>
              <div style={aiStyles.header}>
                <h3 style={aiStyles.title}>Office Action Analysis</h3>
                <span style={aiStyles.subtitle}>{aiPanel.pubNum}</span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
                  {aiResult && !aiResult.error && (
                    <>
                      <button
                        style={{ padding: "6px 10px", borderRadius: 6, background: "#f0f4f8",
                                 border: "1px solid #d0d7de", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                        onClick={() => handlePrintAnalysis()}
                        title="Print this analysis (or Save as PDF via print dialog)"
                      >
                        🖨 Print / Save PDF
                      </button>
                      <button
                        style={{ padding: "6px 10px", borderRadius: 6, background: "#f0f4f8",
                                 border: "1px solid #d0d7de", cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                        onClick={() => handleDownloadAnalysisMarkdown()}
                        title="Download the analysis as a Markdown file"
                      >
                        ⬇️ Save .md
                      </button>
                    </>
                  )}
                  <button style={aiStyles.closeBtn} onClick={() => { setAiPanel(null); setAiResult(null); setAiError(""); }}>✕</button>
                </div>
              </div>
              {aiLoading && (
                <div style={aiStyles.loadingWrap}>
                  <div style={styles.spinner} />
                  <p style={{ margin: 0, color: "#555", fontSize: 14 }}>Fetching and analyzing office action...</p>
                  <p style={{ margin: 0, color: "#999", fontSize: 12 }}>Downloading OA from USPTO, extracting text, running AI analysis. This may take 20-30 seconds.</p>
                </div>
              )}
              {aiError && (
                <div style={aiStyles.errorBox}>
                  <strong>Analysis failed:</strong> {aiError}
                  <button style={aiStyles.retryBtn} onClick={handleRefreshAi}>Retry</button>
                </div>
              )}
              {aiResult && (
                <div style={aiStyles.resultWrap}>
                  {aiResult.error && (
                    <div style={aiStyles.errorBox}>
                      <strong>Analysis error:</strong> {aiResult.error}
                      {aiResult.raw_response && (
                        <details style={{ marginTop: 8 }}>
                          <summary style={{ cursor: "pointer", fontSize: 12 }}>Raw response</summary>
                          <pre style={{ fontSize: 11, background: "#fff", padding: 8, borderRadius: 4, overflow: "auto", maxHeight: 200 }}>
                            {aiResult.raw_response}
                          </pre>
                        </details>
                      )}
                    </div>
                  )}
                  {!aiResult.error && !aiResult.rejections && !aiResult.overview && !aiResult.oa_type && (
                    <div style={{ padding: 14, background: "#fff7ed", border: "1px solid #fed7aa",
                                  borderRadius: 8, color: "#c2410c", fontSize: 13 }}>
                      Analysis returned, but in an unexpected shape. Download the PDF below and review manually.
                      <details style={{ marginTop: 8 }}>
                        <summary style={{ cursor: "pointer", fontSize: 12 }}>Response JSON</summary>
                        <pre style={{ fontSize: 11, background: "#fff", padding: 8, borderRadius: 4, overflow: "auto", maxHeight: 300 }}>
                          {JSON.stringify(aiResult, null, 2)}
                        </pre>
                      </details>
                    </div>
                  )}
                  {/* OA Type + Deadlines + PDF */}
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
                    {aiResult.oa_type && (
                      <span style={{ ...aiStyles.urgencyTag, background: "#e3f2fd", color: "#1565c0", fontSize: 12, padding: "4px 12px" }}>
                        {aiResult.oa_type.replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
                      </span>
                    )}
                    {aiResult.mailing_date && (
                      <span style={{ fontSize: 12, color: "#666", alignSelf: "center" }}>Mailed: {aiResult.mailing_date}</span>
                    )}
                    {aiResult.pdf_url && (
                      <a
                        href={aiResult.pdf_url}
                        target="_blank"
                        rel="noopener"
                        download={aiResult.pdf_filename || "office-action.pdf"}
                        style={{ marginLeft: "auto", padding: "6px 12px", borderRadius: 6,
                                 background: "#1a73e8", color: "#fff", textDecoration: "none",
                                 fontSize: 13, fontWeight: 600 }}
                      >
                        📄 Download OA PDF
                      </a>
                    )}
                  </div>
                  {(aiResult.response_deadline_short || aiResult.response_deadline_extended) && (
                    <div style={{ background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: "#c2410c" }}>
                      <strong>Response due:</strong> {aiResult.response_deadline_short} without extension
                      {aiResult.response_deadline_extended && aiResult.response_deadline_extended !== aiResult.response_deadline_short
                        ? ` and ${aiResult.response_deadline_extended} with extension` : ""}
                    </div>
                  )}

                  {/* Overview */}
                  {aiResult.overview && (
                    <div style={aiStyles.section}>
                      <div style={aiStyles.sectionLabel}>Overview</div>
                      <p style={aiStyles.summaryText}>{aiResult.overview}</p>
                    </div>
                  )}

                  {/* Rejections */}
                  {aiResult.rejections && aiResult.rejections.length > 0 && (
                    <div style={aiStyles.section}>
                      <div style={aiStyles.sectionLabel}>Rejections ({aiResult.rejections.length})</div>
                      {aiResult.rejections.map((rej, i) => (
                        <div key={i} style={{ ...aiStyles.actionItem, borderLeft: "4px solid #c62828" }}>
                          <div style={aiStyles.actionHeader}>
                            <span style={aiStyles.actionTitle}>{rej.section || rej.type}</span>
                            {rej.claims_affected && <span style={{ fontSize: 11, color: "#666" }}>{rej.claims_affected}</span>}
                          </div>
                          <p style={aiStyles.actionDetails}>{rej.summary}</p>
                          {rej.key_argument && (
                            <p style={{ ...aiStyles.actionDetails, fontStyle: "italic", color: "#777", marginTop: 4 }}>
                              Examiner's argument: {rej.key_argument}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Cited Prior Art */}
                  {aiResult.cited_prior_art && aiResult.cited_prior_art.length > 0 && (
                    <div style={aiStyles.section}>
                      <div style={aiStyles.sectionLabel}>Cited Prior Art ({aiResult.cited_prior_art.length})</div>
                      {aiResult.cited_prior_art.map((ref, i) => (
                        <div key={i} style={{ ...aiStyles.actionItem, borderLeft: "4px solid #1a73e8" }}>
                          <div style={{ fontWeight: 600, fontSize: 13, color: "#1a1a2e", marginBottom: 4 }}>
                            {ref.reference}
                            {ref.citation_type && (
                              <span style={{ ...aiStyles.urgencyTag, background: "#e8f0fe", color: "#1a73e8", marginLeft: 8 }}>
                                {ref.citation_type === "non-patent-literature" ? "NPL" : "Patent"}
                              </span>
                            )}
                          </div>
                          {ref.relevance && <p style={aiStyles.actionDetails}>{ref.relevance}</p>}
                          {(() => {
                            const dl = (aiResult.prior_art_downloads || []).find(
                              (d) => ref.reference && ref.reference.toUpperCase().includes(d.pub_num)
                            );
                            if (!dl) return null;
                            return (
                              <a
                                href={dl.download_url}
                                target="_blank"
                                rel="noopener"
                                download={`${dl.pub_num}.pdf`}
                                style={{ display: "inline-block", marginTop: 6, padding: "4px 10px",
                                         borderRadius: 5, background: "#1a73e8", color: "#fff",
                                         textDecoration: "none", fontSize: 12, fontWeight: 600 }}
                              >
                                📄 Download {dl.pub_num}
                              </a>
                            );
                          })()}
                        </div>
                      ))}
                      {aiResult.prior_art_downloads && aiResult.prior_art_downloads.length > 0 && (
                        <p style={{ fontSize: 11, color: "#2e7d32", marginTop: 8 }}>
                          ✓ {aiResult.prior_art_downloads.length} prior-art PDF{aiResult.prior_art_downloads.length === 1 ? "" : "s"} saved to this tile's Files
                        </p>
                      )}
                    </div>
                  )}

                  {/* Suggested Response Strategies */}
                  {aiResult.suggested_response_strategies && aiResult.suggested_response_strategies.length > 0 && (
                    <div style={aiStyles.section}>
                      <div style={aiStyles.sectionLabel}>Response Strategies</div>
                      {aiResult.suggested_response_strategies.map((s, i) => (
                        <div key={i} style={{
                          ...aiStyles.actionItem,
                          borderLeft: `4px solid ${s.likelihood_of_success === "high" ? "#2e7d32" : s.likelihood_of_success === "medium" ? "#f57c00" : "#c62828"}`,
                        }}>
                          <div style={aiStyles.actionHeader}>
                            <span style={aiStyles.actionTitle}>{s.strategy}</span>
                            <span style={{
                              ...aiStyles.urgencyTag,
                              background: s.likelihood_of_success === "high" ? "#e8f5e9" : s.likelihood_of_success === "medium" ? "#fff3e0" : "#fdecea",
                              color: s.likelihood_of_success === "high" ? "#2e7d32" : s.likelihood_of_success === "medium" ? "#e65100" : "#c62828",
                            }}>{s.likelihood_of_success}</span>
                          </div>
                          <p style={aiStyles.actionDetails}>{s.details}</p>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Attorney Flags */}
                  {aiResult.attorney_flags && aiResult.attorney_flags.length > 0 && (
                    <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 8, padding: "12px 16px", marginBottom: 16 }}>
                      <div style={{ ...aiStyles.sectionLabel, color: "#991b1b", marginBottom: 6 }}>Attorney Attention Required</div>
                      {aiResult.attorney_flags.map((flag, i) => (
                        <p key={i} style={{ margin: "4px 0", fontSize: 13, color: "#991b1b", lineHeight: 1.5 }}>{flag}</p>
                      ))}
                    </div>
                  )}

                  <div style={aiStyles.footer}>
                    <span style={aiStyles.footerNote}>AI-generated analysis. Attorney review required.</span>
                    <button style={aiStyles.refreshBtn} onClick={handleRefreshAi}>Re-analyze</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        <div style={styles.dashHeader}>
          <button
            style={styles.backBtn}
            onClick={() => { setViewing(null); setViewingNumber(null); setViewingId(null); }}
          >
            ← Back
          </button>
          <input
            style={styles.nameInput}
            value={familyName}
            onChange={handleNameChange}
            placeholder={`Name this family (e.g. "Widget Portfolio")…`}
            title="Custom name for this patent family — saved automatically"
          />
          {(viewing?.refreshed_at || viewing?.saved_at) && (
            <span style={styles.lastUpdated}>
              Updated {_timeAgo(viewing.refreshed_at || viewing.saved_at)}
            </span>
          )}
          <button
            style={styles.docsBtn}
            onClick={() => {
              const usEntry = (viewing?.family || []).find((m) => m.country === "US");
              setDocsPanel({ portfolioId: viewingId, patentNumber: viewingNumber, usAppNum: usEntry?.app_num || "", tilePubNum: null });
            }}
            title="View all files across this patent family"
          >
            📎 All Files
          </button>
          <button
            style={styles.refreshBtn}
            onClick={handleRefresh}
            title="Refresh prosecution data from USPTO patent office records"
          >
            🔄 Refresh
          </button>
          <button
            style={{...styles.refreshBtn, fontSize: 11, opacity: 0.7}}
            onClick={handleForceScrape}
            title="Force full re-scrape (slower, uses Google Patents as source)"
          >
            ↺ Re-scrape
          </button>
          <button
            style={styles.alertsBtn}
            onClick={() => navigate(`/alerts?patent=${encodeURIComponent(viewingNumber)}`)}
            title="View deadline alerts for this patent family"
          >
            🔔 Family Alerts
          </button>
        </div>
        {refreshError && (
          <div style={styles.refreshErrorBanner}>
            ⚠️ Refresh failed: {refreshError} — your cached dashboard is still shown below.
          </div>
        )}
        <div style={styles.tabBar}>
          {[
            { key: "dashboard",   label: "📊 Family Dashboard" },
            { key: "timeline",    label: "🕒 Timeline" },
            { key: "claims",      label: "📋 Claims" },
            { key: "prior_art",   label: "📚 Prior Art" },
            { key: "assignments", label: "🏛 Assignments" },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              style={{
                ...styles.tabBtn,
                ...(activeTab === t.key ? styles.tabBtnActive : {}),
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
        {activeTab === "dashboard" && (
          <>
            <PrintBar iframeRef={iframeRef} />
            <div style={styles.iframeWrap}>
              <iframe
                ref={iframeRef}
                title="Patent Dashboard"
                style={styles.iframe}
                srcDoc={viewing.dashboard_html}
                sandbox="allow-scripts allow-same-origin allow-modals allow-popups"
                onLoad={handleIframeLoad}
              />
            </div>
          </>
        )}
        {activeTab === "assignments" && (
          <div style={styles.iframeWrap}>
            <AssignmentsTab portfolioId={viewingId} />
          </div>
        )}
        {activeTab === "timeline" && (
          <div style={styles.iframeWrap}>
            <TimelineTab portfolioId={viewingId} />
          </div>
        )}
        {activeTab === "claims" && (
          <div style={styles.iframeWrap}>
            <ClaimsTab portfolioId={viewingId} />
          </div>
        )}
        {activeTab === "prior_art" && (
          <div style={styles.iframeWrap}>
            <PriorArtTab portfolioId={viewingId} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ ...styles.page, padding: isMobile ? "1rem" : "2rem" }}>
      {/* Documents panel modal */}
      {docsPanel && (
        <DocumentsPanel
          portfolioId={docsPanel.portfolioId}
          patentNumber={docsPanel.patentNumber}
          usAppNum={docsPanel.usAppNum}
          tilePubNum={docsPanel.tilePubNum}
          onClose={() => setDocsPanel(null)}
        />
      )}
      {confirmTarget && (
        <ConfirmModal
          patent={confirmTarget.patentNumber}
          onConfirm={confirmDelete}
          onCancel={() => setConfirmTarget(null)}
        />
      )}
      <h2 style={styles.heading}>My Portfolio</h2>

      {/* ── Saved Patentee Groups ─────────────────────────────────────────── */}
      {groups.length > 0 && (
        <div style={styles.groupsWrap}>
          <div style={styles.groupsHeader}>
            <span style={{ fontWeight: 700, color: "#1a1a2e" }}>Saved Groups</span>
            <span style={{ fontSize: 12, color: "#888" }}>
              Combined multi-family dashboards
            </span>
          </div>
          <div style={styles.groupsRow}>
            {groups.map((g) => (
              <div key={g.id} style={styles.groupChip}>
                <button
                  style={styles.groupOpenBtn}
                  onClick={() => handleOpenGroup(g.id)}
                  title={`Open combined dashboard — ${g.portfolio_ids?.length || 0} families`}
                >
                  📚 {g.name}{" "}
                  <span style={{ color: "#888", fontWeight: 400 }}>
                    ({g.portfolio_ids?.length || 0})
                  </span>
                </button>
                <button
                  style={styles.groupDelBtn}
                  onClick={() => handleDeleteGroup(g.id)}
                  title="Delete group (patents are not deleted)"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Combine mode toolbar ─────────────────────────────────────────── */}
      {patents.length >= 2 && (
        <div style={styles.combineBar}>
          <label style={styles.combineToggleWrap}>
            <input
              type="checkbox"
              checked={combineMode}
              onChange={(e) => {
                setCombineMode(e.target.checked);
                if (!e.target.checked) setSelectedIds([]);
              }}
            />
            <span style={{ fontWeight: 600 }}>Combine mode</span>
            <span style={{ fontSize: 12, color: "#666" }}>
              — select multiple families to view together
            </span>
          </label>
          {combineMode && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, color: "#444" }}>
                {selectedIds.length} selected
              </span>
              <button
                style={styles.viewBtn}
                disabled={selectedIds.length < 2}
                onClick={handleCombinePreview}
              >
                Combine Selected
              </button>
              <button
                style={styles.backBtn}
                onClick={() => setSelectedIds([])}
              >
                Clear
              </button>
            </div>
          )}
        </div>
      )}

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

      <div style={{ ...styles.grid, gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(300px, 1fr))" }}>
        {patents.map((p) => {
          const family = p.family || [];
          const countryMap = new Map();
          for (const m of family) {
            const cc = m.country || "??";
            if (!countryMap.has(cc)) countryMap.set(cc, m.status || "unknown");
          }
          const countries  = Array.from(countryMap.entries());
          const usEntry    = family.find((m) => m.country === "US");
          const usAppNum   = usEntry?.app_num || "";

          const isSelected = selectedIds.includes(p.id);
          return (
            <div
              key={p.id}
              style={{
                ...styles.card,
                ...(combineMode && isSelected ? { outline: "3px solid #1a73e8", outlineOffset: -1 } : {}),
              }}
            >
              {combineMode && (
                <label style={styles.tileCheckbox}>
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelected(p.id)}
                  />
                  <span style={{ fontSize: 12 }}>Include in combined view</span>
                </label>
              )}
              <div style={styles.cardHeader}>
                <span style={styles.number}>{p.patent_number}</span>
                <span style={{ ...styles.badge, background: "#e3f2fd", color: "#1565c0" }}>
                  {p.family_size || "?"} members
                </span>
              </div>
              {p.family_name && (
                <div style={styles.familyNameTag}>📁 {p.family_name}</div>
              )}
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
                <button style={styles.viewBtn} onClick={() => handleView(p.id, p.patent_number)}>
                  View Dashboard
                </button>
                <button
                  style={styles.docsBtn}
                  onClick={() => setDocsPanel({ portfolioId: p.id, patentNumber: p.patent_number, usAppNum, tilePubNum: null })}
                  title="View all files for this patent family"
                >
                  📎 Files
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
  docsBtn:   { padding: "8px 12px", borderRadius: 8, background: "#f0f4f8",
    border: "1px solid #d0d7de", cursor: "pointer", fontSize: 13, color: "#1a1a2e",
    fontWeight: 500 },
  aiBtn:     { padding: "8px 12px", borderRadius: 8, background: "#ede7f6",
    border: "1px solid #ce93d8", cursor: "pointer", fontSize: 13, color: "#6a1b9a",
    fontWeight: 600 },
  deleteBtn: { padding: "8px 14px", borderRadius: 8, background: "#fff",
    color: "#d32f2f", border: "1px solid #f5c6cb", cursor: "pointer", fontSize: 13 },
  dashHeader:  { marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  backBtn:     { padding: "8px 14px", borderRadius: 8, background: "#f0f4f8",
    border: "1px solid #d0d7de", cursor: "pointer", fontSize: 14, whiteSpace: "nowrap" },
  nameInput:   { flex: 1, minWidth: 160, maxWidth: 380, padding: "7px 12px", borderRadius: 8,
    border: "1px solid #d0d7de", fontSize: 14, color: "#1a1a2e", background: "#fff",
    fontFamily: "inherit" },
  alertsBtn:   { padding: "8px 14px", borderRadius: 8, background: "#fff3e0",
    border: "1px solid #ffe0b2", color: "#e65100", cursor: "pointer",
    fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" },
  refreshBtn:  { padding: "8px 14px", borderRadius: 8, background: "#f0f4f8",
    border: "1px solid #d0d7de", color: "#1a1a2e", cursor: "pointer",
    fontSize: 13, fontWeight: 600, whiteSpace: "nowrap" },
  lastUpdated: { fontSize: 12, color: "#888", whiteSpace: "nowrap", alignSelf: "center" },
  familyNameTag: { fontSize: 12, color: "#1565c0", fontWeight: 600, marginBottom: 4,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  iframeWrap:  { border: "1px solid #e0e0e0", borderRadius: 10, overflow: "hidden" },
  refreshErrorBanner: {
    margin: "0 0 10px", padding: "10px 14px", borderRadius: 8,
    background: "#fff3cd", border: "1px solid #ffc107",
    color: "#856404", fontSize: 13, lineHeight: 1.5,
  },
  iframe:      { width: "100%", height: "85vh", border: "none", display: "block" },
  tabBar:      { display: "flex", gap: 4, marginBottom: 8 },
  tabBtn:      { padding: "8px 16px", borderRadius: "8px 8px 0 0",
    border: "1px solid #e0e0e0", borderBottom: "none", background: "#f8f9fa",
    cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#666" },
  tabBtnActive:{ background: "#fff", color: "#1a73e8",
    borderTop: "3px solid #1a73e8", boxShadow: "0 -1px 0 #fff" },
  groupsWrap:  { marginBottom: 20, padding: "12px 16px", background: "#f8f9fa",
    borderRadius: 10, border: "1px solid #e0e0e0" },
  groupsHeader:{ display: "flex", alignItems: "baseline", justifyContent: "space-between",
    gap: 10, marginBottom: 8, flexWrap: "wrap" },
  groupsRow:   { display: "flex", flexWrap: "wrap", gap: 8 },
  groupChip:   { display: "inline-flex", alignItems: "stretch", borderRadius: 8,
    background: "#fff", border: "1px solid #d0d7de", overflow: "hidden" },
  groupOpenBtn:{ padding: "7px 12px", border: "none", background: "#fff",
    cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#1a1a2e" },
  groupDelBtn: { padding: "7px 9px", border: "none", borderLeft: "1px solid #e0e0e0",
    background: "#fff", cursor: "pointer", color: "#d32f2f", fontSize: 13 },
  combineBar:  { display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap",
    padding: "10px 14px", marginBottom: 14, background: "#fff3e0",
    border: "1px solid #ffe0b2", borderRadius: 10 },
  combineToggleWrap: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" },
  tileCheckbox: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8,
    padding: "4px 8px", background: "#e8f0fe", borderRadius: 6, cursor: "pointer",
    color: "#1565c0", fontWeight: 500 },
  loadingOverlay: { display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "center", minHeight: "60vh", gap: 20 },
  spinner: { width: 48, height: 48, border: "5px solid #e0e0e0",
    borderTop: "5px solid #1a73e8", borderRadius: "50%",
    animation: "spin 1s linear infinite" },
  loadingText:    { fontSize: 18, color: "#1a1a2e", margin: 0, textAlign: "center" },
  loadingSubtext: { fontSize: 14, color: "#888", margin: 0 },
};

const aiStyles = {
  overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,.45)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 },
  panel: { background: "#fff", borderRadius: 14, padding: 0, width: "90%", maxWidth: 620,
    maxHeight: "85vh", overflow: "hidden", display: "flex", flexDirection: "column",
    boxShadow: "0 20px 60px rgba(0,0,0,.25)" },
  header: { display: "flex", alignItems: "center", gap: 10, padding: "18px 24px 14px",
    borderBottom: "1px solid #e0e0e0", flexShrink: 0 },
  title: { margin: 0, fontSize: 17, color: "#1a1a2e", fontWeight: 700 },
  subtitle: { fontSize: 13, color: "#1a73e8", fontWeight: 600 },
  closeBtn: { marginLeft: "auto", background: "none", border: "none", fontSize: 20,
    cursor: "pointer", color: "#888", padding: "4px 8px", lineHeight: 1 },
  loadingWrap: { display: "flex", flexDirection: "column", alignItems: "center",
    gap: 14, padding: "3rem 2rem" },
  errorBox: { margin: "1.5rem", padding: "14px 18px", borderRadius: 8, background: "#fdecea",
    color: "#c62828", fontSize: 14, lineHeight: 1.5 },
  retryBtn: { marginLeft: 12, padding: "4px 14px", borderRadius: 6, border: "1px solid #c62828",
    background: "#fff", color: "#c62828", cursor: "pointer", fontSize: 13, fontWeight: 600 },
  resultWrap: { overflowY: "auto", padding: "20px 24px" },
  section: { marginBottom: 20 },
  sectionLabel: { fontSize: 12, fontWeight: 700, textTransform: "uppercase",
    letterSpacing: "0.05em", color: "#888", marginBottom: 8 },
  summaryText: { margin: 0, fontSize: 14, color: "#333", lineHeight: 1.65 },
  riskBadge: { display: "inline-block", padding: "5px 14px", borderRadius: 20,
    fontSize: 13, fontWeight: 700, marginBottom: 16 },
  actionItem: { background: "#f8f9fa", borderRadius: 8, padding: "12px 16px",
    marginBottom: 10 },
  actionHeader: { display: "flex", justifyContent: "space-between", alignItems: "center",
    gap: 10, marginBottom: 4 },
  actionTitle: { fontWeight: 600, fontSize: 14, color: "#1a1a2e" },
  urgencyTag: { fontSize: 11, fontWeight: 700, padding: "2px 10px", borderRadius: 12,
    textTransform: "uppercase", flexShrink: 0 },
  actionMeta: { fontSize: 12, color: "#666", marginTop: 2 },
  actionDetails: { margin: "8px 0 0", fontSize: 13, color: "#555", lineHeight: 1.55 },
  footer: { display: "flex", alignItems: "center", justifyContent: "space-between",
    paddingTop: 16, borderTop: "1px solid #eee", marginTop: 8 },
  footerNote: { fontSize: 11, color: "#999", fontStyle: "italic" },
  refreshBtn: { padding: "6px 16px", borderRadius: 8, border: "1px solid #ce93d8",
    background: "#ede7f6", color: "#6a1b9a", cursor: "pointer", fontSize: 13, fontWeight: 600 },
};
