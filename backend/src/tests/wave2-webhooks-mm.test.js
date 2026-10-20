/**
 * WAVE-2 — webhooks Mobile Money (routes/webhooks-mm.routes.js), supertest + DB mockée
 */
'use strict';

process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockQuery = jest.fn();
// WAVE-6 : finalize.service écrit dans une transaction SQL (withTransaction) — même mock de requêtes
jest.mock('../config/database', () => ({ query: (...a) => mockQuery(...a), withTransaction: async (fn) => fn({ query: (...a) => mockQuery(...a) }), pool: {} }));
const mockEnqueue = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/settlement/settlement.queue', () => ({ enqueue: (...a) => mockEnqueue(...a) }));
const mockGetConfig = jest.fn().mockResolvedValue({});
const mockGetProvider = jest.fn().mockReturnValue(null);
jest.mock('../services/mobilemoney/mobilemoney.router', () => ({
  getConfig: (...a) => mockGetConfig(...a),
  getProvider: (...a) => mockGetProvider(...a),
  webhookUrl: jest.fn(),
}));

const { secretRouter, legacyRouter } = require('../routes/webhooks-mm.routes');

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
app.use(express.urlencoded({ extended: true }));
app.use('/api/v1/webhooks', secretRouter);
app.use('/webhooks', legacyRouter);
app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

const SECRET = 'wh-path-secret-123';
const TXN = '11111111-1111-4111-8111-111111111111';
const PAY_LINK = '22222222-2222-4222-8222-222222222222';
const pendingTxn = (over = {}) => ({
  transaction_id: TXN, merchant_id: 'M-1', type: 'collect', amount: '5000', currency: 'XAF', status: 'pending',
  gateway_name: 'orange_cg', gateway_payment_id: 'NOTIF-TOKEN-1', detected_operator: 'ORANGE_MONEY', detected_country: 'CG', pay_link_id: null,
  ...over,
});

const routeQueries = (rules) => {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql, params) => {
    for (const [re, handler] of rules) if (re.test(sql)) return typeof handler === 'function' ? handler(sql, params) : handler;
    return { rows: [], rowCount: 0 };
  });
};
const calls = (re) => mockQuery.mock.calls.filter(([sql]) => re.test(sql));
const SELECT_TXN = /SELECT transaction_id, merchant_id, type, amount, currency, status/;
const UPDATE_TXN = /UPDATE transactions/;
const WH_EVENTS  = /INSERT INTO webhook_events/;
const TXN_EVENTS = /INSERT INTO transaction_events/;
const PAY_LINKS  = /UPDATE pay_links/;

const standardDb = (txn, updRowCount = 1) => routeQueries([
  [SELECT_TXN, { rows: txn ? [txn] : [], rowCount: txn ? 1 : 0 }],
  [UPDATE_TXN, { rows: updRowCount ? [{ transaction_id: TXN }] : [], rowCount: updRowCount }],
]);

const waveSig = (secret, rawBody, ts = String(Math.floor(Date.now() / 1000))) =>
  `t=${ts},v1=${crypto.createHmac('sha256', secret).update(ts + rawBody).digest('hex')}`;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.WEBHOOK_PATH_SECRET = SECRET;
  process.env.WAVE_WEBHOOK_SECRET = 'wave-secret';
  delete process.env.AFRICELL_WEBHOOK_TOKEN;
  mockGetConfig.mockResolvedValue({});
  mockGetProvider.mockReturnValue(null);
});

describe('segment secret', () => {
  test('mauvais secret → 404 sans toucher la base', async () => {
    standardDb(pendingTxn());
    const r = await request(app).post('/api/v1/webhooks/wrong/orange').send({ status: 'SUCCESS', notif_token: 'NOTIF-TOKEN-1' });
    expect(r.status).toBe(404);
    expect(mockQuery).not.toHaveBeenCalled();
  });
  test('WEBHOOK_PATH_SECRET absent → 404 même avec le bon chemin', async () => {
    delete process.env.WEBHOOK_PATH_SECRET;
    const r = await request(app).post(`/api/v1/webhooks/${SECRET}/orange`).send({ status: 'SUCCESS', notif_token: 'NOTIF-TOKEN-1' });
    expect(r.status).toBe(404);
  });
  test('provider inconnu → 404', async () => {
    const r = await request(app).post(`/api/v1/webhooks/${SECRET}/foo`).send({});
    expect(r.status).toBe(404); expect(r.body.code).toBe('UNKNOWN_PROVIDER');
  });
});

