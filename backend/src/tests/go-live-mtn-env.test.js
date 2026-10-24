'use strict';
/**
 * Go-live CG — environnement MTN unifie (config/mtn-env.js).
 * Un seul interrupteur MTN_ENV pilote l'encaissement (provider) et le retrait (client rails).
 */
const { resolveMtnEnv, SANDBOX_BASE_URL, PRODUCTION_BASE_URL } = require('../config/mtn-env');

describe('config/mtn-env — resolution unique sandbox/production', () => {
  test('par defaut : sandbox, hote sandbox, X-Target-Environment=sandbox', () => {
    const r = resolveMtnEnv({ country: 'CG', env: {} });
    expect(r).toMatchObject({ mode: 'sandbox', isSandbox: true, targetEnvironment: 'sandbox', baseUrl: SANDBOX_BASE_URL });
    expect(r.host).toBe('sandbox.momodeveloper.mtn.com');
    expect(r.warnings).toEqual([]);
  });

  test('MTN_ENV=production derive mtncongo et l\'hote de production pour CG', () => {
    const r = resolveMtnEnv({ country: 'CG', env: { MTN_ENV: 'production' } });
    expect(r).toMatchObject({ mode: 'production', isSandbox: false, targetEnvironment: 'mtncongo', baseUrl: PRODUCTION_BASE_URL });
    expect(r.host).toBe('momoapi.momo.africa');
    expect(r.warnings).toEqual([]);
  });

  test('ancien hote proxy.momoapi.mtn.com en production : accepte mais signale comme obsolete', () => {
    const r = resolveMtnEnv({ country: 'CG', env: { MTN_ENV: 'production', MTN_CG_BASE_URL: 'https://proxy.momoapi.mtn.com' } });
    expect(r.host).toBe('proxy.momoapi.mtn.com');
    expect(r.warnings.some((w) => /obsolete/.test(w))).toBe(true);
  });

  test('cibles de production par pays (CM, CI) ; pays inconnu -> avertissement', () => {
    expect(resolveMtnEnv({ country: 'CM', env: { MTN_ENV: 'production' } }).targetEnvironment).toBe('mtncameroon');
    expect(resolveMtnEnv({ country: 'CI', env: { MTN_ENV: 'production' } }).targetEnvironment).toBe('mtnivorycoast');
    const r = resolveMtnEnv({ country: 'XX', env: { MTN_ENV: 'production' } });
    expect(r.targetEnvironment).toBe('production');
    expect(r.warnings.join(' ')).toMatch(/MTN_XX_TARGET_ENV/);
  });

  test('MTN_CG_ENV (historique) prime sur MTN_ENV ; MTN_CG_TARGET_ENV et MTN_CG_BASE_URL explicites sont respectes', () => {
    const r = resolveMtnEnv({ country: 'CG', env: { MTN_ENV: 'sandbox', MTN_CG_ENV: 'production', MTN_CG_TARGET_ENV: 'mtncongo', MTN_CG_BASE_URL: 'https://momoapi.momo.africa/' } });
    expect(r.mode).toBe('production');
    expect(r.targetEnvironment).toBe('mtncongo');
    expect(r.baseUrl).toBe('https://momoapi.momo.africa');
    expect(r.warnings).toEqual([]);
  });

  test('incoherences signalees : production avec cible ou URL sandbox, sandbox avec URL de production', () => {
    const a = resolveMtnEnv({ country: 'CG', env: { MTN_ENV: 'production', MTN_CG_TARGET_ENV: 'sandbox' } });
    expect(a.warnings.some((w) => /incoherent/.test(w))).toBe(true);
    const b = resolveMtnEnv({ country: 'CG', env: { MTN_ENV: 'production', MTN_CG_BASE_URL: 'https://sandbox.momodeveloper.mtn.com' } });
    expect(b.warnings.some((w) => /URL de base sandbox/.test(w))).toBe(true);
    const c = resolveMtnEnv({ country: 'CG', env: { MTN_ENV: 'sandbox', MTN_MOMO_BASE_URL: 'https://proxy.momoapi.mtn.com' } });
    expect(c.warnings.some((w) => /URL de base de production/.test(w))).toBe(true);
  });

  test('la configuration gateway (extra_params.targetEnvironment, base_url) prime sur l\'environnement', () => {
    const r = resolveMtnEnv({ country: 'CM', targetEnvironment: 'mtncameroon', baseUrl: 'https://proxy.momoapi.mtn.com', env: { MTN_ENV: 'production' } });
    expect(r.targetEnvironment).toBe('mtncameroon');
    expect(r.baseUrl).toBe('https://proxy.momoapi.mtn.com');
  });

  test('valeur MTN_ENV inconnue -> sandbox avec avertissement (jamais production par accident)', () => {
    const r = resolveMtnEnv({ country: 'CG', env: { MTN_ENV: 'prodd' } });
    expect(r.mode).toBe('sandbox');
    expect(r.warnings[0]).toMatch(/inconnu/);
  });
});

