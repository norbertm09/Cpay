import axios from 'axios';
import toast from 'react-hot-toast';

const apiBaseUrl = process.env.REACT_APP_API_BASE_URL || '';
const api = axios.create({ baseURL: `${apiBaseUrl}/api/v1/admin` });

api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('admin_token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

api.interceptors.response.use(r => r, err => {
  const st = err.response?.status;
  if (st === 401) {
    localStorage.removeItem('admin_token');
    if (window.location.pathname !== '/login') window.location.href = '/login';
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
  login: (data) => api.post('/auth/login', data),
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
