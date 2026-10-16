import { api } from './api';

export const claims = {
  list: () => api.get('/claims').then((r) => r.data.data || []),
  create: (payload) => api.post('/claims', payload).then((r) => r.data),
};

export const tickets = {
  list: () => api.get('/support/tickets').then((r) => r.data.data || r.data.tickets || []),
  get: (id) => api.get(`/support/tickets/${id}`).then((r) => r.data),
  create: (payload) => api.post('/support/tickets', payload).then((r) => r.data),
  reply: (id, message) => api.post(`/support/tickets/${id}/messages`, { message }).then((r) => r.data),
};