describe('rails/mtn-momo.client et providers/mtn.provider utilisent la meme resolution', () => {
  const https = require('https');
  const mockHttps = (captured) => jest.spyOn(https, 'request').mockImplementation((opts, cb) => {
    captured.push(opts);
    const isToken = /\/token\/?$/.test(String(opts.path));
    const res = { statusCode: isToken ? 200 : 202, on: (ev, h) => { if (ev === 'data') h(isToken ? '{"access_token":"t","expires_in":3600}' : '{}'); if (ev === 'end') h(); return res; } };
    return { write: jest.fn(), end: jest.fn(() => cb(res)), on: jest.fn().mockReturnThis(), destroy: jest.fn(), setTimeout: jest.fn() };
  });
  const ENV_KEYS = ['MTN_ENV', 'MTN_CG_ENV', 'MTN_CG_TARGET_ENV', 'MTN_CG_BASE_URL', 'MTN_MOMO_BASE_URL', 'MTN_CM_TARGET_ENV'];
  beforeEach(() => { jest.resetModules(); jest.restoreAllMocks(); ENV_KEYS.forEach((k) => delete process.env[k]); });
  afterAll(() => { ENV_KEYS.forEach((k) => delete process.env[k]); });

  test('MTN_ENV=production : le client rails envoie X-Target-Environment=mtncongo vers proxy.momoapi.mtn.com', async () => {
    process.env.MTN_ENV = 'production';
    const captured = []; mockHttps(captured);
    const mtn = jest.requireActual('../services/rails/mtn-momo.client');
    expect(mtn.CONFIG.sandbox).toBe(false);
    expect(mtn.CONFIG.targetEnvironment).toBe('mtncongo');
    await mtn.requestToPay({ amount: 100, phone: '061234567', description: 'test', externalId: 'x' });
    const rtp = captured.find((o) => String(o.path).includes('requesttopay'));
    expect(rtp.hostname).toBe('momoapi.momo.africa');
    expect(rtp.headers['X-Target-Environment']).toBe('mtncongo');
  });

  test('sans MTN_ENV : le client rails reste en sandbox', async () => {
    const captured = []; mockHttps(captured);
    const mtn = jest.requireActual('../services/rails/mtn-momo.client');
    expect(mtn.CONFIG.sandbox).toBe(true);
    await mtn.requestToPay({ amount: 100, phone: '061234567', description: 'test', externalId: 'x' });
    const rtp = captured.find((o) => String(o.path).includes('requesttopay'));
    expect(rtp.hostname).toBe('sandbox.momodeveloper.mtn.com');
    expect(rtp.headers['X-Target-Environment']).toBe('sandbox');
  });

  test('provider mtn_cg : X-Target-Environment derive de MTN_ENV=production, mtn_cm de sa propre cible', async () => {
    process.env.MTN_ENV = 'production';
    const captured = []; mockHttps(captured);
    const provider = jest.requireActual('../services/mobilemoney/providers/mtn.provider');
    const base = { apiKey: 'k', apiSecret: 's', subscriptionKey: 'sub', baseUrl: 'https://proxy.momoapi.mtn.com' };
    await provider.getRequestStatus({ ...base, providerKey: 'mtn_cg' }, 'a1').catch(() => {});
    await provider.getRequestStatus({ ...base, providerKey: 'mtn_cm' }, 'a2').catch(() => {});
    const targets = captured.filter((o) => o.headers && o.headers['X-Target-Environment']).map((o) => o.headers['X-Target-Environment']);
    expect(targets).toContain('mtncongo');
    expect(targets).toContain('mtncameroon');
    expect(targets).not.toContain('sandbox');
  });
});

