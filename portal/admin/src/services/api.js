import axios from 'axios';

const api = axios.create({ baseURL: '/api/v1/admin' });

api.interceptors.request.use(cfg => {
  const token = localStorage.getItem('admin_token');
  if (token) cfg.headers.Authorization = `Bearer ${token}`;
  return cfg;
});

api.interceptors.response.use(r => r, err => {
  if (err.response?.status === 401) {
    localStorage.removeItem('admin_token');
    window.location.href = '/login';
  }
  return Promise.reject(err);
});

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

export default api;
