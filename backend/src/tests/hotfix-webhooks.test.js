/**
 * Tests HOTFIX WAVE-1 — webhooks fail-closed
 *  - MTN : jamais de crédit sur le seul callback (re-query provider)
 *  - Airtel / CyberSource / Stripe : signature obligatoire (401 sans changement d'état)
 *  - rejeu d'un callback sur une transaction finalisée : ignoré (idempotent)
 *  - montant/devise incohérents : 409 sans changement
 */
'use strict';

const crypto = require('crypto');

jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/pci.middleware', () => ({ auditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../config/database', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
  pool: { query: jest.fn() },
}));
jest.mock('../services/rails/mtn-momo.client', () => ({
  getCollectionStatus:   jest.fn(),
  getDisbursementStatus: jest.fn(),
  requestToPay: jest.fn(), transfer: jest.fn(),
  getCollectionBalance: jest.fn(), getDisbursementBalance: jest.fn(), validateAccount: jest.fn(),
}));

const db  = require('../config/database');
const mtn = require('../services/rails/mtn-momo.client');

// ─── Helpers ──────────────────────────────────────────────────────

const mkRes = () => {
  const res = { statusCode: 200, body: null, text: null };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json   = jest.fn((b) => { res.body = b; return res; });
  res.send   = jest.fn((b) => { res.text = b; return res; });
  return res;
};
const mkReq = ({ body = {}, headers = {} } = {}) => ({ body, headers, ip: '127.0.0.1' });

const pendingTopup = (over = {}) => ({
  txn_id: 'TXN-1', card_id: 'CARD-1', cardholder_id: 'CH-1', type: 'topup',
  amount: '5000', fee: '50', net_amount: '4950', currency: 'XAF',
  status: 'pending', mm_reference: 'REF-1', metadata: { product: 'collections' },
  ...over,
});

/** Routeur SQL simple : première règle dont la regex matche la requête. */
const routeQueries = (rules) => {
  db.query.mockReset();
  db.query.mockImplementation(async (sql, params) => {
    for (const [re, handler] of rules) {
      if (re.test(sql)) return typeof handler === 'function' ? handler(sql, params) : handler;
    }
    return { rows: [], rowCount: 0 };
  });
};
const calls = (re) => db.query.mock.calls.filter(([sql]) => re.test(sql));

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.MTN_WEBHOOK_TOKEN;
  delete process.env.AIRTEL_WEBHOOK_SECRET;
  delete process.env.CYBERSOURCE_SHARED_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

const wh = require('../routes/webhook-handlers');

// ─── MTN ──────────────────────────────────────────────────────────

