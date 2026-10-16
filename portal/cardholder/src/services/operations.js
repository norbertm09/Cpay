import { api, rootScope } from './api';

export const dashboard = () => api.get('/dashboard').then((r) => r.data);
export const listTransactions = (params) => api.get('/transactions', { params }).then((r) => r.data);
export const pay = ({ merchantId, amount, description, pin }) => api.post('/payment', { merchantId, amount, description, pin }).then((r) => r.data);
export const topup = (payload) => api.post('/topup', payload).then((r) => r.data);
export const unload = (payload) => api.post('/unload', payload).then((r) => r.data);
// Lien de paiement public (pay.c-pay.global/SHORTID) : statut + montant, sans authentification.
export const payLinkStatus = (shortId) => api.get(`/pay/${encodeURIComponent(shortId)}/status`, rootScope).then((r) => r.data);
