import { api, rootScope } from './api';

export const login = (emailOrPhone, password) => api.post('/auth/login', { emailOrPhone, password }).then((r) => r.data);
export const validate2fa = (mfaToken, code) => api.post('/auth/2fa/validate', { mfaToken, code }).then((r) => r.data);
export const register = (payload) => api.post('/auth/register', payload).then((r) => r.data);
export const me = () => api.get('/auth/me').then((r) => r.data);
export const logout = () => api.post('/auth/logout').then((r) => r.data);
export const forgotPassword = (email) => api.post('/auth/forgot-password', { email }).then((r) => r.data);
export const resetPassword = (token, newPassword) => api.post('/auth/reset-password', { token, newPassword }).then((r) => r.data);
export const verifyEmail = (token) => api.get('/auth/verify-email', { params: { token } }).then((r) => r.data);
export const resendVerification = () => api.post('/auth/resend-verification').then((r) => r.data);
export const changePassword = (currentPassword, newPassword) => api.post('/profile/change-password', { currentPassword, newPassword }).then((r) => r.data);

export const twoFa = {
  status: () => api.get('/auth/2fa/status').then((r) => r.data),
  setup: () => api.post('/auth/2fa/setup').then((r) => r.data),
  verify: (token) => api.post('/auth/2fa/verify', { token }).then((r) => r.data),
  disable: (token) => api.post('/auth/2fa/disable', { token }).then((r) => r.data),
};

export const securityEvents = () => api.get('/security/events').then((r) => r.data.events || []);

export const consent = {
  check: () => api.get('/consent/check', rootScope).then((r) => r.data),
  accept: () => api.post('/consent/accept', { portal: 'cardholder', cguAccepted: true, privacyAccepted: true }, rootScope).then((r) => r.data),
};
