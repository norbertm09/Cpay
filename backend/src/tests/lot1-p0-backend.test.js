'use strict';
// Lot 1 de l'audit du 2026-11-02 (P0 backend) — services réels + SQL PostgreSQL (PGlite) ;
// seules les frontières opérateur / e-mail / audit PCI sont simulées.
//   P0 #2  POST /merchant/disburse → cash.createPayout : un délai ne libère JAMAIS les fonds (`unknown`)
//   P0 #3  calc_fee : migration 013 (wrapper) + réconciliation via finalize.service / cpay_calculate_fee
//   P0 #4  callback MTN : transactions marchandes finalisées après re-interrogation, jeton obligatoire en prod
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
let mockPg;
const sql = async (...args) => { const r = await mockPg.query(...args); return { ...r, rowCount: r.affectedRows ?? r.rows.length }; };
jest.mock('../config/database', () => ({
  query: (...args) => sql(...args),
  withTransaction: fn => mockPg.transaction(tx => fn({ query: async (...args) => { const r = await tx.query(...args); return { ...r, rowCount: r.affectedRows ?? r.rows.length }; } })),
  pool: { query: (...args) => sql(...args) },
}));
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/pci.middleware', () => ({ auditLog: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../middleware/auth', () => new Proxy({}, { get: () => (req, res, next) => (typeof next === 'function' ? next() : undefined) }));
jest.mock('../services/notifications/email.service', () => ({ send: jest.fn().mockResolvedValue({ success: true }) }));
// Aucune configuration opérateur en base : les ordres Congo passent par le client rails (simulé ci-dessous)
jest.mock('../services/mobilemoney/mobilemoney.router', () => ({
  getProvider: () => null, getConfig: async () => null, sendPayout: jest.fn(),
  PROVIDERS: { mtn_cg: true, airtel_cg: true, mtn_cm: true },
}));
const mockTransfer = jest.fn();
const mockCollStatus = jest.fn();
const mockDisbStatus = jest.fn();
jest.mock('../services/rails/mtn-momo.client', () => ({
  CONFIG: { disbursements: { apiUser: 'u', apiKey: 'k', primaryKey: 'p' }, collections: { primaryKey: 'p' } },
  transfer: (...a) => mockTransfer(...a),
  getCollectionStatus: (...a) => mockCollStatus(...a),
  getDisbursementStatus: (...a) => mockDisbStatus(...a),
  requestToPay: jest.fn(), getCollectionBalance: jest.fn(), getDisbursementBalance: jest.fn(), validateAccount: jest.fn(),
}));

const cash = require('../services/cash/cash.service');
const reconcile = require('../services/reconcile.service');
const wh = require('../routes/webhook-handlers');
const merchantRouter = require('../routes/merchant.routes');

const M = '11111111-1111-4111-8111-111111111111';
const uuid = () => require('crypto').randomUUID();
const first = async (...a) => (await sql(...a)).rows[0];
const SCHEMA = `
  CREATE TABLE merchants(merchant_id uuid PRIMARY KEY, country text, currency text DEFAULT 'XAF', business_name text, email text,
    merchant_status text DEFAULT 'active', kyb_level int DEFAULT 2, cash_wallet_operator text, cash_wallet_phone text, cash_wallet_verified_at timestamptz,
    velocity_max_per_txn numeric, velocity_max_daily_amount numeric, velocity_max_daily_count int, velocity_max_monthly_amount numeric, velocity_max_monthly_count int, updated_at timestamptz);
  CREATE TABLE financial_institutions(institution_id uuid PRIMARY KEY, name text);
  CREATE TABLE bank_accounts(account_id uuid PRIMARY KEY, institution_id uuid, account_number text, account_name text, owner_id uuid, status text DEFAULT 'pending');
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
  CREATE TABLE card_transactions(txn_id text, mm_reference text, metadata jsonb, status text, initiated_at timestamptz DEFAULT NOW());
  CREATE TABLE webhook_events(id serial PRIMARY KEY, provider text, reference_id text, provider_status text, outcome text, payload jsonb, ip_address text, created_at timestamptz DEFAULT NOW());
  -- barème : 1,5 % encaissement, 1 % versement (même forme que la migration 010)
  CREATE FUNCTION cpay_calculate_fee(uuid,text,text,numeric,text) RETURNS numeric LANGUAGE SQL AS $$
    SELECT round($4 * CASE WHEN $2='payout' THEN 0.01 ELSE 0.015 END) $$;
`;
beforeAll(async () => { mockPg = new PGlite(); await mockPg.exec(SCHEMA); }, 60000);
afterAll(async () => { await mockPg.close(); });
beforeEach(async () => {
  jest.clearAllMocks();
  delete process.env.MTN_WEBHOOK_TOKEN;
  mockTransfer.mockReset(); mockCollStatus.mockReset(); mockDisbStatus.mockReset();
  await mockPg.exec('TRUNCATE merchants, merchant_transfers, transactions, transaction_events, settlement_batches, settlement_queue, pay_links, card_transactions, webhook_events');
  await sql(`INSERT INTO merchants(merchant_id,country,currency,business_name,email) VALUES($1,'CG','XAF','Boutique Pilote','ops@example.test')`, [M]);
  // solde disponible : un encaissement autorisé de 100 000 XAF (net 98 500)
  await sql(`INSERT INTO transactions(merchant_id,type,amount,status,detected_operator,fee_amount,net_amount) VALUES($1,'collect',100000,'authorized','MTN_MOMO',1500,98500)`, [M]);
});

