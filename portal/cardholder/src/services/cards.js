import { api } from './api';

// Carte virtuelle principale (celle du jeton) et cartes creees (max 3).
export const getCard = () => api.get('/card').then((r) => r.data);
export const setCardStatus = (action) => api.patch('/card/status', { action }).then((r) => r.data);
export const setPin = ({ currentPin, newPin, cardId }) => api.post('/card/pin', { currentPin: currentPin || undefined, newPin, cardId }).then((r) => r.data);
export const listCreated = () => api.get('/cards/created').then((r) => r.data);
export const createCard = (label) => api.post('/cards/create', { label }).then((r) => r.data);
export const deleteCreated = (cardId) => api.delete(`/cards/created/${cardId}`).then((r) => r.data);

// Cartes externes enrolees (tokenisees)
export const listEnrolled = () => api.get('/cards').then((r) => r.data.data || []);
export const setDefaultEnrolled = (enrollmentId) => api.patch(`/cards/${enrollmentId}/default`).then((r) => r.data);
export const removeEnrolled = (enrollmentId) => api.delete(`/cards/${enrollmentId}`).then((r) => r.data);

// Cartes GTP (prepayees reseau)
export const gtp = {
  status: () => api.get('/gtp/status').then((r) => r.data),
  list: () => api.get('/gtp/cards').then((r) => r.data.data || []),
  detail: (id) => api.get(`/gtp/cards/${id}`).then((r) => r.data),
  transactions: (id, params) => api.get(`/gtp/cards/${id}/transactions`, { params }).then((r) => r.data.data || []),
  issue: (payload) => api.post('/gtp/issue', payload).then((r) => r.data),
  freeze: (id) => api.patch(`/gtp/cards/${id}/freeze`).then((r) => r.data),
  unfreeze: (id) => api.patch(`/gtp/cards/${id}/unfreeze`).then((r) => r.data),
  cancel: (id) => api.delete(`/gtp/cards/${id}`).then((r) => r.data),
  setPin: (id, pin) => api.post(`/gtp/cards/${id}/pin`, { pin }).then((r) => r.data),
  topup: (id, payload) => api.post(`/gtp/cards/${id}/topup`, payload).then((r) => r.data),
  unload: (id, payload) => api.post(`/gtp/cards/${id}/unload`, payload).then((r) => r.data),
  payment: (id, payload) => api.post(`/gtp/cards/${id}/payment`, payload).then((r) => r.data),
};
