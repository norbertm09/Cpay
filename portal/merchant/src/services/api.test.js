// Audit 2026-11-10 § 3 : une requête mise en attente pendant le rafraîchissement n'est rejouée que si la nouvelle
// session appartient au même compte (utilisateur + marchand).
import axios from 'axios';
import { api, setAccessToken, getAccessToken, sameIdentity, identityOf, SESSION_CHANGED } from './api';

const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (claims) => `${b64({ alg: 'none' })}.${b64({ exp: Math.floor(Date.now() / 1000) + 600, ...claims })}.sig`;
const A = jwt({ sub: 'user-a', merchantId: 'merchant-a' });
const A2 = jwt({ sub: 'user-a', merchantId: 'merchant-a', iat: 99 });
const B = jwt({ sub: 'user-b', merchantId: 'merchant-b' });

let adapterCalls;
const adapter = (sequence) => async (config) => {
  adapterCalls.push({ url: config.url, auth: config.headers?.Authorization });
  const step = sequence.shift();
  if (step === 401) throw new axios.AxiosError('Unauthorized', '401', config, null, { status: 401, statusText: 'Unauthorized', data: { code: 'TOKEN_EXPIRED' }, headers: {}, config });
  return { status: 200, statusText: 'OK', data: { ok: true, auth: config.headers?.Authorization }, headers: {}, config };
};
beforeEach(() => { adapterCalls = []; setAccessToken(A); vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); setAccessToken(null); });

test('identityOf / sameIdentity lisent utilisateur + marchand', () => {
  expect(identityOf(A)).toBe('user-a|merchant-a');
  expect(sameIdentity(A, A2)).toBe(true);
  expect(sameIdentity(A, B)).toBe(false);
  expect(sameIdentity('', B)).toBe(true);   // pas de jeton précédent : rien à comparer (démarrage)
});

test('même compte après rafraîchissement : la requête est rejouée avec le nouveau jeton', async () => {
  vi.spyOn(axios, 'post').mockResolvedValue({ data: { access_token: A2 } });
  api.defaults.adapter = adapter([401, 200]);
  const r = await api.get('/cash/summary');
  expect(r.data.auth).toBe(`Bearer ${A2}`);
  expect(adapterCalls).toHaveLength(2);
  expect(getAccessToken()).toBe(A2);
});

test('compte différent après rafraîchissement : aucun rejeu, session locale fermée', async () => {
  vi.spyOn(axios, 'post').mockResolvedValue({ data: { access_token: B } });
  api.defaults.adapter = adapter([401, 200]);
  await expect(api.post('/cash/withdraw', { amount: 1000 })).rejects.toMatchObject({ code: SESSION_CHANGED });
  expect(adapterCalls).toHaveLength(1);           // la requête n'a PAS été rejouée sous l'identité B
  expect(getAccessToken()).toBeNull();
});
