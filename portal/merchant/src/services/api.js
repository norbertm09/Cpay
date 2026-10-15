// C-Pay — couche API du portail marchand.
//
// Contient la couche axios historique (token d'acces en memoire, refresh
// single-flight via cookie HttpOnly cp_rt_merchant, 401 -> refresh -> rejeu)
// et, depuis la vague 4, l'espace `cashApi` (caisse marchande, contrat
// docs/CAISSE-API.md) ainsi que `detectApi` (detection publique d'operateur).
import axios from 'axios';
import toast from 'react-hot-toast';

const apiBaseUrl = process.env.REACT_APP_API_BASE_URL || '';

// ─── Stockage de l'access token EN MEMOIRE ────────────────────────
//
// Volontairement hors de localStorage. Une XSS peut encore lire cette
// variable, mais le token expire en 15 minutes et ne permet aucun
// renouvellement : le refresh vit desormais dans un cookie HttpOnly
// (cp_rt_merchant), inaccessible au JavaScript.
//
// Contrepartie : un rechargement de page perd le token. C'est le role du
// refresh silencieux au demarrage (voir AuthProvider).
let accessToken = null;
const authListeners = new Set();

// Decodage local du JWT (base64url, expiration verifiee). Ne sert plus qu'a
// deux choses : savoir si le jeton en memoire est encore valide, et fournir
// un profil de repli si /auth/me est injoignable (coupure reseau). Le profil
// de reference vient de GET /auth/me (role, merchantId, mfaEnabled, nom...).
const decodeJwt = (t) => {
  try {
    const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const p = JSON.parse(atob(b.padEnd(b.length + (4 - b.length % 4) % 4, '=')));
    if (!p.exp || p.exp * 1000 <= Date.now()) return null;
    return p;
  } catch { return null; }
};

// Profil de repli construit a partir des claims du jeton : memes cles que
// merchantProfile() cote backend pour que les composants n'aient pas a
// distinguer les deux sources.
const userFromClaims = (c) => c ? ({
  userId: c.sub, merchantId: c.merchantId, role: c.role,
  businessName: c.businessName, country: c.country, currency: c.currency,
  _source: 'token',
}) : null;

// Routes d'authentification non protegees : un 401 sur celles-ci est une
// reponse metier (identifiants faux, refresh revoque...), pas un jeton
// expire. Tout le reste (/auth/me, /auth/change-password, /auth/2fa/*...)
// passe par le refresh comme n'importe quelle route protegee.
const NO_REFRESH_RE = /\/auth\/(login|refresh|register|2fa\/validate|forgot-password|reset-password)(\?|$)/;

const setAccessToken = (t) => {
  accessToken = t || null;
  authListeners.forEach(fn => fn(accessToken));
};

const getAccessToken = () => accessToken;

// withCredentials : indispensable pour que le navigateur joigne le cookie
// cp_rt_merchant aux appels vers /auth/refresh et /auth/logout.
const api = axios.create({
  baseURL: `${apiBaseUrl}/api/v1/merchant`,
  withCredentials: true,
});

api.interceptors.request.use(cfg => {
  if (accessToken) cfg.headers.Authorization = `Bearer ${accessToken}`;
  return cfg;
});

// Appel de refresh nu : pas d'instance api, pour eviter toute recursion
// d'intercepteur si le refresh lui-meme repond 401.
const callRefresh = () =>
  axios.post(`${apiBaseUrl}/api/v1/merchant/auth/refresh`, {}, { withCredentials: true });

// Une seule requete de refresh a la fois. Les appels concurrents qui se
// prennent un 401 attendent la meme promesse plutot que d'en declencher
// chacun un : la rotation cote serveur revoquerait les suivants.
let refreshPromise = null;

const refreshAccessToken = () => {
  if (!refreshPromise) {
    refreshPromise = callRefresh()
      .then(({ data }) => {
        if (!data.access_token) throw new Error('no access_token');
        setAccessToken(data.access_token);
        return data.access_token;
      })
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
};

api.interceptors.response.use(r => r, async err => {
  const original = err.config;
  const isAuthRoute = NO_REFRESH_RE.test(original?.url || '');
  // 403 : droits insuffisants -> simple toast, aucune redirection (la session reste valide)
  if (err.response?.status === 403 && !isAuthRoute) toast.error('Accès refusé');
  if (err.response?.status === 401 && original && !original._retry && !isAuthRoute) {
    original._retry = true;
    try {
      const t = await refreshAccessToken();
      original.headers.Authorization = `Bearer ${t}`;
      return api(original);
    } catch (e) {
      setAccessToken(null);
      window.location.href = '/login';
    }
  }
  return Promise.reject(err);
});

// ─── Caisse marchande (vague 4, docs/CAISSE-API.md) ───────────────
//
// Toute operation qui cree un mouvement exige un en-tete Idempotency-Key
// (8-128 caracteres) : un UUID par tentative, genere par l'ecran appelant
// via newIdempotencyKey().
export const newIdempotencyKey = () => {
  try { if (window.crypto?.randomUUID) return window.crypto.randomUUID(); } catch (e) { /* ancien navigateur */ }
  return 'ck-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
};
const idem = (key) => ({ headers: { 'Idempotency-Key': key || newIdempotencyKey() } });

export const cashApi = {
  summary:        ()             => api.get('/cash/summary'),
  // Encaisser
  collect:        (body, key)    => api.post('/cash/collect', body, idem(key)),
  collectStatus:  (txnId)        => api.get(`/cash/collect/${encodeURIComponent(txnId)}`),
  // Wallet du marchand (destination des retraits) : 200 ou 204
  getWallet:      ()             => api.get('/cash/wallet'),
  putWallet:      (body)         => api.put('/cash/wallet', body),
  // Retirer
  withdraw:       (body, key)    => api.post('/cash/withdraw', body, idem(key)),
  // Transferer
  createTransfer: (body, key)    => api.post('/cash/transfers', body, idem(key)),
  listTransfers:  (params)       => api.get('/cash/transfers', { params }),
  getTransfer:    (id)           => api.get(`/cash/transfers/${encodeURIComponent(id)}`),
  cancelTransfer: (id)           => api.post(`/cash/transfers/${encodeURIComponent(id)}/cancel`),
  // Journal
  history:        (params)       => api.get('/cash/history', { params }),
  exportHistoryCsv: (params)     => api.get('/cash/history/export.csv', { params, responseType: 'blob' }),
  // Comptes bancaires (routes existantes depuis 2.6.0)
  bankAccounts:   ()             => api.get('/bank-accounts'),
  addBankAccount: (body)         => api.post('/bank-accounts', body),
  institutions:   (country)      => api.get('/institutions', { params: { country } }),
};

// Detection publique d'operateur (pas d'authentification, pas de cookie).
export const detectApi = {
  phone: (phone, signal) => axios.post(`${apiBaseUrl}/api/v1/detect/phone`, { phone }, { signal }),
};

// Erreur « fonctionnalite indisponible » : 410 FEATURE_DISABLED (route
// desactivee) ou 404 (route pas encore deployee) -> « en cours d'integration ».
export const isFeatureUnavailable = (err) => {
  const st = err?.response?.status;
  return st === 410 || st === 404 || err?.response?.data?.code === 'FEATURE_DISABLED';
};

export { api, apiBaseUrl, setAccessToken, getAccessToken, authListeners, refreshAccessToken, decodeJwt, userFromClaims };
export default api;
