import { api } from './api';

export const updateProfile = (fields) => api.patch('/profile', fields).then((r) => r.data);
export const kyc = {
  get: () => api.get('/kyc').then((r) => r.data),
  submit: (payload) => api.post('/kyc/documents', payload).then((r) => r.data),
};
