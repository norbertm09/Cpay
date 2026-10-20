import axios from 'axios';
import toast from '../utils/toast';

export const apiBaseUrl = process.env.REACT_APP_API_BASE_URL || '';

// ─── Jeton d'accès ────────────────────────────────────────────────
// L'access token (15 min) reste dans localStorage sous admin_token ; le
// refresh opaque vit dans le cookie HttpOnly cp_rt_admin (path
// /api/v1/admin/auth) posé par le backend. withCredentials est donc
// indispensable sur /auth/refresh et /auth/logout.
const TOKEN_KEY = 'admin_token';
const tokenListeners = new Set();

export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } };
export const setToken = (t) => {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* navigation privée */ }
  tokenListeners.forEach((fn) => fn(t || null));
};
export const clearToken = () => setToken(null);
export const onTokenChange = (fn) => { tokenListeners.add(fn); return () => tokenListeners.delete(fn); };

// Décodage local du JWT (base64url, expiration vérifiée). Repli si
// /auth/me est injoignable ; GET /auth/me reste la source du profil.
export const decodeJwt = (t) => {
  try {
    const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const p = JSON.parse(atob(b.padEnd(b.length + ((4 - (b.length % 4)) % 4), '=')));
    if (!p.exp || p.exp * 1000 <= Date.now()) return null;
    return p;
  } catch (e) { return null; }
};

const api = axios.create({ baseURL: `${apiBaseUrl}/api/v1/admin`, withCredentials: true });
// Rails (Visa Direct, Mastercard Developers) sont montés sous /api/v1/rails.
const railsHttp = axios.create({ baseURL: `${apiBaseUrl}/api/v1/rails`, withCredentials: true });

const attachAuth = (instance) => {
  instance.interceptors.request.use((cfg) => {
    const token = getToken();
    if (token) cfg.headers.Authorization = `Bearer ${token}`;
    return cfg;
  });
};
attachAuth(api); attachAuth(railsHttp);

// Appel de refresh nu (hors instance api) : aucune récursion d'intercepteur
// si le refresh lui-même répond 401.
const callRefresh = () => axios.post(`${apiBaseUrl}/api/v1/admin/auth/refresh`, {}, { withCredentials: true });

// Une seule requête de refresh à la fois : les 401 concurrents attendent la
// même promesse, sinon la rotation côté serveur révoquerait les suivants.
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

// Routes d'authentification non protégées : un 401 est une réponse métier,
// pas un jeton expiré. /auth/me, /auth/change-password, /auth/2fa/*
// passent par le refresh comme toute route protégée.
const NO_REFRESH_RE = /\/auth\/(login|refresh|2fa\/validate|forgot-password|reset-password)(\?|$)/;

export const logoutLocal = () => {
  clearToken();
  if (window.location.pathname !== '/login') window.location.href = '/login';
};

const onResponseError = (instance) => async (err) => {
  const st = err.response?.status;
  const original = err.config;
  const isAuthRoute = NO_REFRESH_RE.test(original?.url || '');
  if (st === 401 && original && !original._retry && !isAuthRoute) {
    original._retry = true;
    try {
      const t = await refreshAccessToken();
      original.headers.Authorization = `Bearer ${t}`;
      return instance(original);
    } catch (e) {
      logoutLocal();
    }
  } else if (st === 403 && !original?.silent403) {
    // Droits insuffisants : la session reste valide, on prévient sans rediriger
    toast.error('Accès refusé : vos droits ne permettent pas cette action.');
  }
  return Promise.reject(err);
};
api.interceptors.response.use((r) => r, onResponseError(api));
railsHttp.interceptors.response.use((r) => r, onResponseError(railsHttp));

// Lecture « discrète » : un 403 n'affiche pas de toast (blocs optionnels du tableau de bord).
const quiet = { silent403: true };

// ─── Auth & compte ────────────────────────────────────────────────
export const authApi = {
  login: (data) => api.post('/auth/login', data),
  validate2fa: (data) => api.post('/auth/2fa/validate', data),
  me: () => api.get('/auth/me'),
  logout: () => api.post('/auth/logout'),
  changePassword: (data) => api.post('/auth/change-password', data),
  mfaStatus: () => api.get('/auth/2fa/status'),
  mfaSetup: () => api.post('/auth/2fa/setup'),
  mfaVerify: (token) => api.post('/auth/2fa/verify', { token }),
  mfaDisable: (token) => api.post('/auth/2fa/disable', { token }),
};

// ─── Tableau de bord / monitoring ─────────────────────────────────
export const monitorApi = {
  stats: () => api.get('/stats/global'),
  live: () => api.get('/activity/live'),
  health: () => axios.get(`${apiBaseUrl}/health`, { withCredentials: false }),
  notifications: () => api.get('/notifications'),
  markRead: (id) => api.patch(`/notifications/${id}/read`),
  markAllRead: () => api.patch('/notifications/read-all'),
};

