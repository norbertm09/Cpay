'use strict';
/**
 * WAVE-6 lot 2 — gardes de capacités (middleware/capability.js), endpoint public /public/capabilities,
 * matrice admin, montage dans server.js. supertest + base mockée (aucune connexion réseau).
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wave6-test-secret-at-least-32-chars-long';
delete process.env.INTERNAL_TOKEN; delete process.env.METRICS_TOKEN;
// Cameroun : MTN configuré (code + clé) → active ; CF / GA / GQ / TD : planned ; CG : rien configuré
process.env.MTN_CM_API_KEY = 'test-key';
delete process.env.CAPABILITY_PILOT_CM; delete process.env.CAPABILITY_LEGACY_ALLOW; delete process.env.CAPABILITY_REGISTRATION_GUARD;

jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn(), http: jest.fn() }));
const mockQuery = jest.fn();
jest.mock('../config/database', () => ({
  query: (...a) => mockQuery(...a),
  pool: { query: jest.fn().mockResolvedValue({}), end: jest.fn() },
  withTransaction: jest.fn(),
}));
jest.mock('../services/orchestration/orchestrator', () => ({ processTransaction: jest.fn(), generateQRPayload: jest.fn(), generatePayLink: jest.fn() }));
jest.mock('../services/reconcile.service', () => ({ reconcilePending: jest.fn(), reconcileOne: jest.fn() }));

const express = require('express');
const request = require('supertest');
const { signToken } = require('../middleware/auth');
const registry = require('../services/capabilities/registry');
const capability = require('../middleware/capability');

const MERCHANT_ID = '11111111-1111-4111-8111-111111111111';
const rows = (r) => ({ rows: r, rowCount: r.length });
const merchantToken = () => signToken({ sub: 'user-1', merchantId: MERCHANT_ID, type: 'merchant', email: 'm@test.io' });
const adminToken = () => signToken({ sub: 'admin-1', type: 'admin', role: 'super_admin', email: 'a@test.io' });
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

// Base mockée : SELECT merchants → pays demandé ; SELECT pay_links → pays du marchand du lien ; faits → vides
let merchantCountry = 'CM';
let linkCountry = 'CM';
beforeEach(() => {
  merchantCountry = 'CM'; linkCountry = 'CM';
  registry.invalidateFacts();
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql) => {
    if (/FROM merchants WHERE merchant_id/.test(sql)) return merchantCountry ? rows([{ merchant_id: MERCHANT_ID, country: merchantCountry, currency: 'XAF' }]) : rows([]);
    if (/FROM pay_links pl JOIN merchants m/.test(sql) && /pl\.short_id=\$1$/.test(sql.trim())) return linkCountry ? rows([{ country: linkCountry }]) : rows([]);
    return rows([]);
  });
});

// ─── Application minimale : gardes + routes factices ───────────────
const mini = express();
mini.use(express.json());
const stub = (req, res) => res.json({ reached: true, path: req.originalUrl });
const { merchantAuth } = require('../middleware/auth');
mini.use('/merchant/cash', merchantAuth, capability.capabilityGuard);
mini.post('/merchant/cash/collect', stub); mini.post('/merchant/cash/withdraw', stub); mini.post('/merchant/cash/transfers', stub);
mini.get('/merchant/cash/summary', stub); mini.post('/merchant/cash/transfers/x/cancel', stub); mini.put('/merchant/cash/wallet', stub);
mini.post(['/merchant/collect', '/merchant/disburse', '/collect', '/payout'], merchantAuth, capability.legacyCapabilityGuard, stub);
mini.post('/merchant/auth/register', capability.registerCapabilityGuard, stub);
mini.post('/pay/:shortId/card', capability.payCardCapabilityGuard, stub);
mini.use((err, _req, res, _next) => res.status(err.statusCode || 500).json({ error: err.message, code: err.code }));

describe('capabilityGuard — caisse', () => {
  test('Cameroun, MTN configuré : encaissement Mobile Money passe', async () => {
    const r = await request(mini).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ method: 'mobile_money', amount: 1000, customerPhone: '+237670000001' });
    expect(r.status).toBe(200); expect(r.body.reached).toBe(true);
    expect(mockQuery.mock.calls.filter(([s]) => /FROM merchants WHERE merchant_id/.test(s))).toHaveLength(1);
  });
  test('Cameroun : opérateur forcé non configuré (Orange) → 403', async () => {
    const r = await request(mini).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ method: 'mobile_money', operator: 'orange_money', amount: 1000 });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'CAPABILITY_NOT_ACTIVE', country: 'CM', operation: 'collect', method: 'mobile_money', status: 'unavailable', operator: 'ORANGE_MONEY' });
  });
  test('Cameroun : carte sans passerelle → 403 unavailable', async () => {
    const r = await request(mini).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ method: 'card', amount: 1000 });
    expect(r.status).toBe(403); expect(r.body).toMatchObject({ code: 'CAPABILITY_NOT_ACTIVE', method: 'card', status: 'unavailable' });
  });
  test('Tchad (planned) : encaissement, retrait refusés avec message clair ; transfert wallet→banque passe', async () => {
    merchantCountry = 'TD';
    const c = await request(mini).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ method: 'mobile_money', amount: 1000 });
    expect(c.status).toBe(403);
    expect(c.body).toMatchObject({ code: 'CAPABILITY_NOT_ACTIVE', country: 'TD', operation: 'collect', method: 'mobile_money', status: 'planned' });
    expect(c.body.message).toMatch(/Tchad/); expect(c.body.message).toMatch(/intégration en cours/); expect(c.body.error).toBe(c.body.message);
    const w = await request(mini).post('/merchant/cash/withdraw').set(bearer(merchantToken())).send({ amount: 5000 });
    expect(w.status).toBe(403); expect(w.body).toMatchObject({ operation: 'withdraw', method: 'mobile_money', status: 'planned' });
    const t = await request(mini).post('/merchant/cash/transfers').set(bearer(merchantToken())).send({ direction: 'wallet_to_bank', amount: 5000 });
    expect(t.status).toBe(200);
    const f = await request(mini).post('/merchant/cash/transfers').set(bearer(merchantToken())).send({ direction: 'bank_to_wallet', amount: 5000 });
    expect(f.status).toBe(403); expect(f.body).toMatchObject({ operation: 'transfer', method: 'bank_to_wallet', status: 'unavailable' });
    merchantCountry = 'CM';
  });
  test('GET, corps invalide, autres POST et marchand introuvable passent à la route', async () => {
    expect((await request(mini).get('/merchant/cash/summary').set(bearer(merchantToken()))).status).toBe(200);
    expect((await request(mini).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ method: 'cash' })).status).toBe(200);
    expect((await request(mini).post('/merchant/cash/transfers').set(bearer(merchantToken())).send({ direction: 'nope' })).status).toBe(200);
    expect((await request(mini).post('/merchant/cash/transfers/x/cancel').set(bearer(merchantToken())).send({})).status).toBe(200);
    expect((await request(mini).put('/merchant/cash/wallet').set(bearer(merchantToken())).send({})).status).toBe(200);
    merchantCountry = null;
    expect((await request(mini).post('/merchant/cash/withdraw').set(bearer(merchantToken())).send({ amount: 1 })).status).toBe(200);
    merchantCountry = 'CM';
  });
  test('sans jeton → 401 (merchantAuth du montage)', async () => {
    expect((await request(mini).post('/merchant/cash/collect').send({ method: 'mobile_money' })).status).toBe(401);
  });
  test('pilote : CAPABILITY_PILOT_CM=true laisse passer ; CAPABILITY_LEGACY_ALLOW=false bloque SN', async () => {
    process.env.CAPABILITY_PILOT_CM = 'true';
    expect((await request(mini).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ method: 'mobile_money' })).status).toBe(200);
    delete process.env.CAPABILITY_PILOT_CM;
    merchantCountry = 'SN'; process.env.ORANGE_SN_API_KEY = 'k';
    expect((await request(mini).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ method: 'mobile_money' })).status).toBe(200);
    process.env.CAPABILITY_LEGACY_ALLOW = 'false';
    const r = await request(mini).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ method: 'mobile_money' });
    expect(r.status).toBe(403); expect(r.body.message).toMatch(/hors périmètre/);
    delete process.env.CAPABILITY_LEGACY_ALLOW; delete process.env.ORANGE_SN_API_KEY; merchantCountry = 'CM';
  });
  test('erreur base → next(err) (500), jamais de passage silencieux', async () => {
    mockQuery.mockImplementationOnce(async () => { throw new Error('db down'); });
    expect((await request(mini).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ method: 'mobile_money' })).status).toBe(500);
  });
});

describe('legacyCapabilityGuard — routes historiques', () => {
  test('/merchant/collect mtn_momo CM passe ; airtel_money CM → 403 (non configuré) ; GA → 403 planned', async () => {
    expect((await request(mini).post('/merchant/collect').set(bearer(merchantToken())).send({ method: 'mtn_momo', amount: 100, customerPhone: '+237670000001' })).status).toBe(200);
    const a = await request(mini).post('/merchant/collect').set(bearer(merchantToken())).send({ method: 'airtel_money', amount: 100 });
    expect(a.status).toBe(403); expect(a.body).toMatchObject({ operation: 'collect', operator: 'AIRTEL_MONEY' });
    merchantCountry = 'GA';
    const g = await request(mini).post('/merchant/disburse').set(bearer(merchantToken())).send({ method: 'airtel_money', amount: 100, recipientPhone: '+24107123456' });
    expect(g.status).toBe(403); expect(g.body).toMatchObject({ operation: 'withdraw', status: 'planned', country: 'GA', operator: 'AIRTEL_MONEY' });
    // opérateur inexistant dans le pays (MTN au Gabon) → unavailable
    const u = await request(mini).post('/merchant/disburse').set(bearer(merchantToken())).send({ method: 'mtn_momo', amount: 100 });
    expect(u.status).toBe(403); expect(u.body).toMatchObject({ status: 'unavailable', operator: 'MTN_MOMO' });
    merchantCountry = 'CM';
  });
  test('/collect avec emvPayload → carte ; /payout → retrait', async () => {
    const c = await request(mini).post('/collect').set(bearer(merchantToken())).send({ amount: 100, emvPayload: 'xx' });
    expect(c.status).toBe(403); expect(c.body).toMatchObject({ operation: 'collect', method: 'card' });
    expect((await request(mini).post('/payout').set(bearer(merchantToken())).send({ amount: 100, customerPhone: '+237670000001' })).status).toBe(200);
  });
});

describe('registerCapabilityGuard — inscription', () => {
  test('Cameroun (MTN actif) → passe ; Tchad (planned) → 422 COUNTRY_NOT_OPEN', async () => {
    expect((await request(mini).post('/merchant/auth/register').send({ phone: '+237670000001' })).status).toBe(200);
    const r = await request(mini).post('/merchant/auth/register').send({ phone: '+23566123456' });
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ code: 'COUNTRY_NOT_OPEN', country: 'TD', status: 'planned', launchCountries: ['CM', 'CF', 'CG', 'GA', 'GQ', 'TD', 'CD'] });
    expect(r.body.error).toMatch(/Tchad/);
  });
  test('Sénégal (historique) → 422 ; téléphone absent / invalide → la route décide ; garde désactivable', async () => {
    const sn = await request(mini).post('/merchant/auth/register').send({ phone: '+221771234567' });
    expect(sn.status).toBe(422); expect(sn.body.error).toMatch(/hors du périmètre/);
    expect((await request(mini).post('/merchant/auth/register').send({})).status).toBe(200);
    expect((await request(mini).post('/merchant/auth/register').send({ phone: 'abc' })).status).toBe(200);
    expect((await request(mini).post('/merchant/auth/register').send({ phone: '+447911123456' })).status).toBe(200);
    process.env.CAPABILITY_REGISTRATION_GUARD = 'off';
    expect((await request(mini).post('/merchant/auth/register').send({ phone: '+23566123456' })).status).toBe(200);
    delete process.env.CAPABILITY_REGISTRATION_GUARD;
  });
});

describe('payCardCapabilityGuard — page publique', () => {
  test('refus structurels seulement : pays hors registre ou historique bloqué → 403 ; sinon la route tranche (410 / 404 / 409)', async () => {
    // CM sans passerelle configurée : la route répond 410 CARD_PAYMENT_DISABLED (pas la garde)
    expect((await request(mini).post('/pay/ABC123/card').send({})).status).toBe(200);
    Object.assign(process.env, { MIGS_MERCHANT_ID: 'm', MIGS_ACCESS_CODE: 'a', MIGS_SECURE_HASH: 'h', CARD_GATEWAY_CM: 'migs' });
    expect((await request(mini).post('/pay/ABC123/card').send({})).status).toBe(200);
    for (const k of ['MIGS_MERCHANT_ID', 'MIGS_ACCESS_CODE', 'MIGS_SECURE_HASH', 'CARD_GATEWAY_CM']) delete process.env[k];
    linkCountry = 'CF'; // carte : code présent, non configuré → la route répond 410
    expect((await request(mini).post('/pay/ABC123/card').send({})).status).toBe(200);
    linkCountry = 'GH';
    const r = await request(mini).post('/pay/ABC123/card').send({});
    expect(r.status).toBe(403); expect(r.body).toMatchObject({ code: 'CAPABILITY_NOT_ACTIVE', operation: 'collect', method: 'card', country: 'GH', status: 'unavailable' });
    linkCountry = 'SN'; process.env.CAPABILITY_LEGACY_ALLOW = 'false';
    expect((await request(mini).post('/pay/ABC123/card').send({})).status).toBe(403);
    delete process.env.CAPABILITY_LEGACY_ALLOW;
    linkCountry = null;
    expect((await request(mini).post('/pay/ABC123/card').send({})).status).toBe(200);
  });
});

// ─── CAPABILITY_ENFORCE : enforce (défaut) | report | off ──────────
describe('CAPABILITY_ENFORCE — interrupteur global de déploiement', () => {
  const logger = require('../config/logger');
  afterEach(() => { delete process.env.CAPABILITY_ENFORCE; capability.resetReportOnly(); });

  test('enforce (défaut, valeur inconnue → enforce) : refus 403 / 422', async () => {
    expect(capability.enforcementMode()).toBe('enforce');
    process.env.CAPABILITY_ENFORCE = 'bogus';
    expect(capability.enforcementMode()).toBe('enforce');
    merchantCountry = 'TD';
    expect((await request(mini).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ method: 'mobile_money' })).status).toBe(403);
    expect((await request(mini).post('/merchant/auth/register').send({ phone: '+23566123456' })).status).toBe(422);
    expect(capability.getReportOnlyState()).toEqual({ since: null, count: 0, refusals: [] });
  });

  test('report : tout passe, journal « would refuse » structuré, compteur et 50 derniers refus', async () => {
    process.env.CAPABILITY_ENFORCE = 'report';
    logger.warn.mockClear();
    merchantCountry = 'TD';
    const c = await request(mini).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ method: 'mobile_money', operator: 'airtel' });
    expect(c.status).toBe(200); expect(c.body.reached).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith('capability: would refuse', expect.objectContaining({ guard: 'cash', country: 'TD', operation: 'collect', method: 'mobile_money', operator: 'AIRTEL_MONEY', status: 'planned', merchantId: MERCHANT_ID, path: '/merchant/cash/collect' }));
    expect((await request(mini).post('/merchant/disburse').set(bearer(merchantToken())).send({ method: 'airtel_money', amount: 1 })).status).toBe(200);
    expect((await request(mini).post('/merchant/auth/register').send({ phone: '+23566123456' })).status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith('capability: would refuse', expect.objectContaining({ guard: 'register', country: 'TD', operation: 'register', status: 'planned', merchantId: null }));
    linkCountry = 'GH';
    expect((await request(mini).post('/pay/ABC123/card').send({})).status).toBe(200);
    expect(logger.warn).toHaveBeenCalledWith('capability: would refuse', expect.objectContaining({ guard: 'pay_card', country: 'GH', method: 'card', shortId: 'ABC123' }));
    // les requêtes autorisées ne sont pas comptées
    merchantCountry = 'CM'; linkCountry = 'CM';
    expect((await request(mini).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ method: 'mobile_money' })).status).toBe(200);
    const st = capability.getReportOnlyState();
    expect(st.count).toBe(4); expect(st.since).toEqual(expect.any(String)); expect(st.refusals).toHaveLength(4);
    expect(st.refusals[0]).toMatchObject({ at: expect.any(String), guard: 'cash', country: 'TD' });
    expect(st.refusals.map((r) => r.guard)).toEqual(['cash', 'cash', 'register', 'pay_card']);
    // plafond : 50 derniers refus conservés, compteur total exact
    merchantCountry = 'TD';
    for (let i = 0; i < 55; i++) await request(mini).post('/merchant/cash/withdraw').set(bearer(merchantToken())).send({ amount: 1 });
    const after = capability.getReportOnlyState();
    expect(after.count).toBe(59); expect(after.refusals).toHaveLength(50); expect(after.refusals[0].guard).toBe('cash'); expect(after.refusals[0].operation).toBe('withdraw');
    expect(logger.warn).not.toHaveBeenCalledWith('capability: refused', expect.anything());
  });

  test('off : gardes désactivées (aucune lecture base, aucun journal), avertissement au démarrage', async () => {
    process.env.CAPABILITY_ENFORCE = 'off';
    logger.warn.mockClear(); mockQuery.mockClear();
    merchantCountry = 'TD';
    expect((await request(mini).post('/merchant/cash/collect').set(bearer(merchantToken())).send({ method: 'mobile_money' })).status).toBe(200);
    expect((await request(mini).post('/merchant/auth/register').send({ phone: '+23566123456' })).status).toBe(200);
    linkCountry = 'GH';
    expect((await request(mini).post('/pay/ABC123/card').send({})).status).toBe(200);
    expect(mockQuery.mock.calls.filter(([q]) => /FROM merchants WHERE merchant_id|FROM pay_links pl JOIN/.test(q))).toHaveLength(0);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(capability.getReportOnlyState().count).toBe(0);
    // avertissement de démarrage (une seule fois par processus)
    jest.isolateModules(() => {
      const fresh = require('../middleware/capability');
      fresh.logStartupMode(); fresh.logStartupMode();
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/CAPABILITY_ENFORCE=off/));
  });

  test('admin : enforcement et reportOnly exposés par GET /api/v1/admin/capabilities', async () => {
    const app = require('../server');
    process.env.CAPABILITY_ENFORCE = 'report';
    merchantCountry = 'CF';
    expect((await request(app).post('/api/v1/merchant/cash/withdraw').set(bearer(merchantToken())).send({ amount: 5000 })).status).not.toBe(403);
    const r = await request(app).get('/api/v1/admin/capabilities').set(bearer(adminToken()));
    expect(r.status).toBe(200);
    expect(r.body.enforcement).toBe('report'); expect(r.body.env.enforce).toBe('report');
    expect(r.body.reportOnly).toMatchObject({ since: expect.any(String), count: 1, refusals: [expect.objectContaining({ guard: 'cash', country: 'CF', operation: 'withdraw', status: 'planned', path: '/api/v1/merchant/cash/withdraw' })] });
    process.env.CAPABILITY_ENFORCE = 'enforce';
    expect((await request(app).get('/api/v1/admin/capabilities').set(bearer(adminToken()))).body.enforcement).toBe('enforce');
  });
});

// ─── Montage réel dans server.js ───────────────────────────────────
describe('server.js — montage', () => {
  let app;
  beforeAll(() => { app = require('../server'); });

  test('GET /api/v1/public/capabilities : public, cache 60 s, forme attendue', async () => {
    const r = await request(app).get('/api/v1/public/capabilities');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toMatch(/max-age=60/);
    expect(r.body.generatedAt).toEqual(expect.any(String));
    expect(r.body.countries.map((c) => c.code)).toEqual(['CM', 'CF', 'CG', 'GA', 'GQ', 'TD', 'CD']);
    const cm = r.body.countries[0];
    expect(cm).toMatchObject({ name: 'Cameroun', currency: 'XAF', region: 'CEMAC' });
    expect(cm.operations.collect.mobile_money.status).toBe('active');
    expect(cm.operations.collect.mobile_money.operators.find((o) => o.operator === 'MTN_MOMO').status).toBe('active');
    expect(cm.operations.collect.card).toEqual({ status: 'unavailable' });
    expect(cm.operations.withdraw.mobile_money.status).toBe('active');
    expect(cm.operations.transfer).toMatchObject({ wallet_to_bank: { status: 'active' }, bank_to_wallet: { status: expect.any(String) } });
    expect(r.body.countries.find((c) => c.code === 'GQ').operations.collect.mobile_money.status).toBe('planned');
    expect(r.body.countries.find((c) => c.code === 'CD').operations.collect.gimac.status).toBe('unavailable');
    expect(r.body.countries.find((c) => c.code === 'GA').operations.collect.gimac.status).toBe('planned');
    expect(JSON.stringify(r.body)).not.toMatch(/API_KEY|requires/);
    // cache : second appel sans nouvelle lecture des faits
    const before = mockQuery.mock.calls.length;
    expect((await request(app).get('/api/v1/public/capabilities')).status).toBe(200);
    expect(mockQuery.mock.calls.length).toBe(before);
  });
  test('GET /api/v1/admin/capabilities : adminAuth, matrice complète avec requires et pilotes', async () => {
    expect((await request(app).get('/api/v1/admin/capabilities')).status).toBe(401);
    expect((await request(app).get('/api/v1/admin/capabilities').set(bearer(merchantToken()))).status).toBe(403);
    const r = await request(app).get('/api/v1/admin/capabilities').set(bearer(adminToken()));
    expect(r.status).toBe(200);
    expect(r.body.pilots).toEqual({ CM: false, CF: false, CG: false, GA: false, GQ: false, TD: false, CD: false });
    expect(r.body.countries.CM.operations.collect.mobile_money.operators[0].requires).toContain('MTN_CM_API_KEY');
    expect(r.body.countries.CM.operations.collect.gimac.requires).toEqual(expect.arrayContaining(['GIMAC_MERCHANT_ID']));
    expect(r.body.countries.SN.legacy).toBe(true);
    expect(r.body.env).toMatchObject({ legacyAllowed: true, registrationGuard: true, pilotFlags: [], enforce: 'enforce' });
    expect(r.body.enforcement).toBe('enforce'); expect(r.body.reportOnly).toEqual({ since: null, count: 0, refusals: [] });
  });
  test('POST /api/v1/merchant/cash/collect pour un marchand CF → 403 avant la route caisse', async () => {
    merchantCountry = 'CF';
    const r = await request(app).post('/api/v1/merchant/cash/collect').set(bearer(merchantToken())).send({ method: 'mobile_money', amount: 1000, customerPhone: '+23672123456' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ code: 'CAPABILITY_NOT_ACTIVE', country: 'CF', operation: 'collect', method: 'mobile_money', status: 'planned' });
    expect(mockQuery.mock.calls.some(([s]) => /INSERT INTO transactions/.test(s))).toBe(false);
    merchantCountry = 'CM';
  });
  test('POST /api/v1/merchant/auth/register avec un numéro gabonais → 422 COUNTRY_NOT_OPEN', async () => {
    const r = await request(app).post('/api/v1/merchant/auth/register').send({ businessName: 'X', phone: '+24107123456', email: 'x@y.z', password: 'longpassword1', walletMtn: '1' });
    expect(r.status).toBe(422); expect(r.body).toMatchObject({ code: 'COUNTRY_NOT_OPEN', country: 'GA', status: 'planned' });
  });
  test('POST /api/v1/pay/:shortId/card : pays hors registre → 403 ; CM → la route répond (410 PAN envoyé / 404)', async () => {
    linkCountry = 'GH';
    const r = await request(app).post('/api/v1/pay/ABC123/card').send({});
    expect(r.status).toBe(403); expect(r.body).toMatchObject({ code: 'CAPABILITY_NOT_ACTIVE', country: 'GH', method: 'card' });
    linkCountry = 'CM';
    expect((await request(app).post('/api/v1/pay/ABC123/card').send({ pan: '4111' })).status).toBe(410);
    linkCountry = null;
    expect((await request(app).post('/api/v1/pay/ABC123/card').send({})).status).toBe(404);
  });
  test('POST /api/v1/merchant/disburse (historique) pour un marchand TD → 403', async () => {
    merchantCountry = 'TD';
    const r = await request(app).post('/api/v1/merchant/disburse').set(bearer(merchantToken())).send({ amount: 100, recipientPhone: '+23566123456', method: 'airtel_money' });
    expect(r.status).toBe(403); expect(r.body).toMatchObject({ operation: 'withdraw', country: 'TD', status: 'planned' });
    merchantCountry = 'CM';
  });
});
