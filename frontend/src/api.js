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
};
