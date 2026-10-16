// Couche HTTP du portail porteur.
// - jeton d'acces (15 min) dans localStorage sous `ch_token` ;
// - refresh opaque dans le cookie HttpOnly `cp_rt_cardholder` pose par le
//   backend (path /api/v1/cardholder/auth), d'ou `withCredentials` ;
// - 401 -> refresh single-flight puis rejeu de la requete ;
// - 403 -> toast « Acces refuse » ;
// - 410 / FEATURE_DISABLED -> laisse aux ecrans le soin d'afficher
//   l'etat « en cours d'integration » (voir utils/errors.js).
import axios from 'axios';
import toast from 'react-hot-toast';

export const BASE = process.env.REACT_APP_API_BASE_URL || '';
export const API_ROOT = `${BASE}/api/v1`;
const LOGIN_PATH = '/connexion';

const TOKEN_KEY = 'ch_token';
const tokenListeners = new Set();

export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } };
export const setToken = (t) => {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* navigation privee */ }
  tokenListeners.forEach((fn) => fn(t || null));
};
export const clearToken = () => setToken(null);
export const subscribeToken = (fn) => { tokenListeners.add(fn); return () => tokenListeners.delete(fn); };

// Decodage local du JWT (base64url, expiration verifiee). Repli si /auth/me
// est injoignable ; GET /auth/me reste la source du profil.
export const decodeJwt = (t) => {
  try {
    const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const p = JSON.parse(atob(b.padEnd(b.length + ((4 - (b.length % 4)) % 4), '=')));
    if (!p.exp || p.exp * 1000 <= Date.now()) return null;
    return p;
  } catch (e) { return null; }
};

export const api = axios.create({ baseURL: `${API_ROOT}/cardholder`, withCredentials: true });
api.interceptors.request.use((cfg) => {
  const token = getToken();
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

// Refresh nu (hors instance api) et single-flight : les 401 concurrents
// attendent la meme promesse, sinon la rotation revoquerait les suivants.
const callRefresh = () => axios.post(`${API_ROOT}/cardholder/auth/refresh`, {}, { withCredentials: true });
let refreshPromise = null;
export const refreshAccessToken = () => {
  if (!refreshPromise) {
    refreshPromise = callRefresh()
      .then(({ data }) => {
        if (!data.access_token) throw new Error('no access_token');
        setToken(data.access_token);
        return data.access_token;
      })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
};

// Routes d'authentification non protegees : un 401 est une reponse metier.
const NO_REFRESH_RE = /\/auth\/(login|refresh|register|2fa\/validate|forgot-password|reset-password|verify-email)(\?|$)/;
export const logoutLocal = () => {
  clearToken();
  if (window.location.pathname !== LOGIN_PATH) window.location.href = LOGIN_PATH;
};

api.interceptors.response.use((r) => r, async (err) => {
  const st = err.response?.status;
  const original = err.config;
  const isAuthRoute = NO_REFRESH_RE.test(original?.url || '');
  if (st === 401 && original && !original._retry && !isAuthRoute) {
    original._retry = true;
    try {
      const t = await refreshAccessToken();
      original.headers.Authorization = `Bearer ${t}`;
      return api(original);
    } catch (e) { logoutLocal(); }
  } else if (st === 403) {
    toast.error('Accès refusé');
  }
  return Promise.reject(err);
});

// Options pour les routes hors prefixe /cardholder (consentement, liens de paiement publics).
export const rootScope = { baseURL: API_ROOT };