// ─── Marchands ────────────────────────────────────────────────────
export const merchantsApi = {
  list: (params) => api.get('/merchants', { params }),
  get: (id) => api.get(`/merchants/${id}`),
  create: (data) => api.post('/merchants', data),
  setStatus: (id, data) => api.patch(`/merchants/${id}/status`, data),
  setKyb: (id, data) => api.patch(`/merchants/${id}/kyb`, data),
  kyb: (id) => api.get(`/merchants/${id}/kyb`),
  reviewKybDoc: (id, docId, data) => api.patch(`/merchants/${id}/kyb/documents/${docId}`, data),
  addKybDoc: (id, data) => api.post(`/merchants/${id}/kyb/documents`, data),
  saveFees: (id, fees) => api.put(`/merchants/${id}/fees`, { fees }),
  velocity: (id) => api.get(`/merchants/${id}/velocity`),
  saveVelocity: (id, data) => api.put(`/merchants/${id}/velocity`, data),
  integrations: (id) => api.get(`/integrations/merchant/${id}`),
  testEvent: (id, data) => api.post(`/integrations/merchant/${id}/test-event`, data),
  pilotState: (id) => api.get(`/pilot/merchants/${id}`, quiet),
  countryDefaults: () => api.get('/country-defaults'),
};

// Utilisateurs marchands (merchant_users) et réinitialisation (vague 3).
export const usersApi = {
  list: (params) => api.get('/users', { params }),
  create: (data) => api.post('/users', data),
  setActive: (id, is_active) => api.patch(`/users/${id}/status`, { is_active }),
  // type = merchant (défaut) | admin ; réponse { tempPassword } affichée une seule fois
  resetPassword: (id, type = 'merchant') => api.post(`/users/${id}/reset-password`, { type }, { params: { type } }),
};

// ─── Opérations ───────────────────────────────────────────────────
export const txnApi = {
  list: (params) => api.get('/transactions', { params }),
  get: (id) => api.get(`/transactions/${id}`),
  reconcile: (data) => api.post('/reconcile', data),
};

export const fraudApi = {
  events: (params) => api.get('/fraud/events', { params }),
  review: (id, outcome) => api.patch(`/fraud/events/${id}/review`, { outcome }),
  rules: () => api.get('/fraud/rules'),
  createRule: (data) => api.post('/fraud/rules', data),
  updateRule: (id, data) => api.put(`/fraud/rules/${id}`, data),
  alerts: (params) => api.get('/alerts', { params, ...quiet }),
  resolveAlert: (id, note) => api.patch(`/alerts/${id}/resolve`, { note }),
};

export const terminalsApi = {
  list: (params) => api.get('/terminals', { params }),
  setStatus: (id, status) => api.patch(`/terminals/${id}/status`, { status }),
  unblock: (id) => api.patch(`/terminals/${id}/unblock`),
};

// Règlements : lots J+1 (settlement_batches, rôles super_admin/finance_admin)
// et virements bancaires en attente (merchant_transfers pending_settlement).
export const financeApi = {
  batches: (params) => api.get('/finance/settlements', { params, ...quiet }),
  validateBatch: (id, data) => api.patch(`/finance/settlements/${id}/validate`, data),
  rejectBatch: (id, reason) => api.patch(`/finance/settlements/${id}/reject`, { reason }),
  exportCsv: () => api.get('/finance/settlements/export', { responseType: 'blob' }),
  runSettlement: () => api.post('/settlement/run'),
  payouts: (status = 'pending_settlement') => api.get('/settlements', { params: { status }, ...quiet }),
  payoutsSummary: () => api.get('/settlements/summary', quiet),
  completePayout: (id, data) => api.post(`/settlements/${id}/complete`, data),
  rejectPayout: (id, reason) => api.post(`/settlements/${id}/reject`, { reason }),
};

// ─── Caisse (vague 4) — docs/CAISSE-API.md §8, rôles super_admin / ops_admin ──
export const cashApi = {
  stats: () => api.get('/cash/stats', quiet),
  transfers: (params) => api.get('/cash/transfers', { params, ...quiet }),
  transfer: (id) => api.get(`/cash/transfers/${id}`),
  confirmFunds: (id, data) => api.post(`/cash/transfers/${id}/confirm-funds`, data),
  markExecuted: (id, data) => api.post(`/cash/transfers/${id}/mark-executed`, data),
  reject: (id, reason) => api.post(`/cash/transfers/${id}/reject`, { reason }),
  platformAccounts: () => api.get('/cash/platform-accounts', quiet),
  createPlatformAccount: (data) => api.post('/cash/platform-accounts', data),
  updatePlatformAccount: (id, data) => api.patch(`/cash/platform-accounts/${id}`, data),
};

