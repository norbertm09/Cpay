// Refonte Expo (2026-11-13) : client HTTP et magasin de session, independants de React Native.
// `createAuthClient({ apiBase, fetchImpl, storage, now })` : fetch et stockage sont injectes (expo-secure-store dans
// l'application, memoire dans les tests). Comportement (README « Flux d'authentification ») :
//   - session { mode: 'merchant', accessToken, refreshToken, expiresAt, user, mustChangePassword } dans le stockage
//     securise (jetons) + profil a part (limite de 2 Ko par entree de SecureStore) ;
//   - rafraichissement proactif quand il reste moins de REFRESH_MARGIN_MS, un seul refresh en vol, un seul rejeu sur 401 ;
//   - refresh refuse (INVALID_REFRESH, REFRESH_REUSED…) : session videe, AuthError ; reseau coupe : session conservee.
'use strict';
const { API, REFRESH_MARGIN_MS, DEFAULT_EXPIRES_IN, ApiError, AuthError } = require('./core');

const SECURE_SESSION_KEY = 'cpay.session';
const SECURE_USER_KEY = 'cpay.user';
// Lot 5 : application MARCHANDE uniquement (le mode administrateur a ete retire, audit 2026-11-02 mobile P1-6)
const MODE = 'merchant';

// Construit une session a partir d'une reponse { access_token, refresh_token, expires_in, user|admin, mustChangePassword }
const sessionFromResponse = (mode, data, previous = null, now = Date.now) => ({
  mode,
  accessToken: data.access_token,
  refreshToken: data.refresh_token,
  expiresAt: now() + (Number(data.expires_in) || DEFAULT_EXPIRES_IN) * 1000,
  user: data.user || previous?.user || null,
  mustChangePassword: data.mustChangePassword !== undefined ? !!data.mustChangePassword : !!previous?.mustChangePassword,
});

function createAuthClient({ apiBase = API, fetchImpl = globalThis.fetch, storage, now = Date.now } = {}) {
  const base = apiBase;
  const secureGet = async (key) => { try { return await storage.getItemAsync(key); } catch { return null; } };
  const secureSet = async (key, value) => { try { await storage.setItemAsync(key, value); } catch { /* stockage indisponible (web, simulateur) : session en memoire */ } };
  const secureDelete = async (key) => { try { await storage.deleteItemAsync(key); } catch { /* idem */ } };

  async function loadStoredSession() {
    const [raw, rawUser] = await Promise.all([secureGet(SECURE_SESSION_KEY), secureGet(SECURE_USER_KEY)]);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed?.accessToken || !parsed?.refreshToken || parsed?.mode !== MODE) return null; // une ancienne session admin est ignoree
      let user = null;
      try { user = rawUser ? JSON.parse(rawUser) : null; } catch { user = null; }
      return { ...parsed, user };
    } catch { return null; }
  }

  async function persistSession(session) {
    if (!session) { await Promise.all([secureDelete(SECURE_SESSION_KEY), secureDelete(SECURE_USER_KEY)]); return; }
    const { user, ...tokens } = session;
    await Promise.all([secureSet(SECURE_SESSION_KEY, JSON.stringify(tokens)), secureSet(SECURE_USER_KEY, JSON.stringify(user || null))]);
  }

  // Magasin partage entre les ecrans et le client HTTP : un refresh refuse vide la session, l'UI revient au login.
  const authStore = {
    session: null,
    listeners: new Set(),
    get() { return this.session; },
    async set(next) { this.session = next; this.listeners.forEach((fn) => fn(next)); await persistSession(next); },
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  };

  let refreshInFlight = null;
  async function doRefresh() {
    const current = authStore.get();
    if (!current?.refreshToken) throw new AuthError();
    let res; let data = {};
    try {
      res = await fetchImpl(`${base}/${current.mode}/auth/refresh`, {
        method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      });
      data = await res.json().catch(() => ({}));
    } catch { throw new ApiError('Réseau indisponible', { status: 0, code: 'NETWORK' }); }
    if (!res.ok || !data.access_token || !data.refresh_token) {
      await authStore.set(null);
      throw new AuthError(data.code === 'REFRESH_REUSED' ? 'Session révoquée par sécurité, veuillez vous reconnecter' : undefined);
    }
    const next = sessionFromResponse(current.mode, data, current, now);
    await authStore.set(next);
    return next;
  }
  function refreshSession() {
    if (!refreshInFlight) refreshInFlight = doRefresh().finally(() => { refreshInFlight = null; });
    return refreshInFlight;
  }

  // auth: true  -> Bearer + refresh proactif (< REFRESH_MARGIN_MS) + refresh unique sur 401 puis rejeu.
  // auth: false -> appel anonyme (login, 2FA, refresh, logout).
  async function apiFetch(path, { auth = true, method = 'GET', body, idempotencyKey, _retried = false } = {}) {
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    if (auth) {
      let session = authStore.get();
      if (!session?.accessToken) throw new AuthError();
      if (!session.expiresAt || session.expiresAt - now() < REFRESH_MARGIN_MS) session = await refreshSession();
      headers.Authorization = `Bearer ${session.accessToken}`;
    }
    let res;
    try { res = await fetchImpl(`${base}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined }); }
    catch { throw new ApiError('Réseau indisponible', { status: 0, code: 'NETWORK' }); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && auth && !_retried) {
      await refreshSession(); // jette AuthError (session videe) si le refresh echoue
      return apiFetch(path, { auth, method, body, idempotencyKey, _retried: true });
    }
    if (res.status === 401 && auth) { await authStore.set(null); throw new AuthError(); }
    if (!res.ok) throw new ApiError(data.error || data.message || `HTTP ${res.status}`, { status: res.status, code: data.code || null, data });
    return data;
  }

  async function logout() {
    const current = authStore.get();
    if (current?.refreshToken) {
      try {
        await fetchImpl(`${base}/${current.mode}/auth/logout`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${current.accessToken}` },
          body: JSON.stringify({ refreshToken: current.refreshToken }),
        });
      } catch { /* le refresh expire de lui-meme cote serveur */ }
    }
    await authStore.set(null);
  }

  return { MODE, authStore, loadStoredSession, persistSession, sessionFromResponse: (data, previous) => sessionFromResponse(MODE, data, previous, now), refreshSession, apiFetch, logout };
}

module.exports = { createAuthClient, sessionFromResponse, MODE, SECURE_SESSION_KEY, SECURE_USER_KEY };