describe('MTN octobre 2026 : X-Target-Environment exige aussi sur la demande de jeton', () => {
  const https = require('https');
  const ENV_KEYS = ['MTN_ENV', 'MTN_CG_ENV', 'MTN_CG_TARGET_ENV', 'MTN_CG_BASE_URL', 'MTN_MOMO_BASE_URL', 'MTN_CG_CALLBACK_URL'];
  beforeEach(() => { jest.resetModules(); jest.restoreAllMocks(); ENV_KEYS.forEach((k) => delete process.env[k]); });
  afterAll(() => { ENV_KEYS.forEach((k) => delete process.env[k]); });
  const mockHttps = (captured) => jest.spyOn(https, 'request').mockImplementation((opts, cb) => {
    captured.push(opts);
    const isToken = /\/token\/?$/.test(String(opts.path));
    const res = { statusCode: isToken ? 200 : 202, on: (ev, h) => { if (ev === 'data') h(isToken ? '{"access_token":"t","expires_in":3600}' : '{}'); if (ev === 'end') h(); return res; } };
    return { write: jest.fn(), end: jest.fn(() => cb(res)), on: jest.fn().mockReturnThis(), destroy: jest.fn(), setTimeout: jest.fn() };
  });

  test('client rails : le POST /collection/token/ et /disbursement/token/ portent X-Target-Environment (sandbox puis mtncongo)', async () => {
    const captured = []; mockHttps(captured);
    let mtn = jest.requireActual('../services/rails/mtn-momo.client');
    await mtn.getToken('collections'); await mtn.getToken('disbursements');
    const tokens = captured.filter((o) => /\/token\/$/.test(o.path));
    expect(tokens).toHaveLength(2);
    tokens.forEach((o) => expect(o.headers['X-Target-Environment']).toBe('sandbox'));
    jest.resetModules(); process.env.MTN_ENV = 'production';
    const captured2 = []; mockHttps(captured2);
    mtn = jest.requireActual('../services/rails/mtn-momo.client');
    await mtn.getToken('collections');
    expect(captured2[0].headers['X-Target-Environment']).toBe('mtncongo');
  });

  test('client rails : requesttopay porte X-Callback-Url quand une URL de callback est configuree', async () => {
    process.env.MTN_CG_CALLBACK_URL = 'https://api.c-pay.global/api/v1/momo/webhooks/mtn';
    const captured = []; mockHttps(captured);
    const mtn = jest.requireActual('../services/rails/mtn-momo.client');
    await mtn.requestToPay({ amount: 100, phone: '061234567', description: 'test', externalId: 'x' });
    const rtp = captured.find((o) => String(o.path).includes('requesttopay'));
    expect(rtp.headers['X-Callback-Url']).toBe('https://api.c-pay.global/api/v1/momo/webhooks/mtn');
  });

  test('provider mtn_cg : le POST /collection/token/ porte X-Target-Environment derive du gateway', async () => {
    process.env.MTN_ENV = 'production';
    const captured = []; mockHttps(captured);
    const provider = jest.requireActual('../services/mobilemoney/providers/mtn.provider');
    await provider.getRequestStatus({ apiKey: 'k', apiSecret: 's', subscriptionKey: 'sub', baseUrl: 'https://proxy.momoapi.mtn.com', providerKey: 'mtn_cg' }, 'ref1').catch(() => {});
    const token = captured.find((o) => /\/token\/$/.test(o.path));
    expect(token).toBeDefined();
    expect(token.headers['X-Target-Environment']).toBe('mtncongo');
  });
});

describe('provider MTN : jeton et cle d\'abonnement par produit (collection vs disbursement)', () => {
  const https = require('https');
  beforeEach(() => { jest.resetModules(); jest.restoreAllMocks(); delete process.env.MTN_ENV; });
  const mockHttps = (captured) => jest.spyOn(https, 'request').mockImplementation((opts, cb) => {
    captured.push(opts);
    const isToken = /\/token\/?$/.test(String(opts.path));
    const res = { statusCode: isToken ? 200 : 200, on: (ev, h) => { if (ev === 'data') h(isToken ? '{"access_token":"t","expires_in":3600}' : '{"status":"SUCCESSFUL"}'); if (ev === 'end') h(); return res; } };
    return { write: jest.fn(), end: jest.fn(() => cb(res)), on: jest.fn().mockReturnThis(), destroy: jest.fn(), setTimeout: jest.fn() };
  });
  const cfg = { apiKey: 'coll-user', apiSecret: 'coll-key', subscriptionKey: 'coll-sub', baseUrl: 'https://sandbox.momodeveloper.mtn.com', providerKey: 'mtn_cm',
    disbursement: { apiKey: 'disb-user', apiSecret: 'disb-key', subscriptionKey: 'disb-sub' } };

  test('statut de retrait : POST /disbursement/token/ avec les identifiants disbursement, puis cle disbursement', async () => {
    const captured = []; mockHttps(captured);
    const provider = jest.requireActual('../services/mobilemoney/providers/mtn.provider');
    await provider.getTransferStatus(cfg, 'ref-d');
    const token = captured.find((o) => /\/token\/$/.test(o.path));
    expect(token.path).toBe('/disbursement/token/');
    expect(token.headers['Ocp-Apim-Subscription-Key']).toBe('disb-sub');
    expect(token.headers.Authorization).toBe('Basic ' + Buffer.from('disb-user:disb-key').toString('base64'));
    const st = captured.find((o) => String(o.path).includes('/disbursement/v1_0/transfer/'));
    expect(st.headers['Ocp-Apim-Subscription-Key']).toBe('disb-sub');
  });

  test('statut d\'encaissement : POST /collection/token/ avec les identifiants collection', async () => {
    const captured = []; mockHttps(captured);
    const provider = jest.requireActual('../services/mobilemoney/providers/mtn.provider');
    await provider.getRequestStatus(cfg, 'ref-c');
    const token = captured.find((o) => /\/token\/$/.test(o.path));
    expect(token.path).toBe('/collection/token/');
    expect(token.headers['Ocp-Apim-Subscription-Key']).toBe('coll-sub');
  });

  test('sans bloc disbursement : les identifiants collection servent aux deux produits (compatibilite)', async () => {
    const captured = []; mockHttps(captured);
    const provider = jest.requireActual('../services/mobilemoney/providers/mtn.provider');
    const { disbursement, ...single } = cfg;
    await provider.getTransferStatus(single, 'ref-d');
    const token = captured.find((o) => /\/token\/$/.test(o.path));
    expect(token.path).toBe('/disbursement/token/');
    expect(token.headers['Ocp-Apim-Subscription-Key']).toBe('coll-sub');
  });
});

