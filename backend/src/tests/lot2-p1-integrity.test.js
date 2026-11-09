'use strict';
// Lot 2 de l'audit du 2026-11-02 (P1 intégrité et sécurité) — services réels + SQL PostgreSQL (PGlite) ;
// frontières simulées : HTTPS opérateurs, e-mail, audit PCI, routeur MM (là où indiqué).
//   P1-1  réponses 5xx / illisibles des providers → `unknown` (fonds réservés), jamais « refus »
//   P1-2  webhook Airtel marchand → enquiry puis finalize.service (frais, règlement, événement)
//   P1-3  /momo/payout, /requesttopay, /accountbalance retirés ; /status filtré par porteur ; montant typé
//   P1-5  règlements admin via cash.transitionTransfer (événement, audit)
//   Portails P1-1 (défense en profondeur) : jeton `pwdTemp` → 403 PASSWORD_CHANGE_REQUIRED hors changement
const crypto = require('crypto');
const EventEmitter = require('events');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { PGlite } = require('@electric-sql/pglite');

let mockPg;
const sql = async (...args) => { const r = await mockPg.query(...args); return { ...r, rowCount: r.affectedRows ?? r.rows.length }; };
jest.mock('../config/database', () => ({
  query: (...args) => sql(...args),
  withTransaction: fn => mockPg.transaction(tx => fn({ query: async (...args) => { const r = await tx.query(...args); return { ...r, rowCount: r.affectedRows ?? r.rows.length }; } })),
  pool: { query: (...args) => sql(...args) },
}));
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockAudit = jest.fn().mockResolvedValue(undefined);
jest.mock('../middleware/pci.middleware', () => ({ auditLog: (...a) => mockAudit(...a) }));
jest.mock('../services/notifications/email.service', () => ({ send: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('https', () => ({ request: jest.fn() }));
const mockAirtelQuery = jest.fn();
jest.mock('../services/mobilemoney/providers/airtel.provider', () => {
  const real = jest.requireActual('../services/mobilemoney/providers/airtel.provider');
  return { ...real, queryTransaction: (...a) => mockAirtelQuery(...a) };
});
jest.mock('../services/rails/mtn-momo.client', () => ({
  CONFIG: { disbursements: {}, collections: {} },
  transfer: jest.fn(), requestToPay: jest.fn(), getCollectionStatus: jest.fn(), getDisbursementStatus: jest.fn(),
  getCollectionBalance: jest.fn(), getDisbursementBalance: jest.fn(), validateAccount: jest.fn(),
}));

const https = require('https');
const cash = require('../services/cash/cash.service');
const mmRouter = require('../services/mobilemoney/mobilemoney.router');
const mtnProvider = require('../services/mobilemoney/providers/mtn.provider');
const airtelProvider = jest.requireActual('../services/mobilemoney/providers/airtel.provider');
const wh = require('../routes/webhook-handlers');
const auth = require('../middleware/auth');

const M = '11111111-1111-4111-8111-111111111111';
const CH = '22222222-2222-4222-8222-222222222222';
const uuid = () => crypto.randomUUID();
const first = async (...a) => (await sql(...a)).rows[0];

// Réponses HTTPS simulées, dans l'ordre des appels (jeton puis ordre)
const httpsQueue = (responses) => {
  https.request.mockReset();
  https.request.mockImplementation((opts, cb) => {
    const { statusCode, body } = responses.shift() || { statusCode: 500, body: '' };
    const res = new EventEmitter(); res.statusCode = statusCode;
    process.nextTick(() => { cb(res); if (body) res.emit('data', body); res.emit('end'); });
    return { on: () => {}, write: () => {}, end: () => {}, destroy: () => {} };
  });
};

beforeAll(async () => {
  mockPg = new PGlite();
  await mockPg.exec(`
    CREATE TABLE merchants(merchant_id uuid PRIMARY KEY, country text, currency text DEFAULT 'XAF', business_name text, email text,
      merchant_status text DEFAULT 'active', kyb_level int DEFAULT 2, cash_wallet_operator text, cash_wallet_phone text, cash_wallet_verified_at timestamptz, updated_at timestamptz);
    CREATE TABLE financial_institutions(institution_id uuid PRIMARY KEY, name text);
    CREATE TABLE bank_accounts(account_id uuid PRIMARY KEY, institution_id uuid, account_number text, account_name text, owner_id uuid, status text DEFAULT 'verified');
    CREATE TABLE merchant_transfers(transfer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid, direction text DEFAULT 'payout', dest_type text DEFAULT 'wallet',
      bank_account_id uuid, wallet_operator text, wallet_phone text, status text DEFAULT 'pending', amount numeric, fee numeric, net_amount numeric, currency text DEFAULT 'XAF',
      reference text, description text, created_at timestamptz DEFAULT NOW(), updated_at timestamptz, completed_at timestamptz, cancelled_at timestamptz, settled_at timestamptz,
      events jsonb DEFAULT '[]', gateway_reference text, bank_reference text, settlement_ref text, settlement_method text, error_message text, executed_by uuid, settled_by uuid,
      admin_note text, amount_requested numeric, request_payload jsonb, unknown_since timestamptz, needs_review boolean DEFAULT false, last_status_check_at timestamptz, review_alerted_at timestamptz);
    CREATE TABLE transactions(transaction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid, type text DEFAULT 'collect', amount numeric DEFAULT 10000, currency text DEFAULT 'XAF',
      detected_operator text, detected_country text, gateway_name text, gateway_payment_id text, gateway_order_id text, pay_link_id uuid, status text DEFAULT 'pending',
      initiated_at timestamptz DEFAULT NOW() - INTERVAL '1 hour', response_message text, response_code text, auth_code text, fee_amount numeric DEFAULT 0, net_amount numeric DEFAULT 0,
      completed_at timestamptz, settlement_batch_id uuid, settlement_status text, payment_method text DEFAULT 'mobile_money', description text, device_id text, provider_raw_response text);
    CREATE TABLE transaction_events(event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), transaction_id uuid, merchant_id uuid, event_type text, payload jsonb, created_at timestamptz DEFAULT NOW());
    CREATE TABLE settlement_batches(merchant_id uuid, currency text, total_net numeric);
    CREATE TABLE settlement_queue(id serial PRIMARY KEY, transaction_id uuid UNIQUE, merchant_id uuid, amount numeric, currency text, queued_at timestamptz DEFAULT NOW(), settled boolean DEFAULT false);
    CREATE TABLE pay_links(pay_link_id uuid PRIMARY KEY, status text, paid_at timestamptz, paid_amount numeric);
    CREATE TABLE card_transactions(txn_id text, card_id text, cardholder_id text, mm_reference text, metadata jsonb, status text, initiated_at timestamptz DEFAULT NOW());
    CREATE TABLE webhook_events(id serial PRIMARY KEY, provider text, reference_id text, provider_status text, outcome text, payload jsonb, ip_address text, created_at timestamptz DEFAULT NOW());
    CREATE TABLE api_configurations(provider_key text, provider_type text, base_url text, api_key text, api_secret text, extra_params jsonb);
    CREATE FUNCTION cpay_calculate_fee(uuid,text,text,numeric,text) RETURNS numeric LANGUAGE SQL AS $$
      SELECT round($4 * CASE WHEN $2='payout' THEN 0.01 ELSE 0.015 END) $$;
  `);
}, 60000);
afterAll(async () => { await mockPg.close(); });
beforeEach(async () => {
  jest.clearAllMocks();
  mockAirtelQuery.mockReset();
  delete process.env.AIRTEL_WEBHOOK_SECRET; delete process.env.AIRTEL_CG_WEBHOOK_SECRET;
  await mockPg.exec('TRUNCATE merchants, merchant_transfers, transactions, transaction_events, settlement_batches, settlement_queue, pay_links, card_transactions, webhook_events, api_configurations, bank_accounts, financial_institutions');
  await sql(`INSERT INTO merchants(merchant_id,country,currency,business_name,email) VALUES($1,'CG','XAF','Boutique Pilote','ops@example.test')`, [M]);
  await sql(`INSERT INTO transactions(merchant_id,type,amount,status,detected_operator,fee_amount,net_amount) VALUES($1,'collect',100000,'authorized','MTN_MOMO',1500,98500)`, [M]);
});

// ───────────────────────────── P1-1 — classification des résultats rail ─────────────────────────────
describe('classifyRailResult / normalize : une erreur HTTP 5xx n’est jamais un refus', () => {
  test.each([
    [{ responseCode: '503', retryable: false }, 'unknown'],
    [{ responseCode: '502', declineReason: 'Bad Gateway' }, 'unknown'],
    [{ responseCode: '05', httpStatus: 500 }, 'unknown'],
    [{ responseCode: 'TIMEOUT' }, 'unknown'],
    [{ responseCode: 'UNPARSABLE' }, 'unknown'],
    [{ outcome: 'unknown', responseCode: '05' }, 'unknown'],
    [{ responseCode: '05', declineReason: 'Solde insuffisant' }, 'declined'],
    [{ responseCode: '400', declineReason: 'PAYEE_NOT_FOUND' }, 'declined'],
    [{ approved: true }, 'completed'],
    [{ pending: true }, 'accepted'],
  ])('%j → %s', (res, expected) => { expect(cash.classifyRailResult(res)).toBe(expected); });

  test('normalize propage outcome et httpStatus du provider', () => {
    const n = mmRouter.normalize({ success: false, pending: false, outcome: 'unknown', httpStatus: 503, responseCode: '503', errorMessage: 'MTN indisponible' }, 'MTN_MOMO', 'mtn_cg');
    expect(n).toMatchObject({ approved: false, pending: false, outcome: 'unknown', httpStatus: 503, responseCode: '503' });
    expect(cash.classifyRailResult(n)).toBe('unknown');
    expect(cash.classifyRailResult(mmRouter.normalize({ success: false, responseCode: '05', errorMessage: 'refus' }, 'MTN_MOMO', 'mtn_cg'))).toBe('declined');
  });
});

describe('providers : HTTP 5xx ou corps illisible → outcome unknown', () => {
  const cfg = { baseUrl: 'https://mtn.invalid', apiKey: 'user', apiSecret: 'key', subscriptionKey: 'sub', targetEnvironment: 'mtncongo' };
  test('mtn.provider.sendPayout : 503 après l’ordre → unknown (pas de refus) ; 400 → refus', async () => {
    httpsQueue([{ statusCode: 200, body: JSON.stringify({ access_token: 't', expires_in: 3600 }) }, { statusCode: 503, body: '<html>Service Unavailable</html>' }]);
    const r = await mtnProvider.sendPayout({ txnId: uuid(), amount: 1000, currency: 'XAF', phone: '+242066000001', config: { ...cfg, apiKey: `u${Date.now()}` } });
    expect(r).toMatchObject({ success: false, pending: false, outcome: 'unknown', httpStatus: 503, responseCode: '503' });
    expect(cash.classifyRailResult(mmRouter.normalize(r, 'MTN_MOMO', 'mtn_cg'))).toBe('unknown');

    httpsQueue([{ statusCode: 200, body: JSON.stringify({ access_token: 't', expires_in: 3600 }) }, { statusCode: 400, body: JSON.stringify({ code: 'PAYEE_NOT_FOUND' }) }]);
    const d = await mtnProvider.sendPayout({ txnId: uuid(), amount: 1000, currency: 'XAF', phone: '+242066000001', config: { ...cfg, apiKey: `v${Date.now()}` } });
    expect(d).toMatchObject({ success: false, responseCode: '400' });
    expect(d.outcome).toBeUndefined();
    expect(cash.classifyRailResult(mmRouter.normalize(d, 'MTN_MOMO', 'mtn_cg'))).toBe('declined');
  });
  test('airtel.provider.sendPayout : page d’erreur HTML d’un proxy (502) → unknown ; collectPayment 5xx → pending + unknown', async () => {
    const acfg = { baseUrl: 'https://airtel.invalid', apiKey: 'id', apiSecret: 's&cret+', pin: null };
    httpsQueue([{ statusCode: 200, body: JSON.stringify({ access_token: 'tok' }) }, { statusCode: 502, body: '<html><body>502 Bad Gateway</body></html>' }]);
    const r = await airtelProvider.sendPayout({ txnId: uuid(), amount: 1000, currency: 'XAF', phone: '+242056000001', config: acfg });
    expect(r).toMatchObject({ success: false, pending: false, outcome: 'unknown', httpStatus: 502 });
    expect(cash.classifyRailResult(mmRouter.normalize(r, 'AIRTEL_MONEY', 'airtel_cg'))).toBe('unknown');
    httpsQueue([{ statusCode: 200, body: JSON.stringify({ access_token: 'tok' }) }, { statusCode: 500, body: JSON.stringify({ status: { success: false, message: 'Internal error' } }) }]);
    const c = await airtelProvider.collectPayment({ txnId: uuid(), amount: 1000, currency: 'XAF', phone: '+242056000001', config: acfg });
    expect(c).toMatchObject({ success: false, pending: true, outcome: 'unknown', httpStatus: 500 });
  });
  test('le secret Airtel est encodé dans la requête de jeton', async () => {
    let captured = null;
    https.request.mockReset();
    https.request.mockImplementation((opts, cb) => {
      const res = new EventEmitter(); res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit('data', JSON.stringify({ access_token: 'tok' })); res.emit('end'); });
      return { on: () => {}, write: (p) => { captured = captured || p; }, end: () => {}, destroy: () => {} };
    });
    await airtelProvider.sendPayout({ txnId: uuid(), amount: 1000, currency: 'XAF', phone: '+242056000001', config: { baseUrl: 'https://airtel.invalid', apiKey: 'id', apiSecret: 's&cret+=' } }).catch(() => {});
    expect(captured).toContain('client_secret=s%26cret%2B%3D');
  });
});

describe('cash.createPayout via le routeur MM : 5xx → unknown, réservation conservée', () => {
  test('un 503 normalisé ne libère pas les fonds', async () => {
    const rail = { available: true, kind: 'mm_router', gateway: 'airtel_cg', operatorLabel: 'Airtel Money' };
    const wallet = { operator: 'airtel_money', phone: '+242056000001', gateway: 'airtel_cg', country: 'CG' };
    const spy = jest.spyOn(mmRouter, 'sendPayout').mockResolvedValue(mmRouter.normalize({ success: false, pending: false, outcome: 'unknown', httpStatus: 503, responseCode: '503', errorMessage: 'Airtel indisponible' }, 'AIRTEL_MONEY', 'airtel_cg'));
    const r = await cash.createPayout({ merchantId: M, destType: 'wallet', wallet, rail, amount: 10000 });
    spy.mockRestore();
    expect(r.error).toBeUndefined();
    expect(r.transfer).toMatchObject({ status: 'unknown', outcome: 'unknown' });
    const bal = await cash.computeAvailableBalance(sql, M);
    expect(bal.reserved).toBe(10000);
    expect((await first('SELECT count(*)::int AS n FROM merchant_transfers WHERE status=$1', ['failed'])).n).toBe(0);
  });
});

// ───────────────────────────── P1-2 — webhook Airtel marchand ─────────────────────────────
describe('handleAirtelWebhook — transactions marchandes via finalize.service', () => {
  const sign = (secret, b) => crypto.createHmac('sha256', secret).update(JSON.stringify(b)).digest('hex');
  const mkRes = () => { const res = { statusCode: 200, body: null }; res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; return res; }; return res; };
  const call = async (body) => { const res = mkRes(); await wh.handleAirtelWebhook({ body, headers: { 'x-airtel-signature': sign('s3cret', body) }, ip: '127.0.0.1' }, res); return res; };
  const airtelCollect = async (ref) => {
    const id = uuid();
    await sql(`INSERT INTO transactions(transaction_id,merchant_id,type,amount,status,detected_operator,detected_country,gateway_name,gateway_payment_id,description)
               VALUES($1,$2,'collect',10000,'pending','AIRTEL_MONEY','CG','airtel_cg',$3,'ENC-TEST — vente')`, [id, M, ref]);
    return id;
  };
  beforeEach(() => { process.env.AIRTEL_WEBHOOK_SECRET = 's3cret'; process.env.AIRTEL_CG_BASE_URL = 'https://airtel.invalid'; process.env.AIRTEL_CG_COLL_CLIENT_ID = 'id'; process.env.AIRTEL_CG_COLL_CLIENT_SECRET = 'sec'; });

  test('TS confirmé par l’enquiry → authorized avec frais, règlement J+1 et événement (source enquiry)', async () => {
    const id = await airtelCollect('AIR-1');
    mockAirtelQuery.mockResolvedValue({ success: true, failed: false, airtelMoneyId: 'AM-1' });
    const res = await call({ transaction: { id: 'AIR-1', status: 'TS', airtel_money_id: 'AM-1', amount: '10000', currency: 'XAF' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ applied: true, newStatus: 'authorized', source: 'enquiry' });
    const row = await first('SELECT status, fee_amount, net_amount, response_code FROM transactions WHERE transaction_id=$1', [id]);
    expect(row.status).toBe('authorized'); expect(row.response_code).toBe('00');
    expect([Number(row.fee_amount), Number(row.net_amount)]).toEqual([150, 9850]);
    expect((await first('SELECT count(*)::int AS n FROM settlement_queue WHERE transaction_id=$1', [id])).n).toBe(1);
    expect((await first('SELECT count(*)::int AS n FROM transaction_events WHERE transaction_id=$1', [id])).n).toBe(1);
  });
  test('enquiry indisponible → le callback signé fait foi, même machine d’état (source callback) ; TF → failed, frais 0', async () => {
    const id = await airtelCollect('AIR-2');
    mockAirtelQuery.mockRejectedValue(new Error('ECONNRESET'));
    const res = await call({ transaction: { id: 'AIR-2', status: 'TS', airtel_money_id: 'AM-2' } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ applied: true, newStatus: 'authorized', source: 'callback' });
    const row = await first('SELECT status, fee_amount, net_amount, auth_code FROM transactions WHERE transaction_id=$1', [id]);
    expect(row).toMatchObject({ status: 'authorized', auth_code: 'AM-2' });
    expect(Number(row.net_amount)).toBe(9850);
    expect((await first('SELECT count(*)::int AS n FROM settlement_queue WHERE transaction_id=$1', [id])).n).toBe(1);

    const id2 = await airtelCollect('AIR-3');
    const r2 = await call({ transaction: { id: 'AIR-3', status: 'TF', message: 'Insufficient balance' } });
    expect(r2.body).toMatchObject({ applied: true, newStatus: 'failed' });
    const row2 = await first('SELECT status, fee_amount, net_amount, response_message FROM transactions WHERE transaction_id=$1', [id2]);
    expect(row2).toMatchObject({ status: 'failed', response_message: 'Insufficient balance' });
    expect([Number(row2.fee_amount), Number(row2.net_amount)]).toEqual([0, 0]);
    expect((await first('SELECT count(*)::int AS n FROM settlement_queue WHERE transaction_id=$1', [id2])).n).toBe(0);
  });
  test('callback TS mais enquiry encore TIP → 202, rien ne change (provider wins) ; montant différent → 409', async () => {
    const id = await airtelCollect('AIR-4');
    mockAirtelQuery.mockResolvedValue({ success: false, failed: false, pending: true, rawStatus: 'TIP' });
    const res = await call({ transaction: { id: 'AIR-4', status: 'TS' } });
    expect(res.statusCode).toBe(202);
    expect((await first('SELECT status FROM transactions WHERE transaction_id=$1', [id])).status).toBe('pending');
    const r2 = await call({ transaction: { id: 'AIR-4', status: 'TS', amount: '5000', currency: 'XAF' } });
    expect(r2.statusCode).toBe(409);
    expect((await first('SELECT status FROM transactions WHERE transaction_id=$1', [id])).status).toBe('pending');
  });
  test('rejeu sur transaction finale → already_processed, aucun second règlement', async () => {
    const id = await airtelCollect('AIR-5');
    mockAirtelQuery.mockResolvedValue({ success: true, failed: false, airtelMoneyId: 'AM-5' });
    await call({ transaction: { id: 'AIR-5', status: 'TS' } });
    const r = await call({ transaction: { id: 'AIR-5', status: 'TF' } });
    expect(r.body.outcome).toBe('already_processed');
    expect((await first('SELECT status FROM transactions WHERE transaction_id=$1', [id])).status).toBe('authorized');
    expect((await first('SELECT count(*)::int AS n FROM settlement_queue WHERE transaction_id=$1', [id])).n).toBe(1);
  });
});

// ───────────────────────────── Portails P1-1 — garde mot de passe temporaire (API) ─────────────────────────────
describe('merchantAuth / cardholderAuth : claim pwdTemp → 403 hors changement de mot de passe', () => {
  const secret = process.env.JWT_SECRET || 'dev_secret_change_in_production';
  const token = (claims) => jwt.sign(claims, secret, { expiresIn: 600, issuer: process.env.JWT_ISSUER || 'api.c-pay.global', audience: process.env.JWT_AUDIENCE || 'c-pay' });
  const app = express();
  app.use(express.json());
  const ok = (req, res) => res.json({ ok: true, sub: req.user.sub });
  app.get('/api/v1/merchant/cash/summary', auth.merchantAuth, ok);
  app.post('/api/v1/merchant/cash/collect', auth.merchantAuth, ok);
  app.get('/api/v1/merchant/auth/me', auth.merchantAuth, ok);
  app.post('/api/v1/merchant/auth/change-password', auth.merchantAuth, ok);
  app.post('/api/v1/merchant/account/change-password', auth.merchantAuth, ok);
  app.post('/api/v1/merchant/auth/logout', auth.merchantAuth, ok);
  app.get('/api/v1/cardholder/cards', auth.cardholderAuth, ok);
  app.post('/api/v1/cardholder/profile/change-password', auth.cardholderAuth, ok);
  const temp = token({ type: 'merchant', sub: 'u1', merchantId: M, role: 'owner', pwdTemp: true });
  const normal = token({ type: 'merchant', sub: 'u1', merchantId: M, role: 'owner' });
  test('marchand : opérations refusées (403 PASSWORD_CHANGE_REQUIRED), profil / changement / déconnexion autorisés', async () => {
    const r1 = await request(app).get('/api/v1/merchant/cash/summary').set('Authorization', `Bearer ${temp}`);
    expect(r1.status).toBe(403); expect(r1.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await request(app).post('/api/v1/merchant/cash/collect').set('Authorization', `Bearer ${temp}`).send({})).status).toBe(403);
    for (const [m, u] of [['get', '/api/v1/merchant/auth/me'], ['post', '/api/v1/merchant/auth/change-password'], ['post', '/api/v1/merchant/account/change-password'], ['post', '/api/v1/merchant/auth/logout']]) {
      expect((await request(app)[m](u).set('Authorization', `Bearer ${temp}`).send({})).status).toBe(200);
    }
    expect((await request(app).get('/api/v1/merchant/cash/summary').set('Authorization', `Bearer ${normal}`)).status).toBe(200);
  });
  test('porteur : même règle', async () => {
    const t = token({ type: 'cardholder', sub: CH, cardId: 'c1', pwdTemp: true });
    expect((await request(app).get('/api/v1/cardholder/cards').set('Authorization', `Bearer ${t}`)).body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await request(app).post('/api/v1/cardholder/profile/change-password').set('Authorization', `Bearer ${t}`).send({})).status).toBe(200);
  });
  test('les claims posés au login portent pwdTemp uniquement si temp_password est vrai', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../routes/merchant.routes.js'), 'utf8');
    expect(src).toMatch(/pwdTemp: true/);
    expect(src).toMatch(/SELECT u\.user_id, u\.role, u\.temp_password/); // refresh : la claim suit l'état réel
  });
});

