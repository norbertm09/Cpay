/**
 * Lot 0 (2026-11-13) — rotation des secrets sans refus des callbacks en vol :
 *  - chemin secret /api/v1/webhooks/<secret>/<provider> : WEBHOOK_PATH_SECRET_PREVIOUS accepte, tout autre segment 404 ;
 *  - callback MTN : MTN_WEBHOOK_TOKEN_PREVIOUS accepte, jeton inconnu 401, sans aucun acces base.
 */
'use strict';

jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/pci.middleware', () => ({ auditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../config/database', () => ({ query: jest.fn(), withTransaction: jest.fn(), pool: { query: jest.fn() } }));
jest.mock('../services/rails/mtn-momo.client', () => ({
  getCollectionStatus: jest.fn(), getDisbursementStatus: jest.fn(), requestToPay: jest.fn(), transfer: jest.fn(),
  getCollectionBalance: jest.fn(), getDisbursementBalance: jest.fn(), validateAccount: jest.fn(),
}));

const express = require('express');
const http = require('http');
const db = require('../config/database');
const wh = require('../routes/webhook-handlers');
const { secretRouter } = require('../routes/webhooks-mm.routes');

const mkRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  res.end = jest.fn(() => res);
  return res;
};

const ENV = ['WEBHOOK_PATH_SECRET', 'WEBHOOK_PATH_SECRET_PREVIOUS', 'MTN_WEBHOOK_TOKEN', 'MTN_WEBHOOK_TOKEN_PREVIOUS'];
const saved = {};
beforeAll(() => { ENV.forEach((k) => { saved[k] = process.env[k]; }); });
afterAll(() => { ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });
beforeEach(() => { jest.clearAllMocks(); ENV.forEach((k) => delete process.env[k]); db.query.mockResolvedValue({ rows: [], rowCount: 0 }); });

// ─── Chemin secret ───
describe('WEBHOOK_PATH_SECRET_PREVIOUS (segment secret des webhooks Mobile Money)', () => {
  let server; let base;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/webhooks', secretRouter);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/api/v1/webhooks`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); });
  const post = (secret) => fetch(`${base}/${secret}/orange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });

  test('nouveau segment accepte, ancien accepte pendant la rotation, segment inconnu 404', async () => {
    process.env.WEBHOOK_PATH_SECRET = 'nouveau-segment';
    process.env.WEBHOOK_PATH_SECRET_PREVIOUS = 'ancien-segment';
    expect((await post('nouveau-segment')).status).not.toBe(404);
    expect((await post('ancien-segment')).status).not.toBe(404);
    expect((await post('autre-segment')).status).toBe(404);
    expect((await post('ancien-segmen')).status).toBe(404);
  });

  test('sans _PREVIOUS, l’ancien segment est refuse (404) sans acces base', async () => {
    process.env.WEBHOOK_PATH_SECRET = 'nouveau-segment';
    db.query.mockClear();
    expect((await post('ancien-segment')).status).toBe(404);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('_PREVIOUS seul (WEBHOOK_PATH_SECRET absent) : tout est refuse', async () => {
    process.env.WEBHOOK_PATH_SECRET_PREVIOUS = 'ancien-segment';
    expect((await post('ancien-segment')).status).toBe(404);
  });
});

// ─── Jeton MTN ───
describe('MTN_WEBHOOK_TOKEN_PREVIOUS (callback MTN)', () => {
  const call = async (token) => {
    const res = mkRes();
    await wh.handleMtnWebhook({ body: {}, headers: {}, query: { token }, ip: '127.0.0.1' }, res);
    return res;
  };

  test('ancien jeton accepte pendant la rotation, jeton inconnu 401 sans acces base', async () => {
    process.env.MTN_WEBHOOK_TOKEN = 'jeton-nouveau';
    process.env.MTN_WEBHOOK_TOKEN_PREVIOUS = 'jeton-ancien';
    expect((await call('jeton-nouveau')).statusCode).not.toBe(401);
    expect((await call('jeton-ancien')).statusCode).not.toBe(401);
    db.query.mockClear();
    const bad = await call('jeton-inconnu');
    expect(bad.statusCode).toBe(401);
    expect(bad.body.code).toBe('INVALID_WEBHOOK_TOKEN');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('sans _PREVIOUS, l’ancien jeton est refuse', async () => {
    process.env.MTN_WEBHOOK_TOKEN = 'jeton-nouveau';
    expect((await call('jeton-ancien')).statusCode).toBe(401);
  });

  test('_PREVIOUS vide ou egal au jeton courant : aucun effet', async () => {
    process.env.MTN_WEBHOOK_TOKEN = 'jeton-nouveau';
    process.env.MTN_WEBHOOK_TOKEN_PREVIOUS = '';
    expect((await call('')).statusCode).toBe(401);
    process.env.MTN_WEBHOOK_TOKEN_PREVIOUS = 'jeton-nouveau';
    expect((await call('jeton-nouveau')).statusCode).not.toBe(401);
  });
});
