/**
 * DocumentsPanel — modal side-panel for a single portfolio entry.
 *
 * Tab 1 "USPTO Docs":  Fetches prosecution documents from the USPTO Open Data
 *   Portal (ODP) for US applications/patents.  Works in two modes:
 *     • No API key configured → shows direct links to the ODP web viewer and
 *       Patent Center so the user can browse documents without any setup.
 *     • USPTO_ODP_API_KEY set on the backend → fetches a full document list
 *       with per-document "Open" and "Save link to My Files" buttons.
 *
 * Tab 2 "My Files":  Drag-and-drop file upload (any type) backed by Firebase
 *   Storage.  File metadata stored in Firestore via backend.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  ref as storageRef,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
} from "firebase/storage";
import { storage, auth } from "./firebase";
import { api } from "./api";

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024)           return `${bytes} B`;
  if (bytes < 1024 * 1024)    return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(raw) {
  if (!raw) return "";
  // raw may be ISO string or "YYYY-MM-DD" or "MM/DD/YYYY"
  try { return new Date(raw).toLocaleDateString(); }
  catch { return raw; }
}

// Guess a human-friendly label from ODP document codes / descriptions
function docLabel(doc) {
  return (
    doc.documentDescription
    || doc.description
    || doc.documentCode
    || doc.code
    || doc.name
    || "Document"
  );
}

function docDate(doc) {
  return fmtDate(
    doc.mailRoomDate || doc.mailDate || doc.date || doc.filingDate || ""
  );
}

function docDownloadUrl(doc) {
  return (
    doc.downloadUrl
    || doc.download_url
    || doc.pdfUrl
    || doc.url
    || null
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function DocumentsPanel({ portfolioId, patentNumber, usAppNum, onClose }) {
  const defaultTab         = usAppNum ? "uspto" : "files";
  const [tab, setTab]      = useState(defaultTab);

  // USPTO tab state
  const [usptoLoading, setUsptoLoading] = useState(false);
  const [usptoData,    setUsptoData]    = useState(null);
  const [savingDoc,    setSavingDoc]    = useState(null); // doc identifier being saved

  // My Files tab state
  const [files,        setFiles]        = useState([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [uploading,    setUploading]    = useState(false);
  const [uploadPct,    setUploadPct]    = useState(0);
  const [isDragging,   setIsDragging]   = useState(false);
  const fileInputRef                    = useRef(null);

  // ── Data loaders ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (tab === "uspto" && usAppNum && !usptoData) loadUsptoDocs();
  }, [tab, usAppNum]);

  useEffect(() => {
    if (tab === "files") loadFiles();
  }, [tab]);

  async function loadUsptoDocs() {
    setUsptoLoading(true);
    try {
      const data = await api.getUsptoDocs(usAppNum);
      setUsptoData(data);
    } catch (err) {
      setUsptoData({ error: err.message, documents: [], viewer_url: null, patent_center: null });
    } finally {
      setUsptoLoading(false);
    }
  }

  async function loadFiles() {
    setFilesLoading(true);
    try {
      const data = await api.listPortfolioFiles(portfolioId);
      setFiles(data.files || []);
    } catch {
      /* non-fatal */
    } finally {
      setFilesLoading(false);
    }
  }

  // ── File upload ───────────────────────────────────────────────────────────

  async function handleUpload(file) {
    if (!file) return;
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    setUploading(true);
    setUploadPct(0);

    const timestamp = Date.now();
    const path      = `users/${uid}/portfolios/${portfolioId}/${timestamp}_${file.name}`;
    const sRef      = storageRef(storage, path);

    try {
      const task = uploadBytesResumable(sRef, file);
      await new Promise((resolve, reject) =>
        task.on(
          "state_changed",
          (snap) => setUploadPct(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
          reject,
          resolve
        )
      );
      const downloadUrl = await getDownloadURL(sRef);
      const saved = await api.addPortfolioFile(portfolioId, {
        name:         file.name,
        storage_path: path,
        download_url: downloadUrl,
        size:         file.size,
        type:         file.type,
        source:       "local",
      });
      setFiles((prev) => [
        { ...saved, uploaded_at: new Date().toISOString() },
        ...prev,
      ]);
    } catch (err) {
      alert(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
      setUploadPct(0);
    }
  }

  // ── Save USPTO doc link to My Files ──────────────────────────────────────

  async function saveUsptoDocLink(doc) {
    const url   = docDownloadUrl(doc);
    const label = docLabel(doc);
    const date  = docDate(doc);
    const name  = `${label}${date ? " (" + date + ")" : ""}.pdf`;
    const key   = doc.documentCode || doc.code || label;

    setSavingDoc(key);
    try {
      const saved = await api.addPortfolioFile(portfolioId, {
        name,
        download_url: url || usptoData?.patent_center || usptoData?.viewer_url || "",
        storage_path: null,
        size:         0,
        type:         "application/pdf",
        source:       "uspto",
      });
      setFiles((prev) => [
        { ...saved, uploaded_at: new Date().toISOString() },
        ...prev,
      ]);
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    } finally {
      setSavingDoc(null);
    }
  }

  // ── File delete ───────────────────────────────────────────────────────────

  async function handleDelete(file) {
    if (!window.confirm(`Remove "${file.name}" from this patent's files?`)) return;
    try {
      if (file.storage_path) {
        const sRef = storageRef(storage, file.storage_path);
        await deleteObject(sRef).catch(() => {});
      }
      await api.deletePortfolioFile(portfolioId, file.id);
      setFiles((prev) => prev.filter((f) => f.id !== file.id));
    } catch (err) {
      alert(err.message);
    }
  }

  // ── Drag-and-drop ─────────────────────────────────────────────────────────

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) handleUpload(file);
    },
    [portfolioId]
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={s.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={s.panel}>
        {/* Header */}
        <div style={s.header}>
          <div>
            <span style={s.headerIcon}>📎</span>
            <span style={s.headerTitle}>Documents</span>
            <span style={s.headerSub}> — {patentNumber}</span>
          </div>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* Tabs */}
        <div style={s.tabs}>
          {usAppNum && (
            <button
              style={{ ...s.tab, ...(tab === "uspto" ? s.tabActive : {}) }}
              onClick={() => setTab("uspto")}
            >
              🏛 USPTO Docs
            </button>
          )}
          <button
            style={{ ...s.tab, ...(tab === "files" ? s.tabActive : {}) }}
            onClick={() => setTab("files")}
          >
            📁 My Files
            {files.length > 0 && <span style={s.tabBadge}>{files.length}</span>}
          </button>
        </div>

        {/* Tab content */}
        <div style={s.body}>
          {tab === "uspto" && <UsptoTab
            loading={usptoLoading}
            data={usptoData}
            usAppNum={usAppNum}
            savingDoc={savingDoc}
            onSave={saveUsptoDocLink}
            onSwitchToFiles={() => setTab("files")}
          />}
          {tab === "files" && <FilesTab
            files={files}
            loading={filesLoading}
            uploading={uploading}
            uploadPct={uploadPct}
            isDragging={isDragging}
            fileInputRef={fileInputRef}
            onDrop={onDrop}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onFileChange={(e) => { const f = e.target.files[0]; if (f) handleUpload(f); }}
            onDelete={handleDelete}
          />}
        </div>
      </div>
    </div>
  );
}