// ───────────────────────────── P1-3 — routes /momo ─────────────────────────────
describe('/api/v1/momo : endpoints bruts retirés, statut filtré par porteur, montant typé', () => {
  const secret = process.env.JWT_SECRET || 'dev_secret_change_in_production';
  const token = (claims) => jwt.sign(claims, secret, { expiresIn: 600, issuer: process.env.JWT_ISSUER || 'api.c-pay.global', audience: process.env.JWT_AUDIENCE || 'c-pay' });
  const app = express(); app.use(express.json()); app.use('/api/v1/momo', require('../routes/mtn-momo.routes'));
  const ch = token({ type: 'cardholder', sub: CH, cardId: 'card-1' });
  test('payout / requesttopay / accountbalance → 410 FEATURE_DISABLED', async () => {
    for (const [m, u] of [['post', '/api/v1/momo/payout'], ['post', '/api/v1/momo/requesttopay'], ['get', '/api/v1/momo/accountbalance?phone=242060000000']]) {
      const r = await request(app)[m](u).set('Authorization', `Bearer ${ch}`).send({ amount: 1000, phone: '242060000000', pin: '1234' });
      expect(r.status).toBe(410); expect(r.body.code).toBe('FEATURE_DISABLED');
    }
    expect(require('../services/rails/mtn-momo.client').transfer).not.toHaveBeenCalled();
    expect(require('../services/rails/mtn-momo.client').requestToPay).not.toHaveBeenCalled();
  });
  test('status/:ref : référence d’un autre porteur ou inconnue → 404 sans appel MTN', async () => {
    await sql(`INSERT INTO card_transactions(txn_id,card_id,cardholder_id,mm_reference,metadata,status) VALUES('T-9','card-9','other-ch','REF-OTHER','{}','pending')`);
    const mtn = require('../services/rails/mtn-momo.client');
    expect((await request(app).get('/api/v1/momo/status/REF-OTHER').set('Authorization', `Bearer ${ch}`)).status).toBe(404);
    expect((await request(app).get('/api/v1/momo/status/REF-NOPE').set('Authorization', `Bearer ${ch}`)).status).toBe(404);
    expect(mtn.getCollectionStatus).not.toHaveBeenCalled();
    await sql(`INSERT INTO card_transactions(txn_id,card_id,cardholder_id,mm_reference,metadata,status) VALUES('T-1','card-1',$1,'REF-MINE','{}','completed')`, [CH]);
    mtn.getCollectionStatus.mockResolvedValue({ status: 'SUCCESSFUL', amount: 1000, currency: 'XAF' });
    const r = await request(app).get('/api/v1/momo/status/REF-MINE').set('Authorization', `Bearer ${ch}`);
    expect(r.status).toBe(200); expect(r.body.txnStatus).toBe('completed');
  });
  test('topup : montant non numérique ou non entier → 422', async () => {
    for (const amount of ['abc', 1000.5, '']) {
      const r = await request(app).post('/api/v1/momo/topup').set('Authorization', `Bearer ${ch}`).send({ amount, phone: '242060000000', cardId: 'card-1' });
      expect(r.status).toBe(422);
    }
  });
});

