// Contexte d'authentification.
//
// Trois états : loading (refresh silencieux en cours), authenticated, anonymous.
// Sans l'état loading, Guard renverrait sur /login à chaque rechargement de
// page avant même que le refresh ait pu répondre.
import React, { useState, useEffect, useCallback, useContext, createContext } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { authApi, setAccessToken, getAccessToken, authListeners, refreshAccessToken, decodeJwt, userFromClaims } from '../services/api';

const AuthContext = createContext(null);

// Charge le profil depuis GET /auth/me.
//   - 401 (après tentative de refresh par l'intercepteur) ou 404 : la session
//     n'est plus valable -> déconnexion.
//   - pas de réponse (réseau coupé) ou erreur serveur : repli sur les claims
//     du jeton pour ne pas bloquer le portail.
const fetchProfile = async (t) => {
  try {
    const { data } = await authApi.me();
    return { ...data.user, mustChangePassword: !!data.mustChangePassword, _source: 'me' };
  } catch (err) {
    const st = err.response?.status;
    if (st === 401 || st === 404) {
      setAccessToken(null);
      if (window.location.pathname !== '/login') window.location.href = '/login';
      return null;
    }
    return userFromClaims(decodeJwt(t));
  }
};

export const AuthProvider = ({ children }) => {
  const [token, setToken] = useState(getAccessToken());
  const [user, setUser] = useState(null);
  const [refreshing, setRefreshing] = useState(true);

  useEffect(() => {
    const listener = (t) => setToken(t);
    authListeners.add(listener);
    return () => { authListeners.delete(listener); };
  }, []);

  // Refresh silencieux au démarrage : le cookie HttpOnly survit au
  // rechargement, l'access token en mémoire non.
  useEffect(() => {
    let cancelled = false;
    if (getAccessToken()) { setRefreshing(false); return undefined; }
    refreshAccessToken()
      .catch(() => { if (!cancelled) setAccessToken(null); })
      .finally(() => { if (!cancelled) setRefreshing(false); });
    return () => { cancelled = true; };
  }, []);

  const reloadUser = useCallback(async () => {
    const t = getAccessToken();
    if (!t) { setUser(null); return null; }
    const p = await fetchProfile(t);
    setUser(p);
    return p;
  }, []);

  // Profil : chargé dès qu'un jeton est disponible (démarrage ou login). Un
  // simple renouvellement du jeton (toutes les 15 min) ne le recharge pas.
  useEffect(() => {
    if (!token) { setUser(null); return undefined; }
    let cancelled = false;
    fetchProfile(token).then(p => { if (!cancelled) setUser(p); });
    return () => { cancelled = true; };
  }, [token]);

  // Déconnexion réelle : révocation du refresh côté serveur + cookie effacé,
  // puis purge mémoire et rechargement complet.
  const logout = useCallback(() => {
    authApi.logout().catch(() => {}).finally(() => {
      setAccessToken(null);
      window.location.href = '/login';
    });
  }, []);

  const isAuth = !!token && !!decodeJwt(token);
  const loading = refreshing || (isAuth && !user);

  return (
    <AuthContext.Provider value={{ isAuth, user, loading, setAccessToken, reloadUser, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    // Repli défensif hors Provider : on lit l'état module plutôt que de planter.
    const tk = getAccessToken(); const claims = tk ? decodeJwt(tk) : null;
    return { isAuth: !!claims, user: userFromClaims(claims), loading: false, setAccessToken, reloadUser: async () => null, logout: () => { setAccessToken(null); window.location.href = '/login'; } };
  }
  return ctx;
};

export const AuthSplash = () => (
  <div className="auth-splash" style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
    <span className="spinner" aria-label="Chargement" />
  </div>
);

export const Guard = ({ children }) => {
  const { isAuth, loading } = useAuth();
  const location = useLocation();
  if (loading) return <AuthSplash />;
  return isAuth ? children : <Navigate to="/login" replace state={{ from: location.pathname }} />;
};