describe('MTN webhook — fail-closed, provider is the source of truth', () => {
  test('callback SUCCESSFUL sans confirmation provider (PENDING) → 202, aucun crédit', async () => {
    routeQueries([
      [/SELECT \* FROM card_transactions/i, { rows: [pendingTopup()], rowCount: 1 }],
    ]);
    mtn.getCollectionStatus.mockResolvedValue({ status: 'PENDING', amount: 5000, currency: 'XAF' });

    const res = mkRes();
    await wh.handleMtnWebhook(mkReq({ body: { referenceId: 'REF-1', status: 'SUCCESSFUL' } }), res);

    expect(res.statusCode).toBe(202);
    expect(calls(/UPDATE virtual_cards/i)).toHaveLength(0);
    expect(calls(/UPDATE card_transactions/i)).toHaveLength(0);
    expect(mtn.getCollectionStatus).toHaveBeenCalledWith('REF-1');
  });

  test('provider injoignable → 202, transaction laissée pending', async () => {
    routeQueries([[/SELECT \* FROM card_transactions/i, { rows: [pendingTopup()], rowCount: 1 }]]);
    mtn.getCollectionStatus.mockRejectedValue(new Error('ECONNRESET'));

    const res = mkRes();
    await wh.handleMtnWebhook(mkReq({ body: { referenceId: 'REF-1', status: 'SUCCESSFUL' } }), res);

    expect(res.statusCode).toBe(202);
    expect(res.body.code).toBe('PROVIDER_UNAVAILABLE');
    expect(calls(/UPDATE/i)).toHaveLength(0);
  });

  test('callback SUCCESSFUL mais provider FAILED → statut provider appliqué, pas de crédit', async () => {
    routeQueries([
      [/SELECT \* FROM card_transactions/i, { rows: [pendingTopup()], rowCount: 1 }],
      [/UPDATE card_transactions/i, { rows: [{ txn_id: 'TXN-1' }], rowCount: 1 }],
    ]);
    mtn.getCollectionStatus.mockResolvedValue({ status: 'FAILED', reason: 'PAYER_NOT_FOUND' });

    const res = mkRes();
    await wh.handleMtnWebhook(mkReq({ body: { referenceId: 'REF-1', status: 'SUCCESSFUL' } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.newStatus).toBe('failed');
    expect(calls(/UPDATE virtual_cards/i)).toHaveLength(0);
    const upd = calls(/UPDATE card_transactions/i);
    expect(upd).toHaveLength(1);
    expect(upd[0][0]).toMatch(/AND status='pending'/);
    expect(upd[0][1][0]).toBe('failed');
  });

  test('provider SUCCESSFUL + montant OK → claim pending puis crédit (une seule fois)', async () => {
    routeQueries([
      [/SELECT \* FROM card_transactions/i, { rows: [pendingTopup()], rowCount: 1 }],
      [/UPDATE card_transactions/i, { rows: [{ txn_id: 'TXN-1', card_id: 'CARD-1', type: 'topup', net_amount: '4950' }], rowCount: 1 }],
      [/UPDATE virtual_cards/i, { rows: [], rowCount: 1 }],
    ]);
    mtn.getCollectionStatus.mockResolvedValue({ status: 'SUCCESSFUL', financialTxnId: 'FT-1', amount: 5000, currency: 'XAF' });

    const res = mkRes();
    await wh.handleMtnWebhook(mkReq({ body: { referenceId: 'REF-1', status: 'SUCCESSFUL' } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.newStatus).toBe('completed');
    const upd = calls(/UPDATE card_transactions/i);
    expect(upd).toHaveLength(1);
    expect(upd[0][0]).toMatch(/AND status='pending'/);
    const credit = calls(/UPDATE virtual_cards/i);
    expect(credit).toHaveLength(1);
    expect(credit[0][1]).toEqual([4950, 'CARD-1']);
    // Le claim précède le crédit
    const order = db.query.mock.calls.map(([sql]) => sql);
    expect(order.findIndex(s => /UPDATE card_transactions/.test(s))).toBeLessThan(order.findIndex(s => /UPDATE virtual_cards/.test(s)));
  });

  test('claim perdu (rejeu concurrent) → pas de crédit', async () => {
    routeQueries([
      [/SELECT \* FROM card_transactions/i, { rows: [pendingTopup()], rowCount: 1 }],
      [/UPDATE card_transactions/i, { rows: [], rowCount: 0 }],
    ]);
    mtn.getCollectionStatus.mockResolvedValue({ status: 'SUCCESSFUL', amount: 5000, currency: 'XAF' });
    const res = mkRes();
    await wh.handleMtnWebhook(mkReq({ body: { referenceId: 'REF-1', status: 'SUCCESSFUL' } }), res);
    expect(calls(/UPDATE virtual_cards/i)).toHaveLength(0);
    expect(res.body.applied).toBe(false);
  });

  test('provider SUCCESSFUL mais montant différent → 409 sans changement', async () => {
    routeQueries([[/SELECT \* FROM card_transactions/i, { rows: [pendingTopup()], rowCount: 1 }]]);
    mtn.getCollectionStatus.mockResolvedValue({ status: 'SUCCESSFUL', amount: 100, currency: 'XAF' });

    const res = mkRes();
    await wh.handleMtnWebhook(mkReq({ body: { referenceId: 'REF-1', status: 'SUCCESSFUL' } }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('AMOUNT_MISMATCH');
    expect(calls(/UPDATE/i)).toHaveLength(0);
  });

  test('callback portant une devise différente → 409 avant même l\'appel provider', async () => {
    routeQueries([[/SELECT \* FROM card_transactions/i, { rows: [pendingTopup()], rowCount: 1 }]]);
    const res = mkRes();
    await wh.handleMtnWebhook(mkReq({ body: { referenceId: 'REF-1', status: 'SUCCESSFUL', amount: '5000', currency: 'EUR' } }), res);
    expect(res.statusCode).toBe(409);
    expect(mtn.getCollectionStatus).not.toHaveBeenCalled();
    expect(calls(/UPDATE/i)).toHaveLength(0);
  });

  test('rejeu sur une transaction déjà completed → ignoré, aucun UPDATE', async () => {
    routeQueries([[/SELECT \* FROM card_transactions/i, { rows: [pendingTopup({ status: 'completed' })], rowCount: 1 }]]);
    const res = mkRes();
    await wh.handleMtnWebhook(mkReq({ body: { referenceId: 'REF-1', status: 'FAILED' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.outcome).toBe('already_processed');
    expect(mtn.getCollectionStatus).not.toHaveBeenCalled();
    expect(calls(/UPDATE/i)).toHaveLength(0);
  });

  test('MTN_WEBHOOK_TOKEN configuré : en-tête absent → 401, mauvais jeton → 401, bon jeton → traité', async () => {
    process.env.MTN_WEBHOOK_TOKEN = 'secret-token';
    routeQueries([[/SELECT \* FROM card_transactions/i, { rows: [], rowCount: 0 }]]);

    let res = mkRes();
    await wh.handleMtnWebhook(mkReq({ body: { referenceId: 'REF-1', status: 'SUCCESSFUL' } }), res);
    expect(res.statusCode).toBe(401);

    res = mkRes();
    await wh.handleMtnWebhook(mkReq({ body: { referenceId: 'REF-1', status: 'SUCCESSFUL' }, headers: { 'x-webhook-token': 'secret-tokeN' } }), res);
    expect(res.statusCode).toBe(401);

    res = mkRes();
    await wh.handleMtnWebhook(mkReq({ body: { referenceId: 'REF-1', status: 'SUCCESSFUL' }, headers: { 'x-webhook-token': 'secret-token' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.outcome).toBe('unknown_reference');
    expect(calls(/UPDATE/i)).toHaveLength(0);
  });

  test('unload (disbursement) FAILED confirmé par MTN → remboursement de la carte', async () => {
    routeQueries([
      [/SELECT \* FROM card_transactions/i, { rows: [pendingTopup({ type: 'unload', metadata: { product: 'disbursements' } })], rowCount: 1 }],
      [/UPDATE card_transactions/i, { rows: [{ txn_id: 'TXN-1' }], rowCount: 1 }],
      [/UPDATE virtual_cards/i, { rows: [], rowCount: 1 }],
    ]);
    mtn.getDisbursementStatus.mockResolvedValue({ status: 'FAILED', reason: 'LIMIT' });
    const res = mkRes();
    await wh.handleMtnWebhook(mkReq({ body: { referenceId: 'REF-1', status: 'FAILED' } }), res);
    expect(mtn.getDisbursementStatus).toHaveBeenCalledWith('REF-1');
    const credit = calls(/UPDATE virtual_cards/i);
    expect(credit).toHaveLength(1);
    expect(credit[0][1]).toEqual([5050, 'CARD-1']);
  });

  test('card2momo : jambe MoMo FAILED → needs_refund (carte déjà débitée), pas failed', async () => {
    routeQueries([
      [/SELECT \* FROM card_transactions/i, { rows: [pendingTopup({ type: 'card2momo', amount: '10000', net_amount: '9800', metadata: { leg2: { mtnRef: 'REF-1' } } })], rowCount: 1 }],
      [/UPDATE card_transactions/i, { rows: [{ txn_id: 'TXN-1' }], rowCount: 1 }],
    ]);
    mtn.getDisbursementStatus.mockResolvedValue({ status: 'FAILED', reason: 'PAYEE_NOT_FOUND' });
    const res = mkRes();
    await wh.handleMtnWebhook(mkReq({ body: { referenceId: 'REF-1', status: 'FAILED' } }), res);
    expect(res.body.newStatus).toBe('needs_refund');
    const upd = calls(/UPDATE card_transactions/i);
    expect(upd[0][1][0]).toBe('needs_refund');
    expect(calls(/UPDATE virtual_cards/i)).toHaveLength(0);
  });
});

// ─── AIRTEL ───────────────────────────────────────────────────────

describe('Airtel webhook — signature obligatoire', () => {
  const body = { transaction: { id: 'REF-A', status: 'TS', airtel_money_id: 'AM-1' } };
  const sign = (secret, b) => crypto.createHmac('sha256', secret).update(JSON.stringify(b)).digest('hex');

  test('secret non configuré → 401, aucun accès DB', async () => {
    routeQueries([]);
    const res = mkRes();
    await wh.handleAirtelWebhook(mkReq({ body, headers: { 'x-airtel-signature': 'abc' } }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('WEBHOOK_NOT_CONFIGURED');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('en-tête absent → 401 sans changement d\'état', async () => {
    process.env.AIRTEL_WEBHOOK_SECRET = 's3cret';
    routeQueries([]);
    const res = mkRes();
    await wh.handleAirtelWebhook(mkReq({ body }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('MISSING_SIGNATURE');
    expect(db.query).not.toHaveBeenCalled();
  });

  test('signature invalide → 401', async () => {
    process.env.AIRTEL_WEBHOOK_SECRET = 's3cret';
    routeQueries([]);
    const res = mkRes();
    await wh.handleAirtelWebhook(mkReq({ body, headers: { 'x-airtel-signature': sign('wrong', body) } }), res);
    expect(res.statusCode).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('signature valide + TS → completed avec claim pending', async () => {
    process.env.AIRTEL_WEBHOOK_SECRET = 's3cret';
    routeQueries([
      [/SELECT \* FROM card_transactions/i, { rows: [pendingTopup({ mm_reference: 'REF-A' })], rowCount: 1 }],
      [/UPDATE card_transactions/i, { rows: [{ txn_id: 'TXN-1' }], rowCount: 1 }],
      [/UPDATE virtual_cards/i, { rows: [], rowCount: 1 }],
    ]);
    const res = mkRes();
    await wh.handleAirtelWebhook(mkReq({ body, headers: { 'x-airtel-signature': sign('s3cret', body) } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.newStatus).toBe('completed');
    expect(calls(/UPDATE card_transactions/i)[0][0]).toMatch(/AND status='pending'/);
    expect(calls(/UPDATE virtual_cards/i)).toHaveLength(1);
  });

  test('rejeu sur transaction completed → ignoré (pas de régression vers failed)', async () => {
    process.env.AIRTEL_WEBHOOK_SECRET = 's3cret';
    const replay = { transaction: { id: 'REF-A', status: 'TF', message: 'late failure' } };
    routeQueries([[/SELECT \* FROM card_transactions/i, { rows: [pendingTopup({ status: 'completed', mm_reference: 'REF-A' })], rowCount: 1 }]]);
    const res = mkRes();
    await wh.handleAirtelWebhook(mkReq({ body: replay, headers: { 'x-airtel-signature': sign('s3cret', replay) } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.outcome).toBe('already_processed');
    expect(calls(/UPDATE/i)).toHaveLength(0);
  });

  test('montant du callback différent → 409 sans changement', async () => {
    process.env.AIRTEL_WEBHOOK_SECRET = 's3cret';
    const b = { transaction: { id: 'REF-A', status: 'TS', amount: 9999, currency: 'XAF' } };
    routeQueries([[/SELECT \* FROM card_transactions/i, { rows: [pendingTopup({ mm_reference: 'REF-A' })], rowCount: 1 }]]);
    const res = mkRes();
    await wh.handleAirtelWebhook(mkReq({ body: b, headers: { 'x-airtel-signature': sign('s3cret', b) } }), res);
    expect(res.statusCode).toBe(409);
    expect(calls(/UPDATE/i)).toHaveLength(0);
  });

  test('TIP (en cours) → 202 et rien ne change', async () => {
    process.env.AIRTEL_WEBHOOK_SECRET = 's3cret';
    const b = { transaction: { id: 'REF-A', status: 'TIP' } };
    routeQueries([[/SELECT \* FROM card_transactions/i, { rows: [pendingTopup({ mm_reference: 'REF-A' })], rowCount: 1 }]]);
    const res = mkRes();
    await wh.handleAirtelWebhook(mkReq({ body: b, headers: { 'x-airtel-signature': sign('s3cret', b) } }), res);
    expect(res.statusCode).toBe(202);
    expect(calls(/UPDATE/i)).toHaveLength(0);
  });

  test('transaction marchand (orchestrateur) TS → authorized gardé par status=pending + transaction_events', async () => {
    process.env.AIRTEL_WEBHOOK_SECRET = 's3cret';
    routeQueries([
      [/SELECT \* FROM card_transactions/i, { rows: [], rowCount: 0 }],
      [/FROM transactions WHERE gateway_payment_id/i, { rows: [{ transaction_id: 'T-1', merchant_id: 'M-1', amount: '5000', currency: 'XAF', status: 'pending', type: 'collect' }], rowCount: 1 }],
      [/UPDATE transactions/i, { rows: [{ transaction_id: 'T-1', merchant_id: 'M-1' }], rowCount: 1 }],
      [/INSERT INTO transaction_events/i, { rows: [], rowCount: 1 }],
    ]);
    const res = mkRes();
    await wh.handleAirtelWebhook(mkReq({ body, headers: { 'x-airtel-signature': sign('s3cret', body) } }), res);
    expect(res.statusCode).toBe(200);
    const upd = calls(/UPDATE transactions/i);
    expect(upd).toHaveLength(1);
    expect(upd[0][0]).toMatch(/AND status='pending'/);
    expect(upd[0][1][0]).toBe('authorized');
    expect(calls(/INSERT INTO transaction_events/i)).toHaveLength(1);
  });
});

// ─── CYBERSOURCE / MIGS ───────────────────────────────────────────

describe('CyberSource webhook — signature obligatoire, pas de régression', () => {
  const csBody = (code, amount = '5000', currency = 'XAF') => ({
    id: 'EVT-1', type: 'payments.payments.updated',
    data: { object: {
      id: 'CS-1',
      clientReferenceInformation: { code: 'ORDER-1' },
      applicationInformation: { reasonCode: code },
      processorInformation: { approvalCode: 'A1' },
      orderInformation: { amountDetails: { totalAmount: amount, currency } },
    } },
  });
  const sign = (secret, b) => crypto.createHmac('sha256', secret).update(JSON.stringify(b)).digest('base64');

  test('secret absent → 401 ; en-tête absent → 401', async () => {
    routeQueries([]);
    let res = mkRes();
    await wh.handleCyberSourceWebhook(mkReq({ body: csBody('100'), headers: { 'v-c-signature': 'x' } }), res);
    expect(res.statusCode).toBe(401);

    process.env.CYBERSOURCE_SHARED_SECRET = 'cs-secret';
    res = mkRes();
    await wh.handleCyberSourceWebhook(mkReq({ body: csBody('100') }), res);
    expect(res.statusCode).toBe(401);
    expect(calls(/UPDATE/i)).toHaveLength(0);
  });

  test('callback rejoué sur une transaction déjà authorized → ignoré', async () => {
    process.env.CYBERSOURCE_SHARED_SECRET = 'cs-secret';
    const b = csBody('100');
    routeQueries([
      [/FROM transactions/i, { rows: [{ transaction_id: 'T-1', merchant_id: 'M-1', amount: '5000', currency: 'XAF', status: 'authorized' }], rowCount: 1 }],
    ]);
    const res = mkRes();
    await wh.handleCyberSourceWebhook(mkReq({ body: b, headers: { 'v-c-signature': sign('cs-secret', b) } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.outcome).toBe('already_processed');
    expect(calls(/UPDATE/i)).toHaveLength(0);
  });

  test('callback "failed" rejoué sur une transaction authorized → ne régresse pas', async () => {
    process.env.CYBERSOURCE_SHARED_SECRET = 'cs-secret';
    const b = csBody('481');
    routeQueries([
      [/FROM transactions/i, { rows: [{ transaction_id: 'T-1', merchant_id: 'M-1', amount: '5000', currency: 'XAF', status: 'authorized' }], rowCount: 1 }],
    ]);
    const res = mkRes();
    await wh.handleCyberSourceWebhook(mkReq({ body: b, headers: { 'v-c-signature': sign('cs-secret', b) } }), res);
    expect(calls(/UPDATE/i)).toHaveLength(0);
  });

  test('montant différent → 409 sans changement', async () => {
    process.env.CYBERSOURCE_SHARED_SECRET = 'cs-secret';
    const b = csBody('100', '1');
    routeQueries([
      [/FROM transactions/i, { rows: [{ transaction_id: 'T-1', merchant_id: 'M-1', amount: '5000', currency: 'XAF', status: 'pending' }], rowCount: 1 }],
    ]);
    const res = mkRes();
    await wh.handleCyberSourceWebhook(mkReq({ body: b, headers: { 'v-c-signature': sign('cs-secret', b) } }), res);
    expect(res.statusCode).toBe(409);
    expect(calls(/UPDATE/i)).toHaveLength(0);
  });

  test('signature valide, pending, montant OK → authorized gardé + transaction_events', async () => {
    process.env.CYBERSOURCE_SHARED_SECRET = 'cs-secret';
    const b = csBody('100');
    routeQueries([
      [/UPDATE transactions/i, { rows: [{ transaction_id: 'T-1', merchant_id: 'M-1' }], rowCount: 1 }],
      [/INSERT INTO transaction_events/i, { rows: [], rowCount: 1 }],
      [/UPDATE pay_links/i, { rows: [], rowCount: 0 }],
      [/JOIN merchants/i, { rows: [], rowCount: 0 }],
      [/FROM transactions/i, { rows: [{ transaction_id: 'T-1', merchant_id: 'M-1', amount: '5000', currency: 'XAF', status: 'pending' }], rowCount: 1 }],
    ]);
    const res = mkRes();
    await wh.handleCyberSourceWebhook(mkReq({ body: b, headers: { 'v-c-signature': sign('cs-secret', b) } }), res);
    expect(res.statusCode).toBe(200);
    const upd = calls(/UPDATE transactions/i);
    expect(upd).toHaveLength(1);
    expect(upd[0][0]).toMatch(/AND status='pending'/);
    expect(upd[0][1][0]).toBe('authorized');
    expect(calls(/INSERT INTO transaction_events/i)).toHaveLength(1);
  });
});

describe('MIGS webhook — signature obligatoire', () => {
  test('secret absent → 401 ; hash absent → 401', async () => {
    routeQueries([]);
    let res = mkRes();
    await wh.handleMigsWebhook(mkReq({ body: { vpc_MerchTxnRef: 'O-1', vpc_TxnResponseCode: '0', vpc_SecureHash: 'AB' } }), res);
    expect(res.statusCode).toBe(401);
    process.env.MIGS_SECURE_HASH = 'ab'.repeat(32);
    res = mkRes();
    await wh.handleMigsWebhook(mkReq({ body: { vpc_MerchTxnRef: 'O-1', vpc_TxnResponseCode: '0' } }), res);
    expect(res.statusCode).toBe(401);
    expect(calls(/UPDATE/i)).toHaveLength(0);
    delete process.env.MIGS_SECURE_HASH;
  });
});

// ─── STRIPE (card2momo.routes /webhooks/psp/stripe) ───────────────

describe('Stripe webhook (/webhooks/psp/stripe) — signature obligatoire', () => {
  jest.mock('../services/psp/psp.router', () => ({ chargeCard: jest.fn(), refundCard: jest.fn(), calculateFees: jest.fn() }));
  const express   = require('express');
  const supertest = require('supertest');
  const app = express();
  app.use(express.json());
  app.use('/api/v1', require('../routes/card2momo.routes'));

  const evt = (type, over = {}) => ({ type, data: { object: { id: 'pi_1', amount: 5000, currency: 'xaf', metadata: { cplus_txn: 'TXN-S' }, ...over } } });
  const sigHeader = (secret, payload, t = Math.floor(Date.now() / 1000)) =>
    `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;

  test('secret non configuré → 401 sans UPDATE', async () => {
    routeQueries([]);
    const r = await supertest(app).post('/api/v1/webhooks/psp/stripe').send(evt('payment_intent.succeeded'));
    expect(r.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('en-tête absent → 401 ; signature fausse → 401', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    routeQueries([]);
    let r = await supertest(app).post('/api/v1/webhooks/psp/stripe').send(evt('payment_intent.succeeded'));
    expect(r.status).toBe(401);
    r = await supertest(app).post('/api/v1/webhooks/psp/stripe')
      .set('stripe-signature', sigHeader('bad', JSON.stringify(evt('payment_intent.succeeded'))))
      .send(evt('payment_intent.succeeded'));
    expect(r.status).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('signature valide + montant OK → completed gardé par status=pending', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    routeQueries([
      [/SELECT \* FROM card_transactions WHERE txn_id/i, { rows: [{ txn_id: 'TXN-S', status: 'pending', amount: '5000', currency: 'XAF' }], rowCount: 1 }],
      [/UPDATE card_transactions/i, { rows: [{ txn_id: 'TXN-S' }], rowCount: 1 }],
    ]);
    const body = evt('payment_intent.succeeded');
    const payload = JSON.stringify(body);
    const r = await supertest(app).post('/api/v1/webhooks/psp/stripe')
      .set('stripe-signature', sigHeader('whsec_test', payload))
      .set('content-type', 'application/json')
      .send(payload);
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(true);
    const upd = calls(/UPDATE card_transactions/i);
    expect(upd).toHaveLength(1);
    expect(upd[0][0]).toMatch(/AND status='pending'/);
  });

  test('signature valide mais montant différent → 409 sans UPDATE', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    routeQueries([
      [/SELECT \* FROM card_transactions WHERE txn_id/i, { rows: [{ txn_id: 'TXN-S', status: 'pending', amount: '5000', currency: 'XAF' }], rowCount: 1 }],
    ]);
    const body = evt('payment_intent.succeeded', { amount: 100 });
    const payload = JSON.stringify(body);
    const r = await supertest(app).post('/api/v1/webhooks/psp/stripe')
      .set('stripe-signature', sigHeader('whsec_test', payload))
      .set('content-type', 'application/json')
      .send(payload);
    expect(r.status).toBe(409);
    expect(calls(/UPDATE/i)).toHaveLength(0);
  });

  test('rejeu sur transaction completed → ignoré', async () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
    routeQueries([
      [/SELECT \* FROM card_transactions WHERE txn_id/i, { rows: [{ txn_id: 'TXN-S', status: 'completed', amount: '5000', currency: 'XAF' }], rowCount: 1 }],
    ]);
    const body = evt('payment_intent.payment_failed');
    const payload = JSON.stringify(body);
    const r = await supertest(app).post('/api/v1/webhooks/psp/stripe')
      .set('stripe-signature', sigHeader('whsec_test', payload))
      .set('content-type', 'application/json')
      .send(payload);
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('already_processed');
    expect(calls(/UPDATE/i)).toHaveLength(0);
  });
});

// ─── Helpers purs ─────────────────────────────────────────────────

describe('helpers', () => {
  test('timingSafeEqualStr : longueurs différentes → false, égales → true', () => {
    expect(wh.timingSafeEqualStr('abc', 'abcd')).toBe(false);
    expect(wh.timingSafeEqualStr('abc', 'abc')).toBe(true);
    expect(wh.timingSafeEqualStr('', '')).toBe(false);
  });
  test('checkAmountCurrency ignore les valeurs absentes, détecte montant et devise', () => {
    expect(wh.checkAmountCurrency({ expectedAmount: 5000, expectedCurrency: 'XAF' })).toBeNull();
    expect(wh.checkAmountCurrency({ expectedAmount: 5000, expectedCurrency: 'XAF', amount: '5000', currency: 'xaf' })).toBeNull();
    expect(wh.checkAmountCurrency({ expectedAmount: 5000, expectedCurrency: 'XAF', amount: 4999 })).toMatchObject({ field: 'amount' });
    expect(wh.checkAmountCurrency({ expectedAmount: 5000, expectedCurrency: 'XAF', currency: 'XOF' })).toMatchObject({ field: 'currency' });
  });
  test('minorToMajor : XAF sans décimales, USD en centimes', () => {
    expect(wh.minorToMajor(5000, 'XAF')).toBe(5000);
    expect(wh.minorToMajor(5000, 'USD')).toBe(50);
  });
});
