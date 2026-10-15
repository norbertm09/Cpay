import axios from 'axios';
import toast from 'react-hot-toast';

const apiBaseUrl = process.env.REACT_APP_API_BASE_URL || '';

// ─── Jeton d'acces ────────────────────────────────────────────────
// L'access token (15 min) reste dans localStorage sous admin_token ; le
// refresh opaque vit dans le cookie HttpOnly cp_rt_admin (path
// /api/v1/admin/auth) pose par le backend. withCredentials est donc
// indispensable sur /auth/refresh et /auth/logout.
const TOKEN_KEY = 'admin_token';
const tokenListeners = new Set();

export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch (e) { return null; } };
export const setToken = (t) => {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* navigation privee */ }
  tokenListeners.forEach(fn => fn(t || null));
};
export const clearToken = () => setToken(null);
export const onTokenChange = (fn) => { tokenListeners.add(fn); return () => tokenListeners.delete(fn); };

// Decodage local du JWT (base64url, expiration verifiee). Repli si
// /auth/me est injoignable ; GET /auth/me reste la source du profil.
export const decodeJwt = (t) => {
  try {
    const b = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const p = JSON.parse(atob(b.padEnd(b.length + (4 - b.length % 4) % 4, '=')));
    if (!p.exp || p.exp * 1000 <= Date.now()) return null;
    return p;
  } catch (e) { return null; }
};

const api = axios.create({ baseURL: `${apiBaseUrl}/api/v1/admin`, withCredentials: true });

api.interceptors.request.use(cfg => {
  const token = getToken();
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

// Appel de refresh nu (hors instance api) : aucune recursion d'intercepteur
// si le refresh lui-meme repond 401.
const callRefresh = () =>
  axios.post(`${apiBaseUrl}/api/v1/admin/auth/refresh`, {}, { withCredentials: true });

// Une seule requete de refresh a la fois : les 401 concurrents attendent la
// meme promesse, sinon la rotation cote serveur revoquerait les suivants.
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

// Routes d'authentification non protegees : un 401 est une reponse metier,
// pas un jeton expire. /auth/me, /auth/change-password, /auth/2fa/*
// passent par le refresh comme toute route protegee.
const NO_REFRESH_RE = /\/auth\/(login|refresh|2fa\/validate|forgot-password|reset-password)(\?|$)/;

export const logoutLocal = () => {
  clearToken();
  if (window.location.pathname !== '/login') window.location.href = '/login';
};

api.interceptors.response.use(r => r, async err => {
  const st = err.response?.status;
  const original = err.config;
  const isAuthRoute = NO_REFRESH_RE.test(original?.url || '');
  if (st === 401 && original && !original._retry && !isAuthRoute) {
    original._retry = true;
    try {
      const t = await refreshAccessToken();
      original.headers.Authorization = `Bearer ${t}`;
      return api(original);
    } catch (e) {
      logoutLocal();
    }
  } else if (st === 403) {
    // Droits insuffisants : la session reste valide, on previent sans rediriger
    toast.error('Accès refusé');
  }
  return Promise.reject(err);
});

export const reconcileApi = {
  // Deplacee de /merchant/reconcile : POST /api/v1/admin/reconcile (super_admin / ops_admin)
  run: (data) => api.post('/reconcile', data),
};

export const authApi = {
  login:  (data) => api.post('/auth/login', data),
  me:     ()     => api.get('/auth/me'),
  logout: ()     => api.post('/auth/logout'),
};

export const apiConfigsApi = {
  list:   (params) => api.get('/api-configs', { params }),
  get:    (id)     => api.get(`/api-configs/${id}`),
  update: (key, data) => api.put(`/api-configs/${key}`, data),
  test:   (key)    => api.post(`/api-configs/${key}/test`),
};

export const merchantsApi = {
  list:       (params) => api.get('/merchants', { params }),
  get:        (id)     => api.get(`/merchants/${id}`),
  setStatus:  (id, data) => api.patch(`/merchants/${id}/status`, data),
  setKyb:     (id, data) => api.patch(`/merchants/${id}/kyb`, data),
};

export const monitorApi = {
  live:   () => api.get('/activity/live'),
  stats:  () => api.get('/stats/global'),
};

export const terminalsApi = {
  list:      (params) => api.get('/terminals', { params }),
  setStatus: (id, data) => api.patch(`/terminals/${id}/status`, data),
};

export const auditApi = {
  list: (params) => api.get('/audit-logs', { params }),
};

export const supportApi = {
  list: (params) => api.get('/support/tickets', { params }),
  get: (id) => api.get(`/support/tickets/${id}`),
  reply: (id, data) => api.post(`/support/tickets/${id}/messages`, data),
  update: (id, data) => api.patch(`/support/tickets/${id}`, data),
};

export const pilotApi = {
  programs: () => api.get('/pilot/programs'),
  features: () => api.get('/pilot/features'),
  readiness: () => api.get('/pilot/readiness'),
  updateFeature: (flagKey, data) => api.put(`/pilot/features/${flagKey}`, data),
  enroll: (pilotKey, data) => api.post(`/pilot/programs/${pilotKey}/enroll`, data),
  merchantState: (merchantId) => api.get(`/pilot/merchants/${merchantId}`),
  evaluate: (data) => api.post('/pilot/evaluate', data),
};

export default api;
