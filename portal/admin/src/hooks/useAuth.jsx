import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { authApi, getToken, setToken, clearToken, onTokenChange, decodeJwt, refreshAccessToken, logoutLocal } from '../services/api';
import { hasRole, can as canRole } from '../utils/roles';

// Le profil vient de GET /auth/me → { admin:{adminId,email,firstName,lastName,role,mfaEnabled}, mustChangePassword }.
// Le décodage local du JWT ne sert que de repli réseau et à vérifier l'expiration.
const adminFromClaims = (c) => (c ? { adminId: c.sub, email: c.email, role: c.role, source: 'token' } : null);

const fetchProfile = async (token) => {
  try {
    const { data } = await authApi.me();
    return { ...data.admin, mustChangePassword: !!data.mustChangePassword, source: 'me' };
  } catch (err) {
    const st = err.response?.status;
    if (st === 401 || st === 404) { logoutLocal(); return null; }
    return adminFromClaims(decodeJwt(token));
  }
};

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [token, setTok] = useState(getToken());
  const [admin, setAdmin] = useState(null);
  const [refreshing, setRefreshing] = useState(true);

  useEffect(() => onTokenChange((t) => setTok(t)), []);

  // Jeton absent/expiré au démarrage : refresh silencieux via le cookie cp_rt_admin.
  useEffect(() => {
    let cancelled = false;
    if (decodeJwt(getToken() || '')) { setRefreshing(false); return undefined; }
    refreshAccessToken()
      .catch(() => { if (!cancelled) clearToken(); })
      .finally(() => { if (!cancelled) setRefreshing(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!token) { setAdmin(null); return undefined; }
    if (admin && admin.source === 'me') return undefined; // simple renouvellement du jeton
    let cancelled = false;
    fetchProfile(token).then((p) => { if (!cancelled) setAdmin(p); });
    return () => { cancelled = true; };
  }, [token]);

  const reloadUser = useCallback(async () => {
    const t = getToken();
    if (!t) { setAdmin(null); return null; }
    const p = await fetchProfile(t);
    setAdmin(p);
    return p;
  }, []);

  const login = useCallback((data) => { if (data?.access_token) setToken(data.access_token); }, []);
  const logout = useCallback(async () => {
    try { await authApi.logout(); } catch (e) { /* session déjà révoquée */ }
    clearToken();
    window.location.href = '/login';
  }, []);

  const isAuth = !!token && !!decodeJwt(token);
  const value = {
    isAuth, admin, loading: refreshing || (isAuth && !admin),
    reloadUser, login, logout,
    isSuperAdmin: admin?.role === 'super_admin',
    hasRole: (roles) => hasRole(admin, roles),
    can: (perm) => canRole(admin, perm),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = () => useContext(AuthContext);
