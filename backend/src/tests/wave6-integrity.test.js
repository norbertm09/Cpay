'use strict';
/**
 * WAVE-6 lot 1 (audit externe du 17/10/2026) — intégrité financière.
 * PostgreSQL embarqué (PGlite, SQL réel, transactions réelles) ; aucun réseau, aucun prestataire.
 *
 *   1. Résultat opérateur incertain : classification declined / accepted / unknown ; timeout → `unknown`
 *      (réservation conservée) → statut opérateur SUCCESS → completed / FAILED → failed + fonds libérés ;
 *      période de grâce sur « introuvable » ; needs_review + alerte ops après CASH_UNKNOWN_ALERT_HOURS.
 *   2. Idempotence durable : 5xx sur un endpoint monétaire → clé conservée, rejeu = ordre d'origine ;
 *      aucun doublon ; 409 IDEMPOTENCY_RETRY_AFTER_ERROR sans ressource ; autres endpoints inchangés.
 *   3. Finalisation atomique (authorized + settlement_queue + pay_link + event) : échec injecté entre
 *      chaque écriture → rollback complet, rejeu → appliqué, jamais deux lignes de file.
 *   4. Job de réparation settlement_queue (+ route admin).
 *   5. Bénéficiaires : rôle owner, step-up, pending_verification, vérification admin, historique, e-mail.
 *   6. Antifraude dégradée (review | allow_limited | block) et exception gateway dans l'orchestrateur.
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wave6-test-secret-at-least-32-chars-long';
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { PGlite } = require('@electric-sql/pglite');

let mockPg;
const sql = async (text, params) => { const r = await mockPg.query(text, params); return { ...r, rowCount: r.affectedRows ?? r.rows.length }; };
jest.mock('../config/database', () => ({
  query: (...a) => sql(...a),
  pool: { connect: async () => ({ query: (...a) => sql(...a), release: () => {} }), end: jest.fn() },
  withTransaction: async (fn) => mockPg.transaction(async (tx) => fn({ query: async (...a) => { const r = await tx.query(...a); return { ...r, rowCount: r.affectedRows ?? r.rows.length }; } })),
}));
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn(), http: jest.fn() }));
const mockMtnTransfer = jest.fn();
const mockMtnStatus = jest.fn();
jest.mock('../services/rails/mtn-momo.client', () => ({
  CONFIG: { disbursements: { apiUser: 'u', apiKey: 'k', primaryKey: 'p' } },
  transfer: (...a) => mockMtnTransfer(...a), getDisbursementStatus: (...a) => mockMtnStatus(...a), getCollectionStatus: jest.fn(),
}));
const mockGetStatus = jest.fn();
const mockSendPayout = jest.fn();
const mockProcessPayment = jest.fn();
jest.mock('../services/mobilemoney/mobilemoney.router', () => ({
  getProvider: () => ({ collectPayment: jest.fn(), sendPayout: jest.fn(), getStatus: (...a) => mockGetStatus(...a) }),
  getConfig: async () => ({ apiKey: 'key', baseUrl: 'https://mm.test' }),
  sendPayout: (...a) => mockSendPayout(...a), processPayment: (...a) => mockProcessPayment(...a),
  invalidateCache: jest.fn(), webhookUrl: jest.fn(), PROVIDERS: {},
}));
const mockEmail = jest.fn(async () => ({ success: true }));
jest.mock('../services/notifications/email.service', () => ({ send: (...a) => mockEmail(...a) }));
jest.mock('../services/notifications/smpp.service', () => ({ sendSmsSmpp: jest.fn(async () => true), notifyMultiChannel: jest.fn(async () => true) }));
jest.mock('../services/notifications/whatsapp.service', () => ({ sendWhatsAppText: jest.fn(async () => true) }));
jest.mock('../services/gateways/card.router', () => ({ isConfigured: () => false, processCard: jest.fn() }));
jest.mock('../services/integrations/integration.service', () => ({ deliverEvent: jest.fn(async () => {}) }));
jest.mock('../services/pilot/pilot-control.service', () => ({ evaluateFeature: jest.fn(async () => ({ allowed: true })) }));
const mockFraud = jest.fn(async () => ({ action: 'allow', score: 0 }));
jest.mock('../services/fraud/fraud.engine', () => ({ evaluate: (...a) => mockFraud(...a) }));

const { signToken } = require('../middleware/auth');
const cash = require('../services/cash/cash.service');
const { idempotency, attachResource } = require('../middleware/idempotency');
const { finalizeTransaction } = require('../services/mobilemoney/finalize.service');
const { sweepAuthorizedWithoutQueue } = require('../services/settlement/settlement.repair');
const reconcile = require('../services/reconcile.service');
const orchestrator = require('../services/orchestration/orchestrator');

const app = express();
app.use(express.json());
app.use('/merchant/cash', require('../routes/cash.routes'));
app.use('/admin/cash', require('../routes/cash-admin.routes'));
app.use('/merchant', require('../routes/merchant.routes'));
app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message, code: err.code || 'INTERNAL' }));

const M = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const CASHIER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const INST = '55555555-5555-4555-8555-555555555555';
const PASSWORD = 'Aa1!wave6-password';
const HASH = bcrypt.hashSync(PASSWORD, 4);
const tok = (sub, role) => signToken({ sub, merchantId: M, type: 'merchant', email: 'owner@test.io', role });
const owner = () => ({ Authorization: `Bearer ${tok(OWNER, 'owner')}`, 'Idempotency-Key': require('crypto').randomUUID() });
const cashier = () => ({ Authorization: `Bearer ${tok(CASHIER, 'cashier')}`, 'Idempotency-Key': require('crypto').randomUUID() });
const admin = (role = 'ops_admin') => ({ Authorization: `Bearer ${signToken({ sub: ADMIN, type: 'admin', role, email: 'admin@test.io' })}` });
const confirm = { password: PASSWORD };
const uuid = () => require('crypto').randomUUID();
const one = async (text, params) => (await sql(text, params)).rows[0];
const count = async (text, params) => Number((await sql(text, params)).rows[0].n);
const flush = () => new Promise((r) => setImmediate(r));

const m010 = fs.readFileSync(path.resolve(__dirname, '../../database/010_audit_financial_integrity.sql'), 'utf8');
const m011 = fs.readFileSync(path.resolve(__dirname, '../../database/011_wave6_integrity.sql'), 'utf8');

beforeAll(async () => {
  mockPg = new PGlite();
  await mockPg.exec(`
    CREATE TABLE merchants (merchant_id uuid PRIMARY KEY, business_name text, email text, currency text, country text, kyb_level int DEFAULT 1,
      merchant_status text DEFAULT 'active', settlement_type text DEFAULT 'bank', settlement_account text, settlement_provider text,
      cash_wallet_operator text, cash_wallet_phone text, cash_wallet_verified_at timestamptz, updated_at timestamptz DEFAULT NOW());
    CREATE TABLE merchant_users (user_id uuid PRIMARY KEY, merchant_id uuid, email text, password_hash text, mfa_enabled boolean DEFAULT false, mfa_secret text, role text DEFAULT 'owner');
    CREATE TABLE settlement_batches (batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid, batch_date date, total_gross numeric, total_fees numeric, total_net numeric, currency text, txn_count int, settlement_type text, settlement_account text, settlement_provider text, status text, completed_at timestamptz, submitted_at timestamptz, failure_reason text, payout_ref text);
    CREATE TABLE transactions (transaction_id uuid PRIMARY KEY, merchant_id uuid, type text, amount numeric, currency text, payment_method text, status text, fee_amount numeric, net_amount numeric,
      gateway_name text, gateway_payment_id text, gateway_order_id text, auth_code text, description text, initiated_at timestamptz DEFAULT NOW(), completed_at timestamptz,
      settlement_status text, settlement_batch_id uuid, pay_link_id uuid, detected_operator text, detected_network text, detected_country text, device_id text, response_code text, response_message text);
    CREATE TABLE settlement_queue (id serial PRIMARY KEY, transaction_id uuid UNIQUE REFERENCES transactions(transaction_id), merchant_id uuid, amount numeric, currency text, queued_at timestamptz DEFAULT NOW(), settled boolean DEFAULT false, batch_id uuid, settled_at timestamptz, fee_amount numeric, net_amount numeric);
    CREATE TABLE transaction_events (event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), transaction_id uuid, merchant_id uuid, event_type text NOT NULL, payload jsonb, created_at timestamptz DEFAULT NOW());
    CREATE TABLE pay_links (pay_link_id uuid PRIMARY KEY, merchant_id uuid, short_id text, amount numeric, currency text, status text DEFAULT 'pending', paid_at timestamptz, paid_amount numeric, type text, short_url text, expires_at timestamptz, description text);
    CREATE TABLE idempotency_keys (merchant_id uuid NOT NULL, endpoint varchar(128) NOT NULL, key varchar(128) NOT NULL, request_hash char(64) NOT NULL, status_code int, response_body jsonb, created_at timestamptz DEFAULT NOW(), completed_at timestamptz, PRIMARY KEY (merchant_id, endpoint, key));
    CREATE TABLE audit_logs (log_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid, actor_type text, actor_email text, action text, entity_type text, entity_id uuid, old_values jsonb, new_values jsonb, ip_address text, created_at timestamptz DEFAULT NOW());
    CREATE TABLE merchant_fees (merchant_id uuid, txn_type text, operator text, fee_rate numeric);
    CREATE TABLE financial_institutions (institution_id uuid PRIMARY KEY, code text, name text, type text DEFAULT 'bank', country text, status text DEFAULT 'active');
    CREATE TABLE bank_accounts (account_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_type text NOT NULL, owner_id uuid NOT NULL, institution_id uuid, account_number text NOT NULL, account_name text NOT NULL,
      iban text, status text NOT NULL DEFAULT 'verified', is_default boolean DEFAULT false, created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW());
    CREATE TABLE merchant_transfers (transfer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL, direction text DEFAULT 'payout', dest_type text, bank_account_id uuid, wallet_operator text, wallet_phone text,
      amount numeric NOT NULL, fee numeric DEFAULT 0, net_amount numeric, currency text, status text DEFAULT 'pending', reference text, description text, gateway_reference text, error_message text,
      settlement_method text, settled_by uuid, settlement_ref text, admin_note text, settled_at timestamptz, completed_at timestamptz, created_at timestamptz DEFAULT NOW(), updated_at timestamptz DEFAULT NOW(),
      bank_reference text, executed_by uuid, instructions jsonb, events jsonb DEFAULT '[]'::jsonb, expires_at timestamptz, cancelled_at timestamptz, amount_requested numeric);
    ALTER TABLE merchant_transfers ADD CONSTRAINT merchant_transfers_status_check CHECK (status IN ('pending','processing','pending_settlement','pending_manual','awaiting_funds','completed','failed','cancelled','rejected'));
  `);
  await mockPg.exec(m010);
  await mockPg.exec(m011);
}, 60000);
afterAll(async () => { if (mockPg) await mockPg.close(); });

const reset = async (merchant = {}) => {
  jest.clearAllMocks();
  mockFraud.mockResolvedValue({ action: 'allow', score: 0 });
  mockSendPayout.mockReset(); mockProcessPayment.mockReset(); mockMtnTransfer.mockReset(); mockMtnStatus.mockReset();
  mockEmail.mockResolvedValue({ success: true });
  cash._resetStepUp();
  orchestrator._resetFraudAlertClock();
  delete process.env.CASH_UNKNOWN_GRACE_MINUTES; delete process.env.CASH_UNKNOWN_ALERT_HOURS;
  delete process.env.FRAUD_DEGRADED_MODE; delete process.env.FRAUD_DEGRADED_MAX_AMOUNT;
  await mockPg.exec('TRUNCATE beneficiary_events, audit_logs, idempotency_keys, pay_links, transaction_events, settlement_queue, transactions, settlement_batches, merchant_transfers, bank_accounts, financial_institutions, merchant_fees, merchant_users, merchants CASCADE');
  const m = { country: 'CM', wallet_op: 'orange_money', wallet_phone: '+237690000001', ...merchant };
  await sql(`INSERT INTO merchants (merchant_id, business_name, email, currency, country, kyb_level, cash_wallet_operator, cash_wallet_phone) VALUES ($1,'Boutique','owner@test.io','XAF',$2,1,$3,$4)`, [M, m.country, m.wallet_op, m.wallet_phone]);
  await sql(`INSERT INTO merchant_users (user_id, merchant_id, email, password_hash, role) VALUES ($1,$2,'owner@test.io',$3,'owner'), ($4,$2,'cashier@test.io',$3,'cashier')`, [OWNER, M, HASH, CASHIER]);
  await sql(`INSERT INTO financial_institutions (institution_id, code, name, country) VALUES ($1,'BKX','Banque X','CM')`, [INST]);
  // 100 000 XAF encaissés (net) → solde disponible
  await sql(`INSERT INTO transactions (transaction_id, merchant_id, type, amount, currency, payment_method, status, fee_amount, net_amount, detected_operator, completed_at) VALUES ($1,$2,'collect',101500,'XAF','mobile_money','authorized',1500,100000,'ORANGE_MONEY',NOW())`, [uuid(), M]);
  mockGetStatus.mockResolvedValue({ available: true, status: 'PENDING' });
};
const available = async () => (await cash.computeAvailableBalance(sql, M)).available;
const withdraw = (body, headers = {}) => request(app).post('/merchant/cash/withdraw').set(owner()).set(headers).send({ amount: 50000, confirm, ...body });
const transfer = (id) => one('SELECT * FROM merchant_transfers WHERE transfer_id=$1', [id]);

// ═══════════════════════════════════════════════════════════════════
describe('1. Résultat opérateur incertain → statut unknown, réservation conservée', () => {
  beforeEach(() => reset());

  test('migration 011 rejouable ; CHECK historique sur le statut levée ; unknown compté comme réservé', async () => {
    await mockPg.exec(m011);
    expect(cash.OUT_NOT_FAILED).toContain('unknown'); expect(cash.OUT_INFLIGHT).toContain('unknown');
    await sql(`INSERT INTO merchant_transfers (merchant_id, direction, dest_type, amount, currency, status) VALUES ($1,'payout','wallet',30000,'XAF','unknown')`, [M]);
    expect(await available()).toBe(70000);
    expect((await cash.computeAvailableBalance(sql, M)).reserved).toBe(30000);
  });

  test('classification : refus explicite = declined ; timeout / 5xx / 96 / réponse vide = unknown', () => {
    expect(cash.classifyRailResult({ approved: false, pending: false, responseCode: '05', declineReason: 'Compte inactif' })).toBe('declined');
    expect(cash.classifyRailResult({ approved: false, responseCode: '96', declineReason: 'Service de retrait indisponible', retryable: true })).toBe('unknown');
    expect(cash.classifyRailResult({ approved: true })).toBe('completed');
    expect(cash.classifyRailResult({ pending: true, approved: false })).toBe('accepted');
    expect(cash.classifyRailResult(null)).toBe('unknown');
    expect(cash.classifyRailResult({})).toBe('unknown');
    expect(cash.classifyRailError(Object.assign(new Error('MTN timeout after 30000ms')))).toBe('unknown');
    expect(cash.classifyRailError(Object.assign(new Error('MTN transfer failed: 503'), { statusCode: 503 }))).toBe('unknown');
    expect(cash.classifyRailError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe('unknown');
    expect(cash.classifyRailError(Object.assign(new Error('MTN transfer failed: 400 bad msisdn'), { statusCode: 400 }))).toBe('declined');
    expect(cash.classifyRailError(Object.assign(new Error('x'), { outcome: 'declined' }))).toBe('declined');
  });

  test('routeur MM indisponible (96) → 201 unknown, request_payload + unknown_since, fonds réservés ; SUCCESS opérateur → completed', async () => {
    mockSendPayout.mockResolvedValue({ approved: false, pending: false, responseCode: '96', declineReason: 'Service de retrait indisponible', retryable: true });
    const r = await withdraw({});
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'unknown', outcome: 'unknown', amount: 50000, fee: 500, net: 49500 });
    const t = await transfer(r.body.transferId);
    expect(t.status).toBe('unknown'); expect(t.unknown_since).toBeTruthy(); expect(t.needs_review).toBe(false);
    expect(t.request_payload).toMatchObject({ gateway: 'orange_cm', amount: 49500, currency: 'XAF', externalId: r.body.reference });
    expect(t.request_payload.phoneMasked).toMatch(/^\*+001$/);
    expect(t.events.map((e) => e.type)).toEqual(['created', 'unknown']);
    expect(await available()).toBe(50000);           // réservation conservée
    // l'opérateur confirme l'exécution → completed (via GET /transfers/:id)
    mockGetStatus.mockResolvedValue({ available: true, status: 'SUCCESSFUL', gatewayRef: 'OP-REF-1' });
    const g = await request(app).get(`/merchant/cash/transfers/${r.body.transferId}`).set(owner());
    expect(g.status).toBe(200); expect(g.body.status).toBe('completed');
    expect(mockGetStatus).toHaveBeenCalledWith(expect.objectContaining({ txnId: r.body.transferId, product: 'disbursement' }));
    const t2 = await transfer(r.body.transferId);
    expect(t2.status).toBe('completed'); expect(t2.gateway_reference).toBe('OP-REF-1'); expect(t2.needs_review).toBe(false);
    expect(await available()).toBe(50000);
    expect((await one('SELECT cash_wallet_verified_at FROM merchants WHERE merchant_id=$1', [M])).cash_wallet_verified_at).toBeTruthy();
  });

  test('unknown → l’opérateur répond FAILED → failed et fonds libérés ; refus explicite (05) → failed immédiat', async () => {
    mockSendPayout.mockResolvedValue({ approved: false, responseCode: '96', retryable: true });
    const r = await withdraw({});
    expect(r.body.status).toBe('unknown'); expect(await available()).toBe(50000);
    mockGetStatus.mockResolvedValue({ available: true, status: 'FAILED', reason: 'Solde opérateur insuffisant' });
    const sweep = await cash.sweepUncertainPayouts({});
    expect(sweep.summary).toMatchObject({ scanned: 1, failed: 1, still_uncertain: 0 });
    const t = await transfer(r.body.transferId);
    expect(t.status).toBe('failed'); expect(t.error_message).toBe('Solde opérateur insuffisant');
    expect(await available()).toBe(100000);
    // refus synchrone explicite
    mockSendPayout.mockResolvedValue({ approved: false, pending: false, responseCode: '05', declineReason: 'Compte inactif' });
    const d = await withdraw({});
    expect(d.status).toBe(502); expect(d.body).toMatchObject({ code: 'GATEWAY_ERROR', outcome: 'declined' });
    expect((await transfer(d.body.transferId)).status).toBe('failed');
    expect(await available()).toBe(100000);
  });

  test('client MTN (Congo) : timeout → unknown ; HTTP 400 → failed ; sans référence opérateur : reste unknown (pas d’interrogation possible)', async () => {
    await reset({ country: 'CG', wallet_op: 'mtn_momo', wallet_phone: '+242060000001' });
    mockMtnTransfer.mockRejectedValue(new Error('MTN timeout after 30000ms'));
    const r = await withdraw({});
    expect(r.status).toBe(201); expect(r.body.status).toBe('unknown');
    expect((await transfer(r.body.transferId)).gateway_reference).toBeNull();
    expect(await available()).toBe(50000);
    const g = await request(app).get(`/merchant/cash/transfers/${r.body.transferId}`).set(owner());
    expect(g.body.status).toBe('unknown'); expect(mockMtnStatus).not.toHaveBeenCalled();
    expect((await transfer(r.body.transferId)).last_status_check_at).toBeTruthy();
    mockMtnTransfer.mockRejectedValue(Object.assign(new Error('MTN transfer failed: 400 {"code":"PAYEE_NOT_FOUND"}'), { statusCode: 400 }));
    const d = await withdraw({});
    expect(d.status).toBe(502); expect(d.body.outcome).toBe('declined');
    expect((await transfer(d.body.transferId)).status).toBe('failed');
    expect(await available()).toBe(50000);
  });

  test('« introuvable » chez l’opérateur : jamais failed avant CASH_UNKNOWN_GRACE_MINUTES', async () => {
    mockSendPayout.mockResolvedValue({ approved: false, responseCode: '96', retryable: true });
    const r = await withdraw({});
    mockGetStatus.mockResolvedValue({ available: true, status: 'NOT_FOUND' });
    let out = await cash.refreshPayoutStatus(await cash.getTransfer(r.body.transferId));
    expect(out.status).toBe('unknown'); expect(out._statusCheck).toBe('not_found_in_grace');
    process.env.CASH_UNKNOWN_GRACE_MINUTES = '0';
    out = await cash.refreshPayoutStatus(await cash.getTransfer(r.body.transferId));
    expect(out.status).toBe('failed');
    expect(out.events.at(-1)).toMatchObject({ type: 'failed', reason: 'not_found_after_grace' });
    expect(await available()).toBe(100000);
    // erreur réseau au poll : statut conservé
    mockSendPayout.mockResolvedValue({ approved: false, responseCode: '96', retryable: true });
    const r2 = await withdraw({});
    mockGetStatus.mockRejectedValue(new Error('ECONNRESET'));
    out = await cash.refreshPayoutStatus(await cash.getTransfer(r2.body.transferId), { graceMinutes: 0 });
    expect(out.status).toBe('unknown'); expect(out._statusCheck).toBe('error');
  });

  test('après CASH_UNKNOWN_ALERT_HOURS : needs_review + e-mail ops une seule fois ; reconcileUncertainPayouts couvre aussi les décaissements pending_unknown', async () => {
    mockSendPayout.mockResolvedValue({ approved: false, responseCode: '96', retryable: true });
    const r = await withdraw({});
    mockEmail.mockClear();
    let s = await cash.sweepUncertainPayouts({});
    expect(s.summary).toMatchObject({ still_uncertain: 1, flagged: 0 }); expect(mockEmail).not.toHaveBeenCalled();
    await sql(`UPDATE merchant_transfers SET unknown_since = NOW() - INTERVAL '3 hours' WHERE transfer_id=$1`, [r.body.transferId]);
    s = await cash.sweepUncertainPayouts({});
    expect(s.summary.flagged).toBe(1); expect(s.results[0]).toMatchObject({ needsReview: true, alerted: true });
    expect(mockEmail).toHaveBeenCalledTimes(1);
    expect(mockEmail.mock.calls[0][0].subject).toMatch(/incertain/);
    const t = await transfer(r.body.transferId);
    expect(t.needs_review).toBe(true); expect(t.review_alerted_at).toBeTruthy(); expect(t.status).toBe('unknown');
    s = await cash.sweepUncertainPayouts({});
    expect(s.summary.flagged).toBe(0); expect(mockEmail).toHaveBeenCalledTimes(1);
    // admin : liste needsReview, détail avec contexte, stats
    const list = await request(app).get('/admin/cash/transfers?needsReview=1').set(admin());
    expect(list.body.total).toBe(1); expect(list.body.data[0]).toMatchObject({ status: 'unknown', needsReview: true });
    const detail = await request(app).get(`/admin/cash/transfers/${r.body.transferId}`).set(admin());
    expect(detail.body).toMatchObject({ status: 'unknown', needsReview: true, requestPayload: expect.objectContaining({ gateway: 'orange_cm' }) });
    expect(detail.body.context).toHaveProperty('beneficiaryHistory');
    const stats = await request(app).get('/admin/cash/stats').set(admin());
    expect(stats.body.queues.unknown).toEqual({ count: 1, amount: 50000 }); expect(stats.body.queues.needsReview).toEqual({ count: 1 });
    // décaissement orchestrateur pending_unknown sans référence → alerte ops après le délai (une fois)
    const txn = uuid();
    await sql(`INSERT INTO transactions (transaction_id, merchant_id, type, amount, currency, payment_method, status, response_message, detected_operator, initiated_at) VALUES ($1,$2,'payout',10000,'XAF','mobile_money','pending','pending_unknown','MTN_MOMO',NOW() - INTERVAL '5 hours')`, [txn, M]);
    const rr = await reconcile.reconcileUncertainPayouts({});
    expect(rr.transactions).toMatchObject({ scanned: 1, flagged: 1 });
    expect(mockEmail).toHaveBeenCalledTimes(2);
    expect(await count(`SELECT COUNT(*)::int AS n FROM transaction_events WHERE transaction_id=$1 AND event_type='PAYOUT_NEEDS_REVIEW'`, [txn])).toBe(1);
    expect((await reconcile.reconcileUncertainPayouts({})).transactions.scanned).toBe(0);
    // admin : rejet manuel impossible tant que unknown (REJECTABLE inchangé) ; mark-executed non plus → décision ops documentée
    const rej = await request(app).post(`/admin/cash/transfers/${r.body.transferId}/reject`).set(admin()).send({ reason: 'test' });
    expect(rej.status).toBe(409);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('2. Idempotence durable sur les endpoints monétaires', () => {
  beforeEach(() => reset());
  const KEY = 'wave6-idem-key-0001';

  test('same key: missing confirmation, invalid TOTP, valid TOTP, then replay without a second payout', async () => {
    const speakeasy = require('speakeasy');
    const secret = speakeasy.generateSecret({ length: 20 }).base32;
    await sql('UPDATE merchant_users SET mfa_enabled=TRUE, mfa_secret=$1 WHERE user_id=$2', [secret, OWNER]);
    const headers = { 'Idempotency-Key': 'durable-totp-intent-001' };
    expect((await withdraw({ confirm: undefined }, headers)).status).toBe(428);
    expect((await withdraw({ confirm: { code: 'invalid' } }, headers)).status).toBe(428);
    expect(await count('SELECT COUNT(*)::int AS n FROM merchant_transfers')).toBe(0);
    expect(mockSendPayout).not.toHaveBeenCalled();
    mockSendPayout.mockResolvedValue({ approved: true, reference: 'PAYOUT-ONE' });
    const r = await withdraw({ confirm: { code: speakeasy.totp({ secret, encoding: 'base32' }) } }, headers);
    expect(r.status).toBe(201); await flush();
    const replay = await withdraw({ confirm: { code: 'renewed-code' } }, headers);
    expect(replay.status).toBe(201); expect(replay.body.transferId).toBe(r.body.transferId);
    expect(await count('SELECT COUNT(*)::int AS n FROM merchant_transfers')).toBe(1);
    expect(mockSendPayout).toHaveBeenCalledTimes(1);
  });

  test('5xx après création de l’ordre → clé conservée avec la ressource ; rejeu = ordre d’origine, aucun doublon', async () => {
    mockSendPayout.mockResolvedValue({ approved: false, pending: false, responseCode: '05', declineReason: 'Compte inactif' });
    const first = await withdraw({}, { 'Idempotency-Key': KEY });
    expect(first.status).toBe(502); await flush();
    const key = await one('SELECT * FROM idempotency_keys');
    expect(key).toMatchObject({ status_code: null, in_progress: false, resource_type: 'merchant_transfer', resource_id: first.body.transferId });
    expect(key.last_error).toBe('GATEWAY_ERROR');
    mockSendPayout.mockClear();
    const replay = await withdraw({}, { 'Idempotency-Key': KEY });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, code: 'IDEMPOTENCY_REPLAY', resourceType: 'merchant_transfer', transferId: first.body.transferId, status: 'failed' });
    expect(mockSendPayout).not.toHaveBeenCalled();
    expect(await count('SELECT COUNT(*)::int AS n FROM merchant_transfers')).toBe(1);
    // corps différent → 409 conflit (inchangé)
    expect((await withdraw({ amount: 60000 }, { 'Idempotency-Key': KEY })).status).toBe(409);
  });

  test('ordre `unknown` : réponse 201 rejouée telle quelle ; ressource attachée AVANT l’appel rail', async () => {
    mockSendPayout.mockImplementation(async ({ txnId }) => {
      const k = await one('SELECT resource_id, resource_type FROM idempotency_keys');
      expect(k).toEqual({ resource_id: txnId, resource_type: 'merchant_transfer' });   // attachée avant l'appel opérateur
      return { approved: false, responseCode: '96', retryable: true };
    });
    const first = await withdraw({}, { 'Idempotency-Key': KEY });
    expect(first.status).toBe(201); expect(first.body.status).toBe('unknown'); await flush();
    const replay = await withdraw({}, { 'Idempotency-Key': KEY });
    expect(replay.status).toBe(201); expect(replay.body).toEqual(first.body);
    expect(mockSendPayout).toHaveBeenCalledTimes(1);
    expect(await count('SELECT COUNT(*)::int AS n FROM merchant_transfers')).toBe(1);
  });

  test('handler interrompu sans ressource → 409 IDEMPOTENCY_RETRY_AFTER_ERROR ; endpoint non monétaire → clé libérée (vague 2)', async () => {
    const mini = express(); mini.use(express.json());
    mini.use((req, _res, next) => { req.user = { merchantId: M }; next(); });
    let boom = true;
    mini.post('/cash/withdraw', idempotency, (_req, res) => boom ? res.status(500).json({ error: 'db down' }) : res.status(201).json({ ok: true }));
    mini.post('/transfer/payout', idempotency, (_req, _res) => { throw new Error('crash'); });
    mini.post('/api/v1/collect', idempotency, async (req, res) => { await attachResource(req, { type: 'transaction', id: TXN }); res.status(503).json({ error: 'late failure', txnId: TXN }); });
    mini.post('/other', idempotency, (_req, res) => res.status(500).json({ error: 'x' }));
    mini.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
    const TXN = uuid();
    await sql(`INSERT INTO transactions (transaction_id, merchant_id, type, amount, currency, status) VALUES ($1,$2,'collect',1000,'XAF','pending')`, [TXN, M]);

    expect((await request(mini).post('/cash/withdraw').set('Idempotency-Key', KEY).send({ a: 1 })).status).toBe(500); await flush();
    boom = false;
    const r = await request(mini).post('/cash/withdraw').set('Idempotency-Key', KEY).send({ a: 1 });
    expect(r.status).toBe(409); expect(r.body).toMatchObject({ code: 'IDEMPOTENCY_RETRY_AFTER_ERROR', lastError: 'db down' });
    expect(await count('SELECT COUNT(*)::int AS n FROM idempotency_keys')).toBe(1);

    expect((await request(mini).post('/transfer/payout').set('Idempotency-Key', 'k2-' + KEY).send({})).status).toBe(500); await flush();
    expect((await request(mini).post('/transfer/payout').set('Idempotency-Key', 'k2-' + KEY).send({})).body.code).toBe('IDEMPOTENCY_RETRY_AFTER_ERROR');

    expect((await request(mini).post('/api/v1/collect').set('Idempotency-Key', 'k3-' + KEY).send({})).status).toBe(503); await flush();
    const rep = await request(mini).post('/api/v1/collect').set('Idempotency-Key', 'k3-' + KEY).send({});
    expect(rep.status).toBe(200); expect(rep.body).toMatchObject({ replayed: true, resourceType: 'transaction', txnId: TXN, status: 'pending' });

    expect((await request(mini).post('/other').set('Idempotency-Key', 'k4-' + KEY).send({})).status).toBe(500); await flush();
    expect(await count(`SELECT COUNT(*)::int AS n FROM idempotency_keys WHERE key=$1`, ['k4-' + KEY])).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('3. Finalisation atomique (authorized + file de règlement + lien)', () => {
  const LINK = '66666666-6666-4666-8666-666666666666';
  let TXN;
  beforeEach(async () => {
    await reset();
    TXN = uuid();
    await sql(`INSERT INTO pay_links (pay_link_id, merchant_id, amount, currency, status) VALUES ($1,$2,5000,'XAF','pending')`, [LINK, M]);
    await sql(`INSERT INTO transactions (transaction_id, merchant_id, type, amount, currency, payment_method, status, detected_operator, pay_link_id, gateway_payment_id) VALUES ($1,$2,'pay_link',5000,'XAF','mobile_money','pending','ORANGE_MONEY',$3,'NOTIF-1')`, [TXN, M, LINK]);
  });
  const txn = () => ({ transaction_id: TXN, merchant_id: M, type: 'pay_link', amount: '5000', currency: 'XAF', pay_link_id: LINK });
  const stillPending = async () => {
    expect((await one('SELECT status, auth_code FROM transactions WHERE transaction_id=$1', [TXN])).status).toBe('pending');
    expect(await count('SELECT COUNT(*)::int AS n FROM settlement_queue')).toBe(0);
    expect(await count('SELECT COUNT(*)::int AS n FROM transaction_events')).toBe(0);
    expect((await one('SELECT status FROM pay_links WHERE pay_link_id=$1', [LINK])).status).toBe('pending');
  };

  test('échec injecté à chaque écriture → rollback complet ; rejeu → appliqué une fois ; jamais deux lignes de file', async () => {
    const fin = () => finalizeTransaction({ txn: txn(), provider: 'orange', outcome: 'authorized', authCode: 'MP1', gatewayRef: 'NOTIF-1' });
    await mockPg.exec(`ALTER TABLE transaction_events ADD CONSTRAINT t_evt CHECK (event_type <> 'ORANGE_CALLBACK')`);
    await expect(fin()).rejects.toBeDefined(); await stillPending();
    await mockPg.exec('ALTER TABLE transaction_events DROP CONSTRAINT t_evt');
    await mockPg.exec('ALTER TABLE settlement_queue ADD CONSTRAINT t_sq CHECK (amount < 0)');
    await expect(fin()).rejects.toBeDefined(); await stillPending();
    await mockPg.exec('ALTER TABLE settlement_queue DROP CONSTRAINT t_sq');
    await mockPg.exec(`ALTER TABLE pay_links ADD CONSTRAINT t_pl CHECK (status <> 'paid')`);
    await expect(fin()).rejects.toBeDefined(); await stillPending();
    await mockPg.exec('ALTER TABLE pay_links DROP CONSTRAINT t_pl');
    // rejeu : tout est appliqué dans un seul COMMIT
    expect(await fin()).toEqual({ applied: true, status: 'authorized' });
    const t = await one('SELECT * FROM transactions WHERE transaction_id=$1', [TXN]);
    expect(t).toMatchObject({ status: 'authorized', auth_code: 'MP1', response_code: '00' });
    expect(Number(t.fee_amount)).toBe(60); expect(Number(t.net_amount)).toBe(4940);
    expect(await count('SELECT COUNT(*)::int AS n FROM settlement_queue WHERE transaction_id=$1', [TXN])).toBe(1);
    expect((await one('SELECT status, paid_amount FROM pay_links WHERE pay_link_id=$1', [LINK]))).toMatchObject({ status: 'paid', paid_amount: '5000' });
    expect((await one(`SELECT event_type FROM transaction_events WHERE transaction_id=$1`, [TXN])).event_type).toBe('ORANGE_CALLBACK');
    // second rejeu : rien ne change
    expect(await fin()).toEqual({ applied: false, status: 'already_processed' });
    expect(await count('SELECT COUNT(*)::int AS n FROM settlement_queue')).toBe(1);
    expect(await count('SELECT COUNT(*)::int AS n FROM transaction_events')).toBe(1);
    expect(await available()).toBe(104940);
  });

  test('failed : aucune file, lien intact ; payout autorisé : jamais enfilé', async () => {
    expect(await finalizeTransaction({ txn: txn(), provider: 'orange', outcome: 'failed', reason: 'Refusé' })).toEqual({ applied: true, status: 'failed' });
    expect((await one('SELECT status, response_message FROM transactions WHERE transaction_id=$1', [TXN]))).toMatchObject({ status: 'failed', response_message: 'Refusé' });
    expect(await count('SELECT COUNT(*)::int AS n FROM settlement_queue')).toBe(0);
    expect((await one('SELECT status FROM pay_links WHERE pay_link_id=$1', [LINK])).status).toBe('pending');
    const P = uuid();
    await sql(`INSERT INTO transactions (transaction_id, merchant_id, type, amount, currency, payment_method, status, detected_operator) VALUES ($1,$2,'payout',5000,'XAF','mobile_money','pending','MTN_MOMO')`, [P, M]);
    expect(await finalizeTransaction({ txn: { transaction_id: P, merchant_id: M, type: 'payout', amount: '5000', currency: 'XAF' }, provider: 'mtn', outcome: 'authorized', source: 'reconcile' })).toMatchObject({ applied: true });
    expect(await count('SELECT COUNT(*)::int AS n FROM settlement_queue')).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('4. Job de réparation settlement_queue', () => {
  beforeEach(() => reset());

  test('authorized sans ligne de file depuis > 5 min → enfilé + événement ; idempotent ; récent ou déjà réglé ignoré', async () => {
    const old = uuid(); const recent = uuid(); const settled = uuid(); const payout = uuid();
    await sql(`INSERT INTO transactions (transaction_id, merchant_id, type, amount, currency, status, fee_amount, net_amount, completed_at) VALUES ($1,$2,'collect',1000,'XAF','authorized',15,985,NOW() - INTERVAL '10 minutes')`, [old, M]);
    await sql(`INSERT INTO transactions (transaction_id, merchant_id, type, amount, currency, status, fee_amount, net_amount, completed_at) VALUES ($1,$2,'collect',1000,'XAF','authorized',15,985,NOW() - INTERVAL '1 minute')`, [recent, M]);
    await sql(`INSERT INTO transactions (transaction_id, merchant_id, type, amount, currency, status, fee_amount, net_amount, completed_at, settlement_status) VALUES ($1,$2,'collect',1000,'XAF','authorized',15,985,NOW() - INTERVAL '1 day','regle')`, [settled, M]);
    await sql(`INSERT INTO transactions (transaction_id, merchant_id, type, amount, currency, status, fee_amount, net_amount, completed_at) VALUES ($1,$2,'payout',1000,'XAF','authorized',0,1000,NOW() - INTERVAL '1 day')`, [payout, M]);
    const r = await sweepAuthorizedWithoutQueue({});
    expect(r).toMatchObject({ scanned: 1, repaired: 1, errors: 0, transactionIds: [old] });
    expect(await count('SELECT COUNT(*)::int AS n FROM settlement_queue')).toBe(1);
    expect((await one('SELECT merchant_id, amount, currency FROM settlement_queue WHERE transaction_id=$1', [old]))).toMatchObject({ merchant_id: M, amount: '1000', currency: 'XAF' });
    expect(await count(`SELECT COUNT(*)::int AS n FROM transaction_events WHERE transaction_id=$1 AND event_type='SETTLEMENT_QUEUE_REPAIRED'`, [old])).toBe(1);
    expect(await sweepAuthorizedWithoutQueue({})).toMatchObject({ scanned: 0, repaired: 0 });
    const all = await sweepAuthorizedWithoutQueue({ minAgeMinutes: 0 });   // + l'encaissement de reset() (completed_at = NOW())
    expect(all.transactionIds).toEqual(expect.arrayContaining([recent])); expect(all.repaired).toBe(2);
    expect(await count('SELECT COUNT(*)::int AS n FROM settlement_queue')).toBe(3);
  });

  test('POST /admin/cash/repair/settlement-queue : ops_admin / super_admin, audit ; support refusé', async () => {
    const old = uuid();
    await sql(`INSERT INTO transactions (transaction_id, merchant_id, type, amount, currency, status, fee_amount, net_amount, completed_at) VALUES ($1,$2,'qr_payment',2000,'XAF','authorized',30,1970,NOW() - INTERVAL '1 hour')`, [old, M]);
    expect((await request(app).post('/admin/cash/repair/settlement-queue').set(admin('support_agent')).send({})).status).toBe(403);
    const r = await request(app).post('/admin/cash/repair/settlement-queue').set(admin('super_admin')).send({});
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ success: true, repaired: 1, transactionIds: [old] });
    expect(await count(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE action='SETTLEMENT_QUEUE_REPAIR'`)).toBe(1);
    expect(await count('SELECT COUNT(*)::int AS n FROM settlement_queue')).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('5. Bénéficiaires : rôle owner, step-up, vérification des comptes bancaires, historique', () => {
  beforeEach(() => reset());
  const bankBody = { institutionId: INST, accountNumber: '12345678901', accountName: 'Boutique SARL' };

  test('PUT /cash/wallet : cashier → 403 INSUFFICIENT_ROLE ; owner sans confirm → 428 ; owner + mot de passe → 200 + historique + audit + e-mail', async () => {
    let r = await request(app).put('/merchant/cash/wallet').set(cashier()).send({ operator: 'mtn_momo', phone: '+237670000001', confirm });
    expect(r.status).toBe(403); expect(r.body.code).toBe('INSUFFICIENT_ROLE');
    r = await request(app).put('/merchant/cash/wallet').set(owner()).send({ operator: 'mtn_momo', phone: '+237670000001' });
    expect(r.status).toBe(428); expect(r.body.code).toBe('STEP_UP_REQUIRED');
    r = await request(app).put('/merchant/cash/wallet').set(owner()).send({ operator: 'mtn_momo', phone: '+237670000001', confirm });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ operator: 'mtn_momo', phone: '+237670000001', verifiedAt: null });
    const ev = await one('SELECT * FROM beneficiary_events');
    expect(ev).toMatchObject({ merchant_id: M, actor_type: 'merchant', actor_id: OWNER, actor_role: 'owner', event_type: 'wallet_updated', entity_type: 'wallet' });
    expect(ev.old_values).toEqual({ operator: 'orange_money', phoneMasked: '**********001' });
    expect(ev.new_values).toEqual({ operator: 'mtn_momo', phoneMasked: '**********001' });
    expect(ev.ip_address).toBeTruthy();
    expect((await one(`SELECT * FROM audit_logs WHERE action='CASH_WALLET_UPDATE'`))).toMatchObject({ actor_type: 'merchant', actor_id: OWNER, entity_id: M });
    expect(mockEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@test.io', subject: expect.stringMatching(/Wallet/) }));
    // même wallet → aucun nouvel événement
    r = await request(app).put('/merchant/cash/wallet').set(owner()).send({ operator: 'mtn_momo', phone: '+237670000001', confirm });
    expect(r.status).toBe(200); expect(await count('SELECT COUNT(*)::int AS n FROM beneficiary_events')).toBe(1);
    const h = await request(app).get('/merchant/cash/beneficiaries/history').set(cashier());
    expect(h.status).toBe(200); expect(h.body.total).toBe(1); expect(h.body.data[0]).toMatchObject({ type: 'wallet_updated', actor: { role: 'owner' } });
  });

  test('POST /bank-accounts : owner + step-up → pending_verification, inutilisable pour wallet_to_bank jusqu’à vérification admin', async () => {
    let r = await request(app).post('/merchant/bank-accounts').set(cashier()).send({ ...bankBody, confirm });
    expect(r.status).toBe(403); expect(r.body.code).toBe('INSUFFICIENT_ROLE');
    r = await request(app).post('/merchant/bank-accounts').set(owner()).send(bankBody);
    expect(r.status).toBe(428);
    r = await request(app).post('/merchant/bank-accounts').set(owner()).send({ ...bankBody, confirm });
    expect(r.status).toBe(201); expect(r.body).toMatchObject({ status: 'pending_verification', usable: false, accountNumber: '*******8901' });
    const accountId = r.body.accountId;
    expect((await one('SELECT status, created_by FROM bank_accounts WHERE account_id=$1', [accountId]))).toEqual({ status: 'pending_verification', created_by: OWNER });
    expect((await one(`SELECT event_type, new_values FROM beneficiary_events`))).toMatchObject({ event_type: 'bank_account_added', new_values: expect.objectContaining({ accountMasked: '*******8901', bankName: 'Banque X' }) });
    expect(mockEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@test.io', subject: expect.stringMatching(/ajouté/) }));
    const list = await request(app).get('/merchant/bank-accounts').set(cashier());
    expect(list.body.data[0]).toMatchObject({ accountId, status: 'pending_verification', usable: false });
    // transfert vers un compte non vérifié : refusé, aucune réservation
    let t = await request(app).post('/merchant/cash/transfers').set(owner()).send({ direction: 'wallet_to_bank', accountId, amount: 20000, confirm });
    expect(t.status).toBe(404); expect(t.body.code).toBe('BANK_ACCOUNT_NOT_FOUND');
    expect(await count('SELECT COUNT(*)::int AS n FROM merchant_transfers')).toBe(0);
    // vérification admin
    let v = await request(app).post(`/admin/cash/bank-accounts/${accountId}/verify`).set(admin('support_agent')).send({ method: 'document', reference: 'RIB-2026-01' });
    expect(v.status).toBe(403);
    v = await request(app).post(`/admin/cash/bank-accounts/${accountId}/verify`).set(admin()).send({ method: 'fax', reference: 'x' });
    expect(v.status).toBe(422);
    v = await request(app).post(`/admin/cash/bank-accounts/${accountId}/verify`).set(admin()).send({ method: 'document' });
    expect(v.status).toBe(422);
    mockEmail.mockClear();
    v = await request(app).post(`/admin/cash/bank-accounts/${accountId}/verify`).set(admin()).send({ method: 'document', reference: 'RIB-2026-01' });
    expect(v.status).toBe(200); expect(v.body).toMatchObject({ success: true, status: 'verified', method: 'document', reference: 'RIB-2026-01' });
    expect((await one('SELECT status, verified_by, verification_method, verification_reference FROM bank_accounts WHERE account_id=$1', [accountId]))).toEqual({ status: 'verified', verified_by: ADMIN, verification_method: 'document', verification_reference: 'RIB-2026-01' });
    expect(await count(`SELECT COUNT(*)::int AS n FROM beneficiary_events WHERE event_type='bank_account_verified' AND actor_type='admin'`)).toBe(1);
    expect(await count(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE action='BANK_ACCOUNT_VERIFY'`)).toBe(1);
    expect(mockEmail).toHaveBeenCalledTimes(1);
    expect((await request(app).post(`/admin/cash/bank-accounts/${accountId}/verify`).set(admin()).send({ method: 'manual', reference: 'again' })).status).toBe(409);
    expect((await request(app).get('/admin/cash/bank-accounts?status=verified').set(admin())).body.total).toBe(1);
    // désormais utilisable
    t = await request(app).post('/merchant/cash/transfers').set(owner()).send({ direction: 'wallet_to_bank', accountId, amount: 20000, confirm });
    expect(t.status).toBe(201); expect(t.body.status).toBe('pending_manual');
    expect(await available()).toBe(80000);
    // suppression : owner + step-up ; historique
    expect((await request(app).delete(`/merchant/bank-accounts/${accountId}`).set(cashier()).send({ confirm })).status).toBe(403);
    expect((await request(app).delete(`/merchant/bank-accounts/${accountId}`).set(owner()).send({})).status).toBe(428);
    const d = await request(app).delete(`/merchant/bank-accounts/${accountId}`).set(owner()).send({ confirm });
    expect(d.status).toBe(200); expect(d.body).toEqual({ success: true, accountId, status: 'removed' });
    expect((await one('SELECT status FROM bank_accounts WHERE account_id=$1', [accountId])).status).toBe('removed');
    expect((await request(app).delete(`/merchant/bank-accounts/${accountId}`).set(owner()).send({ confirm })).status).toBe(404);
    const h = await request(app).get('/merchant/cash/beneficiaries/history').set(owner());
    expect(h.body.data.map((e) => e.type)).toEqual(['bank_account_removed', 'bank_account_verified', 'bank_account_added']);
    const detail = await request(app).get(`/admin/cash/transfers/${t.body.transferId}`).set(admin());
    expect(detail.body.context.beneficiaryHistory).toHaveLength(3);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('6. Orchestrateur : antifraude dégradée et exception gateway', () => {
  beforeEach(() => reset());
  const collect = (amount = 50000) => orchestrator.processTransaction({ merchantId: M, type: 'collect', amount, customerPhone: '+237690000001' });
  const txnOf = (id) => one('SELECT status, response_message, response_code FROM transactions WHERE transaction_id=$1', [id]);
  const eventsOf = async (id) => (await sql('SELECT event_type, payload FROM transaction_events WHERE transaction_id=$1 ORDER BY created_at', [id])).rows;

  test('allow_limited (défaut) : ≤ 100 000 passe tagué fraud_degraded ; au-delà → 503 FRAUD_UNAVAILABLE et transaction failed', async () => {
    mockFraud.mockRejectedValue(new Error('redis down'));
    mockProcessPayment.mockResolvedValue({ approved: false, pending: true, responseCode: '09', _gateway: 'orange_cm' });
    const ok = await collect(50000);
    expect(ok).toMatchObject({ pending: true, status: 'pending' });
    expect(await eventsOf(ok.txnId)).toEqual(expect.arrayContaining([expect.objectContaining({ event_type: 'FRAUD_DEGRADED', payload: expect.objectContaining({ fraud_degraded: true, mode: 'allow_limited', maxAmount: 100000 }) })]));
    mockProcessPayment.mockClear();
    const ko = await collect(200000);
    expect(ko).toMatchObject({ success: false, code: 'FRAUD_UNAVAILABLE', statusCode: 503, fraudDegraded: true });
    expect(mockProcessPayment).not.toHaveBeenCalled();
    expect(await txnOf(ko.txnId)).toMatchObject({ status: 'failed', response_message: 'fraud_unavailable' });
    expect((await eventsOf(ko.txnId)).map((e) => e.event_type)).toEqual(['FRAUD_DEGRADED_REFUSED']);
    process.env.FRAUD_DEGRADED_MAX_AMOUNT = '300000';
    expect(await collect(200000)).toMatchObject({ pending: true });
    // alerte ops : une fois par 10 minutes
    expect(mockEmail).toHaveBeenCalledTimes(1);
    expect(mockEmail.mock.calls[0][0].subject).toMatch(/Antifraude indisponible/);
    orchestrator._resetFraudAlertClock();
    await collect(1000);
    expect(mockEmail).toHaveBeenCalledTimes(2);
    // la caisse renvoie 503
    delete process.env.FRAUD_DEGRADED_MAX_AMOUNT;
    const r = await request(app).post('/merchant/cash/collect').set(owner()).send({ method: 'mobile_money', amount: 200000, customerPhone: '+237690000001' });
    expect(r.status).toBe(503); expect(r.body.code).toBe('FRAUD_UNAVAILABLE');
  });

  test('block : tout refusé ; review : passe tagué ; moteur sain : inchangé', async () => {
    mockFraud.mockRejectedValue(new Error('down'));
    mockProcessPayment.mockResolvedValue({ approved: true, authCode: 'A1', responseCode: '00', _gateway: 'orange_cm' });
    process.env.FRAUD_DEGRADED_MODE = 'block';
    const b = await collect(100);
    expect(b).toMatchObject({ code: 'FRAUD_UNAVAILABLE', mode: 'block' }); expect(mockProcessPayment).not.toHaveBeenCalled();
    process.env.FRAUD_DEGRADED_MODE = 'review';
    const rv = await collect(2000000);   // > FRAUD_DEGRADED_MAX_AMOUNT, accepté en mode review
    expect(rv).toMatchObject({ success: true, status: 'authorized' });
    expect((await eventsOf(rv.txnId))[0]).toMatchObject({ event_type: 'FRAUD_DEGRADED', payload: expect.objectContaining({ mode: 'review' }) });
    expect(await count('SELECT COUNT(*)::int AS n FROM settlement_queue')).toBe(1);
    process.env.FRAUD_DEGRADED_MODE = 'nonsense';
    expect(orchestrator.fraudDegradedMode()).toBe('allow_limited');
    mockFraud.mockResolvedValue({ action: 'block', score: 100, blockReason: 'velocity' });
    expect(await collect(100)).toMatchObject({ success: false, error: expect.stringMatching(/bloquée/) });
    mockFraud.mockResolvedValue(undefined);          // décision absente = moteur indisponible
    expect(await collect(100)).toMatchObject({ pending: false, status: 'authorized' });
  });

  test('exception gateway : timeout → pending + pending_unknown + GATEWAY_UNKNOWN, puis finalisation possible ; 4xx → failed ; payout 96 → pending', async () => {
    mockProcessPayment.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    const u = await collect(5000);
    expect(u).toMatchObject({ success: false, pending: true, status: 'pending', outcome: 'unknown', code: 'GATEWAY_UNKNOWN' });
    expect(await txnOf(u.txnId)).toMatchObject({ status: 'pending', response_message: 'pending_unknown' });
    expect((await eventsOf(u.txnId)).map((e) => e.event_type)).toEqual(['GATEWAY_UNKNOWN']);
    // le webhook / la réconciliation tranchent (finalize exige status='pending')
    const fin = await finalizeTransaction({ txn: { transaction_id: u.txnId, merchant_id: M, type: 'collect', amount: '5000', currency: 'XAF' }, provider: 'orange', outcome: 'authorized', authCode: 'OK1' });
    expect(fin).toEqual({ applied: true, status: 'authorized' });
    expect(await count('SELECT COUNT(*)::int AS n FROM settlement_queue')).toBe(1);
    mockProcessPayment.mockRejectedValue(Object.assign(new Error('HTTP 422 invalid msisdn'), { statusCode: 422 }));
    const d = await collect(5000);
    expect(d).toMatchObject({ success: false, status: 'failed', outcome: 'declined' });
    expect(await txnOf(d.txnId)).toMatchObject({ status: 'failed' });
    // décaissement (fonds réservés) : résultat réseau normalisé par le routeur → pending_unknown, jamais failed
    mockSendPayout.mockResolvedValue({ approved: false, pending: false, responseCode: '96', declineReason: 'Service de retrait indisponible', retryable: true, _gateway: 'orange_cm' });
    const p = await orchestrator.processTransaction({ merchantId: M, type: 'payout', amount: 7000, customerPhone: '+237690000001' });
    expect(p).toMatchObject({ pending: true, status: 'pending', outcome: 'unknown' });
    expect(await txnOf(p.txnId)).toMatchObject({ status: 'pending', response_message: 'pending_unknown', response_code: '96' });
    expect(await available()).toBe(100000 + 4940 - 7000);   // réservation conservée
    // refus explicite d'un décaissement → failed (fonds libérés)
    mockSendPayout.mockResolvedValue({ approved: false, pending: false, responseCode: '05', declineReason: 'Refusé', _gateway: 'orange_cm' });
    const pd = await orchestrator.processTransaction({ merchantId: M, type: 'payout', amount: 7000, customerPhone: '+237690000001' });
    expect(pd).toMatchObject({ status: 'failed' });
    expect(await available()).toBe(100000 + 4940 - 7000);
  });
});
