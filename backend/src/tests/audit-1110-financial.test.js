'use strict';
/**
 * Audit du 10 novembre 2026, § 2 « risques financiers » — tests de régression.
 *   A. Identité de route : /withdraw, /Withdraw et /withdraw/ = une seule intention (clé exigée, un seul ordre,
 *      garde de capacité appliquée).
 *   B. Webhook lié à l'opérateur authentifié : un jeton Moov ne finalise pas un encaissement Orange.
 *   C. État d'envoi durable `sending`, revue des ordres incertains, décision Finance non écrasable par une
 *      réponse opérateur tardive, aucune libération automatique.
 * Données fictives, opérateurs simulés, PostgreSQL réel (PGlite) pour les services financiers.
 */
process.env.NODE_ENV = 'test';
const express = require('express');
const request = require('supertest');
const { PGlite } = require('@electric-sql/pglite');

let mockPg;
const sql = async (...args) => { const r = await mockPg.query(...args); return { ...r, rowCount: r.affectedRows ?? r.rows.length }; };
jest.mock('../config/database', () => ({
  query: (...a) => sql(...a),
  withTransaction: (fn) => mockPg.transaction((tx) => fn({ query: async (...a) => { const r = await tx.query(...a); return { ...r, rowCount: r.affectedRows ?? r.rows.length }; } })),
  pool: {},
}));
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/auth', () => ({ verifyTotp: jest.fn() }));
const mockSendPayout = jest.fn();
const mockStatus = jest.fn();
const mockEmail = jest.fn().mockResolvedValue({ success: true });
let mockProvider;
jest.mock('../services/mobilemoney/mobilemoney.router', () => ({
  getProvider: () => mockProvider, getConfig: async () => ({ apiKey: 'k', apiSecret: 's', baseUrl: 'https://operator.invalid' }),
  sendPayout: (...a) => mockSendPayout(...a), webhookUrl: jest.fn(),
  PROVIDERS: { orange_cg: true, moov_ci: true, airtel_cg: true, mtn_cg: true },
}));
jest.mock('../services/rails/mtn-momo.client', () => ({ getDisbursementStatus: (...a) => mockStatus(...a), getCollectionStatus: jest.fn() }));
jest.mock('../services/notifications/email.service', () => ({ send: (...a) => mockEmail(...a) }));
jest.mock('../services/settlement/settlement.queue', () => ({ enqueue: jest.fn().mockResolvedValue(undefined) }));

const { idempotency, isMoneyEndpoint } = require('../middleware/idempotency');
const { canonicalPath, routeIdentity } = require('../utils/route-identity');
const capability = require('../middleware/capability');
const registry = require('../services/capabilities/registry');
const cash = require('../services/cash/cash.service');
const webhooks = require('../routes/webhooks-mm.routes');

const M = '11111111-1111-4111-8111-111111111111';
const uuid = () => require('crypto').randomUUID();
const first = async (...a) => (await sql(...a)).rows[0];
const flush = () => new Promise((r) => setTimeout(r, 25));

