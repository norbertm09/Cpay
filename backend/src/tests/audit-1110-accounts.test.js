'use strict';
/**
 * Audit du 10 novembre 2026, § 3 « comptes et parcours » — tests de régression (supertest + base simulée).
 *   1. changement de mot de passe obligatoire : plus de contournement par la query string (?next=/auth/me) ;
 *   2. remplacement du second facteur protégé (code courant exigé, secret actif conservé jusqu'à /verify) ;
 *   3. création de banques / comptes bank_admin réservée au super_admin ;
 *   4. clés API : propriétaire du compte + confirmation forte.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'audit-1110-accounts-secret-at-least-32-chars';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');

const mockDbQuery = jest.fn();
jest.mock('../config/database', () => ({
  query: (...a) => mockDbQuery(...a),
  withTransaction: async (fn) => fn({ query: (...a) => mockDbQuery(...a) }),
  pool: {},
}));
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notifications/email.service', () => ({ send: jest.fn(async () => true) }));
jest.mock('../services/notifications/smpp.service', () => ({ sendSmsSmpp: jest.fn(async () => true), notifyMultiChannel: jest.fn(async () => true) }));
jest.mock('../services/notifications/whatsapp.service', () => ({ sendWhatsAppText: jest.fn(async () => true) }));
jest.mock('../services/reconcile.service', () => ({ reconcilePending: jest.fn(async () => ({ summary: {} })), reconcileOne: jest.fn() }));
jest.mock('../services/rails/gtp.client', () => ({ isConfigured: () => true, callSoap: jest.fn(), tagAll: () => [], parseFlat: () => ({}) }));
jest.mock('../services/transfer/transfer.service', () => ({ initiate: jest.fn(), getStatus: jest.fn() }));
jest.mock('../config/secrets', () => ({ encryptConfigPatch: jest.fn(async (p) => p) }));
jest.mock('../services/orchestration/orchestrator', () => ({ processTransaction: jest.fn(), generateQRPayload: jest.fn(), generatePayLink: jest.fn() }));

const auth = require('../middleware/auth');
const merchantRouter = require('../routes/merchant.routes');
const { adminRouter: distributionAdminRouter } = require('../routes/distribution.routes');

const M = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const rows = (r) => ({ rows: r, rowCount: r.length });
const bearer = (claims) => ({ Authorization: `Bearer ${auth.signToken(claims)}` });
const calls = (re) => mockDbQuery.mock.calls.filter(([sql]) => re.test(sql));

const app = express();
app.use(express.json());
app.use('/api/v1/merchant', merchantRouter);
app.use('/api/v1/admin/distribution', auth.adminAuth, distributionAdminRouter);
app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message, code: err.code }));

beforeEach(() => { mockDbQuery.mockReset(); mockDbQuery.mockResolvedValue(rows([])); });

// ───────────── 1. mot de passe obligatoire ─────────────
describe('1. changement de mot de passe obligatoire : liste blanche sur le chemin canonique', () => {
  const guard = express();
  guard.use(express.json());
  const ok = (req, res) => res.json({ ok: true });
  guard.all('/api/v1/merchant/cash/withdraw', auth.merchantAuth, ok);
  guard.all('/api/v1/merchant/auth/me', auth.merchantAuth, ok);
  const temp = bearer({ type: 'merchant', sub: U, merchantId: M, role: 'owner', pwdTemp: true });
  test('?next=/auth/me ou #/auth/me ne contournent plus le blocage', async () => {
    for (const url of ['/api/v1/merchant/cash/withdraw?next=/auth/me', '/api/v1/merchant/cash/withdraw?redirect=%2Fauth%2Fme', '/api/v1/merchant/cash/withdraw?/auth/me']) {
      const r = await request(guard).post(url).set(temp).send({});
      expect([url, r.status, r.body.code]).toEqual([url, 403, 'PASSWORD_CHANGE_REQUIRED']);
    }
  });
  test('les routes autorisées le restent, quelle que soit la casse ou le slash final', async () => {
    for (const url of ['/api/v1/merchant/auth/me', '/api/v1/merchant/auth/me?x=1', '/api/v1/merchant/Auth/Me/']) {
      expect((await request(guard).get(url).set(temp)).status).toBe(200);
    }
  });
});

// ───────────── 2. remplacement du second facteur ─────────────
describe('2. /auth/2fa/setup : la 2FA active ne peut être remplacée qu’avec un code courant', () => {
  const owner = bearer({ type: 'merchant', sub: U, merchantId: M, role: 'owner', email: 'o@example.test' });
  const SECRET = speakeasy.generateSecret({ length: 20 }).base32;
  const code = (s) => speakeasy.totp({ secret: s, encoding: 'base32' });
  const db = (user) => mockDbQuery.mockImplementation(async (sql) => {
    if (/SELECT email FROM merchant_users/.test(sql)) return rows([{ email: 'o@example.test' }]);
    if (/SELECT mfa_secret, mfa_enabled AS enabled FROM merchant_users/.test(sql)) return rows([{ mfa_secret: user.secret, enabled: user.enabled }]);
    if (/SELECT mfa_secret, mfa_pending_secret FROM merchant_users/.test(sql)) return rows([{ mfa_secret: user.secret, mfa_pending_secret: user.pending || null }]);
    return rows([]);
  });
  test('2FA active, pas de code → 428, aucune écriture ; code faux → 401', async () => {
    db({ secret: SECRET, enabled: true });
    const r = await request(app).post('/api/v1/merchant/auth/2fa/setup').set(owner).send({});
    expect(r.status).toBe(428); expect(r.body.code).toBe('MFA_CONFIRMATION_REQUIRED');
    expect((await request(app).post('/api/v1/merchant/auth/2fa/setup').set(owner).send({ token: '000000' })).status).toBe(401);
    expect(calls(/UPDATE merchant_users/)).toHaveLength(0);
  });
  test('2FA active + code valide → nouveau secret en attente, secret actif conservé ; /verify promeut le secret en attente', async () => {
    db({ secret: SECRET, enabled: true });
    const r = await request(app).post('/api/v1/merchant/auth/2fa/setup').set(owner).send({ token: code(SECRET) });
    expect(r.status).toBe(200); expect(r.body.replacing).toBe(true); expect(r.body.secret).toBeTruthy();
    const upd = calls(/UPDATE merchant_users/);
    expect(upd).toHaveLength(1);
    expect(upd[0][0]).toMatch(/SET mfa_pending_secret=\$1/); expect(upd[0][0]).not.toMatch(/mfa_enabled=FALSE/);
    const pending = r.body.secret;
    mockDbQuery.mockClear(); db({ secret: SECRET, enabled: true, pending });
    expect((await request(app).post('/api/v1/merchant/auth/2fa/verify').set(owner).send({ token: code(SECRET) })).status).toBe(400); // l'ancien code ne valide pas le nouveau secret
    const v = await request(app).post('/api/v1/merchant/auth/2fa/verify').set(owner).send({ token: code(pending) });
    expect(v.status).toBe(200); expect(v.body.replaced).toBe(true);
    expect(calls(/SET mfa_secret=mfa_pending_secret, mfa_pending_secret=NULL, mfa_enabled=TRUE/)).toHaveLength(1);
  });
  test('2FA inactive : premier enrôlement inchangé (secret posé, activation à /verify)', async () => {
    db({ secret: null, enabled: false });
    const r = await request(app).post('/api/v1/merchant/auth/2fa/setup').set(owner).send({});
    expect(r.status).toBe(200); expect(r.body.replacing).toBeUndefined();
    expect(calls(/SET mfa_secret=\$1, mfa_enabled=FALSE, mfa_pending_secret=NULL/)).toHaveLength(1);
  });
});

// ───────────── 3. bank_admin ─────────────
describe('3. création de banques / bank_admin (distribution) : super_admin seulement', () => {
  const body = { firstName: 'Ana', lastName: 'B', email: 'ana@bank.test', password: 'Temp-Password-123' };
  test('ops_admin → 403, aucune insertion', async () => {
    const r = await request(app).post(`/api/v1/admin/distribution/banks/${M}/users`).set(bearer({ type: 'admin', sub: U, role: 'ops_admin' })).send(body);
    expect(r.status).toBe(403);
    expect((await request(app).post('/api/v1/admin/distribution/banks').set(bearer({ type: 'admin', sub: U, role: 'finance_admin' })).send({ bankName: 'B', bankCode: 'BB' })).status).toBe(403);
    expect(calls(/INSERT INTO distribution_users|INSERT INTO distribution_banks/)).toHaveLength(0);
  });
  test('super_admin → 201', async () => {
    mockDbQuery.mockImplementation(async (sql) => /INSERT INTO distribution_users/.test(sql) ? rows([{ user_id: 'du-1', email: body.email, role: 'bank_admin' }]) : rows([]));
    const r = await request(app).post(`/api/v1/admin/distribution/banks/${M}/users`).set(bearer({ type: 'admin', sub: U, role: 'super_admin' })).send(body);
    expect(r.status).toBe(201); expect(r.body.role).toBe('bank_admin');
  });
});

// ───────────── 4. clés API ─────────────
describe('4. POST /api-keys : propriétaire + confirmation forte', () => {
  let hash;
  beforeAll(async () => { hash = await bcrypt.hash('owner-password', 4); });
  const db = () => mockDbQuery.mockImplementation(async (sql) => {
    if (/SELECT user_id, password_hash, mfa_enabled, mfa_secret FROM merchant_users/.test(sql)) return rows([{ user_id: U, password_hash: hash, mfa_enabled: false, mfa_secret: null }]);
    if (/INSERT INTO merchant_api_keys/.test(sql)) return rows([{ key_id: 'k1', key_name: 'Site', key_prefix: 'sk_live_abcd', permissions: ['collect'], is_active: true }]);
    return rows([]);
  });
  test('un employé (cashier) ne peut pas créer de clé', async () => {
    db();
    const r = await request(app).post('/api/v1/merchant/api-keys').set(bearer({ type: 'merchant', sub: U, merchantId: M, role: 'cashier' })).send({ keyName: 'Site', confirm: { password: 'owner-password' } });
    expect(r.status).toBe(403); expect(calls(/INSERT INTO merchant_api_keys/)).toHaveLength(0);
  });
  test('propriétaire sans confirmation → 428 STEP_UP_REQUIRED ; avec mot de passe → 201 (clé renvoyée une fois)', async () => {
    db();
    const owner = bearer({ type: 'merchant', sub: U, merchantId: M, role: 'owner' });
    const r1 = await request(app).post('/api/v1/merchant/api-keys').set(owner).send({ keyName: 'Site' });
    expect(r1.status).toBe(428); expect(r1.body.code).toBe('STEP_UP_REQUIRED'); expect(calls(/INSERT INTO merchant_api_keys/)).toHaveLength(0);
    const r2 = await request(app).post('/api/v1/merchant/api-keys').set(owner).send({ keyName: 'Site', confirm: { password: 'owner-password' } });
    expect(r2.status).toBe(201); expect(r2.body.key.api_key).toMatch(/^sk_live_/); expect(r2.body.key.api_secret).toMatch(/^sk_secret_/);
    expect(calls(/INSERT INTO merchant_api_keys/)).toHaveLength(1);
  });
  test('révocation réservée au propriétaire', async () => {
    db();
    expect((await request(app).delete('/api/v1/merchant/api-keys/k1').set(bearer({ type: 'merchant', sub: U, merchantId: M, role: 'cashier' }))).status).toBe(403);
  });
});