describe('Orange (notif_token)', () => {
  test('notif_token différent du gateway_payment_id → 401, aucun changement', async () => {
    standardDb(pendingTxn());
    const r = await request(app).post('/webhooks/orange').send({ status: 'SUCCESS', notif_token: 'FORGED', order_id: TXN, txnid: 'MP1' });
    expect(r.status).toBe(401); expect(r.body.code).toBe('INVALID_NOTIF_TOKEN');
    expect(calls(UPDATE_TXN)).toHaveLength(0);
    expect(calls(WH_EVENTS)[0][1][3]).toBe('rejected');
  });
  test('transaction sans token stocké → 401 (fail-closed)', async () => {
    standardDb(pendingTxn({ gateway_payment_id: null }));
    const r = await request(app).post('/webhooks/orange').send({ status: 'SUCCESS', notif_token: 'X', order_id: TXN });
    expect(r.status).toBe(401);
  });
  test('SUCCESS avec le bon token (lookup par notif_token) → authorized + settlement + pay_link payé', async () => {
    standardDb(pendingTxn({ pay_link_id: PAY_LINK }));
    const r = await request(app).post(`/api/v1/webhooks/${SECRET}/orange`).send({ status: 'SUCCESS', notif_token: 'NOTIF-TOKEN-1', txnid: 'MP123', amount: 5000, currency: 'XAF' });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ applied: true, status: 'authorized' });
    const sel = calls(SELECT_TXN)[0][1]; expect(sel[1]).toBe('NOTIF-TOKEN-1');
    const upd = calls(UPDATE_TXN)[0];
    expect(upd[0]).toMatch(/AND status = 'pending'/);
    expect(upd[1][0]).toBe('authorized'); expect(upd[1][1]).toBe('MP123'); expect(upd[1][4]).toBe(TXN);
    expect(mockEnqueue).toHaveBeenCalledWith({ txnId: TXN, merchantId: 'M-1', amount: 5000, currency: 'XAF' }, expect.anything()); // WAVE-6 : client SQL de la transaction
    expect(calls(PAY_LINKS)).toHaveLength(1); expect(calls(PAY_LINKS)[0][1]).toEqual([5000, PAY_LINK]);
    expect(calls(TXN_EVENTS)[0][1][2]).toBe('ORANGE_CALLBACK');
    expect(calls(WH_EVENTS).some(([, p]) => p[3] === 'authorized')).toBe(true);
  });
  test('FAILED → failed, pas de settlement ni pay_link', async () => {
    standardDb(pendingTxn({ pay_link_id: PAY_LINK }));
    const r = await request(app).post('/webhooks/orange').send({ status: 'FAILED', notif_token: 'NOTIF-TOKEN-1', message: 'Solde insuffisant' });
    expect(r.status).toBe(200); expect(r.body.status).toBe('failed');
    expect(calls(UPDATE_TXN)[0][1][3]).toBe('Solde insuffisant');
    expect(mockEnqueue).not.toHaveBeenCalled(); expect(calls(PAY_LINKS)).toHaveLength(0);
  });
  test('statut non final → 202, transaction laissée pending', async () => {
    standardDb(pendingTxn());
    const r = await request(app).post('/webhooks/orange').send({ status: 'INITIATED', notif_token: 'NOTIF-TOKEN-1' });
    expect(r.status).toBe(202); expect(calls(UPDATE_TXN)).toHaveLength(0);
  });
  test('montant incohérent → 409 sans changement', async () => {
    standardDb(pendingTxn());
    const r = await request(app).post('/webhooks/orange').send({ status: 'SUCCESS', notif_token: 'NOTIF-TOKEN-1', amount: 100, currency: 'XAF' });
    expect(r.status).toBe(409); expect(r.body.code).toBe('AMOUNT_MISMATCH'); expect(calls(UPDATE_TXN)).toHaveLength(0);
  });
  test('devise incohérente → 409', async () => {
    standardDb(pendingTxn());
    const r = await request(app).post('/webhooks/orange').send({ status: 'SUCCESS', notif_token: 'NOTIF-TOKEN-1', amount: 5000, currency: 'XOF' });
    expect(r.status).toBe(409);
  });
  test('rejeu sur transaction déjà autorisée → 200 ignoré, aucun UPDATE', async () => {
    standardDb(pendingTxn({ status: 'authorized' }));
    const r = await request(app).post('/webhooks/orange').send({ status: 'SUCCESS', notif_token: 'NOTIF-TOKEN-1' });
    expect(r.status).toBe(200); expect(r.body.outcome).toBe('already_processed');
    expect(calls(UPDATE_TXN)).toHaveLength(0); expect(mockEnqueue).not.toHaveBeenCalled();
    expect(calls(WH_EVENTS)[0][1][3]).toBe('replay_ignored');
  });
  test('course perdue (claim 0 ligne) → 200 already_processed, pas de settlement', async () => {
    standardDb(pendingTxn(), 0);
    const r = await request(app).post('/webhooks/orange').send({ status: 'SUCCESS', notif_token: 'NOTIF-TOKEN-1' });
    expect(r.status).toBe(200); expect(r.body.outcome).toBe('already_processed'); expect(mockEnqueue).not.toHaveBeenCalled();
  });
  test('référence inconnue → 200 unknown_reference journalisé', async () => {
    standardDb(null);
    const r = await request(app).post('/webhooks/orange').send({ status: 'SUCCESS', notif_token: 'NOPE' });
    expect(r.status).toBe(200); expect(r.body.outcome).toBe('unknown_reference');
    expect(calls(WH_EVENTS)[0][1][3]).toBe('unknown_reference');
  });
  test('sans référence ni token → 400', async () => {
    standardDb(pendingTxn());
    expect((await request(app).post('/webhooks/orange').send({ status: 'SUCCESS' })).status).toBe(400);
  });
});