beforeAll(async () => {
  mockPg = new PGlite();
  await mockPg.exec(`
    CREATE TABLE idempotency_keys (merchant_id TEXT, endpoint TEXT, key TEXT, request_hash TEXT, status_code INT, response_body JSONB,
      in_progress BOOLEAN DEFAULT TRUE, resource_type TEXT, resource_id TEXT, last_error TEXT, failed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(), completed_at TIMESTAMPTZ, PRIMARY KEY(merchant_id,endpoint,key));
    CREATE TABLE merchants(merchant_id uuid PRIMARY KEY, country text, currency text, business_name text, email text,
      cash_wallet_phone text, cash_wallet_operator text, cash_wallet_verified_at timestamptz, updated_at timestamptz,
      merchant_status text DEFAULT 'active', kyb_level int DEFAULT 1);
    CREATE TABLE financial_institutions(institution_id uuid PRIMARY KEY, name text);
    CREATE TABLE bank_accounts(account_id uuid PRIMARY KEY, institution_id uuid, account_number text, account_name text, owner_id uuid, status text DEFAULT 'verified');
    CREATE TABLE merchant_transfers(transfer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid, direction text DEFAULT 'payout',
      dest_type text DEFAULT 'wallet', bank_account_id uuid, wallet_operator text, wallet_phone text, status text DEFAULT 'pending',
      amount numeric DEFAULT 50000, fee numeric DEFAULT 500, net_amount numeric DEFAULT 49500, currency text DEFAULT 'XAF', reference text,
      description text, settlement_method text, created_at timestamptz DEFAULT NOW(), updated_at timestamptz, completed_at timestamptz,
      cancelled_at timestamptz, settled_at timestamptz, events jsonb DEFAULT '[]', gateway_reference text, bank_reference text,
      settlement_ref text, error_message text, executed_by uuid, settled_by uuid, admin_note text, amount_requested numeric,
      request_payload jsonb, unknown_since timestamptz, needs_review boolean DEFAULT false, last_status_check_at timestamptz, review_alerted_at timestamptz);
    CREATE TABLE transactions(transaction_id uuid PRIMARY KEY, merchant_id uuid, type text, amount numeric DEFAULT 10000, currency text DEFAULT 'XAF',
      detected_operator text, detected_country text, gateway_name text, gateway_payment_id text, pay_link_id uuid, status text DEFAULT 'pending',
      initiated_at timestamptz DEFAULT NOW() - INTERVAL '3 hours', response_message text, gateway_order_id text, auth_code text, fee_amount numeric,
      net_amount numeric, completed_at timestamptz, settlement_batch_id uuid, settlement_status text, response_code text, payment_method text);
    CREATE TABLE transaction_events(event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), transaction_id uuid, merchant_id uuid, event_type text, payload jsonb, created_at timestamptz DEFAULT NOW());
    CREATE TABLE webhook_events(id serial PRIMARY KEY, provider text, reference_id text, provider_status text, outcome text, payload jsonb, ip_address text, created_at timestamptz DEFAULT NOW());
    CREATE TABLE settlement_batches(merchant_id uuid, currency text, total_net numeric);
    CREATE TABLE settlement_queue(id serial PRIMARY KEY, transaction_id uuid UNIQUE, merchant_id uuid, amount numeric, currency text, queued_at timestamptz DEFAULT NOW(), settled boolean DEFAULT false);
    CREATE TABLE pay_links(pay_link_id uuid PRIMARY KEY, status text);
    CREATE FUNCTION cpay_calculate_fee(uuid,text,text,numeric,text) RETURNS numeric LANGUAGE SQL AS $$ SELECT 0::numeric $$;
  `);
}, 60000);
afterAll(async () => { await flush(); await mockPg.close(); });
beforeEach(async () => {
  jest.clearAllMocks();
  mockProvider = { getStatus: (...a) => mockStatus(...a) };
  mockStatus.mockReset().mockResolvedValue({ available: true, status: 'PENDING' });
  mockSendPayout.mockReset();
  await mockPg.exec('TRUNCATE idempotency_keys, merchant_transfers, merchants, transactions, transaction_events, webhook_events, settlement_batches, settlement_queue, bank_accounts, pay_links');
  await sql(`INSERT INTO merchants(merchant_id,country,currency,business_name,email,cash_wallet_phone,cash_wallet_operator) VALUES($1,'CG','XAF','Boutique Test','ops@example.test','+242060000001','mtn_momo')`, [M]);
  // encaissements autorisés : solde disponible 200 000
  await sql(`INSERT INTO transactions(transaction_id,merchant_id,type,amount,net_amount,status,currency) VALUES($1,$2,'collect',200000,200000,'authorized','XAF')`, [uuid(), M]);
});