// ───────────────────────────── P1-5 — règlements admin ─────────────────────────────
describe('/admin/settlements/:id/complete|reject via cash.transitionTransfer', () => {
  const secret = process.env.JWT_SECRET || 'dev_secret_change_in_production';
  const token = (claims) => jwt.sign(claims, secret, { expiresIn: 600, issuer: process.env.JWT_ISSUER || 'api.c-pay.global', audience: process.env.JWT_AUDIENCE || 'c-pay' });
  const ADMIN = '33333333-3333-4333-8333-333333333333';
  const fin = token({ type: 'admin', sub: ADMIN, role: 'finance_admin' });
  let app;
  beforeAll(() => { app = express(); app.use(express.json()); app.use('/api/v1/admin', require('../routes/admin.routes')); });
  const pendingBankPayout = async () => {
    const inst = uuid(), acc = uuid(), id = uuid();
    await sql(`INSERT INTO financial_institutions(institution_id,name) VALUES($1,'Banque Test')`, [inst]);
    await sql(`INSERT INTO bank_accounts(account_id,institution_id,account_number,account_name,owner_id) VALUES($1,$2,'00012345','Boutique',$3)`, [acc, inst, M]);
    await sql(`INSERT INTO merchant_transfers(transfer_id,merchant_id,direction,dest_type,bank_account_id,status,amount,fee,net_amount,reference)
               VALUES($1,$2,'payout','bank',$3,'pending_settlement',50000,500,49500,'TRF-1')`, [id, M, acc]);
    return id;
  };
  test('complete : statut completed, référence bancaire, événement JSONB, audit ; rejeu → 404', async () => {
    const id = await pendingBankPayout();
    const r = await request(app).post(`/api/v1/admin/settlements/${id}/complete`).set('Authorization', `Bearer ${fin}`).send({ settlementRef: 'BQ-2026-001', note: 'virement du jour' });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ success: true, status: 'completed', reference: 'TRF-1' });
    const row = await first('SELECT status, bank_reference, settlement_ref, executed_by, admin_note, events, completed_at FROM merchant_transfers WHERE transfer_id=$1', [id]);
    expect(row).toMatchObject({ status: 'completed', bank_reference: 'BQ-2026-001', settlement_ref: 'BQ-2026-001', executed_by: ADMIN, admin_note: 'virement du jour' });
    expect(row.completed_at).toBeTruthy();
    expect(row.events.some((e) => e.type === 'completed' && e.action === 'settlements_complete')).toBe(true);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'CASH_TRANSFER_EXECUTED' }));
    expect((await request(app).post(`/api/v1/admin/settlements/${id}/complete`).set('Authorization', `Bearer ${fin}`).send({ settlementRef: 'BQ-2' })).status).toBe(404);
    expect((await request(app).post(`/api/v1/admin/settlements/${uuid()}/complete`).set('Authorization', `Bearer ${fin}`).send({})).status).toBe(422);
  });
  test('reject : statut rejected (fonds libérés), motif journalisé ; ops_admin → 403', async () => {
    const id = await pendingBankPayout();
    const before = await cash.computeAvailableBalance(sql, M);
    const r = await request(app).post(`/api/v1/admin/settlements/${id}/reject`).set('Authorization', `Bearer ${fin}`).send({ reason: 'IBAN invalide' });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ success: true, status: 'rejected', refunded: 50000 });
    const row = await first('SELECT status, error_message, events FROM merchant_transfers WHERE transfer_id=$1', [id]);
    expect(row).toMatchObject({ status: 'rejected', error_message: 'IBAN invalide' });
    expect(row.events.some((e) => e.type === 'rejected')).toBe(true);
    const after = await cash.computeAvailableBalance(sql, M);
    expect(after.available).toBe(before.available + 50000);
    const ops = token({ type: 'admin', sub: ADMIN, role: 'ops_admin' });
    expect((await request(app).post(`/api/v1/admin/settlements/${id}/reject`).set('Authorization', `Bearer ${ops}`).send({ reason: 'x' })).status).toBe(403);
  });
});