describe('variables MTN_<CC>_COLL_* / _DISB_* reconnues par le routeur et le registre (sans api_configurations)', () => {
  const KEYS = ['MTN_CG_COLL_API_USER', 'MTN_CG_COLL_API_KEY', 'MTN_CG_COLL_SUB_KEY_PRIMARY', 'MTN_CG_DISB_API_USER', 'MTN_CG_DISB_API_KEY', 'MTN_CG_DISB_SUB_KEY_PRIMARY', 'MTN_CG_BASE_URL', 'MTN_CG_API_KEY'];
  beforeEach(() => { jest.resetModules(); KEYS.forEach((k) => delete process.env[k]); });
  afterAll(() => { KEYS.forEach((k) => delete process.env[k]); });

  test('buildConfigFromEnv(mtn_cg) : apiKey = API user, apiSecret = API key, subscriptionKey, bloc disbursement', () => {
    Object.assign(process.env, { MTN_CG_COLL_API_USER: 'u-coll', MTN_CG_COLL_API_KEY: 'k-coll', MTN_CG_COLL_SUB_KEY_PRIMARY: 'sub-coll',
      MTN_CG_DISB_API_USER: 'u-disb', MTN_CG_DISB_API_KEY: 'k-disb', MTN_CG_DISB_SUB_KEY_PRIMARY: 'sub-disb', MTN_CG_BASE_URL: 'https://proxy.momoapi.mtn.com' });
    jest.doMock('../config/database', () => ({ query: jest.fn().mockRejectedValue(new Error('no db')) }));
    const router = require('../services/mobilemoney/mobilemoney.router');
    return router.getConfig('mtn_cg').then((cfg) => {
      expect(cfg).toMatchObject({ providerKey: 'mtn_cg', baseUrl: 'https://proxy.momoapi.mtn.com', apiKey: 'u-coll', apiSecret: 'k-coll', subscriptionKey: 'sub-coll',
        disbursement: { apiKey: 'u-disb', apiSecret: 'k-disb', subscriptionKey: 'sub-disb' } });
    });
  });

  test('sans variables MTN : config vide comme avant, pas de bloc disbursement', () => {
    jest.doMock('../config/database', () => ({ query: jest.fn().mockRejectedValue(new Error('no db')) }));
    const router = require('../services/mobilemoney/mobilemoney.router');
    return router.getConfig('mtn_cg').then((cfg) => {
      expect(cfg.apiKey).toBeUndefined(); expect(cfg.subscriptionKey).toBeUndefined(); expect(cfg.disbursement).toBeUndefined();
    });
  });

  test('registre : MTN_CG_COLL_API_USER rend l\'encaissement MTN CG configure (active) ; MTN_CM_API_KEY reste accepte', () => {
    const { getCapabilities } = require('../services/capabilities/registry');
    const impl = { collectPayment() {}, sendPayout() {} };
    const providers = { getProvider: (gw) => ({ mtn_cg: impl, mtn_cm: impl, airtel_cg: impl })[gw] || null };
    const env = { MTN_CG_COLL_API_USER: 'u', MTN_CG_COLL_API_KEY: 'k', MTN_CG_COLL_SUB_KEY_PRIMARY: 's', MTN_CM_API_KEY: 'x', CAPABILITY_ENFORCE: 'enforce' };
    const facts = { cardGatewayByCountry: {}, configuredGateways: [], fundingCurrencies: [], loadedAt: null, source: 'test' };
    const caps = getCapabilities({ env, facts, providers });
    const mtnCg = caps.countries.CG.operations.collect.mobile_money.operators.find((o) => o.operator === 'MTN_MOMO');
    expect(mtnCg.status).toBe('active');
    expect(caps.countries.CM.operations.collect.mobile_money.operators.find((o) => o.operator === 'MTN_MOMO').status).toBe('active');
  });
});
