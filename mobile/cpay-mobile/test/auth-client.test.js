'use strict';
// Client de session : rafraichissement proactif, vol unique, rejeu unique sur 401, session videe sur refresh refuse,
// session conservee sur coupure reseau, stockage securise (jetons et profil separes), Idempotency-Key transmise.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAuthClient, SECURE_SESSION_KEY, SECURE_USER_KEY } = require('../src/auth-client');
const { ApiError, AuthError } = require('../src/core');

const memoryStorage = () => {
  const map = new Map();
  return {
    map,
    async getItemAsync(k) { return map.has(k) ? map.get(k) : null; },
    async setItemAsync(k, v) { map.set(k, v); },
    async deleteItemAsync(k) { map.delete(k); },
  };
};
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const makeFetch = (handler) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => { calls.push({ url, init }); return handler(url, init, calls.length); };
  fetchImpl.calls = calls;
  return fetchImpl;
};
const loginResponse = (n = 1) => ({ access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 900, user: { id: 'u1', name: 'Boutique' } });

test('session persistee : jetons et profil dans deux entrees, relue au demarrage, ancienne session admin ignoree', async () => {
  const storage = memoryStorage(); let t = 1_000_000;
  const c = createAuthClient({ apiBase: 'https://api.test/api/v1', fetchImpl: makeFetch(() => json(200, {})), storage, now: () => t });
  await c.authStore.set(c.sessionFromResponse(loginResponse()));
  assert.ok(storage.map.has(SECURE_SESSION_KEY) && storage.map.has(SECURE_USER_KEY));
  assert.equal(JSON.parse(storage.map.get(SECURE_SESSION_KEY)).user, undefined, 'le profil ne doit pas etre dans l’entree des jetons');
  const again = createAuthClient({ apiBase: 'https://api.test/api/v1', fetchImpl: makeFetch(() => json(200, {})), storage, now: () => t });
  const stored = await again.loadStoredSession();
  assert.equal(stored.accessToken, 'access-1'); assert.equal(stored.user.name, 'Boutique'); assert.equal(stored.expiresAt, t + 900_000);
  storage.map.set(SECURE_SESSION_KEY, JSON.stringify({ mode: 'admin', accessToken: 'a', refreshToken: 'r' }));
  assert.equal(await again.loadStoredSession(), null);
  await c.authStore.set(null);
  assert.equal(storage.map.size, 0);
});

test('Bearer + Idempotency-Key ; refresh proactif a moins de 60 s ; un seul refresh pour des appels concurrents', async () => {
  let t = 1_000_000; let refreshes = 0;
  const fetchImpl = makeFetch((url) => {
    if (url.endsWith('/merchant/auth/refresh')) { refreshes += 1; return json(200, loginResponse(2)); }
    return json(200, { ok: true });
  });
  const c = createAuthClient({ apiBase: 'https://api.test/api/v1', fetchImpl, storage: memoryStorage(), now: () => t });
  await c.authStore.set(c.sessionFromResponse(loginResponse(1)));
  await c.apiFetch('/merchant/cash/withdraw', { method: 'POST', body: { amount: 1000 }, idempotencyKey: 'intent-0001' });
  const first = fetchImpl.calls[0];
  assert.equal(first.init.headers.Authorization, 'Bearer access-1');
  assert.equal(first.init.headers['Idempotency-Key'], 'intent-0001');
  assert.equal(first.init.body, JSON.stringify({ amount: 1000 }));
  t += 850_000;   // il reste 50 s : rafraichissement proactif
  await Promise.all([c.apiFetch('/merchant/cash/summary'), c.apiFetch('/merchant/cash/wallet'), c.apiFetch('/merchant/pay-links')]);
  assert.equal(refreshes, 1, 'un seul refresh en vol');
  assert.equal(c.authStore.get().accessToken, 'access-2');
  assert.ok(fetchImpl.calls.slice(-3).every((x) => x.init.headers.Authorization === 'Bearer access-2'));
});

test('401 : un seul rejeu apres refresh ; refresh refuse (REFRESH_REUSED) : session videe, AuthError', async () => {
  let t = 1_000_000; let n = 0;
  const fetchImpl = makeFetch((url) => {
    if (url.endsWith('/auth/refresh')) return json(200, loginResponse(2));
    n += 1; return n === 1 ? json(401, { error: 'expired' }) : json(200, { data: [] });
  });
  const c = createAuthClient({ apiBase: 'https://api.test/api/v1', fetchImpl, storage: memoryStorage(), now: () => t });
  await c.authStore.set(c.sessionFromResponse(loginResponse(1)));
  const out = await c.apiFetch('/merchant/cash/history');
  assert.deepEqual(out, { data: [] });
  assert.equal(fetchImpl.calls.filter((x) => x.url.endsWith('/merchant/cash/history')).length, 2, 'un seul rejeu');

  const refused = makeFetch((url) => (url.endsWith('/auth/refresh') ? json(401, { code: 'REFRESH_REUSED' }) : json(401, {})));
  const c2 = createAuthClient({ apiBase: 'https://api.test/api/v1', fetchImpl: refused, storage: memoryStorage(), now: () => t });
  await c2.authStore.set(c2.sessionFromResponse(loginResponse(1)));
  await assert.rejects(c2.apiFetch('/merchant/cash/summary'), (e) => e instanceof AuthError && /révoquée/.test(e.message));
  assert.equal(c2.authStore.get(), null, 'session videe');
});

test('reseau coupe pendant le refresh : erreur NETWORK, session conservee ; sans session : AuthError', async () => {
  let t = 1_000_000;
  const fetchImpl = makeFetch(() => { throw new TypeError('Network request failed'); });
  const c = createAuthClient({ apiBase: 'https://api.test/api/v1', fetchImpl, storage: memoryStorage(), now: () => t });
  await c.authStore.set(c.sessionFromResponse(loginResponse(1)));
  t += 880_000;
  await assert.rejects(c.apiFetch('/merchant/cash/summary'), (e) => e instanceof ApiError && e.code === 'NETWORK');
  assert.ok(c.authStore.get(), 'la session reste en place');
  const anon = createAuthClient({ apiBase: 'https://api.test/api/v1', fetchImpl, storage: memoryStorage(), now: () => t });
  await assert.rejects(anon.apiFetch('/merchant/cash/summary'), (e) => e instanceof AuthError);
});

test('erreurs API : message et code du serveur ; appel anonyme sans Bearer ; logout revoque puis efface', async () => {
  let t = 1_000_000;
  const fetchImpl = makeFetch((url, init) => {
    if (url.endsWith('/auth/login')) { assert.equal(init.headers.Authorization, undefined); return json(422, { error: 'Mot de passe trop court (10 caractères minimum)', code: 'WEAK_PASSWORD' }); }
    if (url.endsWith('/auth/logout')) return json(204, {});
    return json(200, {});
  });
  const c = createAuthClient({ apiBase: 'https://api.test/api/v1', fetchImpl, storage: memoryStorage(), now: () => t });
  await assert.rejects(c.apiFetch('/merchant/auth/login', { auth: false, method: 'POST', body: {} }), (e) => e instanceof ApiError && e.status === 422 && e.code === 'WEAK_PASSWORD');
  await c.authStore.set(c.sessionFromResponse(loginResponse(1)));
  await c.logout();
  const call = fetchImpl.calls.find((x) => x.url.endsWith('/auth/logout'));
  assert.equal(JSON.parse(call.init.body).refreshToken, 'refresh-1');
  assert.equal(c.authStore.get(), null);
});
