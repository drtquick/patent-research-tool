import { useState } from "react";
import { useIsMobile } from "./useIsMobile";

export default function PrintBar({ iframeRef }) {
  const [familyList,    setFamilyList]    = useState(true);
  const [deadlines,     setDeadlines]     = useState(true);
  const [usFees,        setUsFees]        = useState(true);
  const [foreignFees,   setForeignFees]   = useState(true);
  const isMobile = useIsMobile();

  function handlePrint() {
    const win = iframeRef.current?.contentWindow;
    const doc = iframeRef.current?.contentDocument;
    if (!win || !doc) { window.print(); return; }

    // Ensure the printable overview block exists (tracker.py renders it as
    // hidden-by-default so the on-screen dashboard is unchanged; we reveal
    // sections based on the selected checkboxes).
    const familyEl   = doc.getElementById("print-family-list");
    const deadlineEl = doc.getElementById("print-deadlines-list");
    const usFeeEls   = doc.querySelectorAll("details.maint-fees");
    const forFeeEls  = doc.querySelectorAll("details.history[data-fee-type='annuity']");

    function toggle(el, include) {
      if (!el) return;
      el.classList.toggle("print-hide", !include);
      if (el.tagName === "DETAILS" && include) el.open = true;
    }

    toggle(familyEl, familyList);
    toggle(deadlineEl, deadlines);
    usFeeEls.forEach((el) => toggle(el, usFees));
    forFeeEls.forEach((el) => toggle(el, foreignFees));

    win.print();

    setTimeout(() => {
      familyEl?.classList.remove("print-hide");
      deadlineEl?.classList.remove("print-hide");
      usFeeEls.forEach((el) => el.classList.remove("print-hide"));
      forFeeEls.forEach((el) => el.classList.remove("print-hide"));
    }, 1500);
  }

  return (
    <div style={isMobile ? styles.barMobile : styles.bar}>
      {!isMobile && <span style={styles.label}>🖨 Print Report</span>}
      <label style={styles.check}>
        <input type="checkbox" checked={familyList} onChange={(e) => setFamilyList(e.target.checked)} />
        Family list
      </label>
      <label style={styles.check}>
        <input type="checkbox" checked={deadlines} onChange={(e) => setDeadlines(e.target.checked)} />
        Upcoming deadlines
      </label>
      <label style={styles.check}>
        <input type="checkbox" checked={usFees} onChange={(e) => setUsFees(e.target.checked)} />
        US maintenance fees
      </label>
      <label style={styles.check}>
        <input type="checkbox" checked={foreignFees} onChange={(e) => setForeignFees(e.target.checked)} />
        Foreign annuities
      </label>
      <button style={isMobile ? styles.btnMobile : styles.btn} onClick={handlePrint}>
        🖨 {isMobile ? "Print" : "Print / Save PDF"}
      </button>
    </div>
  );
}

const styles = {
  bar: {
    display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
    background: "#fff", borderRadius: 10,
    padding: "8px 18px", border: "1px solid #e8edf2",
    fontSize: 13, color: "#374151", marginBottom: 8,
  },
  barMobile: {
    display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
    background: "#fff", borderRadius: 10,
    padding: "10px 14px", border: "1px solid #e8edf2",
    fontSize: 13, color: "#374151", marginBottom: 8,
  },
  label:  { fontWeight: 700, fontSize: 12, color: "#0f172a", marginRight: 2 },
  check:  { display: "flex", alignItems: "center", gap: 5, cursor: "pointer" },
  btn: {
    marginLeft: "auto", padding: "6px 16px", borderRadius: 7,
    background: "#1a73e8", color: "#fff", border: "none",
    fontSize: 13, fontWeight: 600, cursor: "pointer",
  },
  btnMobile: {
    padding: "8px 18px", borderRadius: 7,
    background: "#1a73e8", color: "#fff", border: "none",
    fontSize: 13, fontWeight: 600, cursor: "pointer",
  },
};
