'use strict';
/**
 * WAVE-3 — réconciliation des providers vague 2 (finalisation partagée avec les webhooks),
 * finalize.service, POST /admin/users/:id/reset-password.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wave3-test-secret-at-least-32-chars-long';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() }));
const mockDbQuery = jest.fn();
jest.mock('../config/database', () => ({
  query: (...a) => mockDbQuery(...a),
  withTransaction: async (fn) => fn({ query: (...a) => mockDbQuery(...a) }),
  pool: {},
}));
const mockEnqueue = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/settlement/settlement.queue', () => ({ enqueue: (...a) => mockEnqueue(...a) }));
const mockGetProvider = jest.fn();
const mockGetConfig = jest.fn();
jest.mock('../services/mobilemoney/mobilemoney.router', () => ({
  getProvider: (...a) => mockGetProvider(...a),
  getConfig: (...a) => mockGetConfig(...a),
  invalidateCache: jest.fn(), webhookUrl: jest.fn(),
  PROVIDERS: Object.fromEntries(['mtn_cm', 'mtn_ci', 'mtn_cg', 'orange_sn', 'orange_ci', 'orange_cm', 'orange_cg', 'orange_cd', 'airtel_cd', 'airtel_cg',
    'africell_cd', 'interswitch_orange_cd', 'wave_sn', 'wave_ci', 'moov_ci', 'moov_cm', 'express_union_cm', 'free_money_sn'].map(k => [k, () => ({})])),
}));
jest.mock('../services/rails/mtn-momo.client', () => ({ getCollectionStatus: jest.fn(), getDisbursementStatus: jest.fn() }));
jest.mock('../services/notifications/email.service', () => ({ send: jest.fn(async () => true) }));
jest.mock('../services/notifications/smpp.service', () => ({ sendSmsSmpp: jest.fn(async () => true), notifyMultiChannel: jest.fn(async () => true) }));
jest.mock('../services/notifications/whatsapp.service', () => ({ sendWhatsAppText: jest.fn(async () => true) }));

const rows = (r, rc) => ({ rows: r, rowCount: rc === undefined ? r.length : rc });
const calls = (re) => mockDbQuery.mock.calls.filter(([s]) => re.test(s));
const UPDATE_TXN = /UPDATE transactions/;

beforeEach(() => {
  jest.clearAllMocks();
  mockDbQuery.mockReset(); mockDbQuery.mockImplementation(async () => rows([]));
  mockGetConfig.mockResolvedValue({ apiKey: 'k', statusPath: '/status/{ref}' });
  mockGetProvider.mockReturnValue(null);
});

const { reconcilePending, reconcileOne, wave2Provider, gatewayKeyFor } = require('../services/reconcile.service');
const { finalizeTransaction } = require('../services/mobilemoney/finalize.service');

const afTxn = (over = {}) => ({
  transaction_id: 'T-AF', merchant_id: 'M-1', type: 'collect', amount: '5000', currency: 'CDF', status: 'pending',
  detected_operator: 'AFRICELL_MONEY', detected_country: 'CD', gateway_name: 'africell_cd', gateway_payment_id: 'AF-REF', pay_link_id: null, ...over,
});

describe('reconcile.service — providers vague 2', () => {
  test('SQL : fenêtre, âge minimal, opérateurs vague 2 par detected_operator OU gateway_name (MTN/Airtel conservés)', async () => {
    mockDbQuery.mockResolvedValue(rows([]));
    const r = await reconcilePending({ maxAgeHours: 6, limit: 10, minAgeMinutes: 7 });
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/LOWER\(detected_operator\) LIKE 'mtn%'/);
    expect(sql).toMatch(/LOWER\(detected_operator\) = ANY\(\$3::text\[\]\)/);
    expect(sql).toMatch(/LOWER\(gateway_name\) = ANY\(\$4::text\[\]\)/);
    expect(sql).toMatch(/initiated_at < NOW\(\) - \(\$5 \|\| ' minutes'\)::interval/);
    expect(sql).toMatch(/gateway_name, gateway_payment_id, pay_link_id/);
    expect(params[0]).toBe('6'); expect(params[1]).toBe(10); expect(params[4]).toBe('7');
    expect(params[2]).toEqual(expect.arrayContaining(['orange_money', 'wave', 'africell_money', 'express_union', 'free_money', 'moov_money']));
    expect(params[3]).toEqual(expect.arrayContaining(['orange_cg', 'wave_sn', 'africell_cd', 'express_union_cm', 'free_money_sn', 'moov_ci']));
    expect(params[3]).not.toContain('interswitch_orange_cd');
    expect(r.summary).toMatchObject({ scanned: 0, skipped: 0, by_provider: {} });
  });

  test('wave2Provider / gatewayKeyFor : gateway_name prioritaire, repli opérateur + pays', () => {
    expect(wave2Provider({ gateway_name: 'orange_cg', detected_operator: 'WAVE' })).toBe('orange');
    expect(wave2Provider({ gateway_name: 'ORANGE_MONEY', detected_operator: 'ORANGE_MONEY' })).toBe('orange');
    expect(wave2Provider({ detected_operator: 'express_union' })).toBe('express_union');
    expect(wave2Provider({ detected_operator: 'MTN_MOMO' })).toBeNull();
    expect(gatewayKeyFor('orange', { gateway_name: 'ORANGE_MONEY', detected_country: 'CM' })).toBe('orange_cm');
    expect(gatewayKeyFor('wave', { detected_country: 'CI' })).toBe('wave_ci');
    expect(gatewayKeyFor('wave', { detected_country: 'XX' })).toBe('wave_sn');
  });

  test('Africell SUCCESSFUL → finalisation webhook (claim status=pending, règlement enfilé, transaction_events RECONCILE)', async () => {
    mockGetProvider.mockReturnValue({ getStatus: jest.fn().mockResolvedValue({ available: true, status: 'SUCCESSFUL', amount: 5000, currency: 'CDF', gatewayRef: 'AF-OP-1' }) });
    mockDbQuery.mockImplementation(async (sql) => UPDATE_TXN.test(sql) ? rows([{ transaction_id: 'T-AF' }]) : rows([]));
    const r = await reconcileOne(afTxn());
    expect(r).toMatchObject({ txn: 'T-AF', provider: 'africell', updated: 'authorized' });
    expect(mockGetProvider).toHaveBeenCalledWith('africell_cd');
    const [sql, params] = calls(UPDATE_TXN)[0];
    expect(sql).toMatch(/WHERE transaction_id = \$5 AND status = 'pending'/);
    expect(sql).toMatch(/response_code = CASE WHEN \$1 = 'authorized' THEN '00'/);
    expect(params[0]).toBe('authorized'); expect(params[1]).toBe('AF-OP-1'); expect(params[3]).toMatch(/reconcile/);
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ txnId: 'T-AF', merchantId: 'M-1', amount: 5000, currency: 'CDF' }), expect.anything()); // WAVE-6 : client SQL
    const ev = calls(/INSERT INTO transaction_events/)[0];
    expect(ev[1][2]).toBe('AFRICELL_RECONCILE');
  });

  test('pay_link : marqué paid ; payout : pas de règlement', async () => {
    mockGetProvider.mockReturnValue({ getStatus: jest.fn().mockResolvedValue({ available: true, status: 'SUCCESSFUL' }) });
    mockDbQuery.mockImplementation(async (sql) => UPDATE_TXN.test(sql) ? rows([{}]) : rows([]));
    await reconcileOne(afTxn({ type: 'pay_link', pay_link_id: 'PL-1' }));
    expect(calls(/UPDATE pay_links SET status='paid'/)).toHaveLength(1);
    mockEnqueue.mockClear();
    await reconcileOne(afTxn({ type: 'payout', gateway_name: 'moov_ci', detected_operator: 'MOOV_MONEY' }));
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockGetProvider.mock.calls.at(-1)[0]).toBe('moov_ci');
    const st = mockGetProvider.mock.results.at(-1).value.getStatus;
    expect(st).toHaveBeenCalledWith(expect.objectContaining({ product: 'disbursement', gatewayRef: 'AF-REF' }));
  });

  test('FAILED explicite → failed avec raison ; montant différent → pending ; PENDING → pending', async () => {
    mockGetProvider.mockReturnValue({ getStatus: jest.fn().mockResolvedValue({ available: true, status: 'FAILED', reason: 'Solde insuffisant' }) });
    mockDbQuery.mockImplementation(async (sql) => UPDATE_TXN.test(sql) ? rows([{}]) : rows([]));
    let r = await reconcileOne(afTxn());
    expect(r).toMatchObject({ updated: 'failed', reason: 'Solde insuffisant' });
    expect(calls(UPDATE_TXN)[0][1][0]).toBe('failed');
    expect(calls(UPDATE_TXN)[0][1][3]).toBe('Solde insuffisant');

    mockDbQuery.mockClear();
    mockGetProvider.mockReturnValue({ getStatus: jest.fn().mockResolvedValue({ available: true, status: 'SUCCESSFUL', amount: 100, currency: 'CDF' }) });
    r = await reconcileOne(afTxn());
    expect(r).toMatchObject({ still: 'pending', mismatch: true });
    expect(calls(UPDATE_TXN)).toHaveLength(0);

    mockGetProvider.mockReturnValue({ getStatus: jest.fn().mockResolvedValue({ available: true, status: 'PENDING' }) });
    r = await reconcileOne(afTxn());
    expect(r).toMatchObject({ still: 'pending', providerStatus: 'PENDING' });
    expect(calls(UPDATE_TXN)).toHaveLength(0);
  });

  test('opérateur injoignable / sans endpoint / statusPath absent → laissé pending, aucune écriture', async () => {
    mockGetProvider.mockReturnValue({ getStatus: jest.fn().mockRejectedValue(new Error('ECONNRESET')) });
    let r = await reconcileOne(afTxn());
    expect(r).toMatchObject({ still: 'pending', error: 'ECONNRESET' });
    // Orange : pas de getStatus
    mockGetProvider.mockReturnValue({ collectPayment: jest.fn() });
    r = await reconcileOne(afTxn({ gateway_name: 'orange_cg', detected_operator: 'ORANGE_MONEY', detected_country: 'CG' }));
    expect(r).toMatchObject({ provider: 'orange', skipped: 'no_status_endpoint' });
    // statusPath non configuré
    mockGetProvider.mockReturnValue({ getStatus: jest.fn().mockResolvedValue({ available: false }) });
    r = await reconcileOne(afTxn());
    expect(r).toMatchObject({ skipped: 'status_unavailable' });
    // déjà finalisée entre-temps (claim perdu)
    mockGetProvider.mockReturnValue({ getStatus: jest.fn().mockResolvedValue({ available: true, status: 'SUCCESSFUL' }) });
    mockDbQuery.mockImplementation(async () => rows([], 0));
    r = await reconcileOne(afTxn());
    expect(r).toMatchObject({ skipped: 'already_final' });
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(calls(/transaction_events/)).toHaveLength(0);
  });

  test('reconcilePending : résumé par provider', async () => {
    mockDbQuery.mockImplementation(async (sql) => {
      if (/FROM transactions/.test(sql) && /status='pending'/.test(sql)) return rows([afTxn(), afTxn({ transaction_id: 'T-OR', gateway_name: 'orange_sn', detected_operator: 'ORANGE_MONEY' })]);
      if (UPDATE_TXN.test(sql)) return rows([{}]);
      return rows([]);
    });
    mockGetProvider.mockImplementation((key) => key === 'africell_cd' ? { getStatus: jest.fn().mockResolvedValue({ available: true, status: 'SUCCESSFUL' }) } : {});
    const r = await reconcilePending({});
    expect(r.summary).toMatchObject({ scanned: 2, authorized: 1, skipped: 1, by_provider: { africell: { authorized: 1 }, orange: { skipped: 1 } } });
  });
});

describe('finalize.service', () => {
  test('outcome invalide refusé ; rejeu → applied:false sans effets', async () => {
    await expect(finalizeTransaction({ txn: { transaction_id: 'T' }, provider: 'wave', outcome: 'pending' })).rejects.toThrow(/outcome/);
    mockDbQuery.mockImplementation(async () => rows([], 0));
    const r = await finalizeTransaction({ txn: { transaction_id: 'T', type: 'collect' }, provider: 'wave', outcome: 'authorized' });
    expect(r).toEqual({ applied: false, status: 'already_processed' });
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
  test('webhook : message « Paiement confirmé (wave) », event WAVE_CALLBACK', async () => {
    mockDbQuery.mockImplementation(async (sql) => UPDATE_TXN.test(sql) ? rows([{}]) : rows([]));
    const r = await finalizeTransaction({ txn: { transaction_id: 'T', merchant_id: 'M', type: 'collect', amount: '10', currency: 'XOF' }, provider: 'wave', outcome: 'authorized', gatewayRef: 'cos-1' });
    expect(r).toEqual({ applied: true, status: 'authorized' });
    expect(calls(UPDATE_TXN)[0][1][3]).toBe('Paiement confirmé (wave)');
    expect(calls(/transaction_events/)[0][1][2]).toBe('WAVE_CALLBACK');
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
  });
});

describe('POST /admin/users/:id/reset-password', () => {
  const { signToken } = require('../middleware/auth');
  const adminRouter = require('../routes/admin.routes');
  const app = express(); app.use(express.json()); app.use('/admin', adminRouter);
  const ADMIN_SELF = '99999999-9999-4999-8999-999999999999';
  const TARGET = '11111111-1111-4111-8111-111111111111';
  const tok = (role, sub = ADMIN_SELF) => `Bearer ${signToken({ sub, type: 'admin', role, email: 'admin@test.io' })}`;
  const userDb = (table, row) => mockDbQuery.mockImplementation(async (sql) => {
    if (new RegExp(`FROM ${table} WHERE`).test(sql)) return rows(row ? [row] : []);
    if (new RegExp(`UPDATE ${table} SET password_hash`).test(sql)) return rows([], 1);
    return rows([]);
  });

  test('ops_admin → marchand : mot de passe temporaire renvoyé une fois, bcrypt, temp_password=TRUE, sessions révoquées, audit', async () => {
    userDb('merchant_users', { id: TARGET, email: 'u@m.io', role: 'cashier', is_active: true });
    const res = await request(app).post(`/admin/users/${TARGET}/reset-password`).set('Authorization', tok('ops_admin')).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, type: 'merchant', email: 'u@m.io', mustChangePassword: true });
    expect(res.body.tempPassword).toMatch(/^Tmp-[A-Za-z0-9_-]{16}$/);
    const upd = calls(/UPDATE merchant_users SET password_hash=\$1, temp_password=TRUE/)[0];
    expect(upd[1][1]).toBe(TARGET);
    expect(upd[1][0]).not.toBe(res.body.tempPassword);
    expect(await bcrypt.compare(res.body.tempPassword, upd[1][0])).toBe(true);
    const rev = calls(/UPDATE refresh_tokens SET revoked_at = NOW\(\) WHERE actor_type = \$1 AND subject_id = \$2/)[0];
    expect(rev[1]).toEqual(['merchant', TARGET]);
    const audit = calls(/INSERT INTO audit_logs/)[0];
    expect(audit[1]).toEqual(expect.arrayContaining([ADMIN_SELF, 'merchant_user', TARGET]));
    expect(audit[1].join(' ')).not.toContain(res.body.tempPassword);
    expect(JSON.stringify(mockDbQuery.mock.calls)).not.toContain(res.body.tempPassword);
    expect(calls(/mfa/)).toHaveLength(0);
  });

  test('ops_admin → compte admin : 403 ; support_agent : 403', async () => {
    userDb('admin_users', { id: TARGET, email: 'a@m.io', role: 'ops_admin' });
    expect((await request(app).post(`/admin/users/${TARGET}/reset-password?type=admin`).set('Authorization', tok('ops_admin'))).status).toBe(403);
    expect((await request(app).post(`/admin/users/${TARGET}/reset-password`).set('Authorization', tok('support_agent'))).status).toBe(403);
    expect(calls(/UPDATE/)).toHaveLength(0);
  });

  test('super_admin → compte admin (même super_admin) : OK sur admin_users ; jamais son propre compte', async () => {
    userDb('admin_users', { id: TARGET, email: 'root@m.io', role: 'super_admin' });
    const res = await request(app).post(`/admin/users/${TARGET}/reset-password?type=admin`).set('Authorization', tok('super_admin'));
    expect(res.status).toBe(200);
    expect(res.body.tempPassword).toMatch(/^Adm-/);
    expect(calls(/UPDATE admin_users SET password_hash=\$1, temp_password=TRUE/)).toHaveLength(1);
    expect(calls(/UPDATE refresh_tokens/)[0][1]).toEqual(['admin', TARGET]);
    expect(calls(/UPDATE merchant_users/)).toHaveLength(0);
    mockDbQuery.mockClear();
    const self = await request(app).post(`/admin/users/${ADMIN_SELF}/reset-password?type=admin`).set('Authorization', tok('super_admin'));
    expect(self.status).toBe(422); expect(self.body.code).toBe('SELF_RESET');
    expect(calls(/UPDATE/)).toHaveLength(0);
  });

  test('introuvable → 404 ; id non uuid → 404 ; type invalide → 422 ; sans jeton → 401', async () => {
    userDb('merchant_users', null);
    expect((await request(app).post(`/admin/users/${TARGET}/reset-password`).set('Authorization', tok('super_admin'))).status).toBe(404);
    expect((await request(app).post(`/admin/users/not-a-uuid/reset-password`).set('Authorization', tok('super_admin'))).status).toBe(404);
    expect((await request(app).post(`/admin/users/${TARGET}/reset-password?type=bank`).set('Authorization', tok('super_admin'))).status).toBe(422);
    expect((await request(app).post(`/admin/users/${TARGET}/reset-password`)).status).toBe(401);
    expect(calls(/UPDATE/)).toHaveLength(0);
  });

  test('POST /admin/reconcile transmet minAgeMinutes (borné) au service', async () => {
    const svc = require('../services/reconcile.service');
    const spy = jest.spyOn(svc, 'reconcilePending').mockResolvedValue({ summary: { scanned: 0 } });
    const res = await request(app).post('/admin/reconcile').set('Authorization', tok('ops_admin')).send({ maxAgeHours: 48, minAgeMinutes: 9999 });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith({ maxAgeHours: 48, limit: 100, minAgeMinutes: 5 });
    spy.mockRestore();
  });
});