// ───────────────────────────── A. Identité de route ─────────────────────────────
describe('A. identité de route commune (idempotence, capacité)', () => {
  test('canonicalPath neutralise la casse, le slash final et les doubles slashs', () => {
    for (const v of ['/api/v1/merchant/cash/Withdraw', '/api/v1/merchant/cash/withdraw/', '/api/v1/merchant//cash/withdraw//', '/api/v1/merchant/cash/WITHDRAW?x=1'])
      expect(canonicalPath(v)).toBe('/api/v1/merchant/cash/withdraw');
    expect(routeIdentity({ method: 'post', originalUrl: '/Cash/Withdraw/?k=1' })).toBe('POST /cash/withdraw');
    for (const v of ['/cash/Withdraw', '/cash/withdraw/', '/merchant/Disburse/'])
      expect(isMoneyEndpoint({ method: 'POST', originalUrl: v })).toBe(true);
  });

  const buildApp = () => {
    let orders = 0;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { merchantId: M }; next(); });
    const router = express.Router();
    router.post('/withdraw', idempotency, (_req, res) => { orders += 1; res.status(201).json({ order: orders }); });
    app.use('/cash', router);
    return { app, orders: () => orders };
  };
  test('la même clé sur /withdraw, /Withdraw et /withdraw/ ne crée qu’un ordre', async () => {
    const { app, orders } = buildApp();
    const body = { amount: 1000 };
    const r1 = await request(app).post('/cash/withdraw').set('Idempotency-Key', 'intent-0001-same').send(body);
    expect(r1.status).toBe(201); await flush();
    const r2 = await request(app).post('/cash/Withdraw').set('Idempotency-Key', 'intent-0001-same').send(body);
    const r3 = await request(app).post('/cash/withdraw/').set('Idempotency-Key', 'intent-0001-same').send(body);
    expect(r2.body).toEqual(r1.body); expect(r3.body).toEqual(r1.body);
    expect(orders()).toBe(1);
    const keys = await sql(`SELECT endpoint FROM idempotency_keys`);
    expect(keys.rows).toHaveLength(1); expect(keys.rows[0].endpoint).toBe('POST /cash/withdraw');
  });
  test('une variante d’URL n’exempte plus de la clé d’idempotence', async () => {
    const { app, orders } = buildApp();
    for (const v of ['/cash/Withdraw', '/cash/withdraw/']) {
      const r = await request(app).post(v).send({ amount: 1000 });
      expect(r.status).toBe(400); expect(r.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    }
    // Express 5 ne replie plus « // » : la variante n'atteint plus la route (404) ; Express 4 la rejetait en 400
    const dbl = await request(app).post('/cash//withdraw').send({ amount: 1000 });
    expect([400, 404]).toContain(dbl.status);
    if (dbl.status === 400) expect(dbl.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect(orders()).toBe(0);
  });
  test('la garde de capacité s’applique à /Withdraw comme à /withdraw (pays sans rail configuré)', async () => {
    process.env.CAPABILITY_ENFORCE = 'enforce';
    delete process.env.MTN_CG_COLL_API_KEY; delete process.env.MTN_CG_DISB_API_KEY;
    registry.invalidateFacts();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { merchantId: M }; next(); });
    let reached = 0;
    app.use('/cash', capability.capabilityGuard);
    app.post('/cash/withdraw', (_req, res) => { reached += 1; res.status(201).json({}); });
    const plain = await request(app).post('/cash/withdraw').send({ amount: 1000 });
    const cased = await request(app).post('/cash/Withdraw').send({ amount: 1000 });
    const slash = await request(app).post('/cash/withdraw/').send({ amount: 1000 });
    expect(cased.status).toBe(plain.status); expect(slash.status).toBe(plain.status);
    if (plain.status !== 201) expect(reached).toBe(0); // CG sans opérateur sortant configuré : refus pour les trois variantes
    expect(capability.mapCashRequest({ path: '/Withdraw/', body: {} })).toEqual({ operation: 'withdraw', method: 'mobile_money' });
    expect(capability.mapLegacyRequest({ path: '/merchant/Disburse/', body: { operator: 'MTN_MOMO' } })).toMatchObject({ operation: 'withdraw' });
  });
});

