import { useState } from "react";

const COUNTRIES = [
  "US","WO","EP","CN","JP","KR","AU","CA","GB","DE","FR","IT","ES","IN",
  "BR","MX","RU","SE","NL","CH","IL","ZA","SG","NZ","AT","BE","PL","FI",
  "NO","DK","PT","HU","CZ","RO","TR","TW","AR","CL","CO","EG","SA","AE",
];

const STATUS_OPTIONS = [
  { value: "pending",   label: "Pending" },
  { value: "granted",   label: "Granted" },
  { value: "abandoned", label: "Abandoned" },
  { value: "expired",   label: "Expired" },
  { value: "rejected",  label: "Rejected" },
  { value: "unknown",   label: "Unknown" },
];

/**
 * Modal for editing an existing tile or adding a new manual tile.
 * Props:
 *   mode       — "edit" or "add"
 *   tileData   — initial field values (for edit mode)
 *   onSave     — (fields, isManual) => Promise
 *   onDelete   — () => Promise  (only for edit mode, to revert overrides)
 *   onClose    — () => void
 *   saving     — boolean
 */
export default function TileEditModal({ mode, tileData, onSave, onDelete, onClose, saving }) {
  const isAdd = mode === "add";

  const [fields, setFields] = useState({
    app_num:     tileData?.app_num || "",
    pub_num:     tileData?.pub_num || "",
    title:       tileData?.title || "",
    status:      tileData?.status || "pending",
    country:     tileData?.country || "US",
    filing_date: tileData?.filing_date === "\u2014" ? "" : (tileData?.filing_date || ""),
    grant_date:  tileData?.grant_date || "",
    inventors:   tileData?.inventors || "",
    assignee:    tileData?.assignee || "",
  });

  function handleChange(key, value) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (isAdd && !fields.app_num && !fields.pub_num) {
      alert("Please enter at least an application number or publication number.");
      return;
    }
    onSave(fields, isAdd || tileData?.is_manual);
  }

  return (
    <div style={s.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={s.modal}>
        <div style={s.header}>
          <h3 style={s.headerTitle}>
            {isAdd ? "Add Family Member" : `Edit Tile: ${fields.app_num || fields.pub_num}`}
          </h3>
          <button style={s.closeBtn} onClick={onClose}>&times;</button>
        </div>

        <form onSubmit={handleSubmit} style={s.form}>
          <div style={s.row}>
            <Field label="Application Number" value={fields.app_num}
              onChange={(v) => handleChange("app_num", v)}
              placeholder="e.g. 19/276,489" />
            <Field label="Publication Number" value={fields.pub_num}
              onChange={(v) => handleChange("pub_num", v)}
              placeholder="e.g. US12178560B2" />
          </div>

          <Field label="Title / Invention Name" value={fields.title}
            onChange={(v) => handleChange("title", v)}
            placeholder="Brief description of the invention" fullWidth />

          <div style={s.row}>
            <div style={s.fieldWrap}>
              <label style={s.label}>Country</label>
              <select style={s.select} value={fields.country}
                onChange={(e) => handleChange("country", e.target.value)}>
                {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div style={s.fieldWrap}>
              <label style={s.label}>Status</label>
              <select style={s.select} value={fields.status}
                onChange={(e) => handleChange("status", e.target.value)}>
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div style={s.row}>
            <Field label="Filing Date" value={fields.filing_date}
              onChange={(v) => handleChange("filing_date", v)}
              placeholder="YYYY-MM-DD" type="date" />
            <Field label="Grant / Publication Date" value={fields.grant_date}
              onChange={(v) => handleChange("grant_date", v)}
              placeholder="YYYY-MM-DD" type="date" />
          </div>

          <div style={s.row}>
            <Field label="Inventors" value={fields.inventors}
              onChange={(v) => handleChange("inventors", v)}
              placeholder="e.g. Smith, John; Doe, Jane" />
            <Field label="Assignee" value={fields.assignee}
              onChange={(v) => handleChange("assignee", v)}
              placeholder="e.g. Acme Corp." />
          </div>

          <div style={s.actions}>
            {!isAdd && !tileData?.is_manual && onDelete && (
              <button type="button" style={s.revertBtn} onClick={onDelete} disabled={saving}>
                Revert to API Data
              </button>
            )}
            <div style={{ flex: 1 }} />
            <button type="button" style={s.cancelBtn} onClick={onClose}>Cancel</button>
            <button type="submit" style={s.saveBtn} disabled={saving}>
              {saving ? "Saving..." : isAdd ? "Add Tile" : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = "text", fullWidth }) {
  return (
    <div style={{ ...s.fieldWrap, ...(fullWidth ? { flex: "1 1 100%" } : {}) }}>
      <label style={s.label}>{label}</label>
      <input
        style={s.input}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

const s = {
  overlay: {
    position: "fixed", inset: 0, background: "rgba(0,0,0,.5)",
    display: "flex", alignItems: "center", justifyContent: "center",
    zIndex: 1100,
  },
  modal: {
    background: "#fff", borderRadius: 14, width: "90%", maxWidth: 620,
    maxHeight: "90vh", overflow: "auto",
    boxShadow: "0 20px 60px rgba(0,0,0,.3)",
  },
  header: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "18px 24px", borderBottom: "1px solid #e5e7eb",
  },
  headerTitle: { margin: 0, fontSize: 17, fontWeight: 700, color: "#1a1a2e" },
  closeBtn: {
    background: "none", border: "none", fontSize: 24, cursor: "pointer",
    color: "#999", lineHeight: 1,
  },
  form: { padding: "20px 24px" },
  row: { display: "flex", gap: 14, marginBottom: 14, flexWrap: "wrap" },
  fieldWrap: { flex: "1 1 45%", minWidth: 200 },
  label: {
    display: "block", fontSize: 12, fontWeight: 700, color: "#555",
    marginBottom: 4, textTransform: "uppercase", letterSpacing: ".04em",
  },
  input: {
    width: "100%", padding: "8px 10px", borderRadius: 6,
    border: "1px solid #d1d5db", fontSize: 14, fontFamily: "inherit",
    boxSizing: "border-box",
  },
  select: {
    width: "100%", padding: "8px 10px", borderRadius: 6,
    border: "1px solid #d1d5db", fontSize: 14, fontFamily: "inherit",
    boxSizing: "border-box", background: "#fff",
  },
  actions: {
    display: "flex", gap: 10, alignItems: "center",
    marginTop: 20, paddingTop: 16, borderTop: "1px solid #f0f0f0",
  },
  cancelBtn: {
    padding: "9px 20px", borderRadius: 8, border: "1px solid #d0d7de",
    background: "#fff", cursor: "pointer", fontSize: 14, fontWeight: 600, color: "#444",
  },
  saveBtn: {
    padding: "9px 22px", borderRadius: 8, border: "none",
    background: "#1e40af", color: "#fff", cursor: "pointer",
    fontSize: 14, fontWeight: 700,
  },
  revertBtn: {
    padding: "9px 18px", borderRadius: 8, border: "1px solid #fca5a5",
    background: "#fff5f5", cursor: "pointer", fontSize: 13, fontWeight: 600,
    color: "#c62828",
  },
};
