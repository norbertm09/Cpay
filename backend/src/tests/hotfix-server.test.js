'use strict';
/** Hotfix v1 — server.js : ordre des routes, échappement, fail-closed, consentements, paymenthub */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-0000';
delete process.env.INTERNAL_TOKEN; delete process.env.METRICS_TOKEN; delete process.env.PAYMENTHUB_WEBHOOK_TOKEN;

jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn(), http: jest.fn() }));
const mockQuery = jest.fn();
jest.mock('../config/database', () => ({ query: (...a) => mockQuery(...a), pool: { query: jest.fn().mockResolvedValue({}), end: jest.fn() }, withTransaction: jest.fn() }));
jest.mock('../services/orchestration/orchestrator', () => ({ processTransaction: jest.fn(), generateQRPayload: jest.fn(), generatePayLink: jest.fn() }));
jest.mock('../services/reconcile.service', () => ({ reconcilePending: jest.fn() }));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../server');
const orchestrator = require('../services/orchestration/orchestrator');

const LINK = { pay_link_id: '33333333-3333-4333-8333-333333333333', short_id: 'ABC123', merchant_id: 'm', amount: '2500', currency: 'XAF',
  business_name: '<img src=x onerror=alert(1)>Boutique', description: '"><script>alert(2)</script>', status: 'pending', expires_at: new Date(Date.now() + 3600e3), psp: 'mtn' };

beforeEach(() => { mockQuery.mockReset(); mockQuery.mockResolvedValue({ rows: [], rowCount: 0 }); });

describe('ordre des routes', () => {
  test('/live, /ready, /metrics ne sont plus masqués par /:shortId', async () => {
    expect((await request(app).get('/live')).body.status).toBe('alive');
    expect((await request(app).get('/ready')).status).toBe(200);
    expect((await request(app).get('/metrics')).status).toBe(404); // METRICS_TOKEN absent → fail-closed, pas une page HTML
    expect((await request(app).get('/metrics')).headers['content-type']).toMatch(/json/);
  });
  test('/metrics avec jeton : Bearer uniquement, jamais en query', async () => {
    process.env.METRICS_TOKEN = 'mtok';
    expect((await request(app).get('/metrics?token=mtok')).status).toBe(403);
    expect((await request(app).get('/metrics').set('Authorization', 'Bearer mtok')).status).toBe(200);
    delete process.env.METRICS_TOKEN;
  });
  test('page pay-link toujours servie', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [LINK] });
    const r = await request(app).get('/ABC123');
    expect(r.status).toBe(200); expect(r.text).toContain('Boutique');
  });
});

describe('échappement HTML des pages publiques', () => {
  test('nom marchand et description injectés échappés', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [LINK] });
    const r = await request(app).get('/ABC123');
    expect(r.text).not.toContain('<img src=x');
    expect(r.text).not.toContain('<script>alert(2)');
    expect(r.text).toContain('&lt;img src=x');
  });
});

describe('POST /api/v1/pay/:shortId', () => {
  test('carte refusée (410), jamais de PAN côté serveur', async () => {
    const r = await request(app).post('/api/v1/pay/ABC123').send({ method: 'card', cardNum: '4111111111111111', cvv: '123' });
    expect(r.status).toBe(410); expect(orchestrator.processTransaction).not.toHaveBeenCalled();
  });
  test('téléphone invalide → 422', async () => {
    expect((await request(app).post('/api/v1/pay/ABC123').send({ phone: 'abc' })).status).toBe(422);
  });
  test('pending → 200 pending, lien non marqué payé', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [LINK] });
    orchestrator.processTransaction.mockResolvedValue({ success: false, pending: true, txnId: 'T1', message: 'En attente' });
    const r = await request(app).post('/api/v1/pay/ABC123').send({ phone: '+242061234567' });
    expect(r.status).toBe(200); expect(r.body.pending).toBe(true);
    expect(mockQuery.mock.calls.some(c => c[0].includes("status='paid'"))).toBe(false);
  });
});

describe('Audit: public pay-link confirmation', () => {
  test('inconsistent legacy success=true with pending is never treated as paid', async () => {
    mockQuery.mockResolvedValueOnce({rows:[LINK]});
    orchestrator.processTransaction.mockResolvedValue({success:true,pending:true,status:'pending',txnId:'T1'});
    const r=await request(app).post('/api/v1/pay/ABC123').send({phone:'+242061234567'});
    expect(r.status).toBe(200);expect(r.body.pending).toBe(true);
    expect(mockQuery.mock.calls.some(([s])=>s.includes("status='paid'"))).toBe(false);
  });
  test('authorized payment consumes the link', async () => {
    mockQuery.mockResolvedValueOnce({rows:[LINK]});
    orchestrator.processTransaction.mockResolvedValue({success:true,pending:false,status:'authorized',txnId:'T1'});
    const r=await request(app).post('/api/v1/pay/ABC123').send({phone:'+242061234567'});
    expect(r.status).toBe(200);
    expect(mockQuery.mock.calls.some(([s])=>s.includes("status='paid'"))).toBe(true);
  });
});

describe('fail-closed', () => {
  test('/internal/settlement/run sans INTERNAL_TOKEN configuré → 503 (plus jamais 200)', async () => {
    expect((await request(app).post('/internal/settlement/run')).status).toBe(503);
  });
  test('/internal/settlement/run mauvais jeton → 403', async () => {
    process.env.INTERNAL_TOKEN = 'itok';
    expect((await request(app).post('/internal/settlement/run').set('x-internal-token', 'nope')).status).toBe(403);
    delete process.env.INTERNAL_TOKEN;
  });
  test('webhook paymenthub sans jeton configuré → 401', async () => {
    expect((await request(app).post('/api/v1/webhooks/paymenthub').send({ reference: 'x', status: 'completed' })).status).toBe(401);
  });
  test('webhook paymenthub : montant différent → 409, authorized non régressé', async () => {
    process.env.PAYMENTHUB_WEBHOOK_TOKEN = 'ph';
    mockQuery.mockResolvedValueOnce({ rows: [{ amount: '1000', currency: 'CDF', status: 'pending' }] });
    const r = await request(app).post('/api/v1/webhooks/paymenthub').set('x-paymenthub-token', 'ph')
      .send({ reference: '22222222-2222-4222-8222-222222222222', status: 'completed', amount: 999 });
    expect(r.status).toBe(409);
    const upd = mockQuery.mock.calls.find(c => c[0].includes('UPDATE transactions SET'));
    expect(upd).toBeUndefined();
    delete process.env.PAYMENTHUB_WEBHOOK_TOKEN;
  });
});

describe('consentements', () => {
  test('sans JWT → 401 ; avec JWT, identité prise dans le jeton', async () => {
    expect((await request(app).get('/api/v1/consent/check?portal=merchant')).status).toBe(401);
    // WAVE-2 : les access tokens portent iss/aud — signes via le module commun
    const tok = require('../middleware/auth').signToken({ sub: 'u-1', type: 'merchant' });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const r = await request(app).get('/api/v1/consent/check?portal=merchant&userId=victim').set('Authorization', `Bearer ${tok}`);
    expect(r.status).toBe(200);
    expect(mockQuery.mock.calls[0][1]).toEqual(['u-1', 'merchant', 'merchant']);
  });
});
