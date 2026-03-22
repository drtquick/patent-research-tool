import { useState, useRef, useCallback } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { useIsMobile } from "./useIsMobile";
import { api } from "./api";

function timeAgo(iso) {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)   return "just now";
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate  = useNavigate();
  const isMobile  = useIsMobile(720);

  const [q, setQ]                     = useState("");
  const [menuOpen, setMenuOpen]       = useState(false);
  const [history, setHistory]         = useState([]);
  const [histOpen, setHistOpen]       = useState(false);
  const [histLoaded, setHistLoaded]   = useState(false);
  const blurTimer = useRef(null);

  const loadHistory = useCallback(async () => {
    if (histLoaded) return;
    try {
      const data = await api.getSearchHistory(8);
      setHistory(data.searches || []);
      setHistLoaded(true);
    } catch { /* silently skip if history unavailable */ }
  }, [histLoaded]);

  function handleFocus() {
    clearTimeout(blurTimer.current);
    loadHistory();
    setHistOpen(true);
  }

  function handleBlur() {
    // Short delay so clicks on dropdown items register before closing
    blurTimer.current = setTimeout(() => setHistOpen(false), 180);
  }

  function handleSearch(e) {
    e.preventDefault();
    const trimmed = q.trim();
    if (!trimmed) return;
    navigate(`/search?q=${encodeURIComponent(trimmed)}`);
    setQ("");
    setHistOpen(false);
    setMenuOpen(false);
    // Invalidate cached history so the new search appears next time
    setHistLoaded(false);
  }

  function pickHistory(patentNumber) {
    navigate(`/search?q=${encodeURIComponent(patentNumber)}`);
    setHistOpen(false);
    setMenuOpen(false);
    setHistLoaded(false);
  }

  function closeMenu() { setMenuOpen(false); }

  const histDropdown = histOpen && history.length > 0 && (
    <div style={dd.wrap}>
      <div style={dd.header}>Recent searches</div>
      {history.map((h) => (
        <button key={h.id} style={dd.item} onMouseDown={() => pickHistory(h.patent_number)}>
          <span style={dd.num}>{h.patent_number}</span>
          <span style={dd.meta}>
            {h.granted_count}✓ {h.pending_count} pending · {timeAgo(h.searched_at)}
          </span>
          <span style={dd.title}>{h.title}</span>
        </button>
      ))}
    </div>
  );

  /* ── Mobile layout ─────────────────────────────────── */
  if (isMobile) {
    return (
      <>
        <nav style={s.navMobile}>
          <button style={s.brandBtn} onClick={() => navigate("/portfolio")}>PatentQ<span style={s.version}>β 1.1</span></button>

          <div style={{ ...s.searchFormMobile, position: "relative" }}>
            <form onSubmit={handleSearch} style={{ display: "flex", gap: 4, flex: 1 }}>
              <input
                style={s.searchInputMobile}
                placeholder="Patent number…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onFocus={handleFocus}
                onBlur={handleBlur}
                aria-label="Search patent number"
              />
              <button style={s.searchBtnMobile} type="submit">🔍</button>
            </form>
            {histDropdown}
          </div>

          <button style={s.hamburger} onClick={() => setMenuOpen((o) => !o)} aria-label="Toggle menu">
            {menuOpen ? "✕" : "☰"}
          </button>
        </nav>

        {menuOpen && (
          <div style={s.mobileMenu}>
            <MobileNavLink to="/portfolio" onClick={closeMenu}>Portfolio</MobileNavLink>
            <MobileNavLink to="/alerts"    onClick={closeMenu}>Alerts</MobileNavLink>
            <MobileNavLink to="/settings"  onClick={closeMenu}>Settings</MobileNavLink>
            <div style={s.menuDivider} />
            <div style={s.menuEmail}>{user?.email}</div>
            <button style={s.menuSignOut} onClick={() => { closeMenu(); logout(); }}>Sign out</button>
          </div>
        )}
        {menuOpen && <div style={s.menuOverlay} onClick={closeMenu} />}
      </>
    );
  }

  /* ── Desktop layout ─────────────────────────────────── */
  return (
    <nav style={s.nav}>
      <button style={s.brandBtn} onClick={() => navigate("/portfolio")}>PatentQ<span style={s.version}>β 1.1</span></button>

      <div style={{ position: "relative", flex: 1, maxWidth: 420, minWidth: 180 }}>
        <form onSubmit={handleSearch} style={s.searchForm}>
          <input
            style={s.searchInput}
            placeholder="Patent number…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={handleFocus}
            onBlur={handleBlur}
            aria-label="Search patent number"
          />
          <button style={s.searchBtn} type="submit">Search</button>
        </form>
        {histDropdown}
      </div>

      <div style={s.links}>
        <NavLink to="/portfolio" style={navStyle}>Portfolio</NavLink>
        <NavLink to="/alerts"    style={navStyle}>Alerts</NavLink>
        <NavLink to="/settings"  style={navStyle}>Settings</NavLink>
      </div>

      <div style={s.user}>
        <span style={s.email}>{user?.email}</span>
        <button style={s.logoutBtn} onClick={logout}>Sign out</button>
      </div>
    </nav>
  );
}

function MobileNavLink({ to, onClick, children }) {
  return (
    <NavLink to={to} onClick={onClick} style={({ isActive }) => ({
      display: "block", padding: "12px 20px",
      color: isActive ? "#1a73e8" : "#1a1a2e",
      fontWeight: isActive ? 700 : 500, textDecoration: "none", fontSize: 16,
      borderLeft: isActive ? "3px solid #1a73e8" : "3px solid transparent",
      background: isActive ? "#e8f0fe" : "transparent",
    })}>
      {children}
    </NavLink>
  );
}

