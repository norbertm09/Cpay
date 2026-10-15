'use strict';
/**
 * WAVE-4 — paiement par carte sur la page hébergée (checkout redirigé MIGS / MPGS, jamais de PAN).
 * server.js + services/cash/card-link.service.js, base de données mockée.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wave4-card-test-secret-at-least-32-chars';
process.env.NODE_ENV = 'test';
process.env.PAY_LINK_BASE_URL = 'https://pay.c-pay.global';

jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn(), http: jest.fn() }));
const mockQuery = jest.fn();
jest.mock('../config/database', () => ({ query: (...a) => mockQuery(...a), pool: { query: jest.fn().mockResolvedValue({}), end: jest.fn() }, withTransaction: jest.fn() }));
const mockCreateTxn = jest.fn(async () => undefined);
const mockAddEvent = jest.fn(async () => undefined);
jest.mock('../services/orchestration/orchestrator', () => ({
  processTransaction: jest.fn(), generateQRPayload: jest.fn(), generatePayLink: jest.fn(),
  createTransactionRecord: (...a) => mockCreateTxn(...a), addTransactionEvent: (...a) => mockAddEvent(...a),
}));
jest.mock('../services/reconcile.service', () => ({ reconcilePending: jest.fn(), reconcileOne: jest.fn() }));
const mockMpgsCheckout = jest.fn();
const mockMpgsOrder = jest.fn();
let mockMpgsConfigured = false;
jest.mock('../services/gateways/mpgs.gateway', () => ({
  hostedConfigured: () => mockMpgsConfigured,
  createHostedCheckout: (...a) => mockMpgsCheckout(...a),
  getOrder: (...a) => mockMpgsOrder(...a),
  processPayment: jest.fn(), ping: jest.fn(),
}));

const request = require('supertest');
const app = require('../server');
const migs = require('../services/gateways/migs.gateway');
const cash = require('../services/cash/cash.service');

const MIGS_SECRET = 'a'.repeat(64);
const PL_ID = '33333333-3333-4333-8333-333333333333';
const TXN_ID = '44444444-4444-4444-8444-444444444444';
const rows = (r, rc) => ({ rows: r, rowCount: rc === undefined ? r.length : rc });
const calls = (re) => mockQuery.mock.calls.filter(([s]) => re.test(s));
const link = (over = {}) => ({
  pay_link_id: PL_ID, short_id: 'ABC123', merchant_id: 'm-1', amount: '2500', currency: 'XAF', description: 'Café',
  status: 'pending', expires_at: new Date(Date.now() + 3600 * 1000), payment_method: 'card', psp: 'migs',
  business_name: 'Boutique', country: 'CM', merchant_currency: 'XAF', ...over,
});
const dbRouter = (handlers) => async (sql, params) => {
  for (const [re, h] of handlers) if (re.test(sql)) return typeof h === 'function' ? h(sql, params) : rows(h);
  return rows([]);
};
const migsEnv = (on) => {
  if (on) { process.env.MIGS_MERCHANT_ID = 'MER1'; process.env.MIGS_ACCESS_CODE = 'ACC1'; process.env.MIGS_SECURE_HASH = MIGS_SECRET; process.env.MIGS_HASH_TYPE = 'SHA256'; }
  else { delete process.env.MIGS_MERCHANT_ID; delete process.env.MIGS_ACCESS_CODE; delete process.env.MIGS_SECURE_HASH; delete process.env.MIGS_HASH_TYPE; }
};
const defaults = (gw) => [/FROM country_payment_defaults/, gw ? [{ country: 'CM', currency: 'XAF', default_card_gateway: gw }] : []];

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockReset(); mockQuery.mockImplementation(async () => rows([]));
  migsEnv(false); mockMpgsConfigured = false;
});
afterAll(() => migsEnv(false));

describe('cardGatewayFor / hostedCardGatewayFor', () => {
  test('null sans configuration env, même si la passerelle est "active" en base ; migs avec env', async () => {
    mockQuery.mockImplementation(dbRouter([defaults('migs'), [/FROM api_configurations/, [{ status: 'active' }]]]));
    expect(await cash.cardGatewayFor('CM')).toBeNull();
    migsEnv(true);
    expect(await cash.cardGatewayFor('CM')).toBe('migs');
    expect(await cash.cardGatewayFor(null)).toBeNull();
    mockQuery.mockImplementation(dbRouter([defaults('cybersource')]));
    process.env.CS_MERCHANT_ID = 'x'; process.env.CS_API_KEY_ID = 'y';
    expect(await cash.cardGatewayFor('CM')).toBeNull(); // pas de checkout hébergé CyberSource
    delete process.env.CS_MERCHANT_ID; delete process.env.CS_API_KEY_ID;
    mockQuery.mockImplementation(dbRouter([defaults('mpgs')]));
    expect(await cash.cardGatewayFor('CM')).toBeNull();
    mockMpgsConfigured = true;
    expect(await cash.cardGatewayFor('CM')).toBe('mpgs');
  });
});

describe('POST /api/v1/pay/:shortId/card', () => {
  test('404 lien inconnu, 409 lien payé/expiré, 410 sans passerelle hébergée, 410 si PAN envoyé', async () => {
    expect((await request(app).post('/api/v1/pay/ZZZ999/card').send({})).status).toBe(404);
    mockQuery.mockImplementation(dbRouter([[/FROM pay_links pl JOIN merchants m/, [link({ status: 'paid' })]]]));
    let r = await request(app).post('/api/v1/pay/ABC123/card').send({});
    expect(r.status).toBe(409); expect(r.body.code).toBe('LINK_NOT_PAYABLE');
    mockQuery.mockImplementation(dbRouter([[/FROM pay_links pl JOIN merchants m/, [link()]], defaults('migs')]));
    r = await request(app).post('/api/v1/pay/ABC123/card').send({});
    expect(r.status).toBe(410); expect(r.body.code).toBe('CARD_PAYMENT_DISABLED');
    expect(mockCreateTxn).not.toHaveBeenCalled();
    migsEnv(true);
    r = await request(app).post('/api/v1/pay/ABC123/card').send({ cardNum: '4111111111111111', cvv: '123' });
    expect(r.status).toBe(410); expect(mockCreateTxn).not.toHaveBeenCalled();
  });

  test('MIGS : transaction pending (collect, pay_link, pay_link_id) + redirection VPC signée', async () => {
    migsEnv(true);
    mockQuery.mockImplementation(dbRouter([[/FROM pay_links pl JOIN merchants m/, [link()]], defaults('migs')]));
    const r = await request(app).post('/api/v1/pay/ABC123/card').send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, gateway: 'migs' });
    expect(mockCreateTxn).toHaveBeenCalledWith(expect.objectContaining({ txnId: r.body.txnId, merchantId: 'm-1', type: 'collect', amount: 2500, currency: 'XAF', paymentMethod: 'pay_link', payLinkId: PL_ID, status: 'pending' }));
    const u = new URL(r.body.redirectUrl);
    expect(u.origin + u.pathname).toBe('https://migs.mastercard.com.au/vpcpay');
    const q = Object.fromEntries(u.searchParams.entries());
    expect(q).toMatchObject({ vpc_Version: '1', vpc_Command: 'pay', vpc_Merchant: 'MER1', vpc_AccessCode: 'ACC1', vpc_Amount: '2500', vpc_Currency: 'XAF', vpc_SecureHashType: 'SHA256',
      vpc_ReturnURL: 'https://pay.c-pay.global/pay/ABC123/return' });
    expect(q.vpc_MerchTxnRef).toMatch(/^ABC123-[A-Z0-9]+$/);
    expect(q).not.toHaveProperty('vpc_CardNum');
    const { vpc_SecureHash, vpc_SecureHashType, ...signed } = q;
    expect(migs.computeSecureHash(signed, MIGS_SECRET)).toBe(vpc_SecureHash);
    const [sql, params] = calls(/UPDATE transactions SET gateway_name=\$2/)[0];
    expect(params).toEqual([r.body.txnId, 'migs', q.vpc_MerchTxnRef, null, expect.stringMatching(/migs/)]);
    expect(mockAddEvent).toHaveBeenCalledWith(expect.objectContaining({ txnId: r.body.txnId, eventType: 'CARD_CHECKOUT_CREATED' }));
  });

  test('MPGS : session INITIATE_CHECKOUT, successIndicator journalisé ; échec passerelle → 502 et transaction failed', async () => {
    mockMpgsConfigured = true;
    mockQuery.mockImplementation(dbRouter([[/FROM pay_links pl JOIN merchants m/, [link({ psp: 'mpgs' })]], defaults('mpgs')]));
    mockMpgsCheckout.mockResolvedValue({ ok: true, sessionId: 'SESS1', successIndicator: 'IND-OK', redirectUrl: 'https://mtf.gateway.mastercard.com/checkout/pay/SESS1?checkoutVersion=1.0.0' });
    let r = await request(app).post('/api/v1/pay/ABC123/card').send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, gateway: 'mpgs', redirectUrl: expect.stringContaining('/checkout/pay/SESS1') });
    expect(mockMpgsCheckout).toHaveBeenCalledWith(expect.objectContaining({ amount: 2500, currency: 'XAF', returnUrl: 'https://pay.c-pay.global/pay/ABC123/return', merchantName: 'Boutique' }));
    expect(calls(/UPDATE transactions SET gateway_name=\$2/)[0][1][3]).toBe('SESS1');
    expect(mockAddEvent.mock.calls[0][0].payload).toMatchObject({ gateway: 'mpgs', sessionId: 'SESS1', successIndicator: 'IND-OK' });

    mockQuery.mockClear();
    mockMpgsCheckout.mockResolvedValue({ ok: false, reason: 'HTTP 500' });
    r = await request(app).post('/api/v1/pay/ABC123/card').send({});
    expect(r.status).toBe(502); expect(r.body.code).toBe('GATEWAY_ERROR');
    const [sql, params] = calls(/UPDATE transactions SET status='failed'/)[0];
    expect(params[1]).toMatch(/HTTP 500/); expect(params[2]).toBe('mpgs');
  });

  test('POST /api/v1/pay/:shortId historique : la carte reste refusée (410) — jamais de PAN', async () => {
    const r = await request(app).post('/api/v1/pay/ABC123').send({ method: 'card', cardNum: '4111111111111111', cvv: '123' });
    expect(r.status).toBe(410); expect(r.body.code).toBe('CARD_PAYMENT_DISABLED');
  });
});

describe('Retour du checkout et statut', () => {
  const txn = (over = {}) => ({ transaction_id: TXN_ID, merchant_id: 'm-1', amount: '2500', currency: 'XAF', status: 'pending', gateway_name: 'migs',
    gateway_order_id: 'ABC123-X1', gateway_payment_id: null, pay_link_id: PL_ID, ...over });
  const signedReturn = (over = {}) => {
    const p = { vpc_Version: '1', vpc_Command: 'pay', vpc_Merchant: 'MER1', vpc_MerchTxnRef: 'ABC123-X1', vpc_TxnResponseCode: '0', vpc_Amount: '2500', vpc_Currency: 'XAF',
      vpc_AuthorizeId: 'AUTH77', vpc_TransactionNo: 'TN-1', ...over };
    return { ...p, vpc_SecureHash: migs.computeSecureHash(p, MIGS_SECRET), vpc_SecureHashType: 'SHA256' };
  };
  const stateful = (t) => {
    const state = { txn: t, linkStatus: 'pending' };
    mockQuery.mockImplementation(dbRouter([
      [/FROM pay_links pl JOIN merchants m/, () => rows([link({ status: state.linkStatus })])],
      [/FROM transactions WHERE pay_link_id=\$1 AND type='collect'/, () => rows([state.txn])],
      [/WHERE gateway_payment_id=\$1 OR gateway_order_id=\$1/, (sql, p) => rows(p[0] === state.txn.gateway_order_id ? [state.txn] : [])],
      [/UPDATE transactions SET\s+status=\$1, auth_code=COALESCE/, (sql, p) => { state.txn = { ...state.txn, status: p[0], auth_code: p[1] }; return rows([{ transaction_id: TXN_ID, merchant_id: 'm-1' }], 1); }],
      [/UPDATE pay_links SET status='paid'/, () => { state.linkStatus = 'paid'; return rows([], 1); }],
      [/SELECT payload FROM transaction_events/, [{ payload: { successIndicator: 'IND-OK' } }]],
    ]));
    return state;
  };

  test('MIGS : retour signé approuvé → transaction authorized, lien payé, page « Paiement accepté »', async () => {
    migsEnv(true);
    const state = stateful(txn());
    const r = await request(app).get('/pay/ABC123/return').query(signedReturn());
    expect(r.status).toBe(200);
    expect(r.text).toContain('Paiement accepté');
    expect(state.txn.status).toBe('authorized'); expect(state.txn.auth_code).toBe('AUTH77');
    expect(calls(/UPDATE pay_links SET status='paid'/)[0][1]).toEqual([2500, 'ABC123-X1', PL_ID]);
    expect(r.text).not.toContain('<script>'); // page finale sans polling
    expect(r.headers['cache-control']).toMatch(/no-store/);
  });

  test('MIGS : refus signé → failed ; hash invalide → reste pending (polling), aucune mise à jour', async () => {
    migsEnv(true);
    let state = stateful(txn());
    let r = await request(app).get('/ABC123/return').query(signedReturn({ vpc_TxnResponseCode: '5' }));
    expect(r.text).toContain('Paiement refusé'); expect(state.txn.status).toBe('failed');

    mockQuery.mockClear();
    state = stateful(txn());
    r = await request(app).get('/pay/ABC123/return').query({ ...signedReturn(), vpc_SecureHash: 'F'.repeat(64) });
    expect(r.status).toBe(200);
    expect(r.text).toContain('Confirmation en cours'); expect(r.text).toContain("/api/v1/pay/ABC123/status");
    expect(state.txn.status).toBe('pending');
    expect(calls(/UPDATE transactions SET\s+status=\$1/)).toHaveLength(0);

    // référence de commande différente de la transaction courante → ignoré
    state = stateful(txn({ gateway_order_id: 'ABC123-OTHER' }));
    r = await request(app).get('/pay/ABC123/return').query(signedReturn());
    expect(state.txn.status).toBe('pending');
  });

  test('MPGS : resultIndicator + getOrder SUCCESS → authorized ; indicateur faux → failed ; getOrder indisponible → pending', async () => {
    mockMpgsConfigured = true;
    let state = stateful(txn({ gateway_name: 'mpgs', gateway_payment_id: 'SESS1' }));
    mockMpgsOrder.mockResolvedValue({ found: true, result: 'SUCCESS', status: 'CAPTURED', amount: 2500, currency: 'XAF' });
    let r = await request(app).get('/pay/ABC123/return').query({ resultIndicator: 'IND-OK' });
    expect(r.text).toContain('Paiement accepté'); expect(state.txn.status).toBe('authorized');
    expect(mockMpgsOrder).toHaveBeenCalledWith('ABC123-X1');

    state = stateful(txn({ gateway_name: 'mpgs' }));
    r = await request(app).get('/pay/ABC123/return').query({ resultIndicator: 'WRONG' });
    expect(state.txn.status).toBe('failed'); expect(r.text).toContain('Paiement refusé');

    state = stateful(txn({ gateway_name: 'mpgs' }));
    mockMpgsOrder.mockResolvedValue({ found: false });
    r = await request(app).get('/pay/ABC123/return').query({ resultIndicator: 'IND-OK' });
    expect(state.txn.status).toBe('pending'); expect(r.text).toContain('Confirmation en cours');
  });

  test('GET /api/v1/pay/:shortId/status : pending → paid ; lien expiré ; 404', async () => {
    const state = stateful(txn());
    let r = await request(app).get('/api/v1/pay/ABC123/status');
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ shortId: 'ABC123', status: 'pending', txnId: TXN_ID, gateway: 'migs', amount: 2500 });
    state.txn = txn({ status: 'authorized' });
    r = await request(app).get('/api/v1/pay/ABC123/status');
    expect(r.body.status).toBe('paid');
    mockQuery.mockImplementation(dbRouter([[/FROM pay_links pl JOIN merchants m/, [link({ expires_at: new Date(Date.now() - 1000) })]]]));
    expect((await request(app).get('/api/v1/pay/ABC123/status')).body.status).toBe('expired');
    mockQuery.mockImplementation(async () => rows([]));
    expect((await request(app).get('/api/v1/pay/ABC123/status')).status).toBe(404);
  });

  test('page de paiement : bouton carte hébergé, aucun champ de saisie de carte', async () => {
    mockQuery.mockResolvedValueOnce(rows([link()]));
    const r = await request(app).get('/ABC123');
    expect(r.status).toBe(200);
    expect(r.text).toContain('/api/v1/pay/ABC123/card');
    expect(r.text).toContain('Payer par carte');
    expect(r.text).not.toContain('id="cardNum"'); expect(r.text).not.toContain('id="cvv"');
  });
});
