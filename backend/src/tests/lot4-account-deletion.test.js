'use strict';
// Lot 4 (audit 2026-11-02 mobile P0-2) — suppression de compte marchand : routes marchand (handlers réels,
// auth simulée), service et routes admin (JWT réel) sur PostgreSQL (PGlite). E-mails et audit simulés.
const crypto = require('crypto');
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
const mockMail = jest.fn().mockResolvedValue({ success: true });
jest.mock('../services/notifications/email.service', () => ({ send: (...a) => mockMail(...a) }));
const mockRevoke = jest.fn().mockResolvedValue(undefined);
jest.mock('../middleware/auth', () => {
  const real = jest.requireActual('../middleware/auth');
  return { ...real, merchantAuth: (req, res, next) => next(), revokeAll: (...a) => mockRevoke(...a), verifyTotp: jest.fn() };
});
jest.mock('../services/mobilemoney/mobilemoney.router', () => ({ getProvider: () => null, getConfig: async () => null, sendPayout: jest.fn(), PROVIDERS: {} }));

const merchantRouter = require('../routes/merchant.routes');
const cash = require('../services/cash/cash.service');
const svc = require('../services/account/deletion.service');

const M = '11111111-1111-4111-8111-111111111111';
const U = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const first = async (...a) => (await sql(...a)).rows[0];
beforeAll(async () => {
  mockPg = new PGlite();
  await mockPg.exec(`
    CREATE TABLE merchants(merchant_id uuid PRIMARY KEY, country text, currency text DEFAULT 'XAF', business_name text, email text, merchant_status text DEFAULT 'active', kyb_level int DEFAULT 2, updated_at timestamptz);
    CREATE TABLE merchant_users(user_id uuid PRIMARY KEY, merchant_id uuid, email text, role text DEFAULT 'owner', is_active boolean DEFAULT true, updated_at timestamptz);
    CREATE TABLE transactions(transaction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid, type text, amount numeric, currency text DEFAULT 'XAF', status text, net_amount numeric, fee_amount numeric, settlement_batch_id uuid, settlement_status text);
    CREATE TABLE merchant_transfers(transfer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid, direction text, status text, amount numeric, currency text DEFAULT 'XAF');
    CREATE TABLE settlement_batches(merchant_id uuid, currency text, total_net numeric);
  `);
  await mockPg.exec(require('fs').readFileSync(require('path').join(__dirname, '../../database/014_account_deletion_requests.sql'), 'utf8'));
}, 60000);
afterAll(async () => { await mockPg.close(); });
beforeEach(async () => {
  jest.clearAllMocks();
  await mockPg.exec('TRUNCATE merchants, merchant_users, transactions, merchant_transfers, settlement_batches, account_deletion_requests');
  await sql(`INSERT INTO merchants(merchant_id,country,business_name,email) VALUES($1,'CG','Boutique Pilote','owner@example.test')`, [M]);
  await sql(`INSERT INTO merchant_users(user_id,merchant_id,email,role) VALUES($1,$2,'owner@example.test','owner')`, [U, M]);
  await sql(`INSERT INTO transactions(merchant_id,type,amount,status,net_amount,fee_amount) VALUES($1,'collect',10000,'authorized',9850,150)`, [M]);
  jest.spyOn(cash, 'verifyStepUp').mockResolvedValue({ ok: true });
});
const handler = (path, method) => { const l = merchantRouter.stack.find((x) => x.route && x.route.path === path && x.route.methods[method]); return l.route.stack[l.route.stack.length - 1].handle; };
const mkRes = () => { const res = { statusCode: 200, body: null }; res.status = (c) => { res.statusCode = c; return res; }; res.json = (b) => { res.body = b; return res; }; return res; };
const mkReq = (over = {}) => ({ body: {}, params: {}, query: {}, headers: { 'x-app-platform': 'android' }, ip: '127.0.0.1', user: { merchantId: M, sub: U, role: 'owner' }, ...over });

