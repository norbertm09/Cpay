import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { broadcastSession, clearToken, decodeJwt, getToken, logoutLocal, logoutServer, refreshAccessToken, subscribeSession, subscribeToken, tokenTtl } from '../services/api';
import * as authApi from '../services/auth';

// Modele de session (vague 7) : jeton d'acces en memoire seulement, refresh
// HttpOnly en cookie. Trois etats : loading (refresh silencieux au demarrage),
// authentifie, anonyme. Sans l'etat loading, RequireAuth renverrait sur
// /connexion a chaque rechargement avant que le refresh ait pu repondre.

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

// Seuil (secondes) en deca duquel un onglet qui redevient visible renouvelle
// son jeton plutot que d'attendre un 401 sur la prochaine requete.
const NEAR_EXPIRY_S = 90;

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [token, setTok] = useState(getToken());
  const [user, setUser] = useState(null);
  const [refreshing, setRefreshing] = useState(true);

  useEffect(() => subscribeToken(setTok), []);

  // Demarrage : le jeton n'est jamais persiste, on le redemande au cookie.
  // Echec (pas de cookie, refresh revoque) = simplement anonyme.
  useEffect(() => {
    let cancelled = false;
    if (getToken()) { setRefreshing(false); return undefined; }
    refreshAccessToken()
      .catch(() => { if (!cancelled) clearToken(); })
      .finally(() => { if (!cancelled) setRefreshing(false); });
    return () => { cancelled = true; };
  }, []);

  // Multi-onglets : deconnexion ailleurs -> on vide la memoire ici (le cookie
  // est deja revoque) ; connexion ailleurs -> on prend un jeton via le cookie.
  useEffect(() => subscribeSession((msg) => {
    if (msg.type === 'logout') { if (getToken()) logoutLocal({ broadcast: false }); return; }
    if (msg.type === 'login' && !getToken()) refreshAccessToken().catch(() => clearToken());
  }), []);

  // Onglet remis au premier plan avec un jeton absent ou proche de l'expiration :
  // renouvellement anticipe (un echec = session revoquee entre-temps).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (!getToken() || tokenTtl() > NEAR_EXPIRY_S) return;
      refreshAccessToken().catch(() => logoutLocal());
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
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

  // Deconnexion reelle : revocation du refresh + cookie efface cote serveur,
  // puis purge memoire et propagation aux autres onglets. La navigation vers
  // /connexion reste a la charge de l'appelant (toast, etat local...).
  const signOut = useCallback(async () => {
    try { await logoutServer(); } catch (e) { /* le jeton local est efface quoi qu'il arrive */ }
    clearToken();
    broadcastSession('logout');
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