// ─── Rails (super_admin / ops_admin) — /api/v1/rails ─────────────
export const railsApi = {
  visaQuery: (params) => railsHttp.get('/visa-direct/transaction-query', { params }),
  visaBalance: (params) => railsHttp.get('/visa-payouts/v3/account-balance', { params }),
  visaPayouts: (params) => railsHttp.get('/visa-payouts/v3/payouts', { params }),
  mcServices: () => railsHttp.get('/mastercard-developers/services'),
  mcProjects: () => railsHttp.get('/mastercard-developers/projects'),
  mcProject: (id) => railsHttp.get(`/mastercard-developers/projects/${id}`),
};

// ─── Support & CRM ────────────────────────────────────────────────
export const supportApi = {
  tickets: (params) => api.get('/support/tickets', { params }),
  ticket: (id) => api.get(`/support/tickets/${id}`),
  reply: (id, data) => api.post(`/support/tickets/${id}/messages`, data),
  setStatus: (id, data) => api.patch(`/support/tickets/${id}/status`, data),
  assignMe: (id) => api.patch(`/support/tickets/${id}/assign`),
  escalate: (id, data) => api.post(`/support/tickets/${id}/escalate`, data),
  agents: () => api.get('/support/agents'),
  cardholderClaims: () => api.get('/claims', quiet),
  incidents: () => api.get('/incidents', quiet),
};

// Contrat : backend/src/routes/crm-admin.routes.js (docs/ASSISTANT-API.md §3)
export const crmApi = {
  stats: () => api.get('/crm/stats', quiet),
  leads: (params) => api.get('/crm/leads', { params }),
  updateLead: (id, data) => api.patch(`/crm/leads/${id}`, data),
  claims: (params) => api.get('/crm/claims', { params }),
  updateClaim: (id, data) => api.patch(`/crm/claims/${id}`, data),
  conversations: (params) => api.get('/crm/conversations', { params }),
  conversation: (id) => api.get(`/crm/conversations/${id}`),
};

// ─── Partenaires & distribution ───────────────────────────────────
export const partnersApi = {
  banks: () => api.get('/partners/banks'),
  bank: (id) => api.get(`/partners/banks/${id}`),
  bankAgencies: (id) => api.get(`/partners/banks/${id}/agencies`),
  bankAgents: (id) => api.get(`/partners/banks/${id}/agents`),
  createBank: (data) => api.post('/partners/banks', data),
  updateBank: (id, data) => api.patch(`/partners/banks/${id}`, data),
  setBankStatus: (id, status) => api.patch(`/partners/banks/${id}/status`, { status }),
  agencies: () => api.get('/partners/agencies/all'),
  agents: () => api.get('/partners/agents/all'),
  tenants: () => api.get('/tenants'),
  createTenant: (data) => api.post('/tenants', data),
  updateTenant: (id, data) => api.patch(`/tenants/${id}`, data),
};

// ─── Configuration ────────────────────────────────────────────────
// Capacités pays (vague 6, lot 2) : matrice calculée côté serveur (statuts, prérequis, pilotes) — lecture seule.
export const capabilitiesApi = {
  matrix: (refresh) => api.get('/capabilities', { params: refresh ? { refresh: 1 } : undefined }),
  refresh: () => api.post('/capabilities/refresh'),
  publicSummary: () => axios.get(`${apiBaseUrl}/api/v1/public/capabilities`, { withCredentials: false }),
};

export const configApi = {
  apiConfigs: (params) => api.get('/api-configs', { params }),
  apiConfig: (id) => api.get(`/api-configs/${id}`),
  envStatus: () => api.get('/api-configs/env-status'),
  updateApiConfig: (key, data) => api.put(`/api-configs/${key}`, data),
  testApiConfig: (key) => api.post(`/api-configs/${key}/test`),
  countryDefaults: () => api.get('/country-defaults'),
  notifConfigs: () => api.get('/notification-configs'),
  saveNotifConfig: (data) => api.post('/notification-configs', data),
  testNotifConfig: (section) => api.post('/notification-configs/test', { section }),
  sendTestNotif: (section, to) => api.post('/notification-configs/send-test', { section, to }),
  adminUsers: () => api.get('/admin-users'),
  createAdmin: (data) => api.post('/admin-users', data),
  updateAdmin: (id, data) => api.patch(`/admin-users/${id}`, data),
  auditLogs: (params) => api.get('/audit-logs', { params, ...quiet }),
  pilotFeatures: () => api.get('/pilot/features'),
  updateFeature: (key, data) => api.put(`/pilot/features/${key}`, data),
  pilotPrograms: () => api.get('/pilot/programs'),
  pilotReadiness: () => api.get('/pilot/readiness'),
};

export default api;
