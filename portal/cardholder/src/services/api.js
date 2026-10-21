// Couche HTTP du portail porteur.
// - jeton d'acces (15 min) EN MEMOIRE uniquement (audit residuel P2 : plus
//   rien dans localStorage, un XSS ne peut plus exfiltrer un jeton persistant) ;
// - refresh opaque dans le cookie HttpOnly `cp_rt_cardholder` pose par le
//   backend (path /api/v1/cardholder/auth, SameSite=Strict), d'ou `withCredentials` ;
// - un rechargement perd le jeton : refresh silencieux au demarrage (hooks/useAuth) ;
// - 401 -> refresh single-flight puis rejeu de la requete ;
// - 403 -> toast « Acces refuse » ;
// - 410 / FEATURE_DISABLED -> laisse aux ecrans le soin d'afficher
//   l'etat « en cours d'integration » (voir utils/errors.js) ;
// - multi-onglets : BroadcastChannel `cpay-cardholder-session` (repli : evenement
//   `storage` sur un drapeau non sensible) pour propager connexion/deconnexion.
import axios from 'axios';
import toast from 'react-hot-toast';

export const BASE = import.meta.env.REACT_APP_API_BASE_URL || '';
export const API_ROOT = `${BASE}/api/v1`;
const LOGIN_PATH = '/connexion';

// ─── Jeton d'acces en memoire ─────────────────────────────────────
let accessToken = null;
const tokenListeners = new Set();

export const getToken = () => accessToken;
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

// Secondes restantes avant expiration du jeton en memoire (0 si absent/expire).
export const tokenTtl = () => {
  const p = accessToken ? decodeJwt(accessToken) : null;
  return p ? Math.max(0, Math.floor(p.exp - Date.now() / 1000)) : 0;
};

// ─── Synchronisation multi-onglets ────────────────────────────────
// Le canal ne transporte JAMAIS de jeton : seulement un type d'evenement.
// Un onglet qui apprend une connexion obtient son propre jeton via le cookie
// (refresh), un onglet qui apprend une deconnexion vide sa memoire.
const CHANNEL = 'cpay-cardholder-session';
const sessionListeners = new Set();
let channel = null;
try { if (typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel(CHANNEL); } catch (e) { channel = null; }
const dispatchSession = (msg) => { if (msg && msg.type) sessionListeners.forEach((fn) => fn(msg)); };
if (channel) channel.onmessage = (ev) => dispatchSession(ev.data);
else if (typeof window !== 'undefined') {
  // Repli : drapeau non sensible dans localStorage (type + horodatage, aucun jeton).
  window.addEventListener('storage', (ev) => {
    if (ev.key !== CHANNEL || !ev.newValue) return;
    try { dispatchSession(JSON.parse(ev.newValue)); } catch (e) { /* valeur inattendue */ }
  });
}
export const broadcastSession = (type) => {
  const msg = { type, at: Date.now() };
  if (channel) { try { channel.postMessage(msg); } catch (e) { /* canal ferme */ } return; }
  try { localStorage.setItem(CHANNEL, JSON.stringify(msg)); localStorage.removeItem(CHANNEL); } catch (e) { /* navigation privee */ }
};
export const subscribeSession = (fn) => { sessionListeners.add(fn); return () => sessionListeners.delete(fn); };

// setToken(jeton) apres une connexion explicite prévient les autres onglets ;
// le refresh silencieux passe { broadcast: false } pour ne pas boucler.
export const setToken = (t, { broadcast = true } = {}) => {
  const had = !!accessToken;
  accessToken = t || null;
  tokenListeners.forEach((fn) => fn(accessToken));
  if (broadcast && accessToken && !had) broadcastSession('login');
};

// ─── Instance axios ───────────────────────────────────────────────
export const api = axios.create({ baseURL: `${API_ROOT}/cardholder`, withCredentials: true });
api.interceptors.request.use((cfg) => {
  if (accessToken) cfg.headers.Authorization = `Bearer ${accessToken}`;
  return cfg;
});

// X-Requested-With : defense en profondeur contre un POST cross-site « simple »
// (la protection CSRF reelle est le cookie SameSite=Strict a path restreint).
// Le backend (cors() sans allowedHeaders) reflete les en-tetes demandes en preflight.
const XHR_HEADERS = { 'X-Requested-With': 'XMLHttpRequest' };

// Refresh nu (hors instance api) et single-flight : les 401 concurrents
// attendent la meme promesse, sinon la rotation revoquerait les suivants.
const callRefresh = () => axios.post(`${API_ROOT}/cardholder/auth/refresh`, {}, { withCredentials: true, headers: XHR_HEADERS });
// Verrou inter-onglets (Web Locks) : le backend detecte la reutilisation d'un
// refresh deja tourne et revoque TOUTES les sessions (REFRESH_REUSED). Deux
// onglets restaures en meme temps doivent donc se rafraichir l'un apres l'autre.
const LOCK = 'cpay-cardholder-refresh';
const withCrossTabLock = (fn) => {
  try { if (typeof navigator !== 'undefined' && navigator.locks?.request) return navigator.locks.request(LOCK, fn); } catch (e) { /* API absente */ }
  return fn();
};
let refreshPromise = null;
export const refreshAccessToken = () => {
  if (!refreshPromise) {
    refreshPromise = withCrossTabLock(callRefresh)
      .then(({ data }) => {
        if (!data.access_token) throw new Error('no access_token');
        setToken(data.access_token, { broadcast: false });
        return data.access_token;
      })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
};

// Deconnexion locale (jeton en memoire efface, autres onglets prevenus) puis
// retour a l'ecran de connexion. Ne revoque pas le refresh : voir logoutServer.
export const logoutLocal = ({ broadcast = true } = {}) => {
  clearToken();
  if (broadcast) broadcastSession('logout');
  if (window.location.pathname !== LOGIN_PATH) window.location.href = LOGIN_PATH;
};

// Deconnexion reelle : POST /auth/logout (Bearer + cookie) revoque le refresh
// et efface le cookie cote serveur. Toujours suivie d'un logoutLocal.
export const logoutServer = () => api.post('/auth/logout', {}, { headers: XHR_HEADERS });

// Routes d'authentification non protegees : un 401 est une reponse metier.
const NO_REFRESH_RE = /\/auth\/(login|refresh|register|2fa\/validate|forgot-password|reset-password|verify-email)(\?|$)/;

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
