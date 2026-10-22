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
    expect(r.host).toBe('proxy.momoapi.mtn.com');
    expect(r.warnings).toEqual([]);
  });

  test('cibles de production par pays (CM, CI) ; pays inconnu -> avertissement', () => {
    expect(resolveMtnEnv({ country: 'CM', env: { MTN_ENV: 'production' } }).targetEnvironment).toBe('mtncameroon');
    expect(resolveMtnEnv({ country: 'CI', env: { MTN_ENV: 'production' } }).targetEnvironment).toBe('mtnivorycoast');
    const r = resolveMtnEnv({ country: 'XX', env: { MTN_ENV: 'production' } });
    expect(r.targetEnvironment).toBe('production');
    expect(r.warnings.join(' ')).toMatch(/MTN_XX_TARGET_ENV/);
  });

  test('MTN_CG_ENV (historique) prime sur MTN_ENV ; MTN_CG_TARGET_ENV et MTN_CG_BASE_URL explicites sont respectes', () => {
    const r = resolveMtnEnv({ country: 'CG', env: { MTN_ENV: 'sandbox', MTN_CG_ENV: 'production', MTN_CG_TARGET_ENV: 'mtncongo', MTN_CG_BASE_URL: 'https://proxy.momoapi.mtn.com/' } });
    expect(r.mode).toBe('production');
    expect(r.targetEnvironment).toBe('mtncongo');
    expect(r.baseUrl).toBe('https://proxy.momoapi.mtn.com');
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
    expect(rtp.hostname).toBe('proxy.momoapi.mtn.com');
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
