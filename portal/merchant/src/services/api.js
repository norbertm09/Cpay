// C-Pay — couche API du portail marchand.
//
// Couche axios : token d'accès en mémoire, refresh single-flight via le cookie
// HttpOnly cp_rt_merchant, 401 -> refresh -> rejeu, 403 -> toast. Les espaces
// de noms (authApi, cashApi, activityApi, salesApi, integrationsApi, accountApi)
// n'appellent que des routes existantes de backend/src/routes/merchant.routes.js,
// cash.routes.js et server.js (consentement, détection).
import axios from 'axios';
import toast from 'react-hot-toast';

const apiBaseUrl = import.meta.env.REACT_APP_API_BASE_URL || '';

// ─── Stockage de l'access token EN MÉMOIRE ────────────────────────
//
// Volontairement hors de localStorage : le token expire en 15 minutes et ne
// permet aucun renouvellement, le refresh vit dans un cookie HttpOnly
// inaccessible au JavaScript. Un rechargement de page perd le token : c'est le
// rôle du refresh silencieux au démarrage (voir hooks/useAuth).
let accessToken = null;
const authListeners = new Set();

// Décodage local du JWT (base64url, expiration vérifiée) : sert à savoir si le
// jeton en mémoire est encore valide et à fournir un profil de repli si
// /auth/me est injoignable (coupure réseau).
const decodeJwt = (t) => {
  try {
    const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const p = JSON.parse(atob(b.padEnd(b.length + (4 - b.length % 4) % 4, '=')));
    if (!p.exp || p.exp * 1000 <= Date.now()) return null;
    return p;
  } catch { return null; }
};

// Profil de repli construit à partir des claims : mêmes clés que merchantProfile()
// côté backend pour que les composants n'aient pas à distinguer les deux sources.
const userFromClaims = (c) => c ? ({
  userId: c.sub, merchantId: c.merchantId, role: c.role,
  businessName: c.businessName, country: c.country, currency: c.currency,
  _source: 'token',
}) : null;

// Routes d'authentification non protégées : un 401 sur celles-ci est une
// réponse métier (identifiants faux, refresh révoqué...), pas un jeton expiré.
const NO_REFRESH_RE = /\/auth\/(login|refresh|register|2fa\/validate|forgot-password|reset-password)(\?|$)/;

const setAccessToken = (t) => {
  accessToken = t || null;
  authListeners.forEach(fn => fn(accessToken));
};
const getAccessToken = () => accessToken;

// Appel de refresh nu : pas d'instance api, pour éviter toute récursion
// d'intercepteur si le refresh lui-même répond 401.
const callRefresh = () =>
  axios.post(`${apiBaseUrl}/api/v1/merchant/auth/refresh`, {}, { withCredentials: true });

// Une seule requête de refresh à la fois : les appels concurrents qui prennent
// un 401 attendent la même promesse (la rotation côté serveur révoquerait les suivants).
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

// withCredentials : indispensable pour que le navigateur joigne le cookie
// cp_rt_merchant aux appels vers /auth/refresh et /auth/logout.
const withInterceptors = (instance) => {
  instance.interceptors.request.use(cfg => {
    if (accessToken) cfg.headers.Authorization = `Bearer ${accessToken}`;
    return cfg;
  });
  instance.interceptors.response.use(r => r, async err => {
    const original = err.config;
    const isAuthRoute = NO_REFRESH_RE.test(original?.url || '');
    // 403 : droits insuffisants -> simple toast, aucune redirection (la session reste valide)
    if (err.response?.status === 403 && !isAuthRoute) toast.error('Accès refusé');
    if (err.response?.status === 401 && original && !original._retry && !isAuthRoute) {
      original._retry = true;
      try {
        const t = await refreshAccessToken();
        original.headers.Authorization = `Bearer ${t}`;
        return instance(original);
      } catch (e) {
        setAccessToken(null);
        window.location.href = '/login';
      }
    }
    return Promise.reject(err);
  });
  return instance;
};