// ── USPTO tab sub-component ────────────────────────────────────────────────

function UsptoTab({ loading, data, usAppNum, savingDoc, onSave, onSwitchToFiles }) {
  if (loading) {
    return (
      <div style={s.centered}>
        <div style={s.spinner} />
        <p style={{ color: "#888" }}>Fetching documents from USPTO…</p>
      </div>
    );
  }

  const viewerUrl    = data?.viewer_url;
  const patentCenter = data?.patent_center;
  const docs         = data?.documents || [];
  const noKey        = data?.no_key;
  const apiError     = data?.error;

  return (
    <div>
      {/* Quick-access links — always shown */}
      <div style={s.viewerLinks}>
        {viewerUrl && (
          <a href={viewerUrl} target="_blank" rel="noreferrer" style={s.viewerBtn}>
            📂 View all docs on USPTO ODP
          </a>
        )}
        {patentCenter && (
          <a href={patentCenter} target="_blank" rel="noreferrer" style={s.patentCenterBtn}>
            🏛 Patent Center
          </a>
        )}
      </div>

      {/* No API key notice */}
      {noKey && (
        <div style={s.noKeyNotice}>
          <strong>Full document list not available.</strong> The backend doesn't have a
          USPTO ODP API key configured. Click the links above to browse all prosecution
          documents directly on the USPTO website. You can also upload your own copies
          in <button style={s.inlineLink} onClick={onSwitchToFiles}>My Files</button>.
          <br /><br />
          <span style={{ color: "#888", fontSize: 12 }}>
            To enable the document list: register a free API key at{" "}
            <a href="https://data.uspto.gov/apis/getting-started" target="_blank" rel="noreferrer">
              data.uspto.gov/apis/getting-started
            </a>{" "}
            and set <code>USPTO_ODP_API_KEY</code> on the Cloud Run service.
          </span>
        </div>
      )}

      {/* API error (key present but call failed) */}
      {apiError && !noKey && (
        <div style={s.errorBanner}>
          ⚠️ Could not load document list: {apiError}. Use the links above to browse on USPTO.
        </div>
      )}

      {/* Document list */}
      {docs.length > 0 && (
        <div>
          <p style={s.docCount}>{docs.length} document{docs.length !== 1 ? "s" : ""} found</p>
          <div style={s.docList}>
            {docs.map((doc, i) => {
              const label   = docLabel(doc);
              const date    = docDate(doc);
              const url     = docDownloadUrl(doc);
              const docKey  = doc.documentCode || doc.code || `${i}`;
              const saving  = savingDoc === docKey;

              return (
                <div key={i} style={s.docRow}>
                  <div style={s.docInfo}>
                    <span style={s.docCode}>{doc.documentCode || doc.code || "—"}</span>
                    <span style={s.docLabel}>{label}</span>
                    {date && <span style={s.docDate}>{date}</span>}
                    {doc.direction && (
                      <span style={{
                        ...s.dirBadge,
                        background: doc.direction === "INCOMING" ? "#e3f2fd" : "#fff3e0",
                        color:      doc.direction === "INCOMING" ? "#1565c0" : "#e65100",
                      }}>
                        {doc.direction === "INCOMING" ? "↑ Applicant" : "↓ USPTO"}
                      </span>
                    )}
                  </div>
                  <div style={s.docActions}>
                    {url && (
                      <a href={url} target="_blank" rel="noreferrer" style={s.openDocBtn}>
                        Open
                      </a>
                    )}
                    <button
                      style={s.saveDocBtn}
                      onClick={() => onSave(doc)}
                      disabled={saving}
                      title="Save a link to this document in My Files"
                    >
                      {saving ? "Saving…" : "💾 Save"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!noKey && !apiError && docs.length === 0 && !loading && (
        <p style={{ color: "#888", textAlign: "center", marginTop: 24 }}>
          No documents returned for application {usAppNum}.
        </p>
      )}
    </div>
  );
}

// ── My Files tab sub-component ────────────────────────────────────────────

function FilesTab({
  files, loading, uploading, uploadPct, isDragging,
  fileInputRef, onDrop, onDragOver, onDragLeave, onFileChange, onDelete,
}) {
  return (
    <div>
      {/* Upload zone */}
      <div
        style={{ ...s.dropZone, ...(isDragging ? s.dropZoneActive : {}) }}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => !uploading && fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          style={{ display: "none" }}
          onChange={onFileChange}
        />
        {uploading ? (
          <div style={s.progressWrap}>
            <div style={s.progressBar}>
              <div style={{ ...s.progressFill, width: `${uploadPct}%` }} />
            </div>
            <p style={s.progressLabel}>Uploading… {uploadPct}%</p>
          </div>
        ) : (
          <>
            <span style={s.uploadIcon}>⬆️</span>
            <p style={s.uploadHint}>
              {isDragging ? "Drop to upload" : "Drag & drop a file here, or click to browse"}
            </p>
            <p style={s.uploadSub}>PDFs, Word docs, images — any file type accepted</p>
          </>
        )}
      </div>

      {/* File list */}
      {loading && <p style={{ color: "#888", textAlign: "center" }}>Loading…</p>}
      {!loading && files.length === 0 && (
        <p style={{ color: "#aaa", textAlign: "center", marginTop: 16, fontSize: 13 }}>
          No files uploaded yet.
        </p>
      )}
      <div style={s.fileList}>
        {files.map((f) => (
          <div key={f.id} style={s.fileRow}>
            <span style={s.fileIcon}>{fileIcon(f.type, f.source)}</span>
            <div style={s.fileInfo}>
              <a href={f.download_url} target="_blank" rel="noreferrer" style={s.fileName}>
                {f.name}
              </a>
              <span style={s.fileMeta}>
                {f.source === "uspto" && <span style={s.usptoTag}>USPTO</span>}
                {fmtSize(f.size)}
                {f.size ? " · " : ""}
                {fmtDate(f.uploaded_at)}
              </span>
            </div>
            <button style={s.deleteFileBtn} onClick={() => onDelete(f)} title="Remove file">
              🗑
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function fileIcon(mimeType, source) {
  if (source === "uspto") return "🏛";
  if (!mimeType) return "📄";
  if (mimeType.includes("pdf"))                                return "📕";
  if (mimeType.includes("word") || mimeType.includes("docx")) return "📘";
  if (mimeType.startsWith("image/"))                          return "🖼";
  return "📄";
}

// ── Styles ────────────────────────────────────────────────────────────────

const s = {
  overlay:   { position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 2000,
    display: "flex", justifyContent: "flex-end" },
  panel:     { width: "min(600px, 100vw)", height: "100vh", background: "#fff",
    display: "flex", flexDirection: "column", boxShadow: "-4px 0 20px rgba(0,0,0,.15)",
    overflowY: "hidden" },

  // Header
  header:    { display: "flex", justifyContent: "space-between", alignItems: "center",
    padding: "16px 20px", borderBottom: "1px solid #e0e0e0", background: "#f8f9fa",
    flexShrink: 0 },
  headerIcon:  { fontSize: 20, marginRight: 8 },
  headerTitle: { fontWeight: 700, fontSize: 16, color: "#1a1a2e" },
  headerSub:   { fontSize: 13, color: "#666" },
  closeBtn:  { background: "none", border: "none", fontSize: 18, cursor: "pointer",
    color: "#888", padding: "4px 8px", borderRadius: 6 },

  // Tabs
  tabs:      { display: "flex", borderBottom: "2px solid #e0e0e0", flexShrink: 0,
    background: "#fff" },
  tab:       { flex: 1, padding: "12px 16px", background: "none", border: "none",
    cursor: "pointer", fontSize: 14, fontWeight: 500, color: "#666",
    borderBottom: "2px solid transparent", marginBottom: -2, display: "flex",
    alignItems: "center", justifyContent: "center", gap: 6 },
  tabActive: { color: "#1a73e8", borderBottomColor: "#1a73e8", fontWeight: 700 },
  tabBadge:  { background: "#1a73e8", color: "#fff", fontSize: 11, fontWeight: 700,
    padding: "1px 6px", borderRadius: 10 },

  body:      { flex: 1, overflowY: "auto", padding: "16px 20px" },

  centered:  { display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "center", minHeight: 200, gap: 16 },
  spinner:   { width: 32, height: 32, border: "4px solid #e0e0e0",
    borderTop: "4px solid #1a73e8", borderRadius: "50%",
    animation: "spin 1s linear infinite" },

  // USPTO viewer links
  viewerLinks: { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 16 },
  viewerBtn:   { display: "inline-flex", alignItems: "center", gap: 6, padding: "10px 18px",
    borderRadius: 8, background: "#1a73e8", color: "#fff", fontWeight: 600,
    fontSize: 13, textDecoration: "none" },
  patentCenterBtn: { display: "inline-flex", alignItems: "center", gap: 6,
    padding: "10px 18px", borderRadius: 8, background: "#f0f4f8",
    border: "1px solid #d0d7de", color: "#1a1a2e", fontWeight: 600,
    fontSize: 13, textDecoration: "none" },

  noKeyNotice: { padding: "14px 16px", background: "#fff8e1", border: "1px solid #ffe082",
    borderRadius: 8, fontSize: 13, color: "#4a3900", lineHeight: 1.6, marginBottom: 16 },
  inlineLink:  { background: "none", border: "none", color: "#1a73e8", cursor: "pointer",
    padding: 0, fontWeight: 600, fontSize: 13, textDecoration: "underline" },
  errorBanner: { padding: "12px 16px", background: "#fdecea", borderRadius: 8,
    color: "#d32f2f", fontSize: 13, marginBottom: 16 },

  // Doc list
  docCount:  { fontSize: 12, color: "#888", marginBottom: 8 },
  docList:   { display: "flex", flexDirection: "column", gap: 6 },
  docRow:    { display: "flex", alignItems: "flex-start", justifyContent: "space-between",
    gap: 10, padding: "10px 12px", border: "1px solid #e8ecf0", borderRadius: 8,
    background: "#fafafa" },
  docInfo:   { display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0 },
  docCode:   { fontSize: 11, color: "#888", fontFamily: "monospace", fontWeight: 600 },
  docLabel:  { fontSize: 13, color: "#1a1a2e", fontWeight: 500,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  docDate:   { fontSize: 11, color: "#888" },
  dirBadge:  { fontSize: 10, padding: "1px 6px", borderRadius: 10, fontWeight: 600,
    alignSelf: "flex-start" },
  docActions: { display: "flex", flexDirection: "column", gap: 4, flexShrink: 0 },
  openDocBtn: { padding: "4px 10px", borderRadius: 6, background: "#1a73e8",
    color: "#fff", fontSize: 12, fontWeight: 600, textDecoration: "none",
    textAlign: "center" },
  saveDocBtn: { padding: "4px 10px", borderRadius: 6, background: "#fff",
    border: "1px solid #d0d7de", fontSize: 12, cursor: "pointer", color: "#444",
    fontWeight: 500 },

  // Drop zone
  dropZone:      { border: "2px dashed #c0cdd8", borderRadius: 10, padding: "28px 20px",
    textAlign: "center", cursor: "pointer", background: "#f8fafc",
    transition: "all .15s", marginBottom: 16 },
  dropZoneActive: { borderColor: "#1a73e8", background: "#e8f0fe" },
  uploadIcon:    { fontSize: 28 },
  uploadHint:    { margin: "8px 0 4px", fontSize: 14, color: "#444", fontWeight: 500 },
  uploadSub:     { margin: 0, fontSize: 12, color: "#888" },
  progressWrap:  { display: "flex", flexDirection: "column", alignItems: "center", gap: 8 },
  progressBar:   { width: "100%", height: 8, background: "#e0e0e0", borderRadius: 4,
    overflow: "hidden" },
  progressFill:  { height: "100%", background: "#1a73e8", transition: "width .1s" },
  progressLabel: { fontSize: 13, color: "#1a73e8", margin: 0 },

  // File list
  fileList:  { display: "flex", flexDirection: "column", gap: 6 },
  fileRow:   { display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
    border: "1px solid #e8ecf0", borderRadius: 8, background: "#fafafa" },
  fileIcon:  { fontSize: 20, flexShrink: 0 },
  fileInfo:  { flex: 1, minWidth: 0 },
  fileName:  { display: "block", fontSize: 13, fontWeight: 500, color: "#1a73e8",
    textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis",
    whiteSpace: "nowrap" },
  fileMeta:  { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#888" },
  usptoTag:  { background: "#e8f0fe", color: "#1565c0", fontSize: 10, fontWeight: 700,
    padding: "1px 5px", borderRadius: 4 },
  deleteFileBtn: { background: "none", border: "none", cursor: "pointer",
    fontSize: 16, color: "#999", padding: "4px", flexShrink: 0 },
};
