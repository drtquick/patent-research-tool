import { auth } from "./firebase";

const BASE = import.meta.env.VITE_API_URL || "http://localhost:5001";

async function authFetch(path, opts = {}) {
  const token = await auth.currentUser?.getIdToken();
  const headers = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(opts.headers || {}),
  };
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export const api = {
  // search_type may be "auto" (default), "patent_number",
  // "application_number", or "publication_number". The server uses this to
  // disambiguate inputs that could parse as either an app number or a patent
  // number (e.g. 8-digit bare numbers).
  search: (patent_number, search_type = "auto") =>
    authFetch("/api/search", {
      method: "POST",
      body: JSON.stringify({ patent_number, search_type }),
    }),

  listPortfolios: () => authFetch("/api/portfolios"),

  savePortfolio: (data) =>
    authFetch("/api/portfolios", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  deletePortfolio: (id) =>
    authFetch(`/api/portfolios/${id}`, { method: "DELETE" }),

  getPortfolio: (id) => authFetch(`/api/portfolios/${id}`),

  getAlerts: (days) =>
    authFetch(`/api/alerts${days ? `?days=${days}` : ""}`),

  getSearchHistory: (limit = 8) =>
    authFetch(`/api/searches?limit=${limit}`),

  updatePortfolioName: (id, name) =>
    authFetch(`/api/portfolios/${id}/name`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  savePortfolioNotes: (id, notes) =>
    authFetch(`/api/portfolios/${id}/notes`, {
      method: "PATCH",
      body: JSON.stringify({ notes }),
    }),

  // Persist freshly-scraped HTML back to cache (called after full re-scrape)
  refreshPortfolio: (id, data) =>
    authFetch(`/api/portfolios/${id}/dashboard`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  // Re-fetch prosecution data using stored app_nums via USPTO ODP — no GP re-scrape
  dataRefreshPortfolio: (id) =>
    authFetch(`/api/portfolios/${id}/refresh`, { method: "POST" }),

  // USPTO Open Data Portal documents
  getUsptoDocs: (appNum) =>
    authFetch(`/api/uspto/documents/${encodeURIComponent(appNum)}`),

  // Portfolio file metadata CRUD (Storage uploads handled by Firebase SDK client-side)
  listPortfolioFiles: (id) =>
    authFetch(`/api/portfolios/${id}/files`),

  // meta may include tile_pub_num (e.g. "US12178560B2") to scope file to a specific tile,
  // or omit / set null for family-level files.
  addPortfolioFile: (id, meta) =>
    authFetch(`/api/portfolios/${id}/files`, {
      method: "POST",
      body: JSON.stringify(meta),
    }),

  deletePortfolioFile: (id, fileId) =>
    authFetch(`/api/portfolios/${id}/files/${fileId}`, { method: "DELETE" }),

  // Assignment chain per US family member
  getPortfolioAssignments: (id) =>
    authFetch(`/api/portfolios/${id}/assignments`),

  // Claims summary: independent claims per US member + optional AI summary
  getPortfolioClaims: (id, { summary = false } = {}) =>
    authFetch(`/api/portfolios/${id}/claims${summary ? "?summary=1" : ""}`),

  // Aggregated prior-art citations per US family member.
  // Pass { aiScan: true } to ALSO run Claude against the latest IDS + 892
  // PDFs on pending apps. Results are cached in Firestore by doc set hash.
  getPortfolioPriorArt: (id, { aiScan = false } = {}) =>
    authFetch(`/api/portfolios/${id}/prior-art${aiScan ? "?ai_scan=1" : ""}`),

  // ── Patentee groups (combined multi-family dashboards) ───────────────────

  listPatenteeGroups: () => authFetch("/api/patentee-groups"),

  createPatenteeGroup: (name, portfolio_ids) =>
    authFetch("/api/patentee-groups", {
      method: "POST",
      body: JSON.stringify({ name, portfolio_ids }),
    }),

  getPatenteeGroup: (id) => authFetch(`/api/patentee-groups/${id}`),

  updatePatenteeGroup: (id, patch) =>
    authFetch(`/api/patentee-groups/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  deletePatenteeGroup: (id) =>
    authFetch(`/api/patentee-groups/${id}`, { method: "DELETE" }),

  getPatenteeGroupDashboard: (id) =>
    authFetch(`/api/patentee-groups/${id}/dashboard`),

  previewPatenteeGroup: (portfolio_ids, name = "Combined preview") =>
    authFetch("/api/patentee-groups/preview", {
      method: "POST",
      body: JSON.stringify({ portfolio_ids, name }),
    }),

  // ── AI Analysis (Claude-powered prosecution assistant) ───────────────────

  aiAnalyze: (portfolioId, pubNum) =>
    authFetch("/api/ai/analyze", {
      method: "POST",
      body: JSON.stringify({ portfolio_id: portfolioId, pub_num: pubNum }),
    }),

  aiAnalyzeOA: (portfolioId, pubNum) =>
    authFetch("/api/ai/analyze-oa", {
      method: "POST",
      body: JSON.stringify({ portfolio_id: portfolioId, pub_num: pubNum }),
    }),

  aiGetCachedAnalysis: (portfolioId, pubNum) =>
    authFetch(`/api/ai/analyze/${portfolioId}/${encodeURIComponent(pubNum)}`),

  aiPortfolioSummary: () =>
    authFetch("/api/ai/portfolio-summary", { method: "POST" }),
};
