import { useState, useRef } from "react";

/**
 * PrintBar — sits above an iframe and lets the user choose which sections
 * to include before printing. Works with both freshly-generated and
 * Firestore-cached dashboard HTML because it operates on the live iframe DOM.
 *
 * Usage:
 *   const iframeRef = useRef(null);
 *   <PrintBar iframeRef={iframeRef} />
 *   <iframe ref={iframeRef} ... />
 */
export default function PrintBar({ iframeRef }) {
  const [abstract, setAbstract] = useState(true);
  const [claims,   setClaims]   = useState(true);
  const [fees,     setFees]     = useState(true);

  function handlePrint() {
    const win = iframeRef.current?.contentWindow;
    const doc = iframeRef.current?.contentDocument;
    if (!win || !doc) { window.print(); return; }

    // Toggle sections in the iframe DOM
    const abstractEl = doc.querySelector(".abstract-details");
    const claimsEl   = doc.querySelector(".claims-tab");
    const feesEl     = doc.getElementById("portfolio-fees-section");

    if (abstractEl) {
      abstractEl.classList.toggle("print-hide", !abstract);
      if (abstract) abstractEl.open = true;
    }
    if (claimsEl) {
      claimsEl.classList.toggle("print-hide", !claims);
      if (claims) claimsEl.open = true;
    }
    if (feesEl) feesEl.classList.toggle("print-hide", !fees);

    win.print();

    // Restore after dialog closes
    setTimeout(() => {
      abstractEl?.classList.remove("print-hide");
      claimsEl?.classList.remove("print-hide");
      feesEl?.classList.remove("print-hide");
    }, 1500);
  }

  return (
    <div style={styles.bar}>
      <span style={styles.label}>🖨 Print Report</span>
      <label style={styles.check}>
        <input type="checkbox" checked={abstract} onChange={e => setAbstract(e.target.checked)} />
        Abstract
      </label>
      <label style={styles.check}>
        <input type="checkbox" checked={claims} onChange={e => setClaims(e.target.checked)} />
        Granted Claims
      </label>
      <label style={styles.check}>
        <input type="checkbox" checked={fees} onChange={e => setFees(e.target.checked)} />
        Fee Schedule
      </label>
      <button style={styles.btn} onClick={handlePrint}>Print / Save PDF</button>
    </div>
  );
}

const styles = {
  bar: {
    display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap",
    background: "#fff", borderRadius: "0 0 10px 10px",
    padding: "8px 18px", borderTop: "1px solid #e8edf2",
    fontSize: 13, color: "#374151",
  },
  label: { fontWeight: 700, fontSize: 12, color: "#0f172a", marginRight: 2 },
  check: { display: "flex", alignItems: "center", gap: 5, cursor: "pointer" },
  btn: {
    marginLeft: "auto", padding: "6px 16px", borderRadius: 7,
    background: "#1a73e8", color: "#fff", border: "none",
    fontSize: 13, fontWeight: 600, cursor: "pointer",
  },
};
