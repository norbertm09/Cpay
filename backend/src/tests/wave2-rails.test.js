/**
 * WAVE-2 — Visa Direct (rails.routes.js) : réservé super_admin/ops_admin, PAN brut refusé (422),
 * réponse provider filtrée (liste blanche).
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'wave2-test-secret-wave2-test-secret';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');

jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), withTransaction: jest.fn(), pool: {} }));
const mockVisa = {
  pushFunds: jest.fn(), pullFunds: jest.fn(), queryTransaction: jest.fn(), accountWalletPayout: jest.fn(),
  validateAccountWalletPayout: jest.fn(), queryPayout: jest.fn(), getAccountBalance: jest.fn(),
};
jest.mock('../services/rails/visa-direct.service', () => mockVisa);
const visa = mockVisa;
jest.mock('../services/rails/mastercard-developers.service', () => ({
  getServices: jest.fn(), getService: jest.fn(), getProjects: jest.fn(), createProject: jest.fn(), getProject: jest.fn(),
  addServiceToProject: jest.fn(), addCredential: jest.fn(),
}));

const { signToken } = require('../middleware/auth');
const railsRouter = require('../routes/rails.routes');

const app = express();
app.use(express.json());
app.use('/rails', railsRouter);
app.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message }));

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const merchantToken = () => signToken({ sub: 'u-1', merchantId: 'm-1', type: 'merchant', role: 'owner' });
const adminToken = (role) => signToken({ sub: 'a-1', type: 'admin', role });

const VISA_ROUTES = [
  ['post', '/rails/visa-direct/push-funds'],
  ['post', '/rails/visa-direct/pull-funds'],
  ['get',  '/rails/visa-direct/transaction-query'],
  ['post', '/rails/visa-payouts/v3/payouts'],
  ['post', '/rails/visa-payouts/v3/payouts/validate'],
  ['get',  '/rails/visa-payouts/v3/payouts'],
  ['get',  '/rails/visa-payouts/v3/account-balance'],
];

beforeEach(() => { jest.clearAllMocks(); for (const fn of Object.values(visa)) fn.mockResolvedValue({ transactionIdentifier: 1, actionCode: '00' }); });

describe('contrôle d’accès', () => {
  test.each(VISA_ROUTES)('%s %s : marchand → 403', async (method, path) => {
    const r = await request(app)[method](path).set(bearer(merchantToken())).send({ txnId: 'T1' });
    expect(r.status).toBe(403);
    for (const fn of Object.values(visa)) expect(fn).not.toHaveBeenCalled();
  });
  test.each(VISA_ROUTES)('%s %s : sans jeton → 401', async (method, path) => {
    expect((await request(app)[method](path).send({})).status).toBe(401);
  });
  test('admin support_agent → 403, ops_admin → 200, super_admin → 200', async () => {
    expect((await request(app).post('/rails/visa-direct/push-funds').set(bearer(adminToken('support_agent'))).send({ txnId: 'T1' })).status).toBe(403);
    expect((await request(app).post('/rails/visa-direct/push-funds').set(bearer(adminToken('ops_admin'))).send({ txnId: 'T1' })).status).toBe(200);
    expect((await request(app).post('/rails/visa-direct/push-funds').set(bearer(adminToken('super_admin'))).send({ txnId: 'T1' })).status).toBe(200);
  });
});

describe('PAN brut interdit', () => {
  const cases = [
    { recipientPrimaryAccountNumber: '4111111111111111' },
    { senderPrimaryAccountNumber: '4111111111111111', senderCardExpiryDate: '2027-12' },
    { cardNumber: '4111111111111111' },
    { pan: '4111111111111111' },
    { cvv: '123' },
    { expiry: '12/27' },
    { recipientDetail: { card: { primaryAccountNumber: '4111111111111111' } } },
  ];
  test.each(cases.map(c => [JSON.stringify(c), c]))('%s → 422 RAW_PAN_NOT_ALLOWED', async (_label, body) => {
    const r = await request(app).post('/rails/visa-direct/push-funds').set(bearer(adminToken('super_admin'))).send({ txnId: 'T1', ...body });
    expect(r.status).toBe(422); expect(r.body.code).toBe('RAW_PAN_NOT_ALLOWED'); expect(r.body.field).toBeTruthy();
    expect(visa.pushFunds).not.toHaveBeenCalled();
  });
  test('en query aussi (GET)', async () => {
    const r = await request(app).get('/rails/visa-direct/transaction-query?cardNumber=4111111111111111').set(bearer(adminToken('ops_admin')));
    expect(r.status).toBe(422);
  });
  test('token réseau accepté', async () => {
    const r = await request(app).post('/rails/visa-direct/push-funds').set(bearer(adminToken('ops_admin'))).send({ txnId: 'T1', amount: 10, recipientToken: 'tok_abc', recipient: { name: 'X' } });
    expect(r.status).toBe(200); expect(visa.pushFunds).toHaveBeenCalledWith(expect.objectContaining({ recipientToken: 'tok_abc' }));
  });
});

describe('réponse provider filtrée', () => {
  test('seuls les champs en liste blanche remontent, jamais de PAN', async () => {
    visa.pushFunds.mockResolvedValue({
      transactionIdentifier: 234, actionCode: '00', approvalCode: 'ABC123', transmissionDateTime: '2026-10-15T10:00:00',
      recipientPrimaryAccountNumber: '4111111111111111', rawRequest: { secret: 'x' }, debugInfo: 'internal',
      settlementFlags: { settlementService: '9', settlementResponsibilityFlag: 'N', cardNumber: '4111' },
    });
    const r = await request(app).post('/rails/visa-direct/push-funds').set(bearer(adminToken('super_admin'))).send({ txnId: 'T1' });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ transactionIdentifier: 234, actionCode: '00', approvalCode: 'ABC123', transmissionDateTime: '2026-10-15T10:00:00',
      settlementFlags: { settlementService: '9', settlementResponsibilityFlag: 'N' } });
    expect(JSON.stringify(r.body)).not.toMatch(/4111111111111111|rawRequest|debugInfo/);
  });
  test('payouts et balance : liste blanche dédiée', async () => {
    visa.accountWalletPayout.mockResolvedValue({ payoutId: 'P1', status: 'COMPLETED', recipientDetail: { pan: '4111' }, raw: {} });
    const p = await request(app).post('/rails/visa-payouts/v3/payouts').set(bearer(adminToken('ops_admin'))).send({ txnId: 'T1' });
    expect(p.body.data).toEqual({ payoutId: 'P1', status: 'COMPLETED' });
    visa.getAccountBalance.mockResolvedValue({ balance: 100, currencyCode: 'USD', internal: true });
    const b = await request(app).get('/rails/visa-payouts/v3/account-balance').set(bearer(adminToken('ops_admin')));
    expect(b.body.data).toEqual({ balance: 100, currencyCode: 'USD' });
  });
  test('réponse non-objet → data vide', async () => {
    visa.queryTransaction.mockResolvedValue(null);
    const r = await request(app).get('/rails/visa-direct/transaction-query?txnId=T1').set(bearer(adminToken('ops_admin')));
    expect(r.body.data).toEqual({});
  });
});
