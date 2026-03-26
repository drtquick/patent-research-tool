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
  search: (patent_number) =>
    authFetch("/api/search", {
      method: "POST",
      body: JSON.stringify({ patent_number }),
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
};
