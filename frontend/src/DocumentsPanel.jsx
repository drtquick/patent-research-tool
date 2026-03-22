/**
 * DocumentsPanel — right-side modal panel for managing files associated with a
 * patent family or a specific tile within that family.
 *
 * Two modes:
 *   tilePubNum = "US12178560B2"  → Tile view: shows files for that tile only;
 *                                   uploads are scoped to that tile.
 *   tilePubNum = null            → Family view: shows ALL files across every tile,
 *                                   grouped by tile with a section header per tile.
 *
 * Tab 1 "USPTO Docs" (US only):
 *   - Always shows quick links to the ODP web viewer and Patent Center.
 *   - If USPTO_ODP_API_KEY is configured on the backend: shows full doc list
 *     with Open + Save-link buttons per document.
 *
 * Tab 2 "Files":
 *   - Drag-and-drop upload (any file type) to Firebase Storage.
 *   - File metadata stored in Firestore via backend, tagged with tile_pub_num.
 *   - Family view groups files by tile with a section header per tile.
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

const fmtSize = (b) => {
  if (!b) return "";
  if (b < 1024)    return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
};

const fmtDate = (raw) => {
  if (!raw) return "";
  try { return new Date(raw).toLocaleDateString(); } catch { return raw; }
};

const docLabel = (d) =>
  d.documentDescription || d.description || d.documentCode || d.code || d.name || "Document";

const docDate = (d) =>
  fmtDate(d.mailRoomDate || d.mailDate || d.date || d.filingDate || "");

const docUrl = (d) =>
  d.downloadUrl || d.download_url || d.pdfUrl || d.url || null;

const fileIcon = (mime, src) => {
  if (src === "uspto") return "🏛";
  if (!mime) return "📄";
  if (mime.includes("pdf")) return "📕";
  if (mime.includes("word") || mime.includes("docx")) return "📘";
  if (mime.startsWith("image/")) return "🖼";
  return "📄";
};

// ── Main component ─────────────────────────────────────────────────────────

export default function DocumentsPanel({
  portfolioId,
  patentNumber,
  usAppNum,
  tilePubNum,   // null = family view; string = tile-scoped view
  onClose,
}) {
  const isTileView = Boolean(tilePubNum);
  const showUspto  = Boolean(usAppNum);
  const defaultTab = showUspto ? "uspto" : "files";

  const [tab, setTab]             = useState(defaultTab);
  const [usptoLoading, setUL]     = useState(false);
  const [usptoData,    setUD]     = useState(null);
  const [savingDoc,    setSaving] = useState(null);
  const [allFiles,     setAll]    = useState([]);
  const [filesLoading, setFL]     = useState(false);
  const [uploading,    setUploading]   = useState(false);
  const [uploadPct,    setUploadPct]   = useState(0);
  const [isDragging,   setIsDragging]  = useState(false);
  const fileInputRef = useRef(null);

  // Derived: which files show in the Files tab
  const visibleFiles = isTileView
    ? allFiles.filter((f) => f.tile_pub_num === tilePubNum)
    : allFiles;

  // ── Loaders ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (tab === "uspto" && usAppNum && !usptoData) loadUspto();
  }, [tab, usAppNum]);

  useEffect(() => {
    if (tab === "files") loadFiles();
  }, [tab]);

  async function loadUspto() {
    setUL(true);
    try { setUD(await api.getUsptoDocs(usAppNum)); }
    catch (err) { setUD({ error: err.message, documents: [], viewer_url: null, patent_center: null }); }
    finally { setUL(false); }
  }

  async function loadFiles() {
    setFL(true);
    try { const d = await api.listPortfolioFiles(portfolioId); setAll(d.files || []); }
    catch { /* non-fatal */ }
    finally { setFL(false); }
  }

  // ── Upload ────────────────────────────────────────────────────────────

  async function handleUpload(file, scopedTile) {
    if (!file) return;
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    setUploading(true);
    setUploadPct(0);
    const ts   = Date.now();
    const path = `users/${uid}/portfolios/${portfolioId}/${ts}_${file.name}`;
    const sRef = storageRef(storage, path);
    try {
      const task = uploadBytesResumable(sRef, file);
      await new Promise((res, rej) =>
        task.on("state_changed",
          (snap) => setUploadPct(Math.round(snap.bytesTransferred / snap.totalBytes * 100)),
          rej, res)
      );
      const dlUrl = await getDownloadURL(sRef);
      const saved = await api.addPortfolioFile(portfolioId, {
        name: file.name, storage_path: path, download_url: dlUrl,
        size: file.size, type: file.type, source: "local",
        tile_pub_num: scopedTile || null,
      });
      setAll((prev) => [{ ...saved, uploaded_at: new Date().toISOString() }, ...prev]);
    } catch (err) {
      alert(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
      setUploadPct(0);
    }
  }

  // ── Save USPTO doc link ───────────────────────────────────────────────

  async function saveUsptoLink(doc) {
    const url   = docUrl(doc);
    const label = docLabel(doc);
    const date  = docDate(doc);
    const name  = `${label}${date ? ` (${date})` : ""}.pdf`;
    const key   = doc.documentCode || doc.code || label;
    setSaving(key);
    try {
      const saved = await api.addPortfolioFile(portfolioId, {
        name,
        download_url: url || usptoData?.patent_center || usptoData?.viewer_url || "",
        storage_path: null, size: 0, type: "application/pdf",
        source: "uspto", tile_pub_num: tilePubNum || null,
      });
      setAll((prev) => [{ ...saved, uploaded_at: new Date().toISOString() }, ...prev]);
    } catch (err) { alert(`Save failed: ${err.message}`); }
    finally { setSaving(null); }
  }

  // ── Delete ────────────────────────────────────────────────────────────

  async function handleDelete(file) {
    if (!window.confirm(`Remove "${file.name}"?`)) return;
    try {
      if (file.storage_path) {
        await deleteObject(storageRef(storage, file.storage_path)).catch(() => {});
      }
      await api.deletePortfolioFile(portfolioId, file.id);
      setAll((prev) => prev.filter((f) => f.id !== file.id));
    } catch (err) { alert(err.message); }
  }

  // ── Drag-and-drop ─────────────────────────────────────────────────────

  const onDrop = useCallback((e, scopedTile) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file, scopedTile);
  }, [portfolioId, tilePubNum]);

  // ── Render ────────────────────────────────────────────────────────────

  const panelTitle = isTileView
    ? `📎 Files — ${tilePubNum}`
    : `📎 All Family Files — ${patentNumber}`;

  return (
    <div style={s.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={s.panel}>
        <div style={s.header}>
          <div style={{ minWidth: 0 }}>
            <div style={s.headerTitle}>{panelTitle}</div>
            {!isTileView && <div style={s.headerSub}>All files from all tiles combined</div>}
          </div>
          <button style={s.closeBtn} onClick={onClose}>✕</button>
        </div>

        <div style={s.tabs}>
          {showUspto && (
            <button style={{ ...s.tab, ...(tab === "uspto" ? s.tabActive : {}) }}
              onClick={() => setTab("uspto")}>
              🏛 USPTO Docs
            </button>
          )}
          <button style={{ ...s.tab, ...(tab === "files" ? s.tabActive : {}) }}
            onClick={() => setTab("files")}>
            📁 {isTileView ? "Tile Files" : "All Files"}
            {visibleFiles.length > 0 && <span style={s.tabBadge}>{visibleFiles.length}</span>}
          </button>
        </div>

        <div style={s.body}>
          {tab === "uspto" && (
            <UsptoTab
              loading={usptoLoading} data={usptoData} usAppNum={usAppNum}
              savingDoc={savingDoc} onSave={saveUsptoLink}
              onSwitchToFiles={() => setTab("files")}
            />
          )}
          {tab === "files" && isTileView && (
            <TileFilesTab
              tilePubNum={tilePubNum} files={visibleFiles}
              loading={filesLoading} uploading={uploading} uploadPct={uploadPct}
              isDragging={isDragging} fileInputRef={fileInputRef}
              onDrop={(e) => onDrop(e, tilePubNum)}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onFileChange={(e) => { const f = e.target.files[0]; if (f) handleUpload(f, tilePubNum); }}
              onDelete={handleDelete}
            />
          )}
          {tab === "files" && !isTileView && (
            <FamilyFilesTab
              allFiles={allFiles} loading={filesLoading}
              uploading={uploading} uploadPct={uploadPct}
              isDragging={isDragging} fileInputRef={fileInputRef}
              onDrop={(e) => onDrop(e, null)}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onFileChange={(e) => { const f = e.target.files[0]; if (f) handleUpload(f, null); }}
              onDelete={handleDelete}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ── USPTO tab ──────────────────────────────────────────────────────────────

function UsptoTab({ loading, data, usAppNum, savingDoc, onSave, onSwitchToFiles }) {
  if (loading) return (
    <div style={s.centered}>
      <div style={s.spinner} />
      <p style={{ color: "#888" }}>Fetching from USPTO…</p>
    </div>
  );

  const viewerUrl    = data?.viewer_url;
  const patentCenter = data?.patent_center;
  const docs         = data?.documents || [];
  const noKey        = data?.no_key;
  const apiError     = data?.error;

  return (
    <div>
      <div style={s.viewerLinks}>
        {viewerUrl    && <a href={viewerUrl}    target="_blank" rel="noreferrer" style={s.viewerBtn}>📂 View all docs on USPTO ODP</a>}
        {patentCenter && <a href={patentCenter} target="_blank" rel="noreferrer" style={s.altBtn}>🏛 Patent Center</a>}
      </div>

      {noKey && (
        <div style={s.noKeyNotice}>
          <strong>Full document list not configured.</strong> Click the link above to browse
          prosecution documents on the USPTO website, or upload your own copies in{" "}
          <button style={s.inlineLink} onClick={onSwitchToFiles}>Files</button>.
          <br /><br />
          <span style={{ color: "#888", fontSize: 12 }}>
            To enable the in-app list: register a free API key at{" "}
            <a href="https://data.uspto.gov/apis/getting-started" target="_blank" rel="noreferrer">data.uspto.gov</a>{" "}
            and set <code>USPTO_ODP_API_KEY</code> on Cloud Run.
          </span>
        </div>
      )}

      {apiError && !noKey && <div style={s.errorBanner}>⚠️ {apiError}</div>}

      {docs.length > 0 && (
        <div>
          <p style={s.docCount}>{docs.length} document{docs.length !== 1 ? "s" : ""}</p>
          <div style={s.docList}>
            {docs.map((doc, i) => {
              const key = doc.documentCode || doc.code || `${i}`;
              const url = docUrl(doc);
              return (
                <div key={i} style={s.docRow}>
                  <div style={s.docInfo}>
                    <span style={s.docCode}>{key}</span>
                    <span style={s.docLabel}>{docLabel(doc)}</span>
                    {docDate(doc) && <span style={s.docDate}>{docDate(doc)}</span>}
                    {doc.direction && (
                      <span style={{ ...s.dirBadge, background: doc.direction === "INCOMING" ? "#e3f2fd" : "#fff3e0", color: doc.direction === "INCOMING" ? "#1565c0" : "#e65100" }}>
                        {doc.direction === "INCOMING" ? "↑ Applicant" : "↓ USPTO"}
                      </span>
                    )}
                  </div>
                  <div style={s.docActions}>
                    {url && <a href={url} target="_blank" rel="noreferrer" style={s.openDocBtn}>Open</a>}
                    <button style={s.saveDocBtn} disabled={savingDoc === key} onClick={() => onSave(doc)}>
                      {savingDoc === key ? "Saving…" : "💾 Save"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!noKey && !apiError && docs.length === 0 && !loading && (
        <p style={{ color: "#888", textAlign: "center", marginTop: 24 }}>No documents returned for {usAppNum}.</p>
      )}
    </div>
  );
}

// ── Tile-scoped Files tab ──────────────────────────────────────────────────

function TileFilesTab({ tilePubNum, files, loading, uploading, uploadPct, isDragging, fileInputRef, onDrop, onDragOver, onDragLeave, onFileChange, onDelete }) {
  return (
    <div>
      <p style={s.tileLabel}>Files for <strong>{tilePubNum}</strong></p>
      <UploadZone uploading={uploading} uploadPct={uploadPct} isDragging={isDragging}
        fileInputRef={fileInputRef} onDrop={onDrop} onDragOver={onDragOver}
        onDragLeave={onDragLeave} onFileChange={onFileChange} />
      {loading && <p style={s.muted}>Loading…</p>}
      {!loading && files.length === 0 && <p style={s.muted}>No files attached to this tile yet.</p>}
      <FileList files={files} onDelete={onDelete} />
    </div>
  );
}

// ── Family-wide Files tab ──────────────────────────────────────────────────

function FamilyFilesTab({ allFiles, loading, uploading, uploadPct, isDragging, fileInputRef, onDrop, onDragOver, onDragLeave, onFileChange, onDelete }) {
  const groups = new Map();
  for (const f of allFiles) {
    const key = f.tile_pub_num || "__family__";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }

  const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
    if (a === "__family__") return 1;
    if (b === "__family__") return -1;
    return a.localeCompare(b);
  });

  return (
    <div>
      <p style={s.tileLabel}>Upload a family-level file (not tied to a specific tile)</p>
      <UploadZone uploading={uploading} uploadPct={uploadPct} isDragging={isDragging}
        fileInputRef={fileInputRef} onDrop={onDrop} onDragOver={onDragOver}
        onDragLeave={onDragLeave} onFileChange={onFileChange} />

      {loading && <p style={s.muted}>Loading…</p>}
      {!loading && allFiles.length === 0 && (
        <p style={s.muted}>No files yet. Use the 📎 Files button on any tile to upload.</p>
      )}

      {sortedKeys.map((key) => (
        <div key={key} style={s.group}>
          <div style={s.groupHeader}>
            {key === "__family__" ? "📁 Family-level files" : `📄 ${key}`}
            <span style={s.groupCount}>{groups.get(key).length}</span>
          </div>
          <FileList files={groups.get(key)} onDelete={onDelete} />
        </div>
      ))}
    </div>
  );
}

// ── Shared sub-components ──────────────────────────────────────────────────

function UploadZone({ uploading, uploadPct, isDragging, fileInputRef, onDrop, onDragOver, onDragLeave, onFileChange }) {
  return (
    <div
      style={{ ...s.dropZone, ...(isDragging ? s.dropZoneActive : {}) }}
      onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave}
      onClick={() => !uploading && fileInputRef.current?.click()}
    >
      <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={onFileChange} />
      {uploading ? (
        <div style={s.progressWrap}>
          <div style={s.progressBar}><div style={{ ...s.progressFill, width: `${uploadPct}%` }} /></div>
          <p style={s.progressLabel}>Uploading… {uploadPct}%</p>
        </div>
      ) : (
        <>
          <span style={{ fontSize: 22 }}>⬆️</span>
          <p style={s.uploadHint}>{isDragging ? "Drop to upload" : "Drag & drop or click to browse"}</p>
          <p style={s.uploadSub}>Any file type accepted</p>
        </>
      )}
    </div>
  );
}

function FileList({ files, onDelete }) {
  if (!files.length) return null;
  return (
    <div style={s.fileList}>
      {files.map((f) => (
        <div key={f.id} style={s.fileRow}>
          <span style={s.fileIcon}>{fileIcon(f.type, f.source)}</span>
          <div style={s.fileInfo}>
            <a href={f.download_url} target="_blank" rel="noreferrer" style={s.fileName}>{f.name}</a>
            <span style={s.fileMeta}>
              {f.source === "uspto" && <span style={s.usptoTag}>USPTO</span>}
              {fmtSize(f.size)}{f.size ? " · " : ""}{fmtDate(f.uploaded_at)}
            </span>
          </div>
          <button style={s.deleteBtn} onClick={() => onDelete(f)} title="Remove">🗑</button>
        </div>
      ))}
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const s = {
  overlay:  { position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 2000, display: "flex", justifyContent: "flex-end" },
  panel:    { width: "min(620px, 100vw)", height: "100vh", background: "#fff", display: "flex", flexDirection: "column", boxShadow: "-4px 0 20px rgba(0,0,0,.15)", overflowY: "hidden" },

  header:      { display: "flex", justifyContent: "space-between", alignItems: "flex-start", padding: "14px 18px", borderBottom: "1px solid #e0e0e0", background: "#f8f9fa", flexShrink: 0, gap: 10 },
  headerTitle: { fontWeight: 700, fontSize: 14, color: "#1a1a2e", wordBreak: "break-all" },
  headerSub:   { fontSize: 12, color: "#888", marginTop: 2 },
  closeBtn:    { background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "#888", padding: "2px 6px", borderRadius: 6, flexShrink: 0 },

  tabs:      { display: "flex", borderBottom: "2px solid #e0e0e0", flexShrink: 0 },
  tab:       { flex: 1, padding: "11px 14px", background: "none", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 500, color: "#666", borderBottom: "2px solid transparent", marginBottom: -2, display: "flex", alignItems: "center", justifyContent: "center", gap: 5 },
  tabActive: { color: "#1a73e8", borderBottomColor: "#1a73e8", fontWeight: 700 },
  tabBadge:  { background: "#1a73e8", color: "#fff", fontSize: 11, fontWeight: 700, padding: "1px 6px", borderRadius: 10 },

  body:    { flex: 1, overflowY: "auto", padding: "14px 18px" },
  centered:{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: 180, gap: 14 },
  spinner: { width: 30, height: 30, border: "4px solid #e0e0e0", borderTop: "4px solid #1a73e8", borderRadius: "50%", animation: "spin 1s linear infinite" },

  viewerLinks: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 },
  viewerBtn:   { display: "inline-flex", alignItems: "center", gap: 5, padding: "9px 16px", borderRadius: 8, background: "#1a73e8", color: "#fff", fontWeight: 600, fontSize: 13, textDecoration: "none" },
  altBtn:      { display: "inline-flex", alignItems: "center", gap: 5, padding: "9px 16px", borderRadius: 8, background: "#f0f4f8", border: "1px solid #d0d7de", color: "#1a1a2e", fontWeight: 600, fontSize: 13, textDecoration: "none" },

  noKeyNotice: { padding: "12px 14px", background: "#fff8e1", border: "1px solid #ffe082", borderRadius: 8, fontSize: 13, color: "#4a3900", lineHeight: 1.6, marginBottom: 14 },
  inlineLink:  { background: "none", border: "none", color: "#1a73e8", cursor: "pointer", padding: 0, fontWeight: 600, fontSize: 13, textDecoration: "underline" },
  errorBanner: { padding: "10px 14px", background: "#fdecea", borderRadius: 8, color: "#d32f2f", fontSize: 13, marginBottom: 14 },

  docCount:   { fontSize: 12, color: "#888", marginBottom: 6 },
  docList:    { display: "flex", flexDirection: "column", gap: 5 },
  docRow:     { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, padding: "9px 11px", border: "1px solid #e8ecf0", borderRadius: 8, background: "#fafafa" },
  docInfo:    { display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 },
  docCode:    { fontSize: 10, color: "#888", fontFamily: "monospace", fontWeight: 600 },
  docLabel:   { fontSize: 13, color: "#1a1a2e", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  docDate:    { fontSize: 11, color: "#888" },
  dirBadge:   { fontSize: 10, padding: "1px 5px", borderRadius: 10, fontWeight: 600, alignSelf: "flex-start" },
  docActions: { display: "flex", flexDirection: "column", gap: 3, flexShrink: 0 },
  openDocBtn: { padding: "3px 9px", borderRadius: 5, background: "#1a73e8", color: "#fff", fontSize: 11, fontWeight: 600, textDecoration: "none", textAlign: "center" },
  saveDocBtn: { padding: "3px 9px", borderRadius: 5, background: "#fff", border: "1px solid #d0d7de", fontSize: 11, cursor: "pointer", color: "#444" },

  tileLabel: { fontSize: 13, color: "#555", marginBottom: 10 },
  muted:     { color: "#aaa", fontSize: 13, textAlign: "center", marginTop: 12 },

  dropZone:      { border: "2px dashed #c0cdd8", borderRadius: 10, padding: "20px 14px", textAlign: "center", cursor: "pointer", background: "#f8fafc", transition: "all .15s", marginBottom: 14 },
  dropZoneActive:{ borderColor: "#1a73e8", background: "#e8f0fe" },
  uploadHint:    { margin: "5px 0 2px", fontSize: 13, color: "#444", fontWeight: 500 },
  uploadSub:     { margin: 0, fontSize: 11, color: "#888" },
  progressWrap:  { display: "flex", flexDirection: "column", alignItems: "center", gap: 7 },
  progressBar:   { width: "100%", height: 7, background: "#e0e0e0", borderRadius: 4, overflow: "hidden" },
  progressFill:  { height: "100%", background: "#1a73e8", transition: "width .1s" },
  progressLabel: { fontSize: 12, color: "#1a73e8", margin: 0 },

  group:       { marginBottom: 16 },
  groupHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", background: "#f0f4f8", borderRadius: 6, fontSize: 13, fontWeight: 600, color: "#1a1a2e", marginBottom: 6 },
  groupCount:  { background: "#1a73e8", color: "#fff", fontSize: 11, fontWeight: 700, padding: "1px 7px", borderRadius: 10 },

  fileList:  { display: "flex", flexDirection: "column", gap: 5 },
  fileRow:   { display: "flex", alignItems: "center", gap: 9, padding: "9px 11px", border: "1px solid #e8ecf0", borderRadius: 8, background: "#fafafa" },
  fileIcon:  { fontSize: 18, flexShrink: 0 },
  fileInfo:  { flex: 1, minWidth: 0 },
  fileName:  { display: "block", fontSize: 13, fontWeight: 500, color: "#1a73e8", textDecoration: "none", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  fileMeta:  { display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "#888" },
  usptoTag:  { background: "#e8f0fe", color: "#1565c0", fontSize: 10, fontWeight: 700, padding: "1px 5px", borderRadius: 4 },
  deleteBtn: { background: "none", border: "none", cursor: "pointer", fontSize: 15, color: "#aaa", padding: "3px", flexShrink: 0 },
};