// ───────────────────────────── B. Webhook lié à l’opérateur ─────────────────────────────
describe('B. un callback authentifié ne finalise que les transactions de son opérateur', () => {
  const TXN = uuid();
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));
  app.use('/webhooks', webhooks.legacyRouter);
  beforeEach(async () => {
    process.env.MOOV_WEBHOOK_TOKEN = 'moov-test-token';
    process.env.ORANGE_WEBHOOK_TOKEN = 'orange-test-token';
    await sql(`INSERT INTO transactions(transaction_id,merchant_id,type,amount,currency,status,gateway_name,gateway_payment_id,detected_operator,detected_country,response_message)
               VALUES($1,$2,'collect',5000,'XAF','pending','orange_cg','ORANGE-NOTIF-TOKEN-1','ORANGE_MONEY','CG','pending')`, [TXN, M]);
  });
  test('jeton Moov + référence Orange → référence inconnue, aucun changement d’état', async () => {
    const r = await request(app).post('/webhooks/moov').set('X-Webhook-Token', 'moov-test-token')
      .send({ reference: TXN, status: 'SUCCESS', transaction_id: 'MOOV-999', amount: 5000, currency: 'XAF' });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('unknown_reference');
    expect((await first(`SELECT status FROM transactions WHERE transaction_id=$1`, [TXN])).status).toBe('pending');
    expect((await first(`SELECT outcome, provider FROM webhook_events ORDER BY id DESC LIMIT 1`))).toMatchObject({ outcome: 'unknown_reference', provider: 'moov' });
    expect(await first(`SELECT 1 FROM transaction_events WHERE transaction_id=$1`, [TXN])).toBeUndefined();
  });
  test('providerOwnsTransaction : gateway persisté prioritaire, opérateur détecté en repli', () => {
    expect(webhooks.providerOwnsTransaction('orange', { gateway_name: 'orange_cg', detected_operator: 'ORANGE_MONEY' })).toBe(true);
    expect(webhooks.providerOwnsTransaction('moov', { gateway_name: 'orange_cg', detected_operator: 'MOOV_MONEY' })).toBe(false);
    expect(webhooks.providerOwnsTransaction('moov', { gateway_name: null, detected_operator: 'MOOV_MONEY' })).toBe(true);
    expect(webhooks.providerOwnsTransaction('free_money', { gateway_name: '', detected_operator: 'ORANGE_MONEY' })).toBe(false);
    expect(webhooks.providerOwnsTransaction('express_union', { gateway_name: 'express_union_cm' })).toBe(true);
    expect(webhooks.providerOwnsTransaction('moov', { gateway_name: 'moov_td' })).toBe(true);     // pays planifie : prefixe du provider
  });
  test('le même callback, authentifié comme Orange, finalise bien la transaction Orange (liaison respectée)', async () => {
    mockProvider = {};   // pas de re-interrogation : le statut du callback fait foi
    const r = await request(app).post('/webhooks/orange').set('X-Webhook-Token', 'orange-test-token')
      .send({ status: 'SUCCESS', notif_token: 'ORANGE-NOTIF-TOKEN-1', order_id: TXN, txnid: 'MP-1', amount: 5000, currency: 'XAF' });
    expect(r.status).toBe(200); expect(r.body.applied).toBe(true);
    expect((await first(`SELECT status FROM transactions WHERE transaction_id=$1`, [TXN])).status).toBe('authorized');
  });
});