function navStyle({ isActive }) {
  return {
    color: isActive ? "#fff" : "rgba(255,255,255,.75)",
    textDecoration: "none", fontWeight: isActive ? 700 : 400,
    padding: "4px 0", borderBottom: isActive ? "2px solid #fff" : "2px solid transparent",
    fontSize: 15, transition: "all .15s", whiteSpace: "nowrap",
  };
}

/* ── Dropdown styles ── */
const dd = {
  wrap: {
    position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0,
    background: "#fff", borderRadius: 10, zIndex: 400,
    boxShadow: "0 8px 28px rgba(0,0,0,.16)", border: "1px solid #e0e0e0",
    overflow: "hidden",
  },
  header: {
    padding: "8px 14px 6px", fontSize: 11, fontWeight: 700,
    textTransform: "uppercase", letterSpacing: ".06em", color: "#9ca3af",
    borderBottom: "1px solid #f0f0f0",
  },
  item: {
    display: "flex", flexDirection: "column", alignItems: "flex-start",
    width: "100%", padding: "9px 14px", border: "none", background: "transparent",
    cursor: "pointer", textAlign: "left", borderBottom: "1px solid #f5f5f5",
    gap: 2,
  },
  num:   { fontSize: 13, fontWeight: 700, color: "#1a73e8" },
  meta:  { fontSize: 11, color: "#9ca3af" },
  title: { fontSize: 12, color: "#555", overflow: "hidden", textOverflow: "ellipsis",
    whiteSpace: "nowrap", maxWidth: "100%" },
};

/* ── Component styles ── */
const s = {
  nav: {
    display: "flex", alignItems: "center", gap: 18,
    background: "#1a1a2e", padding: "0 1.5rem", height: 56,
    position: "sticky", top: 0, zIndex: 100,
    boxShadow: "0 2px 8px rgba(0,0,0,.3)",
  },
  brand: {
    color: "#fff", fontWeight: 800, fontSize: 18, letterSpacing: "-0.02em",
    whiteSpace: "nowrap", flexShrink: 0, display: "flex", alignItems: "baseline", gap: 6,
  },
  brandBtn: {
    color: "#fff", fontWeight: 800, fontSize: 18, letterSpacing: "-0.02em",
    whiteSpace: "nowrap", flexShrink: 0, display: "flex", alignItems: "baseline", gap: 6,
    background: "transparent", border: "none", cursor: "pointer", padding: 0,
    fontFamily: "inherit", lineHeight: "inherit",
  },
  version: {
    fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,.55)",
    background: "rgba(255,255,255,.12)", borderRadius: 4, padding: "1px 5px",
    letterSpacing: "0.03em",
  },
  searchForm: { display: "flex", gap: 6, width: "100%" },
  searchInput: {
    flex: 1, padding: "6px 12px", borderRadius: 7,
    border: "1px solid rgba(255,255,255,.25)", background: "rgba(255,255,255,.1)",
    color: "#fff", fontSize: 14, outline: "none",
  },
  searchBtn: {
    padding: "6px 14px", borderRadius: 7, background: "#1a73e8",
    color: "#fff", border: "none", fontSize: 14, cursor: "pointer",
    fontWeight: 600, whiteSpace: "nowrap",
  },
  links:     { display: "flex", gap: 22, flexShrink: 0 },
  user:      { display: "flex", alignItems: "center", gap: 10, marginLeft: "auto", flexShrink: 0 },
  email: {
    color: "rgba(255,255,255,.6)", fontSize: 12,
    maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  logoutBtn: {
    padding: "5px 12px", borderRadius: 6, background: "transparent",
    border: "1px solid rgba(255,255,255,.4)", color: "#fff",
    cursor: "pointer", fontSize: 13, whiteSpace: "nowrap",
  },
  navMobile: {
    display: "flex", alignItems: "center", gap: 10,
    background: "#1a1a2e", padding: "0 12px", height: 52,
    position: "sticky", top: 0, zIndex: 200,
    boxShadow: "0 2px 8px rgba(0,0,0,.3)",
  },
  searchFormMobile: { display: "flex", gap: 4, flex: 1, minWidth: 0 },
  searchInputMobile: {
    flex: 1, padding: "6px 10px", borderRadius: 7, minWidth: 0,
    border: "1px solid rgba(255,255,255,.25)", background: "rgba(255,255,255,.1)",
    color: "#fff", fontSize: 14, outline: "none",
  },
  searchBtnMobile: {
    padding: "6px 10px", borderRadius: 7, background: "#1a73e8",
    color: "#fff", border: "none", fontSize: 16, cursor: "pointer",
  },
  hamburger: {
    background: "transparent", border: "1px solid rgba(255,255,255,.35)",
    color: "#fff", borderRadius: 7, padding: "5px 10px",
    fontSize: 18, cursor: "pointer", flexShrink: 0, lineHeight: 1,
  },
  mobileMenu: {
    position: "fixed", top: 52, right: 0, width: 260,
    background: "#fff", boxShadow: "0 8px 24px rgba(0,0,0,.18)",
    borderRadius: "0 0 0 12px", zIndex: 300, paddingTop: 8, paddingBottom: 16,
  },
  menuDivider: { height: 1, background: "#e0e0e0", margin: "8px 0" },
  menuEmail: {
    padding: "6px 20px", fontSize: 12, color: "#888",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  menuSignOut: {
    width: "calc(100% - 40px)", margin: "4px 20px 0", padding: "9px 0",
    borderRadius: 8, border: "1px solid #f5c6cb", background: "#fff",
    color: "#d32f2f", cursor: "pointer", fontSize: 14, fontWeight: 600,
  },
  menuOverlay: { position: "fixed", inset: 0, zIndex: 299 },
};
