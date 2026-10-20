'use strict';
/**
 * WAVE-4 — Caisse marchande (docs/CAISSE-API.md) : cash.service, /merchant/cash/*, /admin/cash/*.
 * supertest + base de données mockée (aucune connexion réseau).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wave4-test-secret-at-least-32-chars-long';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');

jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() }));
const mockDbQuery = jest.fn();
const mockTxQuery = jest.fn();
jest.mock('../config/database', () => ({
  query: (...a) => mockDbQuery(...a),
  withTransaction: async (fn) => fn({ query: (...a) => mockTxQuery(...a) }),
  pool: {},
}));
const mockMtnTransfer = jest.fn();
const mockMtnStatus = jest.fn();
jest.mock('../services/rails/mtn-momo.client', () => ({
  CONFIG: { disbursements: { apiUser: 'u', apiKey: 'k', primaryKey: 'p' } },
  transfer: (...a) => mockMtnTransfer(...a),
  getDisbursementStatus: (...a) => mockMtnStatus(...a),
  getCollectionStatus: jest.fn(),
}));
const mockGetProvider = jest.fn();
const mockGetConfig = jest.fn();
const mockSendPayout = jest.fn();
jest.mock('../services/mobilemoney/mobilemoney.router', () => ({
  getProvider: (...a) => mockGetProvider(...a),
  getConfig: (...a) => mockGetConfig(...a),
  sendPayout: (...a) => mockSendPayout(...a),
  processPayment: jest.fn(), invalidateCache: jest.fn(), webhookUrl: jest.fn(), PROVIDERS: {},
}));
const mockProcess = jest.fn();
jest.mock('../services/orchestration/orchestrator', () => ({ processTransaction: (...a) => mockProcess(...a) }));
const mockReconcile = jest.fn();
jest.mock('../services/reconcile.service', () => ({ reconcileOne: (...a) => mockReconcile(...a), reconcilePending: jest.fn() }));
const mockEmail = jest.fn(async () => true);
jest.mock('../services/notifications/email.service', () => ({ send: (...a) => mockEmail(...a) }));
jest.mock('../services/notifications/smpp.service', () => ({ sendSmsSmpp: jest.fn(async () => true), notifyMultiChannel: jest.fn(async () => true) }));
jest.mock('../services/notifications/whatsapp.service', () => ({ sendWhatsAppText: jest.fn(async () => true) }));
jest.mock('../services/gateways/card.router', () => ({ isConfigured: () => false, processCard: jest.fn() }));

const { signToken } = require('../middleware/auth');
const cash = require('../services/cash/cash.service');
const cashRouter = require('../routes/cash.routes');
const cashAdminRouter = require('../routes/cash-admin.routes');
const merchantRouter = require('../routes/merchant.routes');

const app = express();
app.use(express.json());
app.use('/merchant/cash', cashRouter);
app.use('/admin/cash', cashAdminRouter);
app.use('/merchant', merchantRouter);

const MERCHANT_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const TRANSFER_ID = '33333333-3333-4333-8333-333333333333';
const PASSWORD = 'Aa1!' + require('crypto').randomBytes(8).toString('hex');
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
const TOTP_SECRET = speakeasy.generateSecret({ length: 20 }).base32;

const merchantToken = (sub = 'user-1', role = 'owner') => signToken({ sub, merchantId: MERCHANT_ID, type: 'merchant', email: 'm@test.io', role }); // WAVE-6 : rôle owner requis pour PUT /wallet
const adminToken = (role = 'ops_admin') => signToken({ sub: ADMIN_ID, type: 'admin', role, email: 'admin@test.io' });
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const rows = (r) => ({ rows: r, rowCount: r.length });
const calls = (mock, re) => mock.mock.calls.filter(([s]) => re.test(s));

const merchant = (over = {}) => ({
  merchant_id: MERCHANT_ID, business_name: 'Shop', email: 'shop@test.io', merchant_status: 'active',
  currency: 'XAF', country: 'CM', kyb_level: 1,
  cash_wallet_operator: 'mtn_momo', cash_wallet_phone: '+237670000001', cash_wallet_verified_at: null, ...over,
});
const userRow = (over = {}) => ({ user_id: 'user-1', password_hash: PASSWORD_HASH, mfa_enabled: false, mfa_secret: null, ...over });

/** Routeur SQL → résultat : premier handler (regex) qui correspond. */
const dbRouter = (handlers) => async (sql, params) => {
  for (const [re, h] of handlers) if (re.test(sql)) return typeof h === 'function' ? h(sql, params) : rows(h);
  return rows([]);
};
// Mise à jour de statut (transitionTransfer) : renvoie une ligne cohérente avec les paramètres
const transitionRow = (base = {}) => (sql, params) => rows([{
  transfer_id: params[0], merchant_id: MERCHANT_ID, direction: 'payout', dest_type: 'wallet', wallet_phone: '+237670000001',
  amount: 50000, fee: 500, net_amount: 49500, currency: 'XAF', reference: 'PAY-TEST', ...base, status: params[1],
  gateway_reference: params[4] || null, bank_reference: params[5] || null, error_message: params[6] || null, events: [],
}]);
const baseHandlers = (m = merchant(), u = userRow()) => [
  [/FROM merchants WHERE merchant_id=\$1$/m, [m]],
  [/FROM merchants WHERE merchant_id=\$1(?: FOR UPDATE)?$/, [m]],
  [/FROM merchant_users WHERE user_id/, [u]],
  [/FROM merchant_fees/, []],
];
const txHandlers = ({ collected = 100000, pending = 0, withdrawn = 0, reserved = 0, funded = 0, disbursed = 0, today = 0, m = merchant(), bank = null } = {}) => [
  [/pg_advisory_xact_lock/, [{ ok: true }]],
  [/FOR UPDATE/, [m]],
  [/type IN \('collect','qr_payment','pay_link'\)/, [{ collected, pending, nb: 1 }]],
  [/withdrawn_today/, [{ withdrawn_today: today }]],
  [/FROM merchant_transfers/, [{ withdrawn, reserved, funded }]],
  [/type='payout'/, [{ disbursed }]],
  [/FROM bank_accounts ba/, bank ? [bank] : []],
  [/INSERT INTO merchant_transfers/, [{ transfer_id: TRANSFER_ID, created_at: new Date('2026-10-15T10:00:00Z') }]],
];

const withMigsEnv = (on) => {
  if (on) { process.env.MIGS_MERCHANT_ID = 'MER1'; process.env.MIGS_ACCESS_CODE = 'ACC1'; process.env.MIGS_SECURE_HASH = 'a'.repeat(64); }
  else { delete process.env.MIGS_MERCHANT_ID; delete process.env.MIGS_ACCESS_CODE; delete process.env.MIGS_SECURE_HASH; }
};

beforeEach(() => {
  jest.clearAllMocks();
  withMigsEnv(false);
  mockDbQuery.mockReset(); mockDbQuery.mockImplementation(async () => rows([]));
  mockTxQuery.mockReset(); mockTxQuery.mockImplementation(async () => rows([]));
  mockGetProvider.mockReturnValue({ collectPayment: jest.fn(), sendPayout: jest.fn(), getStatus: jest.fn() });
  mockGetConfig.mockResolvedValue({ apiKey: 'key', baseUrl: 'https://mm.test' });
  mockReconcile.mockResolvedValue({ still: 'pending' });
  cash._resetStepUp();
  delete process.env.CASH_WITHDRAW_DAILY_L0; delete process.env.CASH_WITHDRAW_DAILY_L1; delete process.env.CASH_WITHDRAW_DAILY_L2;
});

