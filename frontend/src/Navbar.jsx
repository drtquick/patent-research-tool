import { NavLink } from "react-router-dom";
import { useAuth } from "./AuthContext";

export default function Navbar() {
  const { user, logout } = useAuth();

  return (
    <nav style={styles.nav}>
      <div style={styles.brand}>⚖️ Patent Research Tool</div>
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
  };
}

const styles = {
  nav: {
    display: "flex", alignItems: "center", gap: 24,
    background: "#1a1a2e", padding: "0 2rem", height: 56,
    position: "sticky", top: 0, zIndex: 100,
    boxShadow: "0 2px 8px rgba(0,0,0,.3)",
  },
  brand: { color: "#fff", fontWeight: 700, fontSize: 16, marginRight: 8 },
  links: { display: "flex", gap: 24, flex: 1 },
  user: { display: "flex", alignItems: "center", gap: 12 },
  email: { color: "rgba(255,255,255,.6)", fontSize: 13,
    maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  logoutBtn: {
    padding: "5px 14px", borderRadius: 6, background: "transparent",
    border: "1px solid rgba(255,255,255,.4)", color: "#fff",
    cursor: "pointer", fontSize: 13,
  },
};
