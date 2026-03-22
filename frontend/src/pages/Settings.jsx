import { useState } from "react";
import { useAuth } from "../AuthContext";
import { updatePassword, EmailAuthProvider, reauthenticateWithCredential } from "firebase/auth";
import { useIsMobile } from "../useIsMobile";

export default function Settings() {
  const { user, logout } = useAuth();
  const isMobile = useIsMobile();
  const [section, setSection] = useState("account");

  // Password change state
  const [currentPw, setCurrentPw]   = useState("");
  const [newPw,     setNewPw]       = useState("");
  const [confirmPw, setConfirmPw]   = useState("");
  const [pwMsg,     setPwMsg]       = useState(null);
  const [pwLoading, setPwLoading]   = useState(false);

  async function handleChangePassword(e) {
    e.preventDefault();
    if (newPw !== confirmPw) { setPwMsg({ type: "error", text: "New passwords do not match." }); return; }
    if (newPw.length < 8)    { setPwMsg({ type: "error", text: "Password must be at least 8 characters." }); return; }
    setPwLoading(true);
    setPwMsg(null);
    try {
      const cred = EmailAuthProvider.credential(user.email, currentPw);
      await reauthenticateWithCredential(user, cred);
      await updatePassword(user, newPw);
      setPwMsg({ type: "success", text: "Password updated successfully." });
      setCurrentPw(""); setNewPw(""); setConfirmPw("");
    } catch (err) {
      const msg = err.code === "auth/wrong-password"
        ? "Current password is incorrect."
        : err.message;
      setPwMsg({ type: "error", text: msg });
    } finally {
      setPwLoading(false);
    }
  }

  const isGoogle = user?.providerData?.[0]?.providerId === "google.com";

  return (
    <div style={styles.page}>
      <h2 style={styles.heading}>Settings</h2>

      <div style={isMobile ? styles.layoutMobile : styles.layout}>
        {/* Sidebar nav — horizontal pill tabs on mobile, vertical list on desktop */}
        <nav style={isMobile ? styles.tabBar : styles.sidebar}>
          {[
            { key: "account",       label: "Account" },
            { key: "notifications", label: "Notifications" },
            { key: "about",         label: "About" },
          ].map(({ key, label }) => (
            <button
              key={key}
              style={section === key
                ? (isMobile ? styles.tabActive : styles.sideItemActive)
                : (isMobile ? styles.tab      : styles.sideItem)}
              onClick={() => setSection(key)}
            >
              {label}
            </button>
          ))}
        </nav>

        {/* Main panel */}
        <div style={styles.panel}>

          {section === "account" && (
            <div>
              <h3 style={styles.sectionTitle}>Account</h3>
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>Email</span>
                <span style={styles.infoValue}>{user?.email}</span>
              </div>
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>Sign-in method</span>
                <span style={styles.infoValue}>{isGoogle ? "Google" : "Email / password"}</span>
              </div>

              {!isGoogle && (
                <div style={styles.subSection}>
                  <h4 style={styles.subTitle}>Change Password</h4>
                  <form onSubmit={handleChangePassword} style={styles.form}>
                    <label style={styles.label}>Current password
                      <input type="password" style={styles.input} value={currentPw}
                        onChange={(e) => setCurrentPw(e.target.value)} required />
                    </label>
                    <label style={styles.label}>New password
                      <input type="password" style={styles.input} value={newPw}
                        onChange={(e) => setNewPw(e.target.value)} required />
                    </label>
                    <label style={styles.label}>Confirm new password
                      <input type="password" style={styles.input} value={confirmPw}
                        onChange={(e) => setConfirmPw(e.target.value)} required />
                    </label>
                    {pwMsg && (
                      <div style={{ ...styles.msg, background: pwMsg.type === "error" ? "#fdecea" : "#e8f5e9",
                        color: pwMsg.type === "error" ? "#c62828" : "#2e7d32" }}>
                        {pwMsg.text}
                      </div>
                    )}
                    <button type="submit" style={styles.saveBtn} disabled={pwLoading}>
                      {pwLoading ? "Updating…" : "Update Password"}
                    </button>
                  </form>
                </div>
              )}

              <div style={{ marginTop: 32, borderTop: "1px solid #e0e0e0", paddingTop: 20 }}>
                <button style={styles.signOutBtn} onClick={logout}>Sign out of PatentQ</button>
              </div>
            </div>
          )}

          {section === "notifications" && (
            <div>
              <h3 style={styles.sectionTitle}>Notifications</h3>
              <p style={{ color: "#666", fontSize: 14 }}>
                Deadline alert thresholds and email digest settings will be available in a future release.
                Currently, all upcoming fees within the window you select on the Alerts page are shown automatically.
              </p>
            </div>
          )}

          {section === "about" && (
            <div>
              <h3 style={styles.sectionTitle}>About PatentQ</h3>
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>Version</span>
                <span style={styles.infoValue}>β 1.3</span>
              </div>
              <div style={styles.infoRow}>
                <span style={styles.infoLabel}>Data sources</span>
                <span style={styles.infoValue}>Google Patents, USPTO PEDS, EPO OPS</span>
              </div>
              <p style={{ color: "#666", fontSize: 13, marginTop: 16, lineHeight: 1.6 }}>
                PatentQ aggregates patent family status, prosecution history, and maintenance fee
                schedules from public patent office databases. It is provided for informational
                purposes only and does not constitute legal advice.
              </p>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}

const styles = {
  page:    { padding: "1.5rem", maxWidth: 900, margin: "0 auto" },
  heading: { marginTop: 0, color: "#1a1a2e" },
  /* Desktop: sidebar left + panel right */
  layout:       { display: "flex", gap: 24, alignItems: "flex-start" },
  /* Mobile: tabs across top + panel below */
  layoutMobile: { display: "flex", flexDirection: "column", gap: 12 },
  sidebar: { display: "flex", flexDirection: "column", gap: 4,
    minWidth: 160, flexShrink: 0 },
  /* Mobile: horizontal pill tab bar */
  tabBar: { display: "flex", gap: 6, flexWrap: "wrap" },
  tab: { padding: "8px 16px", borderRadius: 20, border: "1px solid #d0d7de",
    background: "#fff", cursor: "pointer", fontSize: 14, color: "#444", fontWeight: 500 },
  tabActive: { padding: "8px 16px", borderRadius: 20, border: "none",
    background: "#1a73e8", color: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 700 },
  sideItem: { padding: "9px 16px", borderRadius: 8, border: "none",
    background: "transparent", textAlign: "left", cursor: "pointer",
    fontSize: 14, color: "#444", fontWeight: 400 },
  sideItemActive: { padding: "9px 16px", borderRadius: 8, border: "none",
    background: "#e8f0fe", textAlign: "left", cursor: "pointer",
    fontSize: 14, color: "#1a73e8", fontWeight: 700 },
  panel:       { flex: 1, background: "#fff", borderRadius: 10,
    border: "1px solid #e0e0e0", padding: "1.5rem",
    boxShadow: "0 2px 6px rgba(0,0,0,.04)" },
  sectionTitle: { marginTop: 0, color: "#1a1a2e", fontSize: 17, marginBottom: 20 },
  subSection:  { marginTop: 24, paddingTop: 20, borderTop: "1px solid #f0f0f0" },
  subTitle:    { marginTop: 0, fontSize: 15, color: "#333" },
  infoRow:     { display: "flex", gap: 16, alignItems: "baseline",
    padding: "8px 0", borderBottom: "1px solid #f5f5f5" },
  infoLabel:   { width: 140, flexShrink: 0, fontSize: 13, color: "#888", fontWeight: 600 },
  infoValue:   { fontSize: 14, color: "#333" },
  form:        { display: "flex", flexDirection: "column", gap: 14, maxWidth: 380 },
  label:       { display: "flex", flexDirection: "column", gap: 4,
    fontSize: 13, color: "#555", fontWeight: 600 },
  input:       { padding: "8px 12px", borderRadius: 7, border: "1px solid #d0d7de",
    fontSize: 14, outline: "none", marginTop: 2 },
  msg:         { padding: "8px 12px", borderRadius: 7, fontSize: 13 },
  saveBtn:     { padding: "9px 20px", borderRadius: 8, background: "#1a73e8",
    color: "#fff", border: "none", cursor: "pointer", fontWeight: 700,
    fontSize: 14, alignSelf: "flex-start" },
  signOutBtn:  { padding: "9px 20px", borderRadius: 8, background: "#fff",
    color: "#d32f2f", border: "1px solid #f5c6cb", cursor: "pointer",
    fontSize: 14, fontWeight: 600 },
};
