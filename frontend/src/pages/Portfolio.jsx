import { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import PrintBar from "../PrintBar";
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
  const [refreshError, setRefreshError] = useState("");

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

  useEffect(() => { fetchPortfolio(); }, []);

  // Listen for per-tile 📎 Files button postMessages from the dashboard iframe
  useEffect(() => {
    function onMessage(e) {
      if (e.data?.type !== "open-tile-files") return;
      const pubNum  = e.data.pubNum;
      const usEntry = (viewing?.family || []).find((m) => m.country === "US");
      setDocsPanel({
        portfolioId:  viewingId,
        patentNumber: viewingNumber,
        usAppNum:     usEntry?.app_num || "",
        tilePubNum:   pubNum,   // scoped to this specific tile
      });
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
        <div style={styles.iframeWrap}>
          <iframe
            ref={iframeRef}
            title="Patent Dashboard"
            style={styles.iframe}
            srcDoc={viewing.dashboard_html}
            sandbox="allow-scripts allow-same-origin allow-modals allow-popups"
            onLoad={handleIframeLoad}
          />
          <PrintBar iframeRef={iframeRef} />
        </div>
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

          return (
            <div key={p.id} style={styles.card}>
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
  loadingOverlay: { display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "center", minHeight: "60vh", gap: 20 },
  spinner: { width: 48, height: 48, border: "5px solid #e0e0e0",
    borderTop: "5px solid #1a73e8", borderRadius: "50%",
    animation: "spin 1s linear infinite" },
  loadingText:    { fontSize: 18, color: "#1a1a2e", margin: 0, textAlign: "center" },
  loadingSubtext: { fontSize: 14, color: "#888", margin: 0 },
};