const api = withInterceptors(axios.create({ baseURL: `${apiBaseUrl}/api/v1/merchant`, withCredentials: true }));
// Routes hors /merchant (consentement CGU) : même jeton, même refresh.
const apiRoot = withInterceptors(axios.create({ baseURL: `${apiBaseUrl}/api/v1`, withCredentials: true }));

// ─── Idempotence ──────────────────────────────────────────────────
// Toute opération qui crée un mouvement exige un en-tête Idempotency-Key
// (8-128 caractères) : un UUID par tentative.
export const newIdempotencyKey = () => {
  try { if (window.crypto?.randomUUID) return window.crypto.randomUUID(); } catch (e) { /* ancien navigateur */ }
  return 'ck-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
};
const idem = (key) => ({ headers: { 'Idempotency-Key': key || newIdempotencyKey() } });
const enc = encodeURIComponent;

// ─── Authentification, session, sécurité ─────────────────────────
export const authApi = {
  login:          (body)  => api.post('/auth/login', body),
  validate2fa:    (body)  => api.post('/auth/2fa/validate', body),
  me:             ()      => api.get('/auth/me'),
  register:       (body)  => api.post('/auth/register', body),
  logout:         ()      => api.post('/auth/logout'),
  changePassword: (body)  => api.post('/auth/change-password', body),
  forgotPassword: (email) => api.post('/auth/forgot-password', { email }),
  resetPassword:  (body)  => api.post('/auth/reset-password', body),
  twoFaStatus:    ()      => api.get('/auth/2fa/status'),
  twoFaSetup:     ()      => api.post('/auth/2fa/setup'),
  twoFaVerify:    (token) => api.post('/auth/2fa/verify', { token }),
  twoFaDisable:   (token) => api.post('/auth/2fa/disable', { token }),
  institutions:   (country) => api.get('/institutions', { params: { country } }),
};

export const consentApi = {
  check:  () => apiRoot.get('/consent/check', { params: { portal: 'merchant' } }),
  accept: (body) => apiRoot.post('/consent/accept', { portal: 'merchant', ...body }),
};

// ─── Caisse marchande (docs/CAISSE-API.md) ────────────────────────
export const cashApi = {
  summary:        ()          => api.get('/cash/summary'),
  collect:        (body, key) => api.post('/cash/collect', body, idem(key)),
  collectStatus:  (txnId)     => api.get(`/cash/collect/${enc(txnId)}`),
  getWallet:      ()          => api.get('/cash/wallet'),
  putWallet:      (body)      => api.put('/cash/wallet', body),
  withdraw:       (body, key) => api.post('/cash/withdraw', body, idem(key)),
  createTransfer: (body, key) => api.post('/cash/transfers', body, idem(key)),
  listTransfers:  (params)    => api.get('/cash/transfers', { params }),
  getTransfer:    (id)        => api.get(`/cash/transfers/${enc(id)}`),
  cancelTransfer: (id)        => api.post(`/cash/transfers/${enc(id)}/cancel`),
  history:        (params)    => api.get('/cash/history', { params }),
  exportHistoryCsv: (params)  => api.get('/cash/history/export.csv', { params, responseType: 'blob' }),
};

// Détection publique d'opérateur (pas d'authentification, pas de cookie).
export const detectApi = {
  // country = pays du marchand : permet la saisie d'un numéro local sans indicatif (06 XXX XX XX au Congo)
  phone: (phone, signal, country) => axios.post(`${apiBaseUrl}/api/v1/detect/phone`, country ? { phone, country } : { phone }, { signal }),
};

// Capacités réelles par pays (registre serveur, vague 6) : public, sans cookie, cache 60 s côté API.
export const capabilitiesApi = {
  summary: () => axios.get(`${apiBaseUrl}/api/v1/public/capabilities`, { withCredentials: false }),
};

