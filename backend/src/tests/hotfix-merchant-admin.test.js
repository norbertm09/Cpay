'use strict';
/**
 * HOTFIX WAVE-1 (audit prod 2.6.0) — routes marchand / admin
 * supertest + base de donnees mockee (aucune connexion reseau).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'hotfix-test-secret';
process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

// ─── Mocks ────────────────────────────────────────────────────────
const mockDbQuery = jest.fn();
const mockTxQuery = jest.fn();
jest.mock('../config/database', () => ({
  query: (...args) => mockDbQuery(...args),
  withTransaction: async (fn) => fn({ query: (...args) => mockTxQuery(...args) }),
  pool: {},
}));
jest.mock('../services/notifications/email.service', () => ({ send: jest.fn(async () => true) }));
jest.mock('../services/notifications/smpp.service', () => ({
  sendSmsSmpp: jest.fn(async () => true),
  notifyMultiChannel: jest.fn(async () => true),
}));
jest.mock('../services/notifications/whatsapp.service', () => ({ sendWhatsAppText: jest.fn(async () => true) }));
jest.mock('../services/reconcile.service', () => ({
  reconcilePending: jest.fn(async () => ({ summary: { checked: 0, updated: 0 } })),
}));

const { signToken } = require('../middleware/auth');
const merchantRouter = require('../routes/merchant.routes');
const adminRouter = require('../routes/admin.routes');
const integrations = require('../services/integrations/integration.service');
const smpp = require('../services/notifications/smpp.service');
// Mot de passe de fixture généré à l'exécution (rien de codé en dur)
const TEST_PASSWORD = 'Aa1!' + require('crypto').randomBytes(8).toString('hex');

const app = express();
app.use(express.json());
app.use('/merchant', merchantRouter);
app.use('/admin', adminRouter);

const MERCHANT_ID = '11111111-1111-4111-8111-111111111111';
const merchantToken = () => signToken({ sub: 'user-1', merchantId: MERCHANT_ID, type: 'merchant', email: 'm@test.io' });
const adminToken = (role) => signToken({ sub: 'admin-1', type: 'admin', role, email: 'admin@test.io' });
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rows = (r) => ({ rows: r, rowCount: r.length });

beforeEach(() => {
  mockDbQuery.mockReset();
  mockTxQuery.mockReset();
  mockDbQuery.mockImplementation(async () => rows([]));
  mockTxQuery.mockImplementation(async () => rows([]));
});

// ═══════════════════════════════════════════════════════════════════
describe('1. Endpoints desactives (410 / 501) — aucune ecriture', () => {
  test('POST /merchant/withdraw → 410 FEATURE_DISABLED, aucune requete SQL', async () => {
    const res = await request(app).post('/merchant/withdraw').set(bearer(merchantToken()))
      .send({ amount: 5000, phone: '+242061234567', operator: 'mtn' });
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  test('POST /merchant/collect/contactless → 410', async () => {
    const res = await request(app).post('/merchant/collect/contactless').set(bearer(merchantToken()))
      .send({ amount: 5000, cardData: { cryptogram: 'x' } });
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  test('POST /merchant/withdraw sans JWT → 401 (auth conservee)', async () => {
    const res = await request(app).post('/merchant/withdraw').send({ amount: 5000 });
    expect(res.status).toBe(401);
  });

  test('POST /admin/transactions/:id/refund → 501 REFUND_NOT_IMPLEMENTED, aucune ecriture', async () => {
    const res = await request(app).post('/admin/transactions/abc/refund').set(bearer(adminToken('super_admin')));
    expect(res.status).toBe(501);
    expect(res.body.code).toBe('REFUND_NOT_IMPLEMENTED');
    expect(mockDbQuery).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('2. Privileges admin (requireRole)', () => {
  test('support_agent PATCH /admin/admin-users/:id → 403', async () => {
    const res = await request(app).patch('/admin/admin-users/x').set(bearer(adminToken('support_agent')))
      .send({ role: 'super_admin' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  test('ops_admin POST /admin/admin-users → 403 ; super_admin → 201 (bcryptjs)', async () => {
    let res = await request(app).post('/admin/admin-users').set(bearer(adminToken('ops_admin')))
      .send({ email: 'x@y.z', password: TEST_PASSWORD, role: 'support_agent' });
    expect(res.status).toBe(403);

    mockDbQuery.mockImplementation(async (sql) => sql.includes('INSERT INTO admin_users')
      ? rows([{ admin_id: 'new', email: 'x@y.z', role: 'support_agent' }]) : rows([]));
    res = await request(app).post('/admin/admin-users').set(bearer(adminToken('super_admin')))
      .send({ email: 'x@y.z', password: TEST_PASSWORD, role: 'support_agent' });
    expect(res.status).toBe(201);
    const insert = mockDbQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO admin_users'));
    expect(insert[1][1]).toMatch(/^\$2[aby]\$12\$/); // hash bcryptjs cout 12
  });

  test.each([
    ['patch', '/admin/finance/settlements/1/validate', 'ops_admin'],
    ['get', '/admin/finance/settlements/export', 'support_agent'],
    ['post', '/admin/settlements/1/complete', 'ops_admin'],
    ['put', '/admin/merchants/m/fees', 'finance_admin'],
    ['put', '/admin/merchants/m/velocity', 'support_agent'],
    ['post', '/admin/partners/banks', 'ops_admin'],
    ['post', '/admin/tenants', 'ops_admin'],
    ['patch', '/admin/tenants/1', 'finance_admin'],
    ['delete', '/admin/admin-users/1', 'ops_admin'],
    ['post', '/admin/reconcile', 'support_agent'],
  ])('%s %s avec role %s → 403', async (method, url, role) => {
    const res = await request(app)[method](url).set(bearer(adminToken(role))).send({});
    expect(res.status).toBe(403);
  });

  test('finance_admin PATCH /admin/finance/settlements/:id/validate → 200', async () => {
    mockTxQuery.mockImplementation(async sql => sql.startsWith('SELECT status') ? rows([{status:'pending'}]) : rows([]));
    const res = await request(app).patch('/admin/finance/settlements/1/validate')
      .set(bearer(adminToken('finance_admin'))).send({ reference: 'R1' });
    expect(res.status).toBe(200);
  });

  test('/reconcile retire du routeur marchand (404), present cote admin (ops_admin → 200)', async () => {
    let res = await request(app).post('/merchant/reconcile').set(bearer(merchantToken())).send({});
    expect(res.status).toBe(404);
    res = await request(app).post('/admin/reconcile').set(bearer(adminToken('ops_admin'))).send({ maxAgeHours: 12 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ checked: 0, updated: 0 });
  });

  test('GET /admin/users ne selectionne jamais password_hash / mfa_secret', async () => {
    mockDbQuery.mockImplementation(async (sql) => sql.startsWith('SELECT COUNT') ? rows([{ count: '0' }]) : rows([]));
    const res = await request(app).get('/admin/users').set(bearer(adminToken('support_agent')));
    expect(res.status).toBe(200);
    const sql = mockDbQuery.mock.calls[0][0];
    expect(sql).not.toMatch(/u\.\*/);
    expect(sql).not.toMatch(/password_hash|mfa_secret/);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('3. Cles API hachees (apiKeyAuth)', () => {
  const RAW = 'sk_live_' + 'ab'.repeat(24);
  const HASH = sha256(RAW);
  const keyRow = (extra = {}) => ({
    key_id: 'k1', merchant_id: MERCHANT_ID, business_name: 'Shop', merchant_status: 'active',
    api_key: null, api_key_hash: HASH, api_secret: null, api_secret_hash: null,
    permissions: ['transactions'], is_active: true, expires_at: null, ...extra,
  });
  const mockKeyLookup = (row) => mockDbQuery.mockImplementation(async (sql, params) => {
    if (sql.includes('FROM merchant_api_keys k')) {
      if (!row) return rows([]);
      const hashMatch = row.api_key_hash && params[0] === row.api_key_hash;
      const legacyMatch = !row.api_key_hash && row.api_key && params[1] === row.api_key;
      return rows(hashMatch || legacyMatch ? [row] : []);
    }
    if (sql.startsWith('SELECT COUNT')) return rows([{ count: '0' }]);
    return rows([]);
  });

  test('cle hachee valide → 200 ; recherche par hash (jamais par cle brute seule)', async () => {
    mockKeyLookup(keyRow());
    const res = await request(app).get('/merchant/public/transactions').set('X-API-Key', RAW);
    expect(res.status).toBe(200);
    const [sql, params] = mockDbQuery.mock.calls[0];
    expect(sql).toMatch(/api_key_hash=\$1/);
    expect(params[0]).toBe(HASH);
  });

  test('cle inconnue → 401 INVALID_API_KEY', async () => {
    mockKeyLookup(keyRow());
    const res = await request(app).get('/merchant/public/transactions').set('X-API-Key', 'sk_live_' + 'cd'.repeat(24));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_API_KEY');
  });

  test('sans en-tete → 401 API_KEY_REQUIRED', async () => {
    const res = await request(app).get('/merchant/public/transactions');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('API_KEY_REQUIRED');
  });

  test('ligne legacy (cle brute, hash NULL) acceptee puis migree (hash renseigne, api_key=NULL)', async () => {
    mockKeyLookup(keyRow({ api_key: RAW, api_key_hash: null }));
    const res = await request(app).get('/merchant/public/transactions').set('X-API-Key', RAW);
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    const migration = mockDbQuery.mock.calls.find(([sql]) => sql.includes('SET api_key_hash=$1'));
    expect(migration).toBeDefined();
    expect(migration[0]).toMatch(/api_key=NULL/);
    expect(migration[1][0]).toBe(HASH);
    expect(migration[1][1]).toBe(RAW.slice(0, 12));
  });

  test('api_secret_hash present → X-API-Secret obligatoire et verifie', async () => {
    const SECRET = 'sk_secret_' + 'ef'.repeat(32);
    mockKeyLookup(keyRow({ api_secret_hash: sha256(SECRET) }));
    let res = await request(app).get('/merchant/public/transactions').set('X-API-Key', RAW);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_API_SECRET');
    res = await request(app).get('/merchant/public/transactions').set('X-API-Key', RAW).set('X-API-Secret', 'wrong');
    expect(res.status).toBe(401);
    res = await request(app).get('/merchant/public/transactions').set('X-API-Key', RAW).set('X-API-Secret', SECRET);
    expect(res.status).toBe(200);
  });

  test('POST /merchant/api-keys stocke hash + prefixe, renvoie la cle brute une fois', async () => {
    mockDbQuery.mockImplementation(async (sql, params) => sql.includes('INSERT INTO merchant_api_keys')
      ? rows([{ key_id: 'k2', key_name: 'n', key_prefix: params[3], permissions: [], is_active: true, expires_at: null, created_at: 'now' }])
      : rows([]));
    const res = await request(app).post('/merchant/api-keys').set(bearer(merchantToken())).send({ keyName: 'n' });
    expect(res.status).toBe(201);
    const raw = res.body.key.api_key;
    expect(raw).toMatch(/^sk_live_[0-9a-f]{48}$/);
    const [sql, params] = mockDbQuery.mock.calls.find(([s]) => s.includes('INSERT INTO merchant_api_keys'));
    expect(sql).toMatch(/api_key_hash, key_prefix/);
    expect(params).not.toContain(raw);
    expect(params[2]).toBe(sha256(raw));
    expect(params[3]).toBe(raw.slice(0, 12));
    expect(params[4]).toBe(sha256(res.body.key.api_secret));
  });

  test('POST /merchant/public/collect → 410 (API key valide)', async () => {
    mockKeyLookup(keyRow({ permissions: ['collect'] }));
    const res = await request(app).post('/merchant/public/collect').set('X-API-Key', RAW)
      .send({ amount: 100, customerPhone: '+242061234567', method: 'mtn_momo' });
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('FEATURE_DISABLED');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('4. Secrets jamais dans les reponses', () => {
  test('GET /admin/notification-configs masque smtp_pass / wa_token / smpp_pass', async () => {
    mockDbQuery.mockResolvedValue(rows([
      { provider_key: 'notif_smtp', extra_params: { smtp_host: 'smtp.x', smtp_pass: 'SuperSecret123' }, last_tested_at: null, last_test_ok: null },
      { provider_key: 'notif_whatsapp', extra_params: { wa_phone_id: '42', wa_token: 'EAABtoken9876' }, last_tested_at: null, last_test_ok: null },
      { provider_key: 'notif_smpp', extra_params: { smpp_host: 'smpp.x', smpp_pass: 'pw' }, last_tested_at: null, last_test_ok: null },
    ]));
    const res = await request(app).get('/admin/notification-configs').set(bearer(adminToken('super_admin')));
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('SuperSecret123');
    expect(text).not.toContain('EAABtoken9876');
    expect(res.body.smtp_host).toBe('smtp.x');
    expect(res.body.smtp_pass).toEqual({ configured: true, last4: 't123' });
    expect(res.body.wa_token).toEqual({ configured: true, last4: '9876' });
    expect(res.body.smpp_pass).toEqual({ configured: true, last4: '****' });
  });

  test('POST /admin/notification-configs ignore un secret renvoye masque', async () => {
    mockDbQuery.mockImplementation(async (sql) => sql.includes('SELECT config_id')
      ? rows([{ config_id: 'c', extra_params: { smtp_pass: 'keep-me', smtp_host: 'old' } }]) : rows([]));
    const res = await request(app).post('/admin/notification-configs').set(bearer(adminToken('super_admin')))
      .send({ section: 'smtp', smtp_host: 'new', smtp_pass: { configured: true, last4: 'k-me' } });
    expect(res.status).toBe(200);
    const upd = mockDbQuery.mock.calls.find(([s]) => s.includes('UPDATE api_configurations'));
    expect(JSON.parse(upd[1][0])).toEqual({ smtp_pass: 'keep-me', smtp_host: 'new' });
  });

  test('GET /admin/api-configs/:id masque api_key / api_secret meme pour super_admin', async () => {
    mockDbQuery.mockResolvedValue(rows([{ config_id: 'c1', provider_key: 'mtn', api_key: 'RAWKEY123456', api_secret: 'RAWSECRET', extra_params: { subscriptionKey: 'SUBKEY999', env: 'prod' } }]));
    const res = await request(app).get('/admin/api-configs/c1').set(bearer(adminToken('super_admin')));
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('RAWKEY123456');
    expect(text).not.toContain('RAWSECRET');
    expect(text).not.toContain('SUBKEY999');
    expect(res.body.api_key).toEqual({ configured: true, last4: '3456' });
    expect(res.body.api_secret.configured).toBe(true);
    expect(res.body.extra_params.env).toBe('prod');
  });

  test('GET /merchant/webhook-config ne renvoie que configured pour le secret', async () => {
    mockDbQuery.mockResolvedValue(rows([{ webhook_url: 'https://shop.example/hook', webhook_secret: 'abcd'.repeat(16) }]));
    const res = await request(app).get('/merchant/webhook-config').set(bearer(merchantToken()));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ webhook_url: 'https://shop.example/hook', webhook_secret: { configured: true } });
  });

  test('PATCH /merchant/webhook-config genere le secret (64 hex) et le renvoie une seule fois', async () => {
    mockDbQuery.mockImplementation(async (sql) => sql.includes('SELECT webhook_secret') ? rows([{ webhook_secret: null }]) : rows([]));
    const res = await request(app).patch('/merchant/webhook-config').set(bearer(merchantToken()))
      .send({ webhookUrl: 'https://8.8.8.8/hook' });
    expect(res.status).toBe(200);
    expect(res.body.webhook_secret.value).toMatch(/^[0-9a-f]{64}$/);
    const upd = mockDbQuery.mock.calls.find(([s]) => s.includes('UPDATE merchants SET webhook_url'));
    expect(upd[1][1]).toBe(res.body.webhook_secret.value);

    // Deja configure : pas de nouveau secret, pas de valeur renvoyee
    mockDbQuery.mockImplementation(async (sql) => sql.includes('SELECT webhook_secret') ? rows([{ webhook_secret: 'x'.repeat(64) }]) : rows([]));
    const res2 = await request(app).patch('/merchant/webhook-config').set(bearer(merchantToken()))
      .send({ webhookUrl: 'https://8.8.8.8/hook' });
    expect(res2.status).toBe(200);
    expect(res2.body.webhook_secret).toEqual({ configured: true });
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('5. SSRF webhook', () => {
  test.each([
    'http://example.com/hook',
    'http://127.0.0.1/hook',
    'https://127.0.0.1/hook',
    'https://localhost/hook',
    'https://10.0.0.5/hook',
    'https://192.168.1.1/hook',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/hook',
    'https://[::ffff:10.0.0.1]/hook',
    'ftp://example.com/hook',
    'not a url',
  ])('PATCH /merchant/webhook-config refuse %s (422, aucune ecriture)', async (url) => {
    const res = await request(app).patch('/merchant/webhook-config').set(bearer(merchantToken())).send({ webhookUrl: url });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('UNSAFE_WEBHOOK_URL');
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  test('isSafeWebhookUrl : https public accepte', () => {
    expect(integrations.isSafeWebhookUrl('https://shop.example.com/hooks/cpay').ok).toBe(true);
    expect(integrations.isSafeWebhookUrl('https://8.8.8.8/x').ok).toBe(true);
    expect(integrations.isSafeWebhookUrl('http://shop.example.com/x').ok).toBe(false);
    expect(integrations.isSafeWebhookUrl('https://user:pw@shop.example.com/x').ok).toBe(false);
  });

  test('isBlockedAddress couvre IPv6 loopback / ULA / link-local', () => {
    expect(integrations.isBlockedAddress('::1')).toBe(true);
    expect(integrations.isBlockedAddress('fd12::1')).toBe(true);
    expect(integrations.isBlockedAddress('fe80::1')).toBe(true);
    expect(integrations.isBlockedAddress('2001:4860:4860::8888')).toBe(false);
    expect(integrations.isBlockedAddress('100.64.0.1')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('6. CSV : quoting, echappement, anti-formule', () => {
  test('csvCell', () => {
    expect(integrations.csvCell('plain')).toBe('"plain"');
    expect(integrations.csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(integrations.csvCell('=SUM(A1:A9)')).toBe('"\'=SUM(A1:A9)"');
    expect(integrations.csvCell('+1234')).toBe('"\'+1234"');
    expect(integrations.csvCell('-5')).toBe('"\'-5"');
    expect(integrations.csvCell('@cmd')).toBe('"\'@cmd"');
    expect(integrations.csvCell(null)).toBe('""');
    expect(integrations.csvCell(12.5)).toBe('"12.5"');
    expect(integrations.csvCell('a,b\nc')).toBe('"a,b\nc"');
  });

  test('GET /admin/finance/settlements/export echappe les cellules', async () => {
    mockDbQuery.mockResolvedValue(rows([{
      batch_date: '2026-10-01', business_name: '=HYPERLINK("http://evil","x")', settlement_account: '+242061234567',
      txn_count: 3, total_gross: 1000, total_fees: 15, total_net: 985, currency: 'XAF', status: 'completed', completed_at: null,
    }]));
    const res = await request(app).get('/admin/finance/settlements/export').set(bearer(adminToken('finance_admin')));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const lines = res.text.split('\n');
    expect(lines[0]).toBe('"Date","Merchant","Compte","Transactions","Brut","Frais","Net","Devise","Statut","Date paiement"');
    expect(lines[1]).toContain('"\'=HYPERLINK(""http://evil"",""x"")"');
    expect(lines[1]).toContain('"\'+242061234567"');
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('7. Double depense /transfer/payout (solde sous verrou, insertion avant operateur)', () => {
  const txMock = ({ collected, withdrawn = 0, disbursed = 0 }) => mockTxQuery.mockImplementation(async (sql) => {
    if (sql.includes('pg_advisory_xact_lock')) return rows([{ ok: true }]);
    if (sql.includes('FOR UPDATE')) return rows([{ merchant_id: MERCHANT_ID, merchant_status: 'active' }]);
    if (sql.includes("type IN ('collect','qr_payment','pay_link')")) return rows([{ collected, pending: 0, nb: 1 }]);
    if (sql.includes('FROM merchant_transfers')) return rows([{ withdrawn }]);
    if (sql.includes("type='payout'")) return rows([{ disbursed }]);
    if (sql.includes('FROM bank_accounts ba')) return rows([{ account_id: 'ba1', inst_name: 'BankX', account_number: '12345678', account_name: 'Shop' }]);
    if (sql.includes('INSERT INTO merchant_transfers')) return rows([{ transfer_id: 't-1' }]);
    return rows([]);
  });

  test('solde insuffisant (retraits precedents deduits) → 422, aucun INSERT', async () => {
    txMock({ collected: 10000, withdrawn: 6000, disbursed: 1000 });
    const res = await request(app).post('/merchant/transfer/payout').set(bearer(merchantToken())).set('Idempotency-Key', require('crypto').randomUUID())
      .send({ destType: 'bank', accountId: 'ba1', amount: 5000 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INSUFFICIENT_BALANCE');
    expect(res.body.available).toBe(3000);
    expect(mockTxQuery.mock.calls.some(([s]) => s.includes('INSERT INTO merchant_transfers'))).toBe(false);
  });

  test('solde suffisant → verrou + INSERT dans la transaction, puis pending_settlement', async () => {
    txMock({ collected: 10000, withdrawn: 2000 });
    const res = await request(app).post('/merchant/transfer/payout').set(bearer(merchantToken())).set('Idempotency-Key', require('crypto').randomUUID())
      .send({ destType: 'bank', accountId: 'ba1', amount: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.transferId).toBe('t-1');
    expect(res.body.status).toBe('pending_settlement');
    const sqls = mockTxQuery.mock.calls.map(([s]) => s);
    expect(sqls.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(sqls.some((s) => s.includes('FOR UPDATE'))).toBe(true);
    const lockIdx = sqls.findIndex((s) => s.includes('FOR UPDATE'));
    const insertIdx = sqls.findIndex((s) => s.includes('INSERT INTO merchant_transfers'));
    expect(insertIdx).toBeGreaterThan(lockIdx);
    expect(mockDbQuery.mock.calls.some(([s]) => s.includes("status='pending_settlement'"))).toBe(true);
  });

  test('GET /merchant/balance utilise la meme formule (transfers + payouts deduits)', async () => {
    mockDbQuery.mockImplementation(async (sql) => {
      if (sql.includes("type IN ('collect','qr_payment','pay_link')")) return rows([{ collected: 10000, pending: 500, nb: 4 }]);
      if (sql.includes('FROM merchant_transfers')) return rows([{ withdrawn: 2000 }]);
      if (sql.includes("type='payout'")) return rows([{ disbursed: 1500 }]);
      return rows([]);
    });
    const res = await request(app).get('/merchant/balance').set(bearer(merchantToken()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ available: 6500, pending: 500, totalCollected: 10000, totalWithdrawn: 3500, transactionCount: 4, currency: 'XAF' });
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('8. Correctifs fonctionnels', () => {
  test('pagination bornee : limit=1000&page=0 → LIMIT 100 OFFSET 0 (marchand et admin)', async () => {
    mockDbQuery.mockImplementation(async (sql) => sql.startsWith('SELECT COUNT') ? rows([{ count: '0' }]) : rows([]));
    let res = await request(app).get('/merchant/transactions?limit=1000&page=0').set(bearer(merchantToken()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, limit: 100 });
    let params = mockDbQuery.mock.calls.find(([s]) => s.includes('ORDER BY initiated_at DESC LIMIT'))[1];
    expect(params.slice(-2)).toEqual([100, 0]);

    mockDbQuery.mockClear();
    res = await request(app).get('/admin/merchants?limit=-5&page=abc').set(bearer(adminToken('support_agent')));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, limit: 1 });
    params = mockDbQuery.mock.calls.find(([s]) => s.includes('ORDER BY m.created_at DESC'))[1];
    expect(params.slice(-2)).toEqual([1, 0]);
  });

  test('POST /merchant/account/change-password lit req.user.sub', async () => {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('OldPass123', 4);
    mockDbQuery.mockImplementation(async (sql) => sql.includes('SELECT password_hash') ? rows([{ password_hash: hash }]) : rows([]));
    const res = await request(app).post('/merchant/account/change-password').set(bearer(merchantToken()))
      .send({ currentPassword: 'OldPass123', newPassword: 'NewPass12345' });
    expect(res.status).toBe(200);
    expect(mockDbQuery.mock.calls[0][1]).toEqual(['user-1']);
  });

  test('POST /merchant/receipts/sms : numero non E.164 → 422, valide → envoi normalise', async () => {
    let res = await request(app).post('/merchant/receipts/sms').set(bearer(merchantToken()))
      .send({ phone: '061234567', amount: 100, reference: 'R' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_PHONE');
    expect(smpp.sendSmsSmpp).not.toHaveBeenCalled();

    res = await request(app).post('/merchant/receipts/sms').set(bearer(merchantToken()))
      .send({ phone: '+242 06 123 45 67', amount: 100, reference: 'R' });
    expect(res.status).toBe(200);
    expect(res.body.phone).toBe('+242061234567');
    expect(smpp.sendSmsSmpp).toHaveBeenCalledWith(expect.objectContaining({ to: '+242061234567' }));
  });

  test('rate limit SMS : 20/h par marchand puis 429', async () => {
    const other = signToken({ sub: 'u9', merchantId: '99999999-9999-4999-8999-999999999999', type: 'merchant' });
    let last;
    for (let i = 0; i < 20; i++) {
      last = await request(app).post('/merchant/receipts/sms').set(bearer(other)).send({ phone: '+242061234567', amount: 1 });
      expect(last.status).toBe(200);
    }
    last = await request(app).post('/merchant/receipts/sms').set(bearer(other)).send({ phone: '+242061234567', amount: 1 });
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('SMS_RATE_LIMITED');
    // Un autre marchand n'est pas affecte
    const ok = await request(app).post('/merchant/receipts/sms').set(bearer(merchantToken())).send({ phone: '+242061234567', amount: 1 });
    expect(ok.status).toBe(200);
  });

  test('POST /merchant/pay-links : expiresIn hors [1,720] → 422 ; shortId crypto + reprise sur collision', async () => {
    let res = await request(app).post('/merchant/pay-links').set(bearer(merchantToken())).send({ amount: 1000, expiresIn: 0.5 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_EXPIRES_IN');
    res = await request(app).post('/merchant/pay-links').set(bearer(merchantToken())).send({ amount: 1000, expiresIn: 721 });
    expect(res.status).toBe(422);

    const seen = [];
    let attempts = 0;
    mockDbQuery.mockImplementation(async (sql, params) => {
      if (sql.includes('SELECT currency')) return rows([{ currency: 'XAF' }]);
      if (sql.includes('INSERT INTO pay_links')) {
        attempts++; seen.push(params[2]);
        if (attempts === 1) { const e = new Error('dup'); e.code = '23505'; throw e; }
        return rows([{ pay_link_id: params[0], short_id: params[2], short_url: params[6] }]);
      }
      return rows([]);
    });
    res = await request(app).post('/merchant/pay-links').set(bearer(merchantToken())).send({ amount: 1000, expiresIn: 48 });
    expect(res.status).toBe(201);
    expect(attempts).toBe(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(res.body.link.short_id).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  });

  test('POST /merchant/pay-links/:id/send : numero invalide → 422', async () => {
    const res = await request(app).post('/merchant/pay-links/ABC/send').set(bearer(merchantToken())).send({ phone: '12' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_PHONE');
    expect(mockDbQuery).not.toHaveBeenCalled();
  });

  test('module.exports est la derniere instruction : routes de fin de fichier enregistrees', async () => {
    const paths = (r) => r.stack.filter((l) => l.route).map((l) => l.route.path);
    expect(paths(merchantRouter)).toEqual(expect.arrayContaining(['/pay-links', '/api-keys', '/webhook-config', '/webhook-config/test']));
    expect(paths(adminRouter)).toEqual(expect.arrayContaining(['/tenants/:id', '/notification-configs', '/admin-users/:id', '/reconcile']));
    expect(paths(merchantRouter)).not.toContain('/reconcile');
  });
});