// ═══════════════════════════════════════════════════════════════════
describe('1. cash.service — règles', () => {
  test('codes opérateur : insensibles à la casse, alias historiques', () => {
    expect(cash.normalizeOperatorCode('WAVE')).toBe('wave');
    expect(cash.normalizeOperatorCode('mtn')).toBe('mtn_momo');
    expect(cash.normalizeOperatorCode('Express_Union')).toBe('express_union');
    expect(cash.normalizeOperatorCode('MTN_MOMO')).toBe('mtn_momo');
    expect(cash.operatorLabel('orange')).toBe('Orange Money');
  });

  test('detectWallet : détection par numéro, override minuscule (wave), contradiction refusée', () => {
    const d = cash.detectWallet('+237670000001', { country: 'CM' });
    expect(d).toMatchObject({ success: true, operator: 'MTN_MOMO', gateway: 'mtn_cm', currency: 'XAF' });
    const w = cash.detectWallet('+221770000001', { country: 'SN', operator: 'wave' });
    expect(w).toMatchObject({ success: true, operator: 'WAVE', gateway: 'wave_sn', overridden: true });
    const conf = cash.detectWallet('+221770000001', { country: 'SN', operator: 'mtn_momo' });
    expect(conf.success).toBe(false);
    const confirmed = cash.detectWallet('0670000001', { country: 'CM', operator: 'MTN_MOMO' });
    expect(confirmed).toMatchObject({ success: true, phone: '+237670000001' });
  });

  test('limites journalières par niveau KYB, surchargeables par env', () => {
    expect(cash.withdrawDailyLimit(0)).toBe(100000);
    expect(cash.withdrawDailyLimit(1)).toBe(500000);
    expect(cash.withdrawDailyLimit(2)).toBe(2000000);
    expect(cash.withdrawDailyLimit(9)).toBe(2000000);
    process.env.CASH_WITHDRAW_DAILY_L1 = '750000';
    expect(cash.withdrawDailyLimit(1)).toBe(750000);
  });

  test('computeAvailableBalance : + encaissements, + approvisionnements completed, − sorties, − décaissements', async () => {
    mockDbQuery.mockImplementation(dbRouter(txHandlers({ collected: 10000, pending: 500, withdrawn: 2000, reserved: 1000, funded: 5000, disbursed: 1500 })));
    const b = await cash.computeAvailableBalance(mockDbQuery, MERCHANT_ID);
    expect(b).toMatchObject({ available: 11500, pending: 500, reserved: 1000, totalFunded: 5000, totalWithdrawn: 3500 });
    const [sql, params] = calls(mockDbQuery, /FROM merchant_transfers/)[0];
    expect(sql).toMatch(/direction='funding' AND status='completed'/);
    expect(params[1]).toEqual(expect.arrayContaining(['pending', 'processing', 'pending_manual', 'pending_settlement', 'completed']));
    expect(params[1]).not.toContain('failed');
  });

  test('payoutRail : MTN Congo → client rails ; autres via routeur MM (sendPayout + clé) ; Interswitch jamais', async () => {
    expect(await cash.payoutRail({ operator: 'mtn_momo', gateway: 'mtn_cg', country: 'CG' })).toMatchObject({ available: true, kind: 'mtn_client' });
    expect(await cash.payoutRail({ operator: 'orange_money', gateway: 'orange_cm', country: 'CM' })).toMatchObject({ available: true, kind: 'mm_router', gateway: 'orange_cm' });
    mockGetConfig.mockResolvedValue({});
    expect(await cash.payoutRail({ operator: 'orange_money', gateway: 'orange_cm', country: 'CM' })).toMatchObject({ available: false, operatorLabel: 'Orange Money' });
    mockGetConfig.mockResolvedValue({ apiKey: 'k' });
    expect(await cash.payoutRail({ operator: 'vodacom_mpesa', gateway: 'interswitch_mpesa_cd', country: 'CD' })).toMatchObject({ available: false });
    mockGetProvider.mockReturnValue(null);
    expect(await cash.payoutRail({ operator: 'wave', gateway: 'wave_sn', country: 'SN' })).toMatchObject({ available: false, operatorLabel: 'Wave' });
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('2. GET /merchant/cash/summary et /merchant/balance (solde avec approvisionnements)', () => {
  const summaryHandlers = () => [
    ...baseHandlers(),
    [/initiated_at::date = CURRENT_DATE/, [{ collected: 8000, n: 2, mm: 7000, card: 1000 }]],
    [/created_at::date = CURRENT_DATE/, [{ withdrawn: 20000, transfers_out: 0, transfers_in: 0 }]],
    [/COUNT\(\*\)::int AS n FROM bank_accounts/, [{ n: 1 }]],
    ...txHandlers({ collected: 10000, pending: 500, withdrawn: 2000, reserved: 1000, funded: 5000, disbursed: 1500 }),
  ];

  test('summary : solde, activité du jour, limites, frais, profil', async () => {
    mockDbQuery.mockImplementation(dbRouter(summaryHandlers()));
    const res = await request(app).get('/merchant/cash/summary').set(bearer(merchantToken()));
    expect(res.status).toBe(200);
    expect(res.body.currency).toBe('XAF');
    expect(res.body.balance).toEqual({ available: 11500, pending: 500, reserved: 1000 });
    expect(res.body.today).toMatchObject({ collected: 8000, collectedCount: 2, byMethod: { mobile_money: 7000, card: 1000 }, withdrawn: 20000 });
    expect(res.body.limits).toMatchObject({ withdrawDailyMax: 500000, withdrawDailyRemaining: 480000, transferMin: 1000, withdrawFeePercent: 1, withdrawFeeFixed: 0, withdrawFeeMin: 0 });
    expect(res.body.fees).toEqual({ withdraw: { percent: 1, fixed: 0, min: 0 }, transfer: { percent: 1, fixed: 0, min: 0 } });
    expect(res.body.profile).toMatchObject({ kybLevel: 1, wallet: { operator: 'mtn_momo', phone: '+237670000001', verifiedAt: null }, bankAccounts: 1, cardAcceptance: 'unavailable' });
  });

  test('summary : cardAcceptance=link seulement si la passerelle carte hébergée du pays est configurée (env MIGS)', async () => {
    mockDbQuery.mockImplementation(dbRouter([
      [/FROM country_payment_defaults/, [{ country: 'CM', currency: 'XAF', default_card_gateway: 'migs' }]],
      [/FROM api_configurations WHERE provider_key/, [{ status: 'active' }]],
      ...summaryHandlers(),
    ]));
    let res = await request(app).get('/merchant/cash/summary').set(bearer(merchantToken()));
    expect(res.status).toBe(200);
    expect(res.body.profile.cardAcceptance).toBe('unavailable'); // "active" en base ne suffit pas : module non configuré
    withMigsEnv(true);
    res = await request(app).get('/merchant/cash/summary').set(bearer(merchantToken()));
    expect(res.body.profile.cardAcceptance).toBe('link');
    withMigsEnv(false);
  });

  test('GET /merchant/balance (route historique) utilise la même formule, avec les approvisionnements', async () => {
    mockDbQuery.mockImplementation(dbRouter(summaryHandlers()));
    const res = await request(app).get('/merchant/balance').set(bearer(merchantToken()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: 11500, pending: 500, totalFunded: 5000, totalWithdrawn: 3500, currency: 'XAF' });
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('3. POST /merchant/cash/collect', () => {
  beforeEach(() => mockDbQuery.mockImplementation(dbRouter(baseHandlers())));

  test('mobile_money : opérateur détecté, orchestrateur appelé, 201 avec frais estimés et statusUrl', async () => {
    mockProcess.mockResolvedValue({ success: true, txnId: 'T-1', status: 'pending', message: 'ok' });
    const res = await request(app).post('/merchant/cash/collect').set(bearer(merchantToken()))
      .send({ amount: 25000, method: 'mobile_money', customerPhone: '0670000001', reference: 'FACT-001' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ txnId: 'T-1', status: 'pending', method: 'mobile_money', operator: 'mtn_momo', operatorLabel: 'MTN MoMo',
      country: 'CM', currency: 'XAF', amount: 25000, fee: 375, net: 24625, statusUrl: '/api/v1/merchant/cash/collect/T-1' });
    expect(mockProcess).toHaveBeenCalledWith(expect.objectContaining({ merchantId: MERCHANT_ID, type: 'collect', amount: 25000, customerPhone: '+237670000001' }));
    expect(mockProcess.mock.calls[0][0].operatorOverride).toBeUndefined();
    expect(mockProcess.mock.calls[0][0].description).toMatch(/FACT-001/);
  });

  test('operator en minuscules (wave) → override transmis à l’orchestrateur', async () => {
    mockDbQuery.mockImplementation(dbRouter(baseHandlers(merchant({ currency: 'XOF', country: 'SN' }))));
    mockProcess.mockResolvedValue({ success: true, txnId: 'T-2', status: 'pending' });
    const res = await request(app).post('/merchant/cash/collect').set(bearer(merchantToken()))
      .send({ amount: 5000, method: 'mobile_money', customerPhone: '+221770000001', operator: 'wave' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ operator: 'wave', operatorLabel: 'Wave', country: 'SN', currency: 'XOF' });
    expect(mockProcess.mock.calls[0][0].operatorOverride).toBe('WAVE');
  });

  test('devise du numéro ≠ devise du marchand → 422 CURRENCY_MISMATCH (aucun appel orchestrateur)', async () => {
    const res = await request(app).post('/merchant/cash/collect').set(bearer(merchantToken()))
      .send({ amount: 5000, method: 'mobile_money', customerPhone: '+221770000001' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'CURRENCY_MISMATCH', currency: 'XOF', merchantCurrency: 'XAF' });
    expect(mockProcess).not.toHaveBeenCalled();
    const r2 = await request(app).post('/merchant/cash/collect').set(bearer(merchantToken()))
      .send({ amount: 5000, currency: 'XOF', method: 'mobile_money', customerPhone: '0670000001' });
    expect(r2.status).toBe(422); expect(r2.body.code).toBe('CURRENCY_MISMATCH');
  });

  test('opérateur sans rail de collecte → 410 FEATURE_DISABLED avec operatorLabel', async () => {
    mockGetProvider.mockReturnValue(null);
    const res = await request(app).post('/merchant/cash/collect').set(bearer(merchantToken()))
      .send({ amount: 5000, method: 'mobile_money', customerPhone: '0670000001' });
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ code: 'FEATURE_DISABLED', operator: 'mtn_momo', operatorLabel: 'MTN MoMo' });
    expect(mockProcess).not.toHaveBeenCalled();
  });

  test('numéro inconnu / opérateur sans wallet → 422 avec code détection ; validations', async () => {
    let res = await request(app).post('/merchant/cash/collect').set(bearer(merchantToken()))
      .send({ amount: 5000, method: 'mobile_money', customerPhone: '+237620000001' });
    expect(res.status).toBe(422); expect(res.body.code).toBe('OPERATOR_NO_WALLET');
    res = await request(app).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ amount: 5000, method: 'cash' });
    expect(res.status).toBe(422); expect(res.body.code).toBe('VALIDATION_ERROR');
    res = await request(app).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ amount: 10.5, method: 'mobile_money', customerPhone: '0670000001' });
    expect(res.status).toBe(422);
    res = await request(app).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ amount: 5000, method: 'mobile_money' });
    expect(res.status).toBe(422);
  });

  test('refus opérateur → 402 ; plafond KYB → 429 ; marchand inactif → 403', async () => {
    mockProcess.mockResolvedValue({ success: false, txnId: 'T-3', status: 'failed', error: 'Refusé' });
    let res = await request(app).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ amount: 5000, method: 'mobile_money', customerPhone: '0670000001' });
    expect(res.status).toBe(402); expect(res.body).toMatchObject({ code: 'PAYMENT_DECLINED', txnId: 'T-3' });
    mockProcess.mockResolvedValue({ success: false, txnId: 'T-4', error: 'Plafond', limitInfo: { limit: 500000, currentVolume: 499000 } });
    res = await request(app).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ amount: 5000, method: 'mobile_money', customerPhone: '0670000001' });
    expect(res.status).toBe(429); expect(res.body.code).toBe('LIMIT_EXCEEDED');
    mockDbQuery.mockImplementation(dbRouter(baseHandlers(merchant({ merchant_status: 'suspended' }))));
    res = await request(app).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ amount: 5000, method: 'mobile_money', customerPhone: '0670000001' });
    expect(res.status).toBe(403); expect(res.body.code).toBe('MERCHANT_INACTIVE');
  });

  test('card : 410 sans passerelle hébergée ; lien de paiement carte (payment_method=card) avec MIGS configuré', async () => {
    mockDbQuery.mockImplementation(dbRouter([
      [/FROM country_payment_defaults/, [{ country: 'CM', currency: 'XAF', default_card_gateway: 'migs' }]],
      ...baseHandlers(),
    ]));
    let res = await request(app).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ amount: 5000, method: 'card' });
    expect(res.status).toBe(410); expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(calls(mockDbQuery, /INSERT INTO pay_links/)).toHaveLength(0);

    withMigsEnv(true);
    mockDbQuery.mockImplementation(dbRouter([
      [/FROM country_payment_defaults/, [{ country: 'CM', currency: 'XAF', default_card_gateway: 'migs' }]],
      [/INSERT INTO pay_links/, (sql, p) => rows([{ pay_link_id: p[0], short_id: p[2], short_url: p[6], expires_at: p[7] }])],
      ...baseHandlers(),
    ]));
    res = await request(app).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ amount: 5000, method: 'card', description: 'Table 4' });
    withMigsEnv(false);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ txnId: null, status: 'pending', method: 'card', gateway: 'migs', currency: 'XAF' });
    expect(res.body.payLink.shortId).toMatch(/^[A-Z2-9]{8}$/);
    expect(res.body.payLink.shortUrl).toContain(res.body.payLink.shortId);
    const [sql, params] = calls(mockDbQuery, /INSERT INTO pay_links/)[0];
    expect(sql).toMatch(/'card','pending'/);
    expect(params).toEqual(expect.arrayContaining([MERCHANT_ID, 5000, 'XAF', 'migs']));
  });

  test('GET /collect/:txnId : re-interroge l’opérateur si pending et relit la ligne', async () => {
    let status = 'pending';
    mockDbQuery.mockImplementation(dbRouter([
      [/FROM transactions WHERE transaction_id=\$1 AND merchant_id=\$2/, (sql, p) => p[0] !== 'T-1' ? rows([]) : rows([{ transaction_id: 'T-1', amount: '25000', currency: 'XAF', fee_amount: status === 'authorized' ? '375' : '0',
        net_amount: status === 'authorized' ? '24625' : '0', status, payment_method: 'mobile_money', detected_operator: 'MTN_MOMO', detected_country: 'CM',
        gateway_payment_id: 'G-1', gateway_order_id: 'MOB-1', initiated_at: '2026-10-15T10:00:00.000Z', completed_at: null }])],
    ]));
    mockReconcile.mockImplementation(async () => { status = 'authorized'; return { updated: 'authorized' }; });
    const res = await request(app).get('/merchant/cash/collect/T-1').set(bearer(merchantToken()));
    expect(res.status).toBe(200);
    expect(mockReconcile).toHaveBeenCalledWith(expect.objectContaining({ transaction_id: 'T-1', gateway_payment_id: 'G-1' }));
    expect(res.body).toMatchObject({ txnId: 'T-1', status: 'authorized', amount: 25000, fee: 375, net: 24625, operator: 'mtn_momo', operatorLabel: 'MTN MoMo', customerPhone: null });
    const nf = await request(app).get('/merchant/cash/collect/T-9').set(bearer(merchantToken()));
    expect(nf.status).toBe(404);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('4. Wallet et step-up', () => {
  test('GET /wallet : 204 sans wallet, 200 sinon', async () => {
    mockDbQuery.mockImplementation(dbRouter(baseHandlers(merchant({ cash_wallet_phone: null }))));
    expect((await request(app).get('/merchant/cash/wallet').set(bearer(merchantToken()))).status).toBe(204);
    mockDbQuery.mockImplementation(dbRouter(baseHandlers()));
    const res = await request(app).get('/merchant/cash/wallet').set(bearer(merchantToken()));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ operator: 'mtn_momo', phone: '+237670000001', verifiedAt: null });
  });

  test('PUT /wallet : step-up mot de passe, détection, devise, verifiedAt remis à null', async () => {
    mockDbQuery.mockImplementation(dbRouter([
      [/UPDATE merchants/, (sql, p) => rows([{ cash_wallet_operator: p[0], cash_wallet_phone: p[1], cash_wallet_verified_at: null }])],
      ...baseHandlers(),
    ]));
    let res = await request(app).put('/merchant/cash/wallet').set(bearer(merchantToken())).send({ operator: 'orange_money', phone: '0690000001' });
    expect(res.status).toBe(428); expect(res.body).toEqual(expect.objectContaining({ code: 'STEP_UP_REQUIRED', methods: ['password'] }));
    res = await request(app).put('/merchant/cash/wallet').set(bearer(merchantToken())).send({ operator: 'orange_money', phone: '0690000001', confirm: { password: PASSWORD } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ operator: 'orange_money', phone: '+237690000001', verifiedAt: null, country: 'CM' });
    const [sql] = calls(mockDbQuery, /UPDATE merchants/)[0];
    expect(sql).toMatch(/cash_wallet_verified_at = CASE WHEN cash_wallet_phone IS DISTINCT FROM/);
    res = await request(app).put('/merchant/cash/wallet').set(bearer(merchantToken())).send({ phone: '+221770000001', confirm: { password: PASSWORD } });
    expect(res.status).toBe(422); expect(res.body.code).toBe('CURRENCY_MISMATCH');
  });

  test('step-up TOTP : methods=[totp], code valide accepté, 5 échecs → 429', async () => {
    mockDbQuery.mockImplementation(dbRouter(baseHandlers(merchant(), userRow({ mfa_enabled: true, mfa_secret: TOTP_SECRET }))));
    let r = await cash.verifyStepUp({ userId: 'user-1', confirm: { password: PASSWORD } });
    expect(r).toMatchObject({ ok: false, status: 428, body: { code: 'STEP_UP_REQUIRED', methods: ['totp'] } });
    r = await cash.verifyStepUp({ userId: 'user-1', confirm: { code: speakeasy.totp({ secret: TOTP_SECRET, encoding: 'base32' }) } });
    expect(r).toMatchObject({ ok: true, method: 'totp' });
    for (let i = 0; i < 4; i++) await cash.verifyStepUp({ userId: 'user-1', confirm: { code: '000000' } });
    r = await cash.verifyStepUp({ userId: 'user-1', confirm: { code: '000000' } });
    expect(r).toMatchObject({ ok: false, status: 429, body: { code: 'STEP_UP_LOCKED' } });
    r = await cash.verifyStepUp({ userId: 'user-1', confirm: { code: speakeasy.totp({ secret: TOTP_SECRET, encoding: 'base32' }) } });
    expect(r.status).toBe(429);
    // une absence de confirm ne compte pas comme un échec
    cash._resetStepUp();
    r = await cash.verifyStepUp({ userId: 'user-1' });
    expect(r.status).toBe(428);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('5. POST /merchant/cash/withdraw', () => {
  const withdraw = (body, token = merchantToken()) => request(app).post('/merchant/cash/withdraw').set(bearer(token)).send(body);
  const confirm = { password: PASSWORD };

  beforeEach(() => {
    mockDbQuery.mockImplementation(dbRouter([[/UPDATE merchant_transfers/, transitionRow()], ...baseHandlers()]));
    mockTxQuery.mockImplementation(dbRouter(txHandlers({ collected: 100000 })));
    mockSendPayout.mockResolvedValue({ approved: false, pending: true, gatewayRef: 'MM-REF', responseCode: '09' });
  });

  test('sans confirm → 428 STEP_UP_REQUIRED ; mauvais mot de passe → 428 ; aucune réservation', async () => {
    let res = await withdraw({ amount: 50000 });
    expect(res.status).toBe(428); expect(res.body.methods).toEqual(['password']);
    res = await withdraw({ amount: 50000, confirm: { password: 'nope' } });
    expect(res.status).toBe(428);
    expect(mockTxQuery).not.toHaveBeenCalled();
  });

  test('montant < 1000 → 422 ; wallet absent → 422 WALLET_MISSING', async () => {
    let res = await withdraw({ amount: 500, confirm });
    expect(res.status).toBe(422); expect(res.body.code).toBe('VALIDATION_ERROR');
    mockDbQuery.mockImplementation(dbRouter(baseHandlers(merchant({ cash_wallet_phone: null, cash_wallet_operator: null }))));
    res = await withdraw({ amount: 50000, confirm });
    expect(res.status).toBe(422); expect(res.body.code).toBe('WALLET_MISSING');
  });

  test('opérateur sans rail sortant → 410 FEATURE_DISABLED avant toute réservation', async () => {
    mockGetConfig.mockResolvedValue({});
    const res = await withdraw({ amount: 50000, confirm });
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ code: 'FEATURE_DISABLED', operator: 'mtn_momo', operatorLabel: 'MTN MoMo' });
    expect(mockTxQuery).not.toHaveBeenCalled();
  });

  test('solde insuffisant → 422 INSUFFICIENT_BALANCE avec available, aucun INSERT', async () => {
    mockTxQuery.mockImplementation(dbRouter(txHandlers({ collected: 30000, withdrawn: 10000 })));
    const res = await withdraw({ amount: 50000, confirm });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'INSUFFICIENT_BALANCE', available: 20000, requested: 50000 });
    expect(calls(mockTxQuery, /INSERT INTO merchant_transfers/)).toHaveLength(0);
  });

  test('limite journalière (kyb 0 → 100 000) : 90 000 déjà retirés + 20 000 → 422 DAILY_LIMIT_EXCEEDED', async () => {
    mockDbQuery.mockImplementation(dbRouter(baseHandlers(merchant({ kyb_level: 0 }))));
    mockTxQuery.mockImplementation(dbRouter(txHandlers({ collected: 500000, today: 90000, m: merchant({ kyb_level: 0 }) })));
    const res = await withdraw({ amount: 20000, confirm });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'DAILY_LIMIT_EXCEEDED', limit: 100000, withdrawnToday: 90000, remaining: 10000 });
    expect(calls(mockTxQuery, /INSERT INTO merchant_transfers/)).toHaveLength(0);
    const [sql] = calls(mockTxQuery, /withdrawn_today/)[0];
    expect(sql).toMatch(/dest_type='wallet'/);
  });

  test('succès via routeur MM (pending) → 201 processing, INSERT sous verrou avant le rail, transition journalisée', async () => {
    const res = await withdraw({ amount: 50000, description: 'Caisse du soir', confirm });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ transferId: TRANSFER_ID, status: 'processing', amount: 50000, fee: 500, net: 49500, currency: 'XAF',
      wallet: { operator: 'mtn_momo', phone: '+237670000001', operatorLabel: 'MTN MoMo' } });
    expect(res.body.reference).toMatch(/^PAY-/);
    const sqls = mockTxQuery.mock.calls.map(([s]) => s);
    expect(sqls.findIndex((s) => s.includes('INSERT INTO merchant_transfers'))).toBeGreaterThan(sqls.findIndex((s) => s.includes('FOR UPDATE')));
    const [, ins] = calls(mockTxQuery, /INSERT INTO merchant_transfers/)[0];
    expect(ins.slice(1, 6)).toEqual(['wallet', null, 'mtn_momo', '+237670000001', 50000]);
    expect(mockSendPayout).toHaveBeenCalledWith(expect.objectContaining({ txnId: TRANSFER_ID, amount: 49500, currency: 'XAF', phone: '+237670000001', gateway: 'mtn_cm', operator: 'MTN_MOMO' }));
    const [sql, params] = calls(mockDbQuery, /UPDATE merchant_transfers/)[0];
    expect(params[1]).toBe('processing'); expect(params[11]).toEqual(['pending']); expect(params[4]).toBe('MM-REF');
    expect(JSON.parse(params[3])[0]).toMatchObject({ type: 'processing', rail: 'mtn_cm' });
    expect(sql).toMatch(/events = COALESCE\(events, '\[\]'::jsonb\) \|\| \$4::jsonb/);
  });

  test('MTN Congo → client rails mtn-momo (transfer), statut processing', async () => {
    const cg = merchant({ country: 'CG', cash_wallet_phone: '+242060000001' });
    mockDbQuery.mockImplementation(dbRouter([[/UPDATE merchant_transfers/, transitionRow({ wallet_phone: '+242060000001' })], ...baseHandlers(cg)]));
    mockTxQuery.mockImplementation(dbRouter(txHandlers({ collected: 100000, m: cg })));
    mockMtnTransfer.mockResolvedValue({ referenceId: 'MTN-REF', status: 'PENDING' });
    const res = await withdraw({ amount: 50000, confirm });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('processing');
    expect(mockMtnTransfer).toHaveBeenCalledWith(expect.objectContaining({ amount: 49500, phone: '+242060000001' }));
    expect(mockSendPayout).not.toHaveBeenCalled();
  });

  test('rail approuvé immédiatement → completed et wallet marqué vérifié ; refus → failed + 502', async () => {
    mockSendPayout.mockResolvedValue({ approved: true, gatewayRef: 'OK-1', responseCode: '00' });
    let res = await withdraw({ amount: 50000, confirm });
    expect(res.status).toBe(201); expect(res.body.status).toBe('completed');
    expect(calls(mockDbQuery, /UPDATE merchants SET cash_wallet_verified_at = NOW\(\)/)).toHaveLength(1);
    expect(calls(mockDbQuery, /UPDATE merchants SET cash_wallet_verified_at/)[0][1]).toEqual([MERCHANT_ID, '+237670000001']);

    mockDbQuery.mockClear();
    mockSendPayout.mockResolvedValue({ approved: false, pending: false, declineReason: 'Compte inactif', responseCode: '05' });
    res = await withdraw({ amount: 50000, confirm });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'GATEWAY_ERROR', transferId: TRANSFER_ID });
    const [, params] = calls(mockDbQuery, /UPDATE merchant_transfers/)[0];
    expect(params[1]).toBe('failed'); expect(params[6]).toBe('Compte inactif');
    expect(calls(mockDbQuery, /cash_wallet_verified_at = NOW/)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('6. POST /merchant/cash/transfers, liste, détail, annulation', () => {
  const transfers = (body) => request(app).post('/merchant/cash/transfers').set(bearer(merchantToken())).send(body);
  const bank = { account_id: 'ba1', inst_name: 'BGFI', account_number: '00012345678', account_name: 'SHOP' };
  const confirm = { password: PASSWORD };

  beforeEach(() => {
    mockDbQuery.mockImplementation(dbRouter(baseHandlers()));
    mockTxQuery.mockImplementation(dbRouter(txHandlers({ collected: 500000, bank })));
  });

  test('wallet_to_bank : step-up requis, puis 201 pending_manual (TRF-), e-mail opérations', async () => {
    let res = await transfers({ direction: 'wallet_to_bank', accountId: 'ba1', amount: 200000 });
    expect(res.status).toBe(428);
    res = await transfers({ direction: 'wallet_to_bank', accountId: 'ba1', amount: 200000, confirm });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ transferId: TRANSFER_ID, direction: 'wallet_to_bank', status: 'pending_manual', amount: 200000, fee: 2000, net: 198000,
      bankAccount: { bankName: 'BGFI', accountMasked: '*******5678' } });
    expect(res.body.reference).toMatch(/^TRF-/);
    expect(calls(mockDbQuery, /status='pending_manual', settlement_method='manual'/)).toHaveLength(1);
    expect(mockEmail).toHaveBeenCalled();
  });

  test('wallet_to_bank : compte non vérifié → 404 ; accountId manquant → 422 ; direction invalide → 422', async () => {
    mockTxQuery.mockImplementation(dbRouter(txHandlers({ collected: 500000, bank: null })));
    let res = await transfers({ direction: 'wallet_to_bank', accountId: 'ba9', amount: 200000, confirm });
    expect(res.status).toBe(404); expect(res.body.code).toBe('BANK_ACCOUNT_NOT_FOUND');
    res = await transfers({ direction: 'wallet_to_bank', amount: 200000, confirm });
    expect(res.status).toBe(422);
    res = await transfers({ direction: 'sideways', amount: 200000, confirm });
    expect(res.status).toBe(422);
  });

  test('bank_to_wallet : 409 sans compte de collecte ; ordre FND- avec instructions (sans step-up), +7 jours', async () => {
    let res = await transfers({ direction: 'bank_to_wallet', amount: 200000 });
    expect(res.status).toBe(409); expect(res.body).toMatchObject({ code: 'FUNDING_UNAVAILABLE', currency: 'XAF' });

    mockDbQuery.mockImplementation(dbRouter([
      [/FROM platform_bank_accounts WHERE currency=\$1 AND active/, [{ account_id: 'pb1', currency: 'XAF', bank_name: 'Ecobank', account_name: 'CALCULUS PLUS', account_number: '99887766', iban: null, swift: 'ECOCCMCX' }]],
      [/INSERT INTO merchant_transfers/, (sql, p) => rows([{ transfer_id: TRANSFER_ID, status: 'awaiting_funds', reference: p[4], amount: p[2] }])],
      ...baseHandlers(),
    ]));
    res = await transfers({ direction: 'bank_to_wallet', amount: 200000, description: 'Fonds propres' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ transferId: TRANSFER_ID, direction: 'bank_to_wallet', status: 'awaiting_funds', amount: 200000, currency: 'XAF',
      instructions: { bankName: 'Ecobank', accountName: 'CALCULUS PLUS', accountNumber: '99887766', swift: 'ECOCCMCX', currency: 'XAF' } });
    expect(res.body.reference).toMatch(/^FND-/);
    expect(res.body.instructions.reference).toBe(res.body.reference);
    const days = (new Date(res.body.expiresAt) - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(6.9); expect(days).toBeLessThan(7.1);
    const [sql, params] = calls(mockDbQuery, /INSERT INTO merchant_transfers/)[0];
    expect(sql).toMatch(/'funding','balance'/); expect(sql).toMatch(/'awaiting_funds'/);
    expect(params[0]).toBe(MERCHANT_ID); expect(params[2]).toBe(200000);
    expect(mockTxQuery).not.toHaveBeenCalled();
  });

  test('cancel : awaiting_funds | pending_manual uniquement, garde d’appartenance ; 409 sinon ; 404 inconnu', async () => {
    mockDbQuery.mockImplementation(dbRouter([[/UPDATE merchant_transfers/, transitionRow({ direction: 'funding', dest_type: 'balance', reference: 'FND-1' })], ...baseHandlers()]));
    let res = await request(app).post(`/merchant/cash/transfers/${TRANSFER_ID}/cancel`).set(bearer(merchantToken()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: 'cancelled', direction: 'bank_to_wallet' });
    const [sql, params] = calls(mockDbQuery, /UPDATE merchant_transfers/)[0];
    expect(params[11]).toEqual(['awaiting_funds', 'pending_manual']);
    expect(params[12]).toBe(MERCHANT_ID);
    expect(sql).toMatch(/merchant_id = \$13::uuid/);

    mockDbQuery.mockImplementation(dbRouter([
      [/UPDATE merchant_transfers/, []],
      [/FROM merchant_transfers mt/, [{ transfer_id: TRANSFER_ID, status: 'completed', direction: 'payout', dest_type: 'bank' }]],
    ]));
    res = await request(app).post(`/merchant/cash/transfers/${TRANSFER_ID}/cancel`).set(bearer(merchantToken()));
    expect(res.status).toBe(409); expect(res.body).toMatchObject({ code: 'TRANSFER_NOT_CANCELLABLE', status: 'completed' });

    mockDbQuery.mockImplementation(async () => rows([]));
    res = await request(app).post(`/merchant/cash/transfers/${TRANSFER_ID}/cancel`).set(bearer(merchantToken()));
    expect(res.status).toBe(404);
  });

  test('GET /transfers : filtres direction/status, pagination ; GET /transfers/:id rafraîchit un retrait processing', async () => {
    mockDbQuery.mockImplementation(dbRouter([
      [/COUNT\(\*\)::int AS total/, [{ total: 1 }]],
      [/FROM merchant_transfers mt/, [{ transfer_id: TRANSFER_ID, direction: 'payout', dest_type: 'bank', status: 'pending_manual', amount: '200000', fee: '2000', net_amount: '198000',
        currency: 'XAF', reference: 'TRF-1', inst_name: 'BGFI', account_number: '00012345678', created_at: '2026-10-15T10:00:00.000Z' }]],
    ]));
    let res = await request(app).get('/merchant/cash/transfers?direction=wallet_to_bank&status=pending_manual&limit=10').set(bearer(merchantToken()));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0]).toMatchObject({ transferId: TRANSFER_ID, direction: 'wallet_to_bank', type: 'transfer_out', status: 'pending_manual', amount: 200000, net: 198000, bankAccount: { bankName: 'BGFI', accountMasked: '*******5678' } });
    const [sql, params] = calls(mockDbQuery, /FROM merchant_transfers mt/)[0];
    expect(sql).toMatch(/mt.direction='payout' AND mt.dest_type='bank'/); expect(params).toEqual([MERCHANT_ID, 'pending_manual', 10, 0]);
    expect((await request(app).get('/merchant/cash/transfers?direction=nope').set(bearer(merchantToken()))).status).toBe(422);

    // détail : processing MTN Congo → statut opérateur SUCCESSFUL → completed
    mockDbQuery.mockImplementation(dbRouter([
      [/UPDATE merchant_transfers/, transitionRow({ wallet_phone: '+242060000001' })],
      [/FROM merchant_transfers mt/, [{ transfer_id: TRANSFER_ID, merchant_id: MERCHANT_ID, direction: 'payout', dest_type: 'wallet', status: 'processing', amount: '50000', fee: '500', net_amount: '49500',
        currency: 'XAF', reference: 'PAY-1', wallet_operator: 'mtn_momo', wallet_phone: '+242060000001', gateway_reference: 'MTN-REF', merchant_country: 'CG' }]],
    ]));
    mockMtnStatus.mockResolvedValue({ status: 'SUCCESSFUL', financialTxnId: 'FT-1' });
    res = await request(app).get(`/merchant/cash/transfers/${TRANSFER_ID}`).set(bearer(merchantToken()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ transferId: TRANSFER_ID, status: 'completed', type: 'withdraw' });
    expect(mockMtnStatus).toHaveBeenCalledWith('MTN-REF');
    const [, p] = calls(mockDbQuery, /UPDATE merchant_transfers\s+SET status=/)[0]; // WAVE-6 : last_status_check_at est touché avant la transition
    expect(p[1]).toBe('completed'); expect(p[11]).toEqual(['processing']); expect(p[4]).toBe('FT-1');
    expect(calls(mockDbQuery, /cash_wallet_verified_at = NOW/)).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('7. Administration /admin/cash', () => {
  const fundingRow = (over = {}) => ({ transfer_id: TRANSFER_ID, merchant_id: MERCHANT_ID, direction: 'funding', dest_type: 'balance', status: 'awaiting_funds',
    amount: '200000', fee: '0', net_amount: '200000', currency: 'XAF', reference: 'FND-1', business_name: 'Shop', merchant_email: 'shop@test.io', events: [], ...over });

  test('rôles : support_agent / finance_admin → 403, marchand → 403, sans jeton → 401', async () => {
    expect((await request(app).get('/admin/cash/stats').set(bearer(adminToken('support_agent')))).status).toBe(403);
    expect((await request(app).get('/admin/cash/stats').set(bearer(adminToken('finance_admin')))).status).toBe(403);
    expect((await request(app).get('/admin/cash/stats').set(bearer(merchantToken()))).status).toBe(403);
    expect((await request(app).get('/admin/cash/stats')).status).toBe(401);
    expect((await request(app).post(`/admin/cash/transfers/${TRANSFER_ID}/reject`).set(bearer(adminToken('support_agent'))).send({ reason: 'x' })).status).toBe(403);
  });

  test('stats : files d’attente et volumes', async () => {
    mockDbQuery.mockImplementation(dbRouter([
      [/FROM merchant_transfers/, [{ q_manual: '3', q_manual_amount: '600000', q_funding: '2', q_funding_amount: '400000', q_processing: '1', d_withdraw_n: '4', d_withdraw: '80000', d_out_n: '1', d_out: '200000', d_in_n: '0', d_in: '0', w_withdraw_n: '10', w_withdraw: '300000', w_out_n: '2', w_out: '400000', w_in_n: '1', w_in: '150000' }]],
      [/FROM transactions WHERE type='collect'/, [{ d_n: '12', d_amount: '80000', w_n: '70', w_amount: '500000' }]],
    ]));
    const res = await request(app).get('/admin/cash/stats').set(bearer(adminToken('super_admin')));
    expect(res.status).toBe(200);
    expect(res.body.queues).toEqual({ pendingManual: { count: 3, amount: 600000 }, awaitingFunds: { count: 2, amount: 400000 }, processing: { count: 1 }, unknown: { count: 0, amount: 0 }, needsReview: { count: 0 } }); // WAVE-6
    expect(res.body.today.collected).toEqual({ count: 12, amount: 80000 });
    expect(res.body.last7Days.transfersIn).toEqual({ count: 1, amount: 150000 });
    const [, params] = calls(mockDbQuery, /FROM merchant_transfers/)[0];
    expect(params[0]).toEqual(['pending_manual', 'pending_settlement']);
  });

  test('liste : filtres status (alias pending_manual ⇒ + pending_settlement), direction, merchantId, q', async () => {
    mockDbQuery.mockImplementation(dbRouter([[/COUNT\(\*\)::int AS total/, [{ total: 1 }]], [/FROM merchant_transfers mt/, [fundingRow()]]]));
    const res = await request(app).get(`/admin/cash/transfers?status=pending_manual&direction=funding&merchantId=${MERCHANT_ID}&q=FND&limit=5&offset=10`).set(bearer(adminToken()));
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ transferId: TRANSFER_ID, direction: 'bank_to_wallet', merchantId: MERCHANT_ID, merchant: 'Shop', events: [] });
    const [sql, params] = calls(mockDbQuery, /FROM merchant_transfers mt/)[0];
    expect(params[0]).toEqual(['pending_manual', 'pending_settlement']);
    expect(params[1]).toBe(MERCHANT_ID); expect(params[2]).toBe('%FND%'); expect(params.slice(-2)).toEqual([5, 10]);
    expect(sql).toMatch(/mt.direction='funding'/); expect(sql).toMatch(/business_name ILIKE/);
  });

  test('confirm-funds : awaiting_funds → completed, montant reçu ≠ demandé stocké + journalisé, audit log', async () => {
    mockDbQuery.mockImplementation(dbRouter([
      [/UPDATE merchant_transfers/, transitionRow({ direction: 'funding', dest_type: 'balance', amount: 195000, amount_requested: 200000, reference: 'FND-1' })],
      [/FROM merchant_transfers mt/, [fundingRow()]],
    ]));
    let res = await request(app).post(`/admin/cash/transfers/${TRANSFER_ID}/confirm-funds`).set(bearer(adminToken())).send({ amountReceived: 195000, bankReference: 'VIR-2026-001' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: 'completed', amountRequested: 200000, amountReceived: 195000, amount: 195000, bankReference: 'VIR-2026-001' });
    const [, params] = calls(mockDbQuery, /UPDATE merchant_transfers/)[0];
    expect(params[1]).toBe('completed'); expect(params[11]).toEqual(['awaiting_funds']);
    expect(params[5]).toBe('VIR-2026-001'); expect(params[7]).toBe(ADMIN_ID); expect(params[9]).toBe(195000); expect(params[10]).toBe(200000);
    expect(JSON.parse(params[3])[0]).toMatchObject({ type: 'completed', action: 'confirm_funds', amountRequested: 200000, amountReceived: 195000, note: expect.stringMatching(/différent/) });
    const [asql, aparams] = calls(mockDbQuery, /INSERT INTO audit_logs/)[0];
    expect(asql).toMatch(/'admin'/); expect(aparams[2]).toBe('CASH_FUNDING_CONFIRM'); expect(aparams[4]).toBe(TRANSFER_ID);
    expect(calls(mockDbQuery, /cash_wallet_verified_at = NOW/)).toHaveLength(0);

    // montant identique : amount/amount_requested non touchés
    mockDbQuery.mockClear();
    res = await request(app).post(`/admin/cash/transfers/${TRANSFER_ID}/confirm-funds`).set(bearer(adminToken())).send({ amountReceived: 200000, bankReference: 'VIR-2' });
    expect(res.status).toBe(200);
    const [, p2] = calls(mockDbQuery, /UPDATE merchant_transfers/)[0];
    expect(p2[9]).toBeNull(); expect(p2[10]).toBeNull();

    expect((await request(app).post(`/admin/cash/transfers/${TRANSFER_ID}/confirm-funds`).set(bearer(adminToken())).send({ amountReceived: 0, bankReference: 'x' })).status).toBe(422);
    mockDbQuery.mockImplementation(dbRouter([[/FROM merchant_transfers mt/, [fundingRow({ direction: 'payout', dest_type: 'bank', status: 'pending_manual' })]]]));
    expect((await request(app).post(`/admin/cash/transfers/${TRANSFER_ID}/confirm-funds`).set(bearer(adminToken())).send({ amountReceived: 1, bankReference: 'x' })).body.code).toBe('NOT_FUNDING_ORDER');
  });

  test('mark-executed : pending_manual | pending_settlement → completed ; statut incompatible → 409 ; bankReference requis', async () => {
    mockDbQuery.mockImplementation(dbRouter([
      [/UPDATE merchant_transfers/, transitionRow({ direction: 'payout', dest_type: 'bank', reference: 'TRF-1' })],
      [/FROM merchant_transfers mt/, [fundingRow({ direction: 'payout', dest_type: 'bank', status: 'pending_settlement', reference: 'TRF-1', inst_name: 'BGFI', account_number: '00012345678' })]],
    ]));
    let res = await request(app).post(`/admin/cash/transfers/${TRANSFER_ID}/mark-executed`).set(bearer(adminToken())).send({ bankReference: 'VIR-9' });
    expect(res.status).toBe(200); expect(res.body).toMatchObject({ success: true, status: 'completed' });
    const [, params] = calls(mockDbQuery, /UPDATE merchant_transfers/)[0];
    expect(params[11]).toEqual(['pending_manual', 'pending_settlement']); expect(params[5]).toBe('VIR-9');
    expect(calls(mockDbQuery, /INSERT INTO audit_logs/)[0][1][2]).toBe('CASH_TRANSFER_EXECUTED');
    expect(mockEmail).toHaveBeenCalled();
    expect((await request(app).post(`/admin/cash/transfers/${TRANSFER_ID}/mark-executed`).set(bearer(adminToken())).send({})).status).toBe(422);

    mockDbQuery.mockClear();
    mockDbQuery.mockImplementation(dbRouter([[/UPDATE merchant_transfers/, []], [/FROM merchant_transfers mt/, [fundingRow({ status: 'completed' })]]]));
    res = await request(app).post(`/admin/cash/transfers/${TRANSFER_ID}/mark-executed`).set(bearer(adminToken())).send({ bankReference: 'VIR-9' });
    expect(res.status).toBe(409); expect(res.body).toMatchObject({ code: 'INVALID_STATUS', status: 'completed' });
    expect(calls(mockDbQuery, /INSERT INTO audit_logs/)).toHaveLength(0);
  });

  test('reject : libère les fonds d’un payout, 409 sur processing, reason requis, 404 inconnu', async () => {
    mockDbQuery.mockImplementation(dbRouter([
      [/UPDATE merchant_transfers/, transitionRow({ direction: 'payout', dest_type: 'bank', amount: 200000 })],
      [/FROM merchant_transfers mt/, [fundingRow({ direction: 'payout', dest_type: 'bank', status: 'pending_manual' })]],
    ]));
    let res = await request(app).post(`/admin/cash/transfers/${TRANSFER_ID}/reject`).set(bearer(adminToken())).send({ reason: 'RIB invalide' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: 'rejected', released: 200000 });
    const [, params] = calls(mockDbQuery, /UPDATE merchant_transfers/)[0];
    expect(params[1]).toBe('rejected'); expect(params[11]).toEqual(['awaiting_funds', 'pending_manual', 'pending_settlement']); expect(params[6]).toBe('RIB invalide');
    expect(calls(mockDbQuery, /INSERT INTO audit_logs/)[0][1][2]).toBe('CASH_TRANSFER_REJECT');

    expect((await request(app).post(`/admin/cash/transfers/${TRANSFER_ID}/reject`).set(bearer(adminToken())).send({})).status).toBe(422);
    mockDbQuery.mockImplementation(dbRouter([[/UPDATE merchant_transfers/, []], [/FROM merchant_transfers mt/, [fundingRow({ direction: 'payout', dest_type: 'wallet', status: 'processing' })]]]));
    res = await request(app).post(`/admin/cash/transfers/${TRANSFER_ID}/reject`).set(bearer(adminToken())).send({ reason: 'x' });
    expect(res.status).toBe(409);
    mockDbQuery.mockImplementation(async () => rows([]));
    expect((await request(app).post(`/admin/cash/transfers/${TRANSFER_ID}/reject`).set(bearer(adminToken())).send({ reason: 'x' })).status).toBe(404);
  });

  test('platform-accounts : GET / POST (201, audit) / PATCH ; validations', async () => {
    mockDbQuery.mockImplementation(dbRouter([
      [/INSERT INTO platform_bank_accounts/, (sql, p) => rows([{ account_id: 'pb1', currency: p[0], bank_name: p[1], account_name: p[2], account_number: p[3], iban: p[4], swift: p[5], active: p[6], notes: p[7] }])],
      [/UPDATE platform_bank_accounts/, (sql, p) => rows([{ account_id: p[p.length - 1], currency: 'XAF', bank_name: 'Ecobank', account_name: 'CALCULUS PLUS', account_number: '99887766', active: false }])],
      [/FROM platform_bank_accounts/, [{ account_id: 'pb1', currency: 'XAF', bank_name: 'Ecobank', account_name: 'CALCULUS PLUS', account_number: '99887766', active: true }]],
    ]));
    let res = await request(app).post('/admin/cash/platform-accounts').set(bearer(adminToken('super_admin'))).send({ currency: 'xaf', bankName: 'Ecobank', accountName: 'CALCULUS PLUS', accountNumber: '99887766', swift: 'ECOCCMCX' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ accountId: 'pb1', currency: 'XAF', bankName: 'Ecobank', swift: 'ECOCCMCX', active: true });
    expect(calls(mockDbQuery, /INSERT INTO audit_logs/)[0][1][2]).toBe('CASH_PLATFORM_ACCOUNT_CREATE');
    expect((await request(app).post('/admin/cash/platform-accounts').set(bearer(adminToken())).send({ currency: 'XAF', bankName: 'x' })).status).toBe(422);
    expect((await request(app).post('/admin/cash/platform-accounts').set(bearer(adminToken())).send({ currency: 'FRANCS', bankName: 'x', accountName: 'y', accountNumber: '1' })).status).toBe(422);

    res = await request(app).patch('/admin/cash/platform-accounts/pb1').set(bearer(adminToken())).send({ active: false, notes: 'Compte clôturé' });
    expect(res.status).toBe(200); expect(res.body.active).toBe(false);
    const [sql, params] = calls(mockDbQuery, /UPDATE platform_bank_accounts/)[0];
    expect(sql).toMatch(/active=\$1, notes=\$2, updated_at=NOW\(\) WHERE account_id=\$3/); expect(params).toEqual([false, 'Compte clôturé', 'pb1']);
    expect((await request(app).patch('/admin/cash/platform-accounts/pb1').set(bearer(adminToken())).send({})).status).toBe(422);
    expect((await request(app).patch('/admin/cash/platform-accounts/pb1').set(bearer(adminToken())).send({ bankName: '' })).status).toBe(422);

    res = await request(app).get('/admin/cash/platform-accounts').set(bearer(adminToken()));
    expect(res.status).toBe(200); expect(res.body.total).toBe(1); expect(res.body.data[0].accountNumber).toBe('99887766');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('8. Journal /merchant/cash/history et export CSV', () => {
  const journal = [
    { id: 'T-1', type: 'collect', reference: 'MOB-1', amount: '25000', fee: '375', net: '24625', currency: 'XAF', status: 'authorized', cp_kind: 'operator', cp_name: 'MTN_MOMO', cp_number: '', method: 'mobile_money', created_at: new Date('2026-10-15T10:00:00Z'), description: 'Table 4; "VIP"' },
    { id: TRANSFER_ID, type: 'withdraw', reference: 'PAY-1', amount: '50000', fee: '500', net: '49500', currency: 'XAF', status: 'completed', cp_kind: 'wallet', cp_name: 'mtn_momo', cp_number: '+237670000001', method: 'mobile_money', created_at: new Date('2026-10-15T09:00:00Z'), description: null },
    { id: 'X-3', type: 'transfer_out', reference: 'TRF-1', amount: '200000', fee: '2000', net: '198000', currency: 'XAF', status: 'pending_manual', cp_kind: 'bank', cp_name: 'BGFI', cp_number: '00012345678', method: 'bank_transfer', created_at: new Date('2026-10-14T09:00:00Z'), description: null },
    { id: 'X-4', type: 'transfer_in', reference: 'FND-1', amount: '100000', fee: '0', net: '100000', currency: 'XAF', status: 'completed', cp_kind: 'platform', cp_name: 'Ecobank', cp_number: '', method: 'bank_transfer', created_at: new Date('2026-10-13T09:00:00Z'), description: null },
  ];
  beforeEach(() => mockDbQuery.mockImplementation(dbRouter([
    [/SELECT COUNT\(\*\)::int AS total,/, [{ total: 4, total_in: 124625, total_out: 250000 }]],
    [/WITH j AS/, journal],
  ])));

  test('history : UNION transactions + merchant_transfers, filtres, totaux in/out, contreparties masquées', async () => {
    const res = await request(app).get('/merchant/cash/history?from=2026-10-01&to=2026-10-15&type=collect&limit=20&offset=0').set(bearer(merchantToken()));
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.totals).toEqual({ in: 124625, out: 250000 });
    expect(res.body.data.map((d) => d.counterparty)).toEqual(['MTN MoMo', 'MTN MoMo **********001', 'BGFI *******5678', 'Ecobank']);
    expect(res.body.data[0]).toMatchObject({ id: 'T-1', type: 'collect', reference: 'MOB-1', amount: 25000, fee: 375, net: 24625, status: 'authorized', method: 'mobile_money' });
    const [sql, params] = calls(mockDbQuery, /WITH j AS/)[0];
    expect(sql).toMatch(/FROM transactions t/); expect(sql).toMatch(/UNION ALL/); expect(sql).toMatch(/FROM merchant_transfers mt/);
    expect(sql).toMatch(/t.type IN \('collect','payout'\)/);
    expect(params[0]).toBe(MERCHANT_ID); expect(params[1].toISOString()).toBe('2026-10-01T00:00:00.000Z'); expect(params[2].toISOString()).toBe('2026-10-15T23:59:59.999Z');
    expect(params[3]).toBe('collect'); expect(params.slice(4)).toEqual([20, 0]);
    const [tsql] = calls(mockDbQuery, /SELECT COUNT\(\*\)::int AS total,/)[0];
    expect(tsql).toMatch(/type IN \('collect','transfer_in'\) AND status IN \('authorized','completed'\)/);
    expect(tsql).toMatch(/type IN \('withdraw','transfer_out'\) AND status NOT IN \('failed','cancelled','rejected'/);
    expect((await request(app).get('/merchant/cash/history?type=refund').set(bearer(merchantToken()))).status).toBe(422);
    expect((await request(app).get('/merchant/cash/history?from=hier').set(bearer(merchantToken()))).status).toBe(422);
  });

  test('export.csv : BOM UTF-8, séparateur ;, en-tête, échappement, pièce jointe', async () => {
    const res = await request(app).get('/merchant/cash/history/export.csv?from=2026-10-01&to=2026-10-15').set(bearer(merchantToken()));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="caisse-2026-10-01_2026-10-15.csv"/);
    expect(res.text.charCodeAt(0)).toBe(0xFEFF);
    const lines = res.text.slice(1).split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('date;type;reference;montant;frais;net;devise;statut;contrepartie;methode;description');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe('2026-10-15T10:00:00.000Z;collect;MOB-1;25000;375;24625;XAF;authorized;MTN MoMo;mobile_money;"Table 4; ""VIP"""');
    expect(lines[2]).toContain(';withdraw;PAY-1;50000;500;49500;XAF;completed;MTN MoMo **********001;mobile_money;');
    const [sql] = calls(mockDbQuery, /WITH j AS/)[0];
    expect(sql).toMatch(/LIMIT 10000/);
  });
});