// ───────────────────────────── C. Envoi durable, revue, décision Finance ─────────────────────────────
describe('C. état d’envoi durable et ordres incertains', () => {
  const rail = { available: true, kind: 'mm', gateway: 'mtn_cg', operatorLabel: 'MTN MoMo' };
  const payout = (amount = 10000) => cash.createPayout({ merchantId: M, destType: 'wallet', amount, rail,
    wallet: { operator: 'mtn_momo', phone: '+242060000001', gateway: 'mtn_cg', country: 'CG' }, actor: 'test' });
  const balance = () => cash.computeAvailableBalance(sql, M);

  test('la ligne est en `sending` pendant l’appel rail, puis finalisée depuis `sending`', async () => {
    let seen = null;
    mockSendPayout.mockImplementation(async ({ txnId }) => { seen = (await first(`SELECT status FROM merchant_transfers WHERE transfer_id=$1`, [txnId])).status; return { approved: true, responseCode: '00', gatewayRef: 'MTN-OK-1' }; });
    const out = await payout();
    expect(seen).toBe('sending');
    expect(out.transfer.status).toBe('completed');
    const row = await first(`SELECT status, events FROM merchant_transfers WHERE transfer_id=$1`, [out.transfer.transferId]);
    expect(row.events.map((e) => e.type)).toEqual(['created', 'sending', 'completed']);
  });

  test('un envoi interrompu reste réservé, est mis en revue après la grâce, jamais renvoyé ni libéré', async () => {
    // Interruption simulée : le processus meurt pendant l’appel rail → ligne laissée en `sending`, sans référence
    const id = uuid();
    await sql(`INSERT INTO merchant_transfers(transfer_id,merchant_id,wallet_operator,wallet_phone,status,amount,fee,net_amount,reference,created_at,request_payload)
               VALUES($1,$2,'mtn_momo','+242060000001','sending',50000,500,49500,'PAY-INTERRUPTED',NOW() - INTERVAL '2 hours','{"gateway":"mtn_cg","rail":"mm"}')`, [id, M]);
    expect((await balance()).reserved).toBe(50000);
    const r = await cash.sweepUncertainPayouts({ graceMinutes: 10, alertHours: 0 });
    expect(r.summary.scanned).toBe(1); expect(r.summary.flagged).toBe(1);
    const row = await cash.getTransfer(id);
    expect(row.status).toBe('sending'); expect(row.needs_review).toBe(true);
    expect(row.events.map((e) => e.type)).toContain('needs_review');
    expect(mockSendPayout).not.toHaveBeenCalled();
    expect((await balance()).reserved).toBe(50000);
    expect(mockEmail).toHaveBeenCalledTimes(1);
  });

  test('un envoi interrompu récent (dans la grâce) n’est pas encore mis en revue', async () => {
    const id = uuid();
    await sql(`INSERT INTO merchant_transfers(transfer_id,merchant_id,wallet_operator,wallet_phone,status,reference,created_at) VALUES($1,$2,'mtn_momo','+242060000001','sending','PAY-FRESH',NOW() - INTERVAL '1 minute')`, [id, M]);
    const r = await cash.sweepUncertainPayouts({ graceMinutes: 10, alertHours: 0 });
    expect(r.summary.scanned).toBe(0);
    const out = await cash.refreshPayoutStatus(await cash.getTransfer(id), { graceMinutes: 10 });
    expect(out._statusCheck).toBe('interrupted_in_grace'); expect(out.needs_review).toBe(false);
  });

  test('une ancienne ligne `pending` (avant le lot) interrompue est reprise de la même façon', async () => {
    const id = uuid();
    await sql(`INSERT INTO merchant_transfers(transfer_id,merchant_id,wallet_operator,wallet_phone,status,reference,gateway_reference,created_at,request_payload)
               VALUES($1,$2,'mtn_momo','+242060000001','pending','PAY-OLD','MTN-REF-OLD',NOW() - INTERVAL '3 hours','{"gateway":"mtn_cg","rail":"mtn_client"}')`, [id, M]);
    mockStatus.mockResolvedValue({ status: 'SUCCESSFUL', financialTransactionId: 'FT-OLD' });
    const r = await cash.sweepUncertainPayouts({ graceMinutes: 10, alertHours: 0 });
    expect(r.summary.completed).toBe(1);
    expect((await cash.getTransfer(id)).status).toBe('completed');
  });

  test('décision Finance `failed` sur preuve : fonds libérés, puis une réponse opérateur tardive n’écrase rien', async () => {
    const id = uuid();
    await sql(`INSERT INTO merchant_transfers(transfer_id,merchant_id,wallet_operator,wallet_phone,status,amount,reference,gateway_reference,created_at,request_payload)
               VALUES($1,$2,'mtn_momo','+242060000001','unknown',50000,'PAY-UNK','MTN-REF-UNK',NOW() - INTERVAL '5 hours','{"gateway":"mtn_cg","rail":"mtn_client"}')`, [id, M]);
    const stale = await cash.getTransfer(id);           // vue chargée AVANT la décision (poll concurrent)
    expect((await balance()).reserved).toBe(50000);
    const bad = await cash.resolveUncertainPayout({ transferId: id, outcome: 'failed', evidence: 'x' });
    expect(bad.error.status).toBe(422);
    const d = await cash.resolveUncertainPayout({ transferId: id, outcome: 'failed', evidence: 'Relevé MTN 09/11 : aucune sortie', note: 'vérifié par Finance', actor: 'admin:fin-1' });
    expect(d.transfer.status).toBe('failed'); expect(d.released).toBe(50000);
    expect((await balance()).reserved).toBe(0);
    // réponse opérateur tardive : SUCCESSFUL
    mockStatus.mockResolvedValue({ status: 'SUCCESSFUL', financialTransactionId: 'FT-LATE' });
    const out = await cash.refreshPayoutStatus(stale);
    expect(out._statusCheck).toBe('already_final');
    const row = await cash.getTransfer(id);
    expect(row.status).toBe('failed');
    expect(row.events.map((e) => e.type)).toEqual(expect.arrayContaining(['finance_decision', 'late_operator_response']));
    expect((await balance()).reserved).toBe(0);
    // une seconde décision est refusée
    const again = await cash.resolveUncertainPayout({ transferId: id, outcome: 'completed', evidence: 'Relevé contradictoire' });
    expect(again.error.status).toBe(409);
  });

  test('décision Finance `completed` sur un `sending` interrompu : fonds comptés comme sortis, référence de preuve conservée', async () => {
    const id = uuid();
    await sql(`INSERT INTO merchant_transfers(transfer_id,merchant_id,wallet_operator,wallet_phone,status,amount,reference,created_at) VALUES($1,$2,'mtn_momo','+242060000001','sending',20000,'PAY-SND',NOW() - INTERVAL '2 hours')`, [id, M]);
    const d = await cash.resolveUncertainPayout({ transferId: id, outcome: 'completed', evidence: 'FT-2026110900123', actor: 'admin:fin-1' });
    expect(d.transfer.status).toBe('completed'); expect(d.released).toBe(0);
    const row = await cash.getTransfer(id);
    expect(row.gateway_reference).toBe('FT-2026110900123'); expect(row.needs_review).toBe(false);
    expect((await balance()).totalWithdrawn).toBe(20000); expect((await balance()).reserved).toBe(0);
  });

  test('un transfert bancaire ou déjà final n’est pas résoluble par cette décision', async () => {
    const id = uuid();
    await sql(`INSERT INTO merchant_transfers(transfer_id,merchant_id,dest_type,status,reference) VALUES($1,$2,'bank','pending_manual','TRF-1')`, [id, M]);
    const r = await cash.resolveUncertainPayout({ transferId: id, outcome: 'failed', evidence: 'relevé banque' });
    expect(r.error.status).toBe(409);
  });
});
