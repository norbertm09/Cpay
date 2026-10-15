/**
 * WAVE-2 — secrets au repos (config/secrets.js) + déchiffrement dans mobilemoney.router.getConfig
 */
'use strict';

jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockQuery = jest.fn();
jest.mock('../config/database', () => ({ query: (...a) => mockQuery(...a), withTransaction: jest.fn(), pool: {} }));

const crypto = require('crypto');
const secrets = require('../config/secrets');

const HEX_KEY = crypto.randomBytes(32).toString('hex');
const B64_KEY = crypto.randomBytes(32).toString('base64');

const withEnv = (vars, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  let out;
  try { out = fn(); } catch (e) { restore(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(restore);
  restore();
  return out;
};

describe('encrypt / decrypt', () => {
  test('aller-retour avec clé hex (64)', () => withEnv({ CONFIG_ENCRYPTION_KEY: HEX_KEY }, () => {
    const enc = secrets.encrypt('sk_live_abc');
    expect(enc.startsWith('enc:v1:')).toBe(true);
    expect(enc.split(':')).toHaveLength(5);
    expect(secrets.isEncrypted(enc)).toBe(true);
    expect(secrets.decrypt(enc)).toBe('sk_live_abc');
  }));
  test('aller-retour avec clé base64 (44)', () => withEnv({ CONFIG_ENCRYPTION_KEY: B64_KEY }, () => {
    expect(secrets.decrypt(secrets.encrypt('pässwörd €'))).toBe('pässwörd €');
  }));
  test('IV aléatoire : deux chiffrements diffèrent', () => withEnv({ CONFIG_ENCRYPTION_KEY: HEX_KEY }, () => {
    expect(secrets.encrypt('x')).not.toBe(secrets.encrypt('x'));
  }));
  test('encrypt idempotent sur une valeur déjà chiffrée', () => withEnv({ CONFIG_ENCRYPTION_KEY: HEX_KEY }, () => {
    const enc = secrets.encrypt('v');
    expect(secrets.encrypt(enc)).toBe(enc);
  }));
  test('null / undefined / "" passent tels quels', () => withEnv({ CONFIG_ENCRYPTION_KEY: HEX_KEY }, () => {
    expect(secrets.encrypt(null)).toBeNull(); expect(secrets.encrypt(undefined)).toBeUndefined(); expect(secrets.encrypt('')).toBe('');
    expect(secrets.decrypt(null)).toBeNull(); expect(secrets.decrypt('')).toBe('');
  }));
  test('valeur héritée en clair : decrypt la renvoie telle quelle', () => withEnv({ CONFIG_ENCRYPTION_KEY: HEX_KEY }, () => {
    expect(secrets.decrypt('plain-legacy-key')).toBe('plain-legacy-key');
  }));
  test('valeur altérée → erreur GCM', () => withEnv({ CONFIG_ENCRYPTION_KEY: HEX_KEY }, () => {
    const enc = secrets.encrypt('secret');
    const parts = enc.split(':');
    const cipher = Buffer.from(parts[4], 'base64'); cipher[0] ^= 0xff; parts[4] = cipher.toString('base64');
    expect(() => secrets.decrypt(parts.join(':'))).toThrow();
  }));
  test('mauvaise clé → erreur', () => {
    const enc = withEnv({ CONFIG_ENCRYPTION_KEY: HEX_KEY }, () => secrets.encrypt('secret'));
    withEnv({ CONFIG_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') }, () => expect(() => secrets.decrypt(enc)).toThrow());
  });
  test('clé de mauvaise taille → erreur explicite', () => withEnv({ CONFIG_ENCRYPTION_KEY: 'abcd' }, () => {
    expect(() => secrets.encrypt('x')).toThrow(/32 octets/);
  }));
  test('production sans clé : encrypt lève, decrypt d’une valeur chiffrée lève', () => {
    const enc = withEnv({ CONFIG_ENCRYPTION_KEY: HEX_KEY }, () => secrets.encrypt('secret'));
    withEnv({ CONFIG_ENCRYPTION_KEY: undefined, NODE_ENV: 'production' }, () => {
      expect(() => secrets.encrypt('x')).toThrow(/CONFIG_ENCRYPTION_KEY/);
      expect(() => secrets.decrypt(enc)).toThrow(/CONFIG_ENCRYPTION_KEY/);
      expect(secrets.decrypt('legacy')).toBe('legacy'); // passthrough toujours possible
    });
  });
  test('hors production sans clé : encrypt renvoie le clair, decrypt chiffré lève', () => {
    const enc = withEnv({ CONFIG_ENCRYPTION_KEY: HEX_KEY }, () => secrets.encrypt('secret'));
    withEnv({ CONFIG_ENCRYPTION_KEY: undefined, NODE_ENV: 'test' }, () => {
      expect(secrets.encrypt('x')).toBe('x');
      expect(() => secrets.decrypt(enc)).toThrow();
    });
  });
});

describe('extra_params et encryptConfigPatch', () => {
  test('seules les clés sensibles sont chiffrées', () => withEnv({ CONFIG_ENCRYPTION_KEY: HEX_KEY }, () => {
    const out = secrets.encryptExtraParams({ merchantId: 'M1', subscriptionKey: 'sub', webhookSecret: 'wh', pin: '1234', privateKey: 'pk', password: 'pw', accessToken: 'tok', timeout: 30 });
    expect(out.merchantId).toBe('M1'); expect(out.timeout).toBe(30);
    for (const k of ['subscriptionKey', 'webhookSecret', 'pin', 'privateKey', 'password', 'accessToken']) expect(secrets.isEncrypted(out[k])).toBe(true);
    expect(secrets.decryptExtraParams(out)).toEqual({ merchantId: 'M1', subscriptionKey: 'sub', webhookSecret: 'wh', pin: '1234', privateKey: 'pk', password: 'pw', accessToken: 'tok', timeout: 30 });
  }));
  test('encryptConfigPatch ne renvoie que les propriétés présentes', () => withEnv({ CONFIG_ENCRYPTION_KEY: HEX_KEY }, () => {
    const p1 = secrets.encryptConfigPatch({ apiKey: 'k' });
    expect(Object.keys(p1)).toEqual(['apiKey']); expect(secrets.decrypt(p1.apiKey)).toBe('k');
    const p2 = secrets.encryptConfigPatch({ apiKey: 'k', apiSecret: null, extraParams: { pin: '0000', merchantCode: 'MC' } });
    expect(p2.apiSecret).toBeNull();
    expect(secrets.isEncrypted(p2.extraParams.pin)).toBe(true); expect(p2.extraParams.merchantCode).toBe('MC');
    expect(secrets.encryptConfigPatch({})).toEqual({});
  }));
});

describe('mobilemoney.router.getConfig — déchiffrement et fusion explicite', () => {
  const mm = require('../services/mobilemoney/mobilemoney.router');
  beforeEach(() => { mockQuery.mockReset(); mm.invalidateCache(); });

  test('api_key / api_secret / extra_params sensibles déchiffrés ; extra_params ne peut pas écraser apiKey/baseUrl', async () => {
    await withEnv({ CONFIG_ENCRYPTION_KEY: HEX_KEY }, async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{
        provider_key: 'orange_sn', base_url: 'https://api.orange.com',
        api_key: secrets.encrypt('ORANGE-KEY'), api_secret: secrets.encrypt('ORANGE-SECRET'),
        extra_params: { apiKey: 'EVIL', baseUrl: 'https://evil.example', merchantId: 'M-1', webhookSecret: secrets.encrypt('wh-secret'), legacyToken: 'plain-legacy' },
      }] });
      const cfg = await mm.getConfig('orange_sn');
      expect(cfg.apiKey).toBe('ORANGE-KEY');
      expect(cfg.apiSecret).toBe('ORANGE-SECRET');
      expect(cfg.baseUrl).toBe('https://api.orange.com');
      expect(cfg.merchantId).toBe('M-1');
      expect(cfg.webhookSecret).toBe('wh-secret');
      expect(cfg.legacyToken).toBe('plain-legacy');
    });
  });

  test('valeurs héritées en clair toujours lues', async () => {
    await withEnv({ CONFIG_ENCRYPTION_KEY: HEX_KEY }, async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ provider_key: 'mtn_cg', base_url: 'https://mtn', api_key: 'plain-key', api_secret: 'plain-secret', extra_params: {} }] });
      const cfg = await mm.getConfig('mtn_cg');
      expect(cfg).toMatchObject({ apiKey: 'plain-key', apiSecret: 'plain-secret', providerKey: 'mtn_cg' });
    });
  });

  test('ligne indéchiffrable (clé absente) : provider non configuré, pas de crash, autres lignes lues', async () => {
    const encKey = withEnv({ CONFIG_ENCRYPTION_KEY: HEX_KEY }, () => secrets.encrypt('k'));
    await withEnv({ CONFIG_ENCRYPTION_KEY: undefined, NODE_ENV: 'test' }, async () => {
      mockQuery.mockResolvedValueOnce({ rows: [
        { provider_key: 'wave_sn', base_url: 'https://wave', api_key: encKey, api_secret: null, extra_params: {} },
        { provider_key: 'moov_ci', base_url: 'https://moov', api_key: 'ok', api_secret: null, extra_params: {} },
      ] });
      const wave = await mm.getConfig('wave_sn');
      expect(wave.apiKey).toBeUndefined(); // fallback env (non défini en test)
      expect((await mm.getConfig('moov_ci')).apiKey).toBe('ok');
    });
  });

  test('normalize : notif_token Orange / session Wave → gatewayRef (gateway_payment_id)', () => {
    expect(mm.normalize({ pending: true, notifToken: 'NT-1', externalId: 'TXN-1' }, 'ORANGE_MONEY').gatewayRef).toBe('NT-1');
    expect(mm.normalize({ pending: true, sessionId: 'cos-1', externalId: 'TXN-1' }, 'WAVE').gatewayRef).toBe('cos-1');
    expect(mm.normalize({ pending: true, externalId: 'REF-MTN' }, 'MTN_MOMO').gatewayRef).toBe('REF-MTN');
  });

  test('webhookUrl : chemin secret si WEBHOOK_PATH_SECRET, sinon legacy', () => {
    withEnv({ API_BASE_URL: 'https://api.c-pay.global/', WEBHOOK_PATH_SECRET: 'S3cr3t' }, () => {
      expect(mm.webhookUrl('orange')).toBe('https://api.c-pay.global/api/v1/webhooks/S3cr3t/orange');
      expect(mm.webhookUrl('africell', '/TXN-1')).toBe('https://api.c-pay.global/api/v1/webhooks/S3cr3t/africell/TXN-1');
    });
    withEnv({ API_BASE_URL: 'https://api.c-pay.global', WEBHOOK_PATH_SECRET: undefined }, () => {
      expect(mm.webhookUrl('orange')).toBe('https://api.c-pay.global/webhooks/orange');
    });
  });
});