describe('marchand : POST / GET / DELETE /account/deletion-request', () => {
  test('propriétaire + step-up → 201, délai de rétractation 30 j, solde mémorisé, e-mails marchand et opérations', async () => {
    const res = mkRes();
    await handler('/account/deletion-request', 'post')(mkReq({ body: { reason: 'Fermeture de la boutique', confirm: { password: 'x' } } }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({ status: 'pending', canCancel: true, retractDays: 30, reason: 'Fermeture de la boutique', balanceAtRequest: 9850 });
    const row = await first('SELECT * FROM account_deletion_requests WHERE merchant_id=$1', [M]);
    expect(row.channel).toBe('app');
    const days = (new Date(row.retract_until) - new Date(row.requested_at)) / 86400000;
    expect(Math.round(days)).toBe(30);
    expect(mockMail).toHaveBeenCalledTimes(2);
    expect(mockMail.mock.calls.map((c) => c[0].to).sort()).toEqual(['owner@example.test', 'support@c-pay.global']);
    const g = mkRes(); await handler('/account/deletion-request', 'get')(mkReq(), g);
    expect(g.body.request).toMatchObject({ status: 'pending' });
    expect(g.body.deletionUrl).toBe('https://c-pay.global/legal/suppression-compte.html');
  });
  test('seconde demande → 200 « déjà en attente » (une seule demande pending par marchand)', async () => {
    await handler('/account/deletion-request', 'post')(mkReq({ body: { confirm: {} } }), mkRes());
    const res = mkRes(); await handler('/account/deletion-request', 'post')(mkReq({ body: { confirm: {} } }), res);
    expect(res.statusCode).toBe(200); expect(res.body.message).toMatch(/déjà en attente/);
    expect((await first('SELECT count(*)::int AS n FROM account_deletion_requests')).n).toBe(1);
  });
  test('rôle non propriétaire → 403 ; step-up refusé → 428 sans écriture', async () => {
    const r1 = mkRes(); await handler('/account/deletion-request', 'post')(mkReq({ user: { merchantId: M, sub: U, role: 'cashier' } }), r1);
    expect(r1.statusCode).toBe(403); expect(r1.body.code).toBe('INSUFFICIENT_ROLE');
    cash.verifyStepUp.mockResolvedValue({ ok: false, status: 428, body: { error: 'Confirmation requise', code: 'STEP_UP_REQUIRED', methods: ['password'] } });
    const r2 = mkRes(); await handler('/account/deletion-request', 'post')(mkReq({ body: {} }), r2);
    expect(r2.statusCode).toBe(428);
    expect((await first('SELECT count(*)::int AS n FROM account_deletion_requests')).n).toBe(0);
  });
  test('rétractation : DELETE → cancelled ; second DELETE → 404 ; une nouvelle demande redevient possible', async () => {
    await handler('/account/deletion-request', 'post')(mkReq({ body: { confirm: {} } }), mkRes());
    const d = mkRes(); await handler('/account/deletion-request', 'delete')(mkReq(), d);
    expect(d.statusCode).toBe(200); expect(d.body.status).toBe('cancelled');
    const d2 = mkRes(); await handler('/account/deletion-request', 'delete')(mkReq(), d2);
    expect(d2.statusCode).toBe(404);
    const g = mkRes(); await handler('/account/deletion-request', 'get')(mkReq(), g);
    expect(g.body.request).toBeNull();
    const again = mkRes(); await handler('/account/deletion-request', 'post')(mkReq({ body: { confirm: {} } }), again);
    expect(again.statusCode).toBe(201);
  });
});

describe('admin : liste et traitement des demandes', () => {
  const secret = process.env.JWT_SECRET || 'dev_secret_change_in_production';
  const token = (claims) => jwt.sign(claims, secret, { expiresIn: 600, issuer: process.env.JWT_ISSUER || 'api.c-pay.global', audience: process.env.JWT_AUDIENCE || 'c-pay' });
  const ops = token({ type: 'admin', sub: ADMIN, role: 'ops_admin' });
  let app;
  beforeAll(() => { app = express(); app.use(express.json()); app.use('/api/v1/admin', require('../routes/admin.routes')); });
  test('liste pending puis processed : utilisateurs désactivés, marchand suspendu, sessions révoquées, audit, e-mail', async () => {
    const { request: req } = await svc.requestDeletion({ merchantId: M, userId: U, email: 'owner@example.test', reason: 'test', channel: 'web' });
    const l = await request(app).get('/api/v1/admin/account-deletion-requests').set('Authorization', `Bearer ${ops}`);
    expect(l.status).toBe(200); expect(l.body.data).toHaveLength(1);
    expect(l.body.data[0]).toMatchObject({ requestId: req.request_id, status: 'pending', businessName: 'Boutique Pilote', channel: 'web' });
    mockMail.mockClear();
    const p = await request(app).patch(`/api/v1/admin/account-deletion-requests/${req.request_id}`).set('Authorization', `Bearer ${ops}`).send({ status: 'processed', note: 'solde reversé le 09/11' });
    expect(p.status).toBe(200); expect(p.body).toMatchObject({ success: true, status: 'processed', note: 'solde reversé le 09/11' });
    expect((await first('SELECT is_active FROM merchant_users WHERE user_id=$1', [U])).is_active).toBe(false);
    expect((await first('SELECT merchant_status FROM merchants WHERE merchant_id=$1', [M])).merchant_status).toBe('suspended');
    expect(mockRevoke).toHaveBeenCalledWith('merchant', U);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ACCOUNT_DELETION_PROCESSED' }));
    expect(mockMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'owner@example.test', subject: expect.stringMatching(/compte supprimé/) }));
    // rejeu → 409
    const again = await request(app).patch(`/api/v1/admin/account-deletion-requests/${req.request_id}`).set('Authorization', `Bearer ${ops}`).send({ status: 'processed' });
    expect(again.status).toBe(409);
  });
  test('refus : note obligatoire, compte conservé ; support_agent → 403 ; statut inconnu → 422', async () => {
    const { request: req } = await svc.requestDeletion({ merchantId: M, userId: U, email: 'owner@example.test' });
    expect((await request(app).patch(`/api/v1/admin/account-deletion-requests/${req.request_id}`).set('Authorization', `Bearer ${ops}`).send({ status: 'rejected' })).status).toBe(422);
    expect((await request(app).patch(`/api/v1/admin/account-deletion-requests/${req.request_id}`).set('Authorization', `Bearer ${ops}`).send({ status: 'deleted' })).status).toBe(422);
    const r = await request(app).patch(`/api/v1/admin/account-deletion-requests/${req.request_id}`).set('Authorization', `Bearer ${ops}`).send({ status: 'rejected', note: 'Solde non nul' });
    expect(r.status).toBe(200); expect(r.body.status).toBe('rejected');
    expect((await first('SELECT is_active FROM merchant_users WHERE user_id=$1', [U])).is_active).toBe(true);
    expect((await first('SELECT merchant_status FROM merchants WHERE merchant_id=$1', [M])).merchant_status).toBe('active');
    const sa = token({ type: 'admin', sub: ADMIN, role: 'support_agent' });
    expect((await request(app).get('/api/v1/admin/account-deletion-requests').set('Authorization', `Bearer ${sa}`)).status).toBe(403);
  });
  test('la migration 014 est rejouable et impose une seule demande pending par marchand', async () => {
    await mockPg.exec(require('fs').readFileSync(require('path').join(__dirname, '../../database/014_account_deletion_requests.sql'), 'utf8'));
    await svc.requestDeletion({ merchantId: M, userId: U });
    await expect(sql(`INSERT INTO account_deletion_requests(merchant_id, retract_until) VALUES($1, NOW())`, [M])).rejects.toThrow(/idx_adr_one_pending|duplicate/);
  });
});
