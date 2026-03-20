import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthContext";

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState("");

  function handleSearch(e) {
    e.preventDefault();
    const trimmed = q.trim();
    if (!trimmed) return;
    navigate(`/search?q=${encodeURIComponent(trimmed)}`);
    setQ("");
  }

  return (
    <nav style={styles.nav}>
      <div style={styles.brand}>PatentQ</div>

      {/* Inline search bar */}
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
        <NavLink to="/search" style={navStyle}>Search</NavLink>
        <NavLink to="/portfolio" style={navStyle}>Portfolio</NavLink>
        <NavLink to="/alerts" style={navStyle}>Alerts</NavLink>
      </div>
      <div style={styles.user}>
        <span style={styles.email}>{user?.email}</span>
        <button style={styles.logoutBtn} onClick={logout}>Sign out</button>
      </div>
    </nav>
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
  nav: {
    display: "flex", alignItems: "center", gap: 18,
    background: "#1a1a2e", padding: "0 1.5rem", height: 56,
    position: "sticky", top: 0, zIndex: 100,
    boxShadow: "0 2px 8px rgba(0,0,0,.3)",
  },
  brand: {
    color: "#fff", fontWeight: 800, fontSize: 18,
    letterSpacing: "-0.02em", whiteSpace: "nowrap", flexShrink: 0,
  },
  searchForm: {
    display: "flex", gap: 6, flex: 1, maxWidth: 380, minWidth: 180,
  },
  searchInput: {
    flex: 1, padding: "6px 12px", borderRadius: 7,
    border: "1px solid rgba(255,255,255,.25)", background: "rgba(255,255,255,.1)",
    color: "#fff", fontSize: 14, outline: "none",
    "::placeholder": { color: "rgba(255,255,255,.5)" },
  },
  searchBtn: {
    padding: "6px 14px", borderRadius: 7, background: "#1a73e8",
    color: "#fff", border: "none", fontSize: 14, cursor: "pointer",
    fontWeight: 600, whiteSpace: "nowrap",
  },
  links: { display: "flex", gap: 22, flexShrink: 0 },
  user: { display: "flex", alignItems: "center", gap: 10, marginLeft: "auto", flexShrink: 0 },
  email: {
    color: "rgba(255,255,255,.6)", fontSize: 12,
    maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  logoutBtn: {
    padding: "5px 12px", borderRadius: 6, background: "transparent",
    border: "1px solid rgba(255,255,255,.4)", color: "#fff",
    cursor: "pointer", fontSize: 13, whiteSpace: "nowrap",
  },
};