// ───────────────────────────── P0 #3 — migration 013 ─────────────────────────────
describe('migration 013 : calc_fee de compatibilité', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../../database/013_calc_fee_compat.sql'), 'utf8');
  test('crée calc_fee quand elle manque, déléguée à cpay_calculate_fee, et reste idempotente', async () => {
    const db = new PGlite();
    await db.exec(`CREATE FUNCTION cpay_calculate_fee(uuid,text,text,numeric,text) RETURNS numeric LANGUAGE SQL AS $$ SELECT round($4*0.015) $$;`);
    expect((await db.query(`SELECT to_regprocedure('calc_fee(uuid,text,text,numeric)') AS f`)).rows[0].f).toBeNull();
    await db.exec(migration);
    await db.exec(migration); // rejeu sans erreur
    const r = await db.query(`SELECT calc_fee('${M}'::uuid,'collect','mtn',10000) AS fee`);
    expect(Number(r.rows[0].fee)).toBe(150);
    await db.close();
  });
  test('conserve une calc_fee déjà présente (barème créé à la main en production)', async () => {
    const db = new PGlite();
    await db.exec(`CREATE FUNCTION cpay_calculate_fee(uuid,text,text,numeric,text) RETURNS numeric LANGUAGE SQL AS $$ SELECT 0::numeric $$;
                   CREATE FUNCTION calc_fee(uuid,text,text,numeric) RETURNS numeric LANGUAGE SQL AS $$ SELECT 42::numeric $$;`);
    await db.exec(migration);
    expect(Number((await db.query(`SELECT calc_fee('${M}'::uuid,'collect','mtn',10000) AS fee`)).rows[0].fee)).toBe(42);
    await db.close();
  });
  test('le code ne référence plus calc_fee (hors migration de compatibilité)', () => {
    const src = ['src/routes/merchant.routes.js', 'src/services/reconcile.service.js']
      .map((f) => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8')).join('\n');
    expect(src).not.toMatch(/\bcalc_fee\(/);
  });
});

// ───────────────────────────── P0 #2 — décaissement ─────────────────────────────
const railTimeout = () => Object.assign(new Error('MTN transfer failed: ETIMEDOUT'), { code: 'ETIMEDOUT' });
const mtnRail = { available: true, kind: 'mtn_client', gateway: 'mtn_cg', operatorLabel: 'MTN MoMo' };
const wallet = { operator: 'mtn_momo', phone: '+242066000001', gateway: 'mtn_cg', country: 'CG' };

describe('cash.createPayout — frais en sus (feeMode on_top)', () => {
  test('réserve amount + fee, envoie amount au bénéficiaire ; un délai donne `unknown`, jamais `failed`', async () => {
    mockTransfer.mockRejectedValue(railTimeout());
    const r = await cash.createPayout({ merchantId: M, destType: 'wallet', wallet, rail: mtnRail, amount: 10000, feeMode: 'on_top', refPrefix: 'DSB' });
    expect(r.error).toBeUndefined();
    expect(r.transfer).toMatchObject({ status: 'unknown', outcome: 'unknown', amount: 10100, fee: 100, net: 10000, feeMode: 'on_top' });
    expect(mockTransfer).toHaveBeenCalledWith(expect.objectContaining({ amount: 10000 }));
    const row = await first('SELECT status, amount, fee, net_amount FROM merchant_transfers WHERE transfer_id=$1', [r.transfer.transferId]);
    expect(row).toMatchObject({ status: 'unknown' });
    expect([Number(row.amount), Number(row.fee), Number(row.net_amount)]).toEqual([10100, 100, 10000]);
    const bal = await cash.computeAvailableBalance(sql, M);
    expect(bal.reserved).toBe(10100);
    expect(bal.available).toBe(98500 - 10100);
  });
  test('mode par défaut `deduct` inchangé : amount réservé, amount − fee envoyé', async () => {
    mockTransfer.mockResolvedValue({ referenceId: 'ref-1', status: 'PENDING' });
    const r = await cash.createPayout({ merchantId: M, destType: 'wallet', wallet, rail: mtnRail, amount: 10000 });
    expect(r.transfer).toMatchObject({ status: 'processing', amount: 10000, fee: 100, net: 9900, gatewayReference: 'ref-1' });
    expect(mockTransfer).toHaveBeenCalledWith(expect.objectContaining({ amount: 9900 }));
  });
  test('solde insuffisant évalué sur le montant débité (amount + fee)', async () => {
    const r = await cash.createPayout({ merchantId: M, destType: 'wallet', wallet, rail: mtnRail, amount: 98000, feeMode: 'on_top' });
    expect(r.error).toMatchObject({ status: 422, body: { code: 'INSUFFICIENT_BALANCE', requested: 98980 } });
    expect(mockTransfer).not.toHaveBeenCalled();
  });
  test('feeMode inconnu refusé', async () => {
    await expect(cash.createPayout({ merchantId: M, destType: 'wallet', wallet, rail: mtnRail, amount: 1000, feeMode: 'gratis' })).rejects.toThrow(/feeMode/);
  });
});

const routeHandler = (routePath, method) => {
  const layer = merchantRouter.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const mkRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};
const mkReq = (over = {}) => ({ body: {}, params: {}, query: {}, headers: {}, ip: '127.0.0.1', user: { merchantId: M, sub: 'user-1' }, merchant: { merchantId: M }, ...over });

describe('POST /merchant/disburse (application Android) délégué à cash.createPayout', () => {
  const disburse = () => routeHandler('/disburse', 'post');
  const status = () => routeHandler('/disburse/:txnId/status', 'get');
  test('délai opérateur → 200 status pending/unknown, fonds réservés, aucune ligne `failed` ; GET /status reste pending', async () => {
    mockTransfer.mockRejectedValue(railTimeout());
    const res = mkRes();
    await disburse()(mkReq({ body: { amount: 10000, recipientPhone: '066000001', method: 'mtn_momo', description: 'DSB-TEST' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: 'pending', transferStatus: 'unknown', outcome: 'unknown', amount: 10000, fee: 100, total: 10100, operator: 'mtn_momo' });
    expect(res.body.reference).toMatch(/^DSB-/);
    expect((await first('SELECT count(*)::int AS n FROM merchant_transfers WHERE status=$1', ['failed'])).n).toBe(0);
    expect((await first('SELECT count(*)::int AS n FROM transactions WHERE type=$1', ['payout'])).n).toBe(0); // plus d'écriture legacy

    // sans référence opérateur (délai avant la réponse MTN) : impossible d'interroger MTN → reste `unknown`, fonds réservés
    const res2 = mkRes();
    await status()(mkReq({ params: { txnId: res.body.txnId } }), res2);
    expect(res2.statusCode).toBe(200);
    expect(res2.body).toMatchObject({ txnId: res.body.txnId, status: 'pending', transferStatus: 'unknown', outcome: 'unknown', amount: 10000, fee: 100, total: 10100 });
    expect(mockDisbStatus).not.toHaveBeenCalled();
    expect((await cash.computeAvailableBalance(sql, M)).reserved).toBe(10100);
  });
  test('MTN accepte (processing) puis confirme : GET /disburse/:id/status → authorized/completed', async () => {
    mockTransfer.mockResolvedValue({ referenceId: 'mtn-ref-9', status: 'PENDING' });
    const res = mkRes();
    await disburse()(mkReq({ body: { amount: 10000, recipientPhone: '066000001', method: 'mtn_momo' } }), res);
    expect(res.body).toMatchObject({ status: 'pending', transferStatus: 'processing', gatewayReference: 'mtn-ref-9' });
    mockDisbStatus.mockResolvedValue({ status: 'SUCCESSFUL', financialTxnId: 'FT-1', amount: 10000, currency: 'XAF' });
    const res2 = mkRes();
    await status()(mkReq({ params: { txnId: res.body.txnId } }), res2);
    expect(res2.statusCode).toBe(200);
    expect(res2.body).toMatchObject({ txnId: res.body.txnId, status: 'authorized', transferStatus: 'completed', amount: 10000, fee: 100, total: 10100, reference: res.body.reference });
    expect(mockDisbStatus).toHaveBeenCalledWith('mtn-ref-9');
    const bal = await cash.computeAvailableBalance(sql, M);
    expect(bal.reserved).toBe(0); expect(bal.totalWithdrawn).toBe(10100);
  });
  test('refus explicite de l\'opérateur → 502 et fonds libérés (failed)', async () => {
    mockTransfer.mockRejectedValue(Object.assign(new Error('PAYEE_NOT_FOUND'), { statusCode: 400 }));
    const res = mkRes();
    await disburse()(mkReq({ body: { amount: 10000, recipientPhone: '066000001', method: 'mtn_momo' } }), res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ code: 'GATEWAY_ERROR', outcome: 'declined' });
    expect((await cash.computeAvailableBalance(sql, M)).reserved).toBe(0);
  });
  test('numéro invalide / opérateur inconnu / montant non entier → 422 sans réservation', async () => {
    for (const body of [
      { amount: 10000, recipientPhone: '12', method: 'mtn_momo' },
      { amount: 10000, recipientPhone: '066000001', method: 'paypal' },
      { amount: 10000.5, recipientPhone: '066000001', method: 'mtn_momo' },
    ]) {
      const res = mkRes();
      await disburse()(mkReq({ body }), res);
      expect(res.statusCode).toBe(422);
    }
    expect((await first('SELECT count(*)::int AS n FROM merchant_transfers')).n).toBe(0);
  });
});

// ───────────────────────────── P0 #3 — réconciliation via finalize.service ─────────────────────────────
const legacyCollect = async (over = {}) => {
  const id = uuid();
  await sql(`INSERT INTO transactions(transaction_id,merchant_id,type,amount,status,detected_operator,gateway_name,gateway_payment_id,gateway_order_id,description)
             VALUES($1,$2,'collect',10000,'pending','mtn','mtn',$3,$4,$5)`, [id, M, over.ref || `mtn-ref-${id.slice(0, 8)}`, over.orderId || 'MOB-ABC123', over.description || 'Encaissement mobile']);
  return first('SELECT * FROM transactions WHERE transaction_id=$1', [id]);
};
describe('reconcileOne — encaissements historiques MTN (client rails Congo)', () => {
  test('SUCCESSFUL → authorized, frais cpay_calculate_fee, règlement J+1 enfilé, événement MTN_RECONCILE', async () => {
    const t = await legacyCollect();
    mockCollStatus.mockResolvedValue({ status: 'SUCCESSFUL', financialTxnId: 'FT-77', amount: 10000, currency: 'XAF' });
    const out = await reconcile.reconcileOne(t);
    expect(out).toMatchObject({ updated: 'authorized' });
    const row = await first('SELECT status, fee_amount, net_amount, auth_code, response_code, completed_at FROM transactions WHERE transaction_id=$1', [t.transaction_id]);
    expect(row.status).toBe('authorized');
    expect([Number(row.fee_amount), Number(row.net_amount)]).toEqual([150, 9850]);
    expect(row.auth_code).toBe('FT-77');
    expect(row.response_code).toBe('00');
    expect(row.completed_at).toBeTruthy();
    expect((await first('SELECT count(*)::int AS n FROM settlement_queue WHERE transaction_id=$1', [t.transaction_id])).n).toBe(1);
    expect((await first('SELECT event_type FROM transaction_events WHERE transaction_id=$1', [t.transaction_id])).event_type).toBe('MTN_RECONCILE');
  });
  test('FAILED explicite → failed, frais et net à 0, pas de règlement', async () => {
    const t = await legacyCollect();
    mockCollStatus.mockResolvedValue({ status: 'FAILED', reason: 'APPROVAL_REJECTED' });
    expect(await reconcile.reconcileOne(t)).toMatchObject({ updated: 'failed', reason: 'APPROVAL_REJECTED' });
    const row = await first('SELECT status, fee_amount, net_amount, response_message FROM transactions WHERE transaction_id=$1', [t.transaction_id]);
    expect(row).toMatchObject({ status: 'failed', response_message: 'APPROVAL_REJECTED' });
    expect([Number(row.fee_amount), Number(row.net_amount)]).toEqual([0, 0]);
    expect((await first('SELECT count(*)::int AS n FROM settlement_queue')).n).toBe(0);
  });
  test('opérateur injoignable ou PENDING → la transaction reste pending ; montant différent → pending (mismatch)', async () => {
    const t = await legacyCollect();
    mockCollStatus.mockRejectedValue(new Error('ECONNRESET'));
    expect(await reconcile.reconcileOne(t)).toMatchObject({ still: 'pending' });
    mockCollStatus.mockResolvedValue({ status: 'PENDING' });
    expect(await reconcile.reconcileOne(t)).toMatchObject({ still: 'pending' });
    mockCollStatus.mockResolvedValue({ status: 'SUCCESSFUL', amount: 9000, currency: 'XAF' });
    expect(await reconcile.reconcileOne(t)).toMatchObject({ still: 'pending', mismatch: true });
    expect((await first('SELECT status FROM transactions WHERE transaction_id=$1', [t.transaction_id])).status).toBe('pending');
  });
  test('rejeu : une transaction déjà finale n\'est pas modifiée (claim perdu)', async () => {
    const t = await legacyCollect();
    mockCollStatus.mockResolvedValue({ status: 'SUCCESSFUL', amount: 10000, currency: 'XAF' });
    await reconcile.reconcileOne(t);
    expect(await reconcile.reconcileOne(t)).toMatchObject({ skipped: 'already_final' });
    expect((await first('SELECT count(*)::int AS n FROM transaction_events WHERE transaction_id=$1', [t.transaction_id])).n).toBe(1);
  });
});

// ───────────────────────────── P0 #4 — callback MTN ─────────────────────────────
describe('handleMtnWebhook — transactions marchandes', () => {
  const call = async (body, over = {}) => { const res = mkRes(); await wh.handleMtnWebhook(mkReq({ body, ...over }), res); return res; };
  test('callback caisse (externalId = transaction_id, sans referenceId) → statut MTN re-interrogé puis authorized', async () => {
    const id = uuid();
    await sql(`INSERT INTO transactions(transaction_id,merchant_id,type,amount,status,detected_operator,detected_country,gateway_name,gateway_payment_id)
               VALUES($1,$2,'collect',10000,'pending','MTN_MOMO','CG','mtn_cg',$3)`, [id, M, id]);
    mockCollStatus.mockResolvedValue({ status: 'SUCCESSFUL', financialTxnId: 'FT-1', amount: 10000, currency: 'XAF' });
    const res = await call({ externalId: id, financialTransactionId: 'FT-1', status: 'SUCCESSFUL', amount: '10000', currency: 'XAF' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ applied: true, newStatus: 'authorized', txnId: id });
    expect((await first('SELECT status FROM transactions WHERE transaction_id=$1', [id])).status).toBe('authorized');
    expect((await first('SELECT outcome FROM webhook_events ORDER BY id DESC LIMIT 1')).outcome).toBe('authorized');
  });
  test('callback client historique (externalId = <ref>-<timestamp>-<aléa>) retrouvé par gateway_order_id', async () => {
    const t = await legacyCollect({ orderId: 'MOB-K9Z2' });
    mockCollStatus.mockResolvedValue({ status: 'SUCCESSFUL', amount: 10000, currency: 'XAF' });
    const res = await call({ externalId: 'MOB-K9Z2-1730000000000-ab12', status: 'SUCCESSFUL' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ applied: true, newStatus: 'authorized', txnId: t.transaction_id });
  });
  test('le callback seul ne crédite jamais : MTN répond PENDING → 202 ; MTN injoignable → 202 ; FAILED → failed', async () => {
    const t = await legacyCollect();
    mockCollStatus.mockResolvedValue({ status: 'PENDING' });
    expect((await call({ referenceId: t.gateway_payment_id, status: 'SUCCESSFUL' })).statusCode).toBe(202);
    mockCollStatus.mockRejectedValue(new Error('ETIMEDOUT'));
    const r2 = await call({ referenceId: t.gateway_payment_id, status: 'SUCCESSFUL' });
    expect(r2.statusCode).toBe(202); expect(r2.body.code).toBe('PROVIDER_UNAVAILABLE');
    expect((await first('SELECT status FROM transactions WHERE transaction_id=$1', [t.transaction_id])).status).toBe('pending');
    mockCollStatus.mockResolvedValue({ status: 'FAILED', reason: 'EXPIRED' });
    const r3 = await call({ referenceId: t.gateway_payment_id, status: 'SUCCESSFUL' });
    expect(r3.body).toMatchObject({ applied: true, newStatus: 'failed' });
  });
  test('montant du callback différent → 409 sans appel MTN ; rejeu sur transaction finale → already_processed', async () => {
    const t = await legacyCollect();
    const r = await call({ referenceId: t.gateway_payment_id, status: 'SUCCESSFUL', amount: '5000', currency: 'XAF' });
    expect(r.statusCode).toBe(409); expect(mockCollStatus).not.toHaveBeenCalled();
    await sql(`UPDATE transactions SET status='authorized' WHERE transaction_id=$1`, [t.transaction_id]);
    const r2 = await call({ referenceId: t.gateway_payment_id, status: 'FAILED' });
    expect(r2.statusCode).toBe(200); expect(r2.body.outcome).toBe('already_processed');
    expect((await first('SELECT status FROM transactions WHERE transaction_id=$1', [t.transaction_id])).status).toBe('authorized');
  });
  test('référence inconnue → 200 unknown_reference ; ni referenceId ni externalId → 400', async () => {
    expect((await call({ referenceId: 'nope', status: 'SUCCESSFUL' })).body.outcome).toBe('unknown_reference');
    expect((await call({ status: 'SUCCESSFUL' })).statusCode).toBe(400);
  });
  test('jeton : accepté en en-tête ou en paramètre d\'URL (X-Callback-Url) ; absent en production → 503 fail-closed', async () => {
    const t = await legacyCollect();
    mockCollStatus.mockResolvedValue({ status: 'SUCCESSFUL', amount: 10000, currency: 'XAF' });
    process.env.MTN_WEBHOOK_TOKEN = 'secret-token';
    expect((await call({ referenceId: t.gateway_payment_id, status: 'SUCCESSFUL' })).statusCode).toBe(401);
    expect((await call({ referenceId: t.gateway_payment_id, status: 'SUCCESSFUL' }, { query: { token: 'secret-tokeN' } })).statusCode).toBe(401);
    const ok = await call({ referenceId: t.gateway_payment_id, status: 'SUCCESSFUL' }, { query: { token: 'secret-token' } });
    expect(ok.statusCode).toBe(200);
    delete process.env.MTN_WEBHOOK_TOKEN;
    const prev = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
    try {
      const r = await call({ referenceId: t.gateway_payment_id, status: 'SUCCESSFUL' });
      expect(r.statusCode).toBe(503); expect(r.body.code).toBe('WEBHOOK_NOT_CONFIGURED');
    } finally { process.env.NODE_ENV = prev; }
  });
});