describe('Wave (HMAC Wave-Signature)', () => {
  const waveTxn = () => pendingTxn({ gateway_name: 'wave_sn', gateway_payment_id: 'cos-abc', detected_operator: 'WAVE', detected_country: 'SN', currency: 'XOF' });
  const event = { type: 'checkout.session.completed', data: { id: 'cos-abc', client_reference: TXN, payment_status: 'succeeded', amount: '5000', currency: 'XOF', transaction_id: 'T-WAVE-1' } };

  test('signature absente → 401', async () => {
    standardDb(waveTxn());
    const r = await request(app).post(`/api/v1/webhooks/${SECRET}/wave`).send(event);
    expect(r.status).toBe(401); expect(r.body.code).toBe('MISSING_SIGNATURE'); expect(calls(UPDATE_TXN)).toHaveLength(0);
  });
  test('mauvaise signature → 401 et journal rejected', async () => {
    standardDb(waveTxn());
    const raw = JSON.stringify(event);
    const r = await request(app).post('/webhooks/wave').set('Wave-Signature', waveSig('other-secret', raw)).set('Content-Type', 'application/json').send(raw);
    expect(r.status).toBe(401); expect(r.body.code).toBe('INVALID_SIGNATURE');
    expect(calls(WH_EVENTS)[0][1][3]).toBe('rejected');
  });
  test('secret non configuré → 401 WEBHOOK_NOT_CONFIGURED (fail-closed)', async () => {
    delete process.env.WAVE_WEBHOOK_SECRET;
    standardDb(waveTxn());
    const raw = JSON.stringify(event);
    const r = await request(app).post('/webhooks/wave').set('Wave-Signature', waveSig('x', raw)).set('Content-Type', 'application/json').send(raw);
    expect(r.status).toBe(401); expect(r.body.code).toBe('WEBHOOK_NOT_CONFIGURED');
  });
  test('secret issu de la config provider (extra_params.webhookSecret)', async () => {
    delete process.env.WAVE_WEBHOOK_SECRET;
    mockGetConfig.mockImplementation(async (k) => (k === 'wave_sn' ? { webhookSecret: 'cfg-secret' } : {}));
    standardDb(waveTxn());
    const raw = JSON.stringify(event);
    const r = await request(app).post('/webhooks/wave').set('Wave-Signature', waveSig('cfg-secret', raw)).set('Content-Type', 'application/json').send(raw);
    expect(r.status).toBe(200); expect(r.body.status).toBe('authorized');
  });
  test('signature valide sur le corps brut → authorized + settlement', async () => {
    standardDb(waveTxn());
    const raw = JSON.stringify(event);
    const r = await request(app).post(`/api/v1/webhooks/${SECRET}/wave`).set('Wave-Signature', waveSig('wave-secret', raw)).set('Content-Type', 'application/json').send(raw);
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ applied: true, status: 'authorized' });
    expect(calls(UPDATE_TXN)[0][1][1]).toBe('T-WAVE-1');
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });
  test('plusieurs v1 : l’une valide suffit', async () => {
    standardDb(waveTxn());
    const raw = JSON.stringify(event); const ts = '1700000000';
    const good = crypto.createHmac('sha256', 'wave-secret').update(ts + raw).digest('hex');
    const r = await request(app).post('/webhooks/wave').set('Wave-Signature', `t=${ts},v1=${'0'.repeat(64)},v1=${good}`).set('Content-Type', 'application/json').send(raw);
    expect(r.status).toBe(200);
  });
  test('checkout échoué → failed', async () => {
    standardDb(waveTxn());
    const raw = JSON.stringify({ type: 'checkout.session.payment_failed', data: { id: 'cos-abc', client_reference: TXN, payment_status: 'failed', last_payment_error: { message: 'insufficient-funds' } } });
    const r = await request(app).post('/webhooks/wave').set('Wave-Signature', waveSig('wave-secret', raw)).set('Content-Type', 'application/json').send(raw);
    expect(r.status).toBe(200); expect(r.body.status).toBe('failed');
    expect(calls(UPDATE_TXN)[0][1][3]).toBe('insufficient-funds');
  });
  test('redirections navigateur success/error : page HTML, aucune requête DB', async () => {
    standardDb(waveTxn());
    const ok = await request(app).get(`/webhooks/wave/success/${TXN}`);
    expect(ok.status).toBe(200); expect(ok.headers['content-type']).toMatch(/html/); expect(ok.text).toMatch(/confirmation/);
    const ko = await request(app).get(`/webhooks/wave/error/${TXN}`);
    expect(ko.status).toBe(200); expect(ko.text).toMatch(/non abouti/);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('providers sans signature (Africell, Express Union, Free Money, Moov)', () => {
  const afTxn = () => pendingTxn({ gateway_name: 'africell_cd', gateway_payment_id: TXN, detected_operator: 'AFRICELL_MONEY', detected_country: 'CD', currency: 'CDF' });

  test('chemin legacy sans jeton configuré → 401 WEBHOOK_NOT_CONFIGURED', async () => {
    standardDb(afTxn());
    const r = await request(app).post(`/webhooks/africell/${TXN}`).send({ status: 'SUCCESS', transaction_id: 'AF-1' });
    expect(r.status).toBe(401); expect(r.body.code).toBe('WEBHOOK_NOT_CONFIGURED'); expect(calls(UPDATE_TXN)).toHaveLength(0);
  });
  test('chemin legacy avec X-Webhook-Token valide → authorized (référence prise dans le chemin)', async () => {
    process.env.AFRICELL_WEBHOOK_TOKEN = 'af-token';
    standardDb(afTxn());
    const r = await request(app).post(`/webhooks/africell/${TXN}`).set('X-Webhook-Token', 'af-token').send({ status: 'SUCCESS', transaction_id: 'AF-1', amount: 5000, currency: 'CDF' });
    expect(r.status).toBe(200); expect(r.body.status).toBe('authorized');
    expect(calls(SELECT_TXN)[0][1][0]).toBe(TXN);
  });
  test('jeton configuré mais invalide → 401 même sur le chemin secret', async () => {
    process.env.AFRICELL_WEBHOOK_TOKEN = 'af-token';
    standardDb(afTxn());
    const r = await request(app).post(`/api/v1/webhooks/${SECRET}/africell/${TXN}`).set('X-Webhook-Token', 'bad').send({ status: 'SUCCESS' });
    expect(r.status).toBe(401); expect(r.body.code).toBe('INVALID_WEBHOOK_TOKEN');
  });
  test('chemin secret sans jeton configuré → accepté (le segment secret authentifie)', async () => {
    standardDb(afTxn());
    const r = await request(app).post(`/api/v1/webhooks/${SECRET}/africell/${TXN}`).send({ status: 'SUCCESS', transaction_id: 'AF-1' });
    expect(r.status).toBe(200); expect(r.body.status).toBe('authorized');
  });
  test('Express Union / Free Money / Moov : extraction des références', async () => {
    for (const [p, body] of [
      ['express_union', { reference: TXN, status: 'CONFIRMED', transaction_id: 'EU-1' }],
      ['free_money',    { orderId: TXN, status: 'SUCCESS', transactionId: 'FM-1' }],
      ['moov',          { external_transaction_id: TXN, status: 'SUCCESS', transaction_id: 'MV-1' }],
    ]) {
      standardDb(pendingTxn({ gateway_name: `${p}_x`, gateway_payment_id: TXN }));
      const r = await request(app).post(`/api/v1/webhooks/${SECRET}/${p}`).send(body);
      expect([p, r.status, r.body.status]).toEqual([p, 200, 'authorized']);
      expect(calls(UPDATE_TXN)[0][1][1]).toBe(body.transaction_id || body.transactionId);
    }
  });

  describe('re-interrogation opérateur (getStatus)', () => {
    test('le statut opérateur prime sur le callback (FAILED malgré SUCCESS annoncé)', async () => {
      mockGetProvider.mockReturnValue({ getStatus: jest.fn().mockResolvedValue({ available: true, status: 'FAILED', reason: 'Rejected by operator' }) });
      standardDb(afTxn());
      const r = await request(app).post(`/api/v1/webhooks/${SECRET}/africell/${TXN}`).send({ status: 'SUCCESS' });
      expect(r.status).toBe(200); expect(r.body.status).toBe('failed');
      expect(mockGetProvider).toHaveBeenCalledWith('africell_cd');
      expect(mockEnqueue).not.toHaveBeenCalled();
    });
    test('opérateur injoignable → 202, transaction laissée pending', async () => {
      mockGetProvider.mockReturnValue({ getStatus: jest.fn().mockRejectedValue(new Error('timeout')) });
      standardDb(afTxn());
      const r = await request(app).post(`/api/v1/webhooks/${SECRET}/africell/${TXN}`).send({ status: 'SUCCESS' });
      expect(r.status).toBe(202); expect(r.body.code).toBe('PROVIDER_UNAVAILABLE'); expect(calls(UPDATE_TXN)).toHaveLength(0);
    });
    test('montant opérateur incohérent → 409', async () => {
      mockGetProvider.mockReturnValue({ getStatus: jest.fn().mockResolvedValue({ available: true, status: 'SUCCESSFUL', amount: 1, currency: 'CDF' }) });
      standardDb(afTxn());
      const r = await request(app).post(`/api/v1/webhooks/${SECRET}/africell/${TXN}`).send({ status: 'SUCCESS' });
      expect(r.status).toBe(409);
    });
    test('statusPath non configuré (available:false) → callback appliqué', async () => {
      mockGetProvider.mockReturnValue({ getStatus: jest.fn().mockResolvedValue({ available: false }) });
      standardDb(afTxn());
      const r = await request(app).post(`/api/v1/webhooks/${SECRET}/africell/${TXN}`).send({ status: 'SUCCESS' });
      expect(r.status).toBe(200); expect(r.body.status).toBe('authorized');
    });
  });

  test('payout autorisé : pas de mise en file de règlement', async () => {
    standardDb(pendingTxn({ type: 'payout', gateway_payment_id: TXN }));
    const r = await request(app).post(`/api/v1/webhooks/${SECRET}/moov`).send({ external_transaction_id: TXN, status: 'SUCCESS' });
    expect(r.status).toBe(200); expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
