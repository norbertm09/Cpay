'use strict';
/**
 * WAVE-3 — webhooks SORTANTS : signature/en-têtes partagés (services/webhooks/outgoing.js),
 * utilisés par les intégrations, le test de webhook marchand et triggerMerchantWebhook ;
 * statut Wave (getStatus) ; rate limiters (en-têtes standard).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wave3-test-secret-at-least-32-chars-long';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() }));
const mockDbQuery = jest.fn();
jest.mock('../config/database', () => ({
  query: (...a) => mockDbQuery(...a),
  withTransaction: async (fn) => fn({ query: (...a) => mockDbQuery(...a) }),
  pool: {},
}));
jest.mock('../middleware/pci.middleware', () => ({ auditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/notifications/email.service', () => ({ send: jest.fn(async () => true) }));
jest.mock('../services/notifications/smpp.service', () => ({ sendSmsSmpp: jest.fn(async () => true), notifyMultiChannel: jest.fn(async () => true) }));
jest.mock('../services/notifications/whatsapp.service', () => ({ sendWhatsAppText: jest.fn(async () => true) }));
jest.mock('../services/reconcile.service', () => ({ reconcilePending: jest.fn(async () => ({ summary: {} })) }));
jest.mock('../services/rails/mtn-momo.client', () => ({
  getCollectionStatus: jest.fn(), getDisbursementStatus: jest.fn(), requestToPay: jest.fn(), transfer: jest.fn(),
  getCollectionBalance: jest.fn(), getDisbursementBalance: jest.fn(), validateAccount: jest.fn(),
}));

// https programmable (triggerMerchantWebhook + wave.provider)
const mockHttpsCalls = [];
let mockHttpsRespond = () => ({ status: 200, body: {} });
jest.mock('https', () => ({
  request: jest.fn((opts, cb) => {
    const rec = { opts, written: '' };
    mockHttpsCalls.push(rec);
    const r = {
      on: () => r, setTimeout: () => r, destroy: jest.fn(),
      write: (chunk) => { rec.written += String(chunk); },
      end: () => {
        const { status, body } = mockHttpsRespond(rec);
        const h = {};
        const res = { statusCode: status, on: (ev, fn) => { h[ev] = fn; return res; } };
        cb(res);
        process.nextTick(() => { if (h.data) h.data(JSON.stringify(body)); if (h.end) h.end(); });
      },
    };
    return r;
  }),
}));

const outgoing = require('../services/webhooks/outgoing');
const rows = (r) => ({ rows: r, rowCount: r.length });
const hex = (secret, body) => crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');

beforeEach(() => { mockDbQuery.mockReset(); mockDbQuery.mockImplementation(async () => rows([])); mockHttpsCalls.length = 0; });

describe('services/webhooks/outgoing — algorithme en un seul endroit', () => {
  test('HMAC-SHA256 hex du corps brut, préfixe sha256=, X-CPay-* + X-CPlus-* + User-Agent', () => {
    const body = JSON.stringify({ event: 'transaction.authorized', amount: 100 });
    const h = outgoing.buildHeaders({ secret: 's3cret', rawBody: body, event: 'transaction.authorized' });
    expect(h['X-CPay-Signature']).toBe('sha256=' + hex('s3cret', body));
    expect(h['X-CPlus-Signature']).toBe('sha256=' + hex('s3cret', body));
    expect(h['X-CPay-Event']).toBe('transaction.authorized');
    expect(h['X-CPlus-Event']).toBe('transaction.authorized');
    expect(h['User-Agent']).toBe('CPay-Webhooks/1.0');
    expect(h['Content-Type']).toBe('application/json');
    expect(h['X-CPay-Timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
  test('legacyPrefixed:false → X-CPlus-Signature hex nu (format historique des intégrations), X-CPay toujours préfixé', () => {
    const h = outgoing.buildHeaders({ secret: 'k', rawBody: '{}', event: 'e', legacyPrefixed: false });
    expect(h['X-CPlus-Signature']).toBe(hex('k', '{}'));
    expect(h['X-CPay-Signature']).toBe('sha256=' + hex('k', '{}'));
  });
  test('legacy:false → aucun en-tête X-CPlus-*', () => {
    const h = outgoing.buildHeaders({ secret: 'k', rawBody: '{}', event: 'e', legacy: false });
    expect(Object.keys(h).some(k => k.startsWith('X-CPlus'))).toBe(false);
  });
  test('verifySignature : accepte avec ou sans préfixe, refuse un corps modifié ou un autre secret', () => {
    const body = '{"a":1}';
    const sig = outgoing.signatureHeader('k', body);
    expect(outgoing.verifySignature('k', body, sig)).toBe(true);
    expect(outgoing.verifySignature('k', body, hex('k', body))).toBe(true);
    expect(outgoing.verifySignature('k', '{"a":2}', sig)).toBe(false);
    expect(outgoing.verifySignature('other', body, sig)).toBe(false);
    expect(outgoing.verifySignature('k', body, undefined)).toBe(false);
    expect(outgoing.verifySignature('k', body, 'sha256=abc')).toBe(false);
  });
  test('plus aucune signature locale dans les émetteurs (createHmac uniquement côté réception)', () => {
    const integ = fs.readFileSync(path.join(__dirname, '../services/integrations/integration.service.js'), 'utf8');
    const merch = fs.readFileSync(path.join(__dirname, '../routes/merchant.routes.js'), 'utf8');
    const wh = fs.readFileSync(path.join(__dirname, '../routes/webhook-handlers.js'), 'utf8');
    expect(integ).not.toMatch(/createHmac/);
    expect(merch).not.toMatch(/'X-CPlus-Signature'/);
    expect(wh).not.toMatch(/'X-CPlus-Signature'/);
    expect(wh).not.toMatch(/CPlus-Webhook\/2\.6\.0/);
  });
});

describe('integration.service.deliverEvent — en-têtes via le helper', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  test('X-CPay-Signature = sha256=HMAC(corps envoyé), X-CPlus-Signature = hex nu, User-Agent CPay-Webhooks/1.0', async () => {
    const integ = require('../services/integrations/integration.service');
    const calls = [];
    global.fetch = jest.fn(async (url, opts) => { calls.push({ url, opts }); return { status: 200, ok: true, text: async () => 'ok' }; });
    mockDbQuery.mockImplementation(async (sql) => {
      if (/FROM merchant_integrations/.test(sql)) return rows([{ integration_id: 'I-1', endpoint_url: 'https://93.184.216.34/hook', signing_secret: 'int-secret' }]);
      return rows([]);
    });
    await integ.deliverEvent({ merchantId: 'M-1', eventType: 'transaction.authorized', payload: { txnId: 'T-1' } });
    expect(calls).toHaveLength(1);
    const { opts } = calls[0];
    expect(opts.headers['X-CPay-Signature']).toBe('sha256=' + hex('int-secret', opts.body));
    expect(opts.headers['X-CPlus-Signature']).toBe(hex('int-secret', opts.body));
    expect(opts.headers['X-CPay-Event']).toBe('transaction.authorized');
    expect(opts.headers['X-CPlus-Event']).toBe('transaction.authorized');
    expect(opts.headers['User-Agent']).toBe('CPay-Webhooks/1.0');
    expect(JSON.parse(opts.body)).toMatchObject({ eventType: 'transaction.authorized', merchantId: 'M-1' });
    expect(mockDbQuery.mock.calls.some(([s]) => /INSERT INTO integration_delivery_logs/.test(s))).toBe(true);
  });
});

describe('POST /merchant/webhook-config/test — en-têtes via le helper', () => {
  test('X-CPay-* et X-CPlus-* (préfixés) sur le corps exact envoyé', async () => {
    const { signToken } = require('../middleware/auth');
    const integrations = require('../services/integrations/integration.service');
    const merchantRouter = require('../routes/merchant.routes');
    const app = express(); app.use(express.json()); app.use('/merchant', merchantRouter);
    const MERCHANT_ID = '11111111-1111-4111-8111-111111111111';
    const token = signToken({ sub: 'user-1', merchantId: MERCHANT_ID, type: 'merchant', email: 'm@test.io' });
    mockDbQuery.mockImplementation(async (sql) => {
      if (/SELECT webhook_url, webhook_secret FROM merchants/.test(sql)) return rows([{ webhook_url: 'https://example.com/hook', webhook_secret: 'wh-secret' }]);
      return rows([]);
    });
    const safe = jest.spyOn(integrations, 'assertSafeWebhookUrl').mockResolvedValue('https://example.com/hook');
    const fetchSpy = jest.spyOn(integrations, 'fetchWithTimeout').mockResolvedValue({ status: 204 });
    const res = await request(app).post('/merchant/webhook-config/test').set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(res.body.statusCode).toBe(204);
    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.headers['X-CPay-Signature']).toBe('sha256=' + hex('wh-secret', opts.body));
    expect(opts.headers['X-CPlus-Signature']).toBe('sha256=' + hex('wh-secret', opts.body));
    expect(opts.headers['X-CPay-Event']).toBe('webhook.test');
    expect(opts.headers['User-Agent']).toBe('CPay-Webhooks/1.0');
    safe.mockRestore(); fetchSpy.mockRestore();
  });
});

describe('triggerMerchantWebhook — en-têtes via le helper (https.request)', () => {
  test('signature sha256= sur le corps exact, X-CPay + X-CPlus, User-Agent, Content-Length', async () => {
    const { triggerMerchantWebhook } = require('../routes/webhook-handlers');
    mockDbQuery.mockImplementation(async (sql) => {
      if (/FROM transactions t/.test(sql) && /webhook_url/.test(sql)) {
        return rows([{ transaction_id: 'T-1', reference: 'REF-1', amount: '5000', currency: 'XAF', status: 'authorized', payment_method: 'mobile_money',
          auth_code: 'A1', webhook_url: 'https://merchant.example/hook', webhook_secret: 'm-secret' }]);
      }
      return rows([]);
    });
    mockHttpsRespond = () => ({ status: 200, body: {} });
    await triggerMerchantWebhook('T-1', 'payment.completed');
    expect(mockHttpsCalls).toHaveLength(1);
    const { opts, written } = mockHttpsCalls[0];
    expect(opts.hostname).toBe('merchant.example');
    expect(opts.headers['X-CPay-Signature']).toBe('sha256=' + hex('m-secret', written));
    expect(opts.headers['X-CPlus-Signature']).toBe('sha256=' + hex('m-secret', written));
    expect(opts.headers['X-CPay-Event']).toBe('payment.completed');
    expect(opts.headers['X-CPlus-Event']).toBe('payment.completed');
    expect(opts.headers['User-Agent']).toBe('CPay-Webhooks/1.0');
    expect(opts.headers['Content-Length']).toBe(Buffer.byteLength(written));
    expect(JSON.parse(written)).toMatchObject({ event: 'payment.completed', txnId: 'T-1', amount: 5000 });
  });
});

describe('wave.provider.getStatus (WAVE-3)', () => {
  const wave = require('../services/mobilemoney/providers/wave.provider');
  const cfg = { apiKey: 'wave-key', baseUrl: 'https://api.wave.com' };

  test('session payée → SUCCESSFUL avec montant/devise/référence', async () => {
    mockHttpsRespond = () => ({ status: 200, body: { id: 'cos-1', payment_status: 'succeeded', checkout_status: 'complete', amount: '5000', currency: 'XOF', transaction_id: 'TW-1' } });
    const s = await wave.getStatus({ txnId: 'T-1', gatewayRef: 'cos-1', config: cfg });
    expect(s).toMatchObject({ available: true, status: 'SUCCESSFUL', amount: 5000, currency: 'XOF', gatewayRef: 'TW-1' });
    expect(mockHttpsCalls[0].opts.method).toBe('GET');
    expect(mockHttpsCalls[0].opts.path).toBe('/v1/checkout/sessions/cos-1');
    expect(mockHttpsCalls[0].opts.headers.Authorization).toBe('Bearer wave-key');
  });
  test('annulée / expirée → FAILED ; en cours → PENDING', async () => {
    mockHttpsRespond = () => ({ status: 200, body: { id: 'cos-1', payment_status: 'cancelled', checkout_status: 'complete' } });
    expect((await wave.getStatus({ gatewayRef: 'cos-1', config: cfg })).status).toBe('FAILED');
    mockHttpsRespond = () => ({ status: 200, body: { id: 'cos-1', payment_status: 'processing', checkout_status: 'expired' } });
    expect((await wave.getStatus({ gatewayRef: 'cos-1', config: cfg })).status).toBe('FAILED');
    mockHttpsRespond = () => ({ status: 200, body: { id: 'cos-1', payment_status: 'processing', checkout_status: 'open' } });
    expect((await wave.getStatus({ gatewayRef: 'cos-1', config: cfg })).status).toBe('PENDING');
  });
  test('HTTP 404 → erreur (transaction laissée pending par l’appelant) ; versement → non disponible', async () => {
    mockHttpsRespond = () => ({ status: 404, body: { message: 'not found' } });
    await expect(wave.getStatus({ gatewayRef: 'cos-x', config: cfg })).rejects.toThrow(/HTTP 404/);
    expect(await wave.getStatus({ gatewayRef: 'tr-1', config: cfg, product: 'disbursement' })).toEqual({ available: false });
    await expect(wave.getStatus({ gatewayRef: 'cos-1', config: {} })).rejects.toThrow(/API key/);
  });
});

describe('mobilemoney.router.normalize — _gateway persisté dans gateway_name', () => {
  test('normalize(raw, operator, gateway) expose _gateway', () => {
    const { normalize } = require('../services/mobilemoney/mobilemoney.router');
    expect(normalize({ success: null, pending: true, sessionId: 'cos-1' }, 'WAVE', 'wave_sn')).toMatchObject({ pending: true, _operator: 'WAVE', _gateway: 'wave_sn', gatewayRef: 'cos-1' });
    expect(normalize({ success: true }, 'MTN_MOMO')).toMatchObject({ approved: true, _gateway: null });
  });
});

describe('rate limiters — standardHeaders + legacyHeaders:false partout', () => {
  const walk = (dir, out = []) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) { if (f !== 'tests' && f !== 'node_modules') walk(p, out); }
      else if (p.endsWith('.js')) out.push(p);
    }
    return out;
  };
  test('chaque appel rateLimit( fixe standardHeaders et legacyHeaders:false', () => {
    const files = walk(path.join(__dirname, '..'));
    const bad = [];
    let count = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const re = /rateLimit\(\s*\{/g; let m;
      while ((m = re.exec(src))) {
        count++;
        // bloc d'options : jusqu'à la prochaine occurrence ou 600 caractères
        const next = src.indexOf('rateLimit(', m.index + 10);
        const block = src.slice(m.index, next === -1 ? m.index + 600 : Math.min(next, m.index + 600));
        if (!/standardHeaders:\s*(true|'draft-[67]')/.test(block) || !/legacyHeaders:\s*false/.test(block)) bad.push(`${path.relative(process.cwd(), f)}@${m.index}`);
      }
    }
    expect(count).toBeGreaterThanOrEqual(10);
    expect(bad).toEqual([]);
  });
});