// ─── Activité : transactions, règlements, reçus ───────────────────
export const activityApi = {
  dashboard:        ()       => api.get('/dashboard'),
  transactions:     (params) => api.get('/transactions', { params }),
  transaction:      (id)     => api.get(`/transactions/${enc(id)}`),
  settlements:      ()       => api.get('/settlements'),
  settlementsDaily: ()       => api.get('/settlements/daily'),
  settlementsDay:   (date)   => api.get(`/settlements/daily/${enc(date)}`),
  receiptSms:       (body)   => api.post('/receipts/sms', body),
};

// ─── Outils de vente : liens de paiement, terminaux ───────────────
export const salesApi = {
  payLinks:       (params)     => api.get('/pay-links', { params }),
  payLinkStats:   ()           => api.get('/pay-links/stats'),
  createPayLink:  (body, key)  => api.post('/pay-links', body, idem(key)),
  sendPayLink:    (id, body)   => api.post(`/pay-links/${enc(id)}/send`, body),
  cancelPayLink:  (id)         => api.delete(`/pay-links/${enc(id)}`),
  terminals:      ()           => api.get('/terminals'),
  createTerminal: (body)       => api.post('/terminals', body),
  updateTerminal: (id, body)   => api.put(`/terminals/${enc(id)}`, body),
  deleteTerminal: (id)         => api.delete(`/terminals/${enc(id)}`),
  regenerateCode: (id)         => api.post(`/terminals/${enc(id)}/regenerate-code`),
};

// ─── Intégrations : clés API, webhooks, connecteurs ───────────────
export const integrationsApi = {
  apiKeys:        ()         => api.get('/api-keys'),
  createApiKey:   (body)     => api.post('/api-keys', body),
  revokeApiKey:   (id)       => api.delete(`/api-keys/${enc(id)}`),
  deleteApiKey:   (id)       => api.delete(`/api-keys/${enc(id)}/permanent`),
  webhookConfig:  ()         => api.get('/webhook-config'),
  saveWebhook:    (body)     => api.patch('/webhook-config', body),
  testWebhook:    ()         => api.post('/webhook-config/test'),
  connectors:     ()         => api.get('/integrations'),
  createConnector:(body)     => api.post('/integrations', body),
  updateConnector:(id, body) => api.put(`/integrations/${enc(id)}`, body),
};

// ─── Compte : profil, KYB, comptes bancaires, support ─────────────
export const accountApi = {
  get:              ()         => api.get('/account'),
  update:           (body)     => api.put('/account', body),
  kyb:              ()         => api.get('/kyb'),
  uploadKybDocument:(body)     => api.post('/kyb/documents', body),
  bankAccounts:     ()         => api.get('/bank-accounts'),
  addBankAccount:   (body)     => api.post('/bank-accounts', body),
  deleteBankAccount:(id, confirm) => api.delete(`/bank-accounts/${enc(id)}`, { data: { confirm } }),
  tickets:          ()         => api.get('/support/tickets'),
  createTicket:     (body)     => api.post('/support/tickets', body),
  ticket:           (id)       => api.get(`/support/tickets/${enc(id)}`),
  replyTicket:      (id, body) => api.post(`/support/tickets/${enc(id)}/messages`, body),
  resolveTicket:    (id)       => api.patch(`/support/tickets/${enc(id)}/resolve`),
};

// Erreur « fonctionnalité indisponible » : 410 FEATURE_DISABLED (route
// désactivée) ou 404 (route pas encore déployée) -> « en cours d'intégration ».
export const isFeatureUnavailable = (err) => {
  const st = err?.response?.status;
  return st === 410 || st === 404 || err?.response?.data?.code === 'FEATURE_DISABLED';
};
export const isStepUp = (err) => err?.response?.status === 428 || err?.response?.data?.code === 'STEP_UP_REQUIRED';
// 403 CAPABILITY_NOT_ACTIVE : moyen / opérateur non activé dans le pays du marchand (registre de capacités).
export const isCapabilityBlocked = (err) => err?.response?.data?.code === 'CAPABILITY_NOT_ACTIVE';

export { api, apiBaseUrl, setAccessToken, getAccessToken, authListeners, refreshAccessToken, decodeJwt, userFromClaims };
export default api;
