import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";
import { useIsMobile } from "./useIsMobile";

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate  = useNavigate();
  const isMobile  = useIsMobile(720);
  const [q, setQ] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  function handleSearch(e) {
    e.preventDefault();
    const trimmed = q.trim();
    if (!trimmed) return;
    navigate(`/search?q=${encodeURIComponent(trimmed)}`);
    setQ("");
    setMenuOpen(false);
  }

  function closeMenu() { setMenuOpen(false); }

  /* ── Mobile layout ─────────────────────────────────── */
  if (isMobile) {
    return (
      <>
        <nav style={styles.navMobile}>
          {/* Brand */}
          <div style={styles.brand}>
            PatentQ
            <span style={styles.version}>β 0.3</span>
          </div>

          {/* Search — takes remaining width */}
          <form onSubmit={handleSearch} style={styles.searchFormMobile}>
            <input
              style={styles.searchInputMobile}
              placeholder="Patent number…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search patent number"
            />
            <button style={styles.searchBtnMobile} type="submit">🔍</button>
          </form>

          {/* Hamburger */}
          <button
            style={styles.hamburger}
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Toggle menu"
          >
            {menuOpen ? "✕" : "☰"}
          </button>
        </nav>

        {/* Dropdown menu */}
        {menuOpen && (
          <div style={styles.mobileMenu}>
            <MobileNavLink to="/portfolio" onClick={closeMenu}>Portfolio</MobileNavLink>
            <MobileNavLink to="/alerts"    onClick={closeMenu}>Alerts</MobileNavLink>
            <MobileNavLink to="/settings"  onClick={closeMenu}>Settings</MobileNavLink>
            <div style={styles.menuDivider} />
            <div style={styles.menuEmail}>{user?.email}</div>
            <button style={styles.menuSignOut} onClick={() => { closeMenu(); logout(); }}>
              Sign out
            </button>
          </div>
        )}

        {/* Tap-outside overlay to close menu */}
        {menuOpen && (
          <div style={styles.menuOverlay} onClick={closeMenu} />
        )}
      </>
    );
  }

  /* ── Desktop layout ─────────────────────────────────── */
  return (
    <nav style={styles.nav}>
      <div style={styles.brand}>
        PatentQ
        <span style={styles.version}>β 0.3</span>
      </div>

      <form onSubmit={handleSearch} style={styles.searchForm}>
        <input
          style={styles.searchInput}
          placeholder="Patent number…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search patent number"
        />
        <button style={styles.searchBtn} type="submit">Search</button>
      </form>

      <div style={styles.links}>
        <NavLink to="/portfolio" style={navStyle}>Portfolio</NavLink>
        <NavLink to="/alerts"    style={navStyle}>Alerts</NavLink>
        <NavLink to="/settings"  style={navStyle}>Settings</NavLink>
      </div>

      <div style={styles.user}>
        <span style={styles.email}>{user?.email}</span>
        <button style={styles.logoutBtn} onClick={logout}>Sign out</button>
      </div>
    </nav>
  );
}

function MobileNavLink({ to, onClick, children }) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      style={({ isActive }) => ({
        display: "block",
        padding: "12px 20px",
        color: isActive ? "#1a73e8" : "#1a1a2e",
        fontWeight: isActive ? 700 : 500,
        textDecoration: "none",
        fontSize: 16,
        borderLeft: isActive ? "3px solid #1a73e8" : "3px solid transparent",
        background: isActive ? "#e8f0fe" : "transparent",
      })}
    >
      {children}
    </NavLink>
  );
}

function navStyle({ isActive }) {
  return {
    color: isActive ? "#fff" : "rgba(255,255,255,.75)",
    textDecoration: "none",
    fontWeight: isActive ? 700 : 400,
    padding: "4px 0",
    borderBottom: isActive ? "2px solid #fff" : "2px solid transparent",
    fontSize: 15,
    transition: "all .15s",
    whiteSpace: "nowrap",
  };
}

const styles = {
  /* ── Desktop ── */
  nav: {
    display: "flex", alignItems: "center", gap: 18,
    background: "#1a1a2e", padding: "0 1.5rem", height: 56,
    position: "sticky", top: 0, zIndex: 100,
    boxShadow: "0 2px 8px rgba(0,0,0,.3)",
  },
  brand: {
    color: "#fff", fontWeight: 800, fontSize: 18,
    letterSpacing: "-0.02em", whiteSpace: "nowrap", flexShrink: 0,
    display: "flex", alignItems: "baseline", gap: 6,
  },
  version: {
    fontSize: 10, fontWeight: 600, color: "rgba(255,255,255,.55)",
    background: "rgba(255,255,255,.12)", borderRadius: 4,
    padding: "1px 5px", letterSpacing: "0.03em",
  },
  searchForm: { display: "flex", gap: 6, flex: 1, maxWidth: 380, minWidth: 180 },
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

  /* ── Mobile nav bar ── */
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

  /* ── Mobile dropdown menu ── */
  mobileMenu: {
    position: "fixed", top: 52, right: 0, width: 260,
    background: "#fff", boxShadow: "0 8px 24px rgba(0,0,0,.18)",
    borderRadius: "0 0 0 12px", zIndex: 300,
    paddingTop: 8, paddingBottom: 16,
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
  menuOverlay: {
    position: "fixed", inset: 0, zIndex: 299,
    background: "transparent",
  },
};
