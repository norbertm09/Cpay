import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { clearToken, decodeJwt, getToken, logoutLocal, refreshAccessToken, subscribeToken } from '../services/api';
import * as authApi from '../services/auth';

// Profil de reference : GET /auth/me -> { cardholder:{cardholderId,firstName,
// lastName,email,phone,kycLevel,mfaEnabled}, card, mustChangePassword }.
const userFromClaims = (c) => (c ? { userId: c.sub, cardholderId: c.sub, cardId: c.cardId, email: c.email, card: null, _source: 'token' } : null);

const fetchProfile = async (t) => {
  try {
    const data = await authApi.me();
    const ch = data.cardholder || {};
    return { ...ch, userId: ch.cardholderId, card: data.card || null, mustChangePassword: !!data.mustChangePassword, _source: 'me' };
  } catch (err) {
    const st = err.response?.status;
    if (st === 401 || st === 404) { logoutLocal(); return null; }
    return userFromClaims(decodeJwt(t));
  }
};

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [token, setTok] = useState(getToken());
  const [user, setUser] = useState(null);
  const [refreshing, setRefreshing] = useState(true);

  useEffect(() => subscribeToken(setTok), []);

  // Jeton absent ou expire au demarrage : refresh silencieux par cookie.
  useEffect(() => {
    let cancelled = false;
    if (decodeJwt(getToken() || '')) { setRefreshing(false); return undefined; }
    refreshAccessToken()
      .catch(() => { if (!cancelled) clearToken(); })
      .finally(() => { if (!cancelled) setRefreshing(false); });
    return () => { cancelled = true; };
  }, []);

  const reloadUser = useCallback(async () => {
    const t = getToken();
    if (!t) { setUser(null); return null; }
    const p = await fetchProfile(t);
    setUser(p);
    return p;
  }, []);

  useEffect(() => {
    if (!token) { setUser(null); return undefined; }
    if (user && user._source === 'me') return undefined; // simple renouvellement du jeton
    let cancelled = false;
    fetchProfile(token).then((p) => { if (!cancelled) setUser(p); });
    return () => { cancelled = true; };
  }, [token]);

  const signOut = useCallback(async () => {
    try { await authApi.logout(); } catch (e) { /* le jeton local est efface quoi qu'il arrive */ }
    clearToken();
  }, []);

  // Mise a jour locale du solde apres une operation (sans rappeler /auth/me).
  const patchCard = useCallback((patch) => {
    setUser((u) => (u && u.card ? { ...u, card: { ...u.card, ...patch } } : u));
  }, []);

  const isAuth = !!token && !!decodeJwt(token);
  const loading = refreshing || (isAuth && !user);
  const value = useMemo(() => ({ isAuth, loading, user, reloadUser, signOut, patchCard }), [isAuth, loading, user, reloadUser, signOut, patchCard]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth doit être utilisé sous AuthProvider');
  return ctx;
};
