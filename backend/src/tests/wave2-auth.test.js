'use strict';
/**
 * WAVE-2 (audit prod 2.6.0) — authentification unifiee
 * supertest + base de donnees simulee en memoire (aucune connexion reseau).
 *
 * Couvre : 2FA au login (merchant / admin / cardholder), attributs du cookie
 * refresh (HttpOnly, Secure, SameSite=Strict, sans Domain), rotation des
 * refresh (ancien token refuse, reutilisation = revocation globale), branche
 * legacy, revokeAll apres changement de mot de passe, temp_password ->
 * mustChangePassword, rate limits (register, forgot-password, partners login,
 * terminals/pair), verrouillage partenaires, chiffrement des secrets
 * api-configs, et l'absence de toute implementation JWT locale.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wave2-test-secret-at-least-32-chars-long';
process.env.NODE_ENV = 'test';
process.env.AUTH_LEGACY_REFRESH_UNTIL = '2099-01-01T00:00:00Z';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const speakeasy = require('speakeasy');

// ─── Mocks ────────────────────────────────────────────────────────
const mockDbQuery = jest.fn();
const mockTxQuery = jest.fn();
jest.mock('../config/database', () => ({
  query: (...args) => mockDbQuery(...args),
  withTransaction: async (fn) => fn({ query: (...args) => mockTxQuery(...args) }),
  pool: {},
}));
jest.mock('../services/notifications/email.service', () => ({ send: jest.fn(async () => true) }));
jest.mock('../services/email.service', () => ({ send: jest.fn(async () => true) }), { virtual: true });
jest.mock('../services/notifications/smpp.service', () => ({
  sendSmsSmpp: jest.fn(async () => true), notifyMultiChannel: jest.fn(async () => true),
}));
jest.mock('../services/notifications/whatsapp.service', () => ({ sendWhatsAppText: jest.fn(async () => true) }));
jest.mock('../services/reconcile.service', () => ({ reconcilePending: jest.fn(async () => ({ summary: {} })) }));
jest.mock('../services/rails/gtp.client', () => ({ isConfigured: () => true, callSoap: jest.fn(), tagAll: () => [], parseFlat: () => ({}) }));
jest.mock('../services/transfer/transfer.service', () => ({ initiate: jest.fn(), getStatus: jest.fn() }));
// Module fourni par la wave-2 paiements : stub (virtual) pour verifier l'appel
const mockEncrypt = jest.fn(async ({ apiKey, apiSecret, extraParams }) => ({
  apiKey: apiKey ? `enc:${apiKey}` : null,
  apiSecret: apiSecret ? `enc:${apiSecret}` : null,
  extraParams: extraParams ? Object.fromEntries(Object.entries(extraParams).map(([k, v]) => [k, `enc:${v}`])) : null,
}));
jest.mock('../config/secrets', () => ({ encryptConfigPatch: (...a) => mockEncrypt(...a) }), { virtual: true });

const auth = require('../middleware/auth');
const merchantRouter = require('../routes/merchant.routes');
const adminRouter = require('../routes/admin.routes');
const cardholderRouter = require('../routes/cardholder.routes');
const partnersRouter = require('../routes/partners.routes');
const card2momoRouter = require('../routes/card2momo.routes');
const { merchantResetRouter, cardholderResetRouter } = require('../routes/password_reset_distribution.routes');

const app = express();
app.use(cookieParser());
app.use(express.json());
app.use('/api/v1/merchant', merchantRouter);
app.use('/api/v1/merchant', merchantResetRouter);
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/cardholder', cardholderRouter);
app.use('/api/v1/cardholder', cardholderResetRouter);
app.use('/api/v1/partners', partnersRouter);
app.use('/api/v1', card2momoRouter);

// ─── Fixtures ─────────────────────────────────────────────────────
const PWD = 'Passw0rd!xyz';
const PWD_HASH = bcrypt.hashSync(PWD, 4);
const SECRET = speakeasy.generateSecret({ length: 20 }).base32;
const MERCHANT_ID = '11111111-1111-4111-8111-111111111111';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rows = (r) => ({ rows: r, rowCount: r.length });
const totp = () => speakeasy.totp({ secret: SECRET, encoding: 'base32' });
const wrongTotp = () => String((parseInt(totp(), 10) + 1) % 1000000).padStart(6, '0');

let db;
const freshDb = () => ({
  refresh: [],
  merchantUser: {
    user_id: 'mu-1', merchant_id: MERCHANT_ID, email: 'm@test.io', phone: '+242061234567', first_name: 'M', last_name: 'U',
    role: 'owner', is_active: true, password_hash: PWD_HASH, mfa_enabled: false, mfa_secret: null, temp_password: false,
    failed_attempts: 0, locked_until: null, business_name: 'Shop', currency: 'XAF', kyb_level: 1, merchant_status: 'active', country: 'CG',
  },
  admin: {
    admin_id: 'ad-1', email: 'admin@test.io', first_name: 'A', last_name: 'D', role: 'super_admin', is_active: true,
    password_hash: PWD_HASH, mfa_enabled: false, mfa_secret: null, temp_password: false, failed_attempts: 0, locked_until: null,
  },
  cardholder: {
    cardholder_id: 'ch-1', card_id: 'card-1', first_name: 'C', last_name: 'H', email: 'ch@test.io', phone: '+242061234568', kyc_level: 1,
    is_active: true, password_hash: PWD_HASH, mfa_enabled: false, mfa_secret: null, temp_password: false, failed_attempts: 0, locked_until: null,
    card_masked: '4000 **** **** 1234', balance: '0', currency: 'XAF', card_status: 'active', expiry_month: 12, expiry_year: 2029,
    cardholder_name: 'C H', network: 'visa', daily_limit: '100000', monthly_limit: '500000', email_verified: true,
  },
  bankUser: {
    user_id: 'bu-1', bank_id: 'b1', agency_id: null, first_name: 'B', last_name: 'U', email: 'bank@test.io', phone: null, role: 'bank_admin',
    status: 'active', password_hash: PWD_HASH, is_mfa_enabled: false, mfa_secret: null, temp_password: false, failed_attempts: 0, locked_until: null,
    bank_name: 'Bank', agency_name: null,
  },
  apiConfigUpdates: [],
});

// Projection : une liste de colonnes explicite ne renvoie que ces colonnes
// (un `u.*` renverrait toute la ligne, password_hash et mfa_secret compris).
const project = (s, row) => {
  const cols = s.match(/^SELECT (.+?) FROM /i)?.[1];
  if (!cols || /\*/.test(cols)) return { ...row };
  const names = cols.split(',').map(c => c.trim().split(/\s+/).pop().replace(/^\w+\./, ''));
  return Object.fromEntries(names.filter(n => n in row).map(n => [n, row[n]]));
};

// Simulateur SQL minimal : refresh_tokens (insert / rotation / revocation) +
// lectures/ecritures des tables utilisateurs.
const fakeQuery = async (sql, params = []) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  // refresh_tokens
  if (/INSERT INTO refresh_tokens/.test(s)) {
    db.refresh.push({ subject_id: params[0], actor_type: params[1], token_hash: params[2], expires_at: params[3], meta: JSON.parse(params[4]), revoked_at: null });
    return rows([]);
  }
  if (/UPDATE refresh_tokens SET revoked_at = NOW\(\), last_used_at = NOW\(\)/.test(s)) {
    const t = db.refresh.find(r => r.token_hash === params[0] && r.actor_type === params[1] && !r.revoked_at && r.expires_at > new Date());
    if (!t) return rows([]);
    t.revoked_at = new Date();
    return rows([{ subject_id: t.subject_id, meta: t.meta }]);
  }
  if (/SELECT subject_id FROM refresh_tokens WHERE token_hash/.test(s)) {
    const t = db.refresh.find(r => r.token_hash === params[0] && r.actor_type === params[1] && r.revoked_at);
    return rows(t ? [{ subject_id: t.subject_id }] : []);
  }
  if (/UPDATE refresh_tokens SET revoked_at = NOW\(\) WHERE token_hash/.test(s)) {
    db.refresh.filter(r => r.token_hash === params[0] && !r.revoked_at).forEach(r => { r.revoked_at = new Date(); });
    return rows([]);
  }
  if (/UPDATE refresh_tokens SET revoked_at = NOW\(\) WHERE actor_type/.test(s)) {
    db.refresh.filter(r => r.actor_type === params[0] && r.subject_id === params[1] && !r.revoked_at).forEach(r => { r.revoked_at = new Date(); });
    return rows([]);
  }
  // merchant_users
  if (/FROM merchant_users u JOIN merchants m/.test(s)) {
    const u = db.merchantUser;
    const match = /u\.email = \$1 OR u\.phone = \$1/.test(s) ? (params[0] === u.email || params[0] === u.phone) : params[0] === u.user_id;
    return rows(match && u.is_active ? [project(s, u)] : []);
  }
  if (/SELECT password_hash FROM merchant_users/.test(s)) return rows(params[0] === db.merchantUser.user_id ? [{ password_hash: db.merchantUser.password_hash }] : []);
  if (/UPDATE merchant_users SET password_hash=\$1, temp_password=FALSE/.test(s)) { db.merchantUser.password_hash = params[0]; db.merchantUser.temp_password = false; return rows([]); }
  if (/UPDATE merchant_users SET failed_attempts=\$1/.test(s)) { db.merchantUser.failed_attempts = params[0]; db.merchantUser.locked_until = params[1]; return rows([]); }
  if (/SELECT mfa_secret FROM merchant_users/.test(s)) return rows([{ mfa_secret: db.merchantUser.mfa_secret }]);
  if (/SELECT email FROM merchant_users/.test(s)) return rows([{ email: db.merchantUser.email }]);
  if (/UPDATE merchant_users SET mfa_secret=\$1, mfa_enabled=FALSE/.test(s)) { db.merchantUser.mfa_secret = params[0]; db.merchantUser.mfa_enabled = false; return rows([]); }
  if (/UPDATE merchant_users SET mfa_enabled=TRUE/.test(s)) { db.merchantUser.mfa_enabled = true; return rows([]); }
  if (/UPDATE merchant_users SET mfa_enabled=FALSE, mfa_secret=NULL/.test(s)) { db.merchantUser.mfa_enabled = false; db.merchantUser.mfa_secret = null; return rows([]); }
  // admin_users
  if (/FROM admin_users WHERE email = \$1/.test(s)) return rows(params[0] === db.admin.email ? [project(s, db.admin)] : []);
  if (/FROM admin_users WHERE admin_id = \$1/.test(s)) return rows(params[0] === db.admin.admin_id ? [project(s, db.admin)] : []);
  if (/UPDATE admin_users SET password_hash=\$1, temp_password=FALSE/.test(s)) { db.admin.password_hash = params[0]; db.admin.temp_password = false; return rows([]); }
  // cardholders
  if (/FROM cardholders ch JOIN virtual_cards vc/.test(s) || /FROM cardholders ch LEFT JOIN virtual_cards vc/.test(s)) {
    const c = db.cardholder;
    const match = /ch\.email = \$1 OR ch\.phone = \$1/.test(s) ? (params[0] === c.email || params[0] === c.phone) : params[0] === c.cardholder_id;
    return rows(match ? [project(s, c)] : []);
  }
  if (/UPDATE cardholders SET failed_attempts=\$1/.test(s)) { db.cardholder.failed_attempts = params[0]; db.cardholder.locked_until = params[1]; return rows([]); }
  // partenaires
  if (/FROM bank_users u/.test(s)) {
    const u = db.bankUser;
    const match = /u\.email=\$1/.test(s) ? params[0] === u.email : params[0] === u.user_id;
    return rows(match ? [project(s, u)] : []);
  }
  if (/FROM agents a/.test(s)) return rows([]);
  if (/UPDATE bank_users SET failed_attempts=\$1/.test(s)) { db.bankUser.failed_attempts = params[0]; db.bankUser.locked_until = params[1]; return rows([]); }
  if (/UPDATE bank_users SET failed_attempts=0/.test(s)) { db.bankUser.failed_attempts = 0; db.bankUser.locked_until = null; return rows([]); }
  // api_configurations
  if (/UPDATE api_configurations/.test(s)) { db.apiConfigUpdates.push(params); return rows([{ config_id: 'cfg-1', provider_key: params[7], status: 'active' }]); }
  if (/password_reset_tokens WHERE token_hash/.test(s)) return rows(params[0] === sha256('reset-raw') ? [{ token_id: 'rt-1', actor_id: db.merchantUser.user_id }] : []);
  return rows([]);
};

beforeEach(() => {
  db = freshDb();
  mockDbQuery.mockReset(); mockTxQuery.mockReset(); mockEncrypt.mockClear();
  mockDbQuery.mockImplementation(fakeQuery);
  mockTxQuery.mockImplementation(fakeQuery);
});

// ─── Helpers ──────────────────────────────────────────────────────
const cookieOf = (res, name) => (res.headers['set-cookie'] || []).find(c => c.startsWith(`${name}=`));
const cookieValue = (c) => c.split(';')[0].split('=').slice(1).join('=');
const decode = (t) => jwt.decode(t);
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

const expectHardenedCookie = (res, name, path) => {
  const c = cookieOf(res, name);
  expect(c).toBeDefined();
  expect(c).toMatch(/HttpOnly/i);
  expect(c).toMatch(/Secure/i);
  expect(c).toMatch(/SameSite=Strict/i);
  expect(c).toMatch(new RegExp(`Path=${path.replace(/\//g, '\\/')}`));
  expect(c).not.toMatch(/Domain=/i);
  expect(cookieValue(c)).toBe(res.body.refresh_token);
};

// ═══════════════════════════════════════════════════════════════════
describe('1. 2FA au login', () => {
  test('merchant : mfa_enabled → { mfaRequired, mfaToken } (type merchant_mfa, 5 min), sans session', async () => {
    db.merchantUser.mfa_enabled = true; db.merchantUser.mfa_secret = SECRET;
    const r = await request(app).post('/api/v1/merchant/auth/login').send({ emailOrPhone: 'm@test.io', password: PWD });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ mfaRequired: true, mfaToken: expect.any(String) });
    expect(r.body.access_token).toBeUndefined();
    expect(r.headers['set-cookie']).toBeUndefined();
    const d = decode(r.body.mfaToken);
    expect(d.type).toBe('merchant_mfa');
    expect(d.exp - d.iat).toBe(300);
    expect(d.iss).toBe(auth.JWT_ISSUER);
    expect(db.refresh).toHaveLength(0);
  });

  test('merchant : validate avec un mauvais code → 401 ; avec speakeasy.totp() → session + cookie', async () => {
    db.merchantUser.mfa_enabled = true; db.merchantUser.mfa_secret = SECRET;
    const login = await request(app).post('/api/v1/merchant/auth/login').send({ emailOrPhone: 'm@test.io', password: PWD });
    const bad = await request(app).post('/api/v1/merchant/auth/2fa/validate').send({ mfaToken: login.body.mfaToken, code: wrongTotp() });
    expect(bad.status).toBe(401);
    expect(db.refresh).toHaveLength(0);

    const ok = await request(app).post('/api/v1/merchant/auth/2fa/validate').send({ mfaToken: login.body.mfaToken, code: totp() });
    expect(ok.status).toBe(200);
    expect(ok.body.access_token).toBeTruthy();
    expect(ok.body.expires_in).toBe(900);
    expect(ok.body.user.email).toBe('m@test.io');
    expect(JSON.stringify(ok.body)).not.toMatch(/password_hash|mfa_secret/);
    const d = decode(ok.body.access_token);
    expect(d.type).toBe('merchant');
    expect(d.sub).toBe('mu-1');
    expect(d.exp - d.iat).toBe(900);
    expect(d.iss).toBe(auth.JWT_ISSUER);
    expect(d.aud).toBe(auth.JWT_AUDIENCE);
    expectHardenedCookie(ok, 'cp_rt_merchant', '/api/v1/merchant/auth');
    // refresh stocke hashe, jamais en clair
    expect(db.refresh[0].token_hash).toBe(sha256(ok.body.refresh_token));
    expect(db.refresh[0].actor_type).toBe('merchant');
  });

  test('un access token ne peut pas servir de mfaToken ; un mfaToken ne donne pas acces aux routes', async () => {
    const access = auth.signToken({ sub: 'mu-1', type: 'merchant', merchantId: MERCHANT_ID });
    const r = await request(app).post('/api/v1/merchant/auth/2fa/validate').send({ mfaToken: access, code: totp() });
    expect(r.status).toBe(401);
    const mfa = auth.signMfaToken({ actorType: 'merchant', sub: 'mu-1' });
    const me = await request(app).get('/api/v1/merchant/auth/me').set(bearer(mfa));
    expect(me.status).toBe(403);
  });

  test('admin : mfa_enabled → mfaRequired ; validate → session, cookie cp_rt_admin (7 j)', async () => {
    db.admin.mfa_enabled = true; db.admin.mfa_secret = SECRET;
    const login = await request(app).post('/api/v1/admin/auth/login').send({ email: 'admin@test.io', password: PWD });
    expect(login.body.mfaRequired).toBe(true);
    expect(decode(login.body.mfaToken).type).toBe('admin_mfa');
    expect((await request(app).post('/api/v1/admin/auth/2fa/validate').send({ mfaToken: login.body.mfaToken, code: wrongTotp() })).status).toBe(401);
    const ok = await request(app).post('/api/v1/admin/auth/2fa/validate').send({ mfaToken: login.body.mfaToken, code: totp() });
    expect(ok.status).toBe(200);
    expect(decode(ok.body.access_token)).toMatchObject({ type: 'admin', role: 'super_admin', sub: 'ad-1' });
    expectHardenedCookie(ok, 'cp_rt_admin', '/api/v1/admin/auth');
    const ttlDays = (db.refresh[0].expires_at - Date.now()) / 86400000;
    expect(ttlDays).toBeGreaterThan(6.9); expect(ttlDays).toBeLessThanOrEqual(7);
  });

  test('cardholder : mfa_enabled → mfaRequired ; validate → session, cookie cp_rt_cardholder, access 15 min', async () => {
    db.cardholder.mfa_enabled = true; db.cardholder.mfa_secret = SECRET;
    const login = await request(app).post('/api/v1/cardholder/auth/login').send({ emailOrPhone: 'ch@test.io', password: PWD });
    expect(login.status).toBe(200);
    expect(login.body.mfaRequired).toBe(true);
    expect(decode(login.body.mfaToken).type).toBe('cardholder_mfa');
    expect((await request(app).post('/api/v1/cardholder/auth/2fa/validate').send({ mfaToken: login.body.mfaToken, code: wrongTotp() })).status).toBe(401);
    const ok = await request(app).post('/api/v1/cardholder/auth/2fa/validate').send({ mfaToken: login.body.mfaToken, code: totp() });
    expect(ok.status).toBe(200);
    const d = decode(ok.body.access_token);
    expect(d).toMatchObject({ type: 'cardholder', sub: 'ch-1', cardId: 'card-1' });
    expect(d.exp - d.iat).toBe(900);
    expectHardenedCookie(ok, 'cp_rt_cardholder', '/api/v1/cardholder/auth');
    expect(JSON.stringify(ok.body)).not.toMatch(/password_hash|mfa_secret|card_number/);
  });

  test('2FA setup/verify/disable merchant : QR serveur, fenetre 1, disable exige un code valide', async () => {
    const tok = auth.signToken({ sub: 'mu-1', type: 'merchant', merchantId: MERCHANT_ID });
    const setup = await request(app).post('/api/v1/merchant/auth/2fa/setup').set(bearer(tok));
    expect(setup.status).toBe(200);
    expect(setup.body.secret).toMatch(/^[A-Z2-7]+=*$/);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(setup.body.qrCode).toMatch(/^data:image\/png;base64,/);
    expect(db.merchantUser.mfa_secret).toBe(setup.body.secret);
    expect(db.merchantUser.mfa_enabled).toBe(false);
    const code = speakeasy.totp({ secret: setup.body.secret, encoding: 'base32' });
    expect((await request(app).post('/api/v1/merchant/auth/2fa/verify').set(bearer(tok)).send({ token: '000000' })).status).toBe(400);
    expect((await request(app).post('/api/v1/merchant/auth/2fa/verify').set(bearer(tok)).send({ token: code })).status).toBe(200);
    expect(db.merchantUser.mfa_enabled).toBe(true);
    expect((await request(app).post('/api/v1/merchant/auth/2fa/disable').set(bearer(tok)).send({ token: '000000' })).status).toBe(400);
    expect((await request(app).post('/api/v1/merchant/auth/2fa/disable').set(bearer(tok)).send({ token: code })).status).toBe(200);
    expect(db.merchantUser.mfa_enabled).toBe(false);
    // mfa_secret NULL -> 400, jamais 500 (audit §3.8)
    expect((await request(app).post('/api/v1/merchant/auth/2fa/disable').set(bearer(tok)).send({ token: '123456' })).status).toBe(400);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('2. Refresh : cookie, rotation, reutilisation, legacy', () => {
  test('login merchant → cookie ; refresh via cookie → rotation ; ancien token refuse ; reutilisation revoque tout', async () => {
    const login = await request(app).post('/api/v1/merchant/auth/login').send({ emailOrPhone: 'm@test.io', password: PWD });
    expect(login.status).toBe(200);
    expectHardenedCookie(login, 'cp_rt_merchant', '/api/v1/merchant/auth');
    const r1 = login.body.refresh_token;
    expect(r1.split('.')).toHaveLength(1); // opaque, pas un JWT

    const ref = await request(app).post('/api/v1/merchant/auth/refresh').set('Cookie', `cp_rt_merchant=${r1}`);
    expect(ref.status).toBe(200);
    const r2 = ref.body.refresh_token;
    expect(r2).toBeTruthy(); expect(r2).not.toBe(r1);
    expect(decode(ref.body.access_token).type).toBe('merchant');
    expectHardenedCookie(ref, 'cp_rt_merchant', '/api/v1/merchant/auth');

    // ancien token : refuse, et toute la famille est revoquee (vol probable)
    const reuse = await request(app).post('/api/v1/merchant/auth/refresh').send({ refreshToken: r1 });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('REFRESH_REUSED');
    expect(db.refresh.every(t => t.revoked_at)).toBe(true);
    const r2again = await request(app).post('/api/v1/merchant/auth/refresh').send({ refreshToken: r2 });
    expect(r2again.status).toBe(401);
  });

  test('admin : refresh accepte le cookie OU le corps ; logout revoque et efface le cookie', async () => {
    const login = await request(app).post('/api/v1/admin/auth/login').send({ email: 'admin@test.io', password: PWD });
    expect(login.status).toBe(200);
    const byBody = await request(app).post('/api/v1/admin/auth/refresh').send({ refreshToken: login.body.refresh_token });
    expect(byBody.status).toBe(200);
    const byCookie = await request(app).post('/api/v1/admin/auth/refresh').set('Cookie', `cp_rt_admin=${byBody.body.refresh_token}`);
    expect(byCookie.status).toBe(200);
    const out = await request(app).post('/api/v1/admin/auth/logout').set('Cookie', `cp_rt_admin=${byCookie.body.refresh_token}`);
    expect(out.status).toBe(200);
    expect(cookieOf(out, 'cp_rt_admin')).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(db.refresh.every(t => t.revoked_at)).toBe(true);
    expect((await request(app).post('/api/v1/admin/auth/refresh').send({ refreshToken: byCookie.body.refresh_token })).status).toBe(401);
  });

  test('cardholder : ancien refresh JWT 7 j (cardholder_refresh) accepte en legacy, journalise, puis remplace par un refresh opaque', async () => {
    const logger = require('../config/logger');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const legacy = jwt.sign({ sub: 'ch-1', type: 'cardholder_refresh' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    const r = await request(app).post('/api/v1/cardholder/auth/refresh').send({ refreshToken: legacy });
    expect(r.status).toBe(200);
    expect(decode(r.body.access_token)).toMatchObject({ type: 'cardholder', sub: 'ch-1', cardId: 'card-1' });
    expect(r.body.refresh_token.split('.')).toHaveLength(1);
    expectHardenedCookie(r, 'cp_rt_cardholder', '/api/v1/cardholder/auth');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/legacy JWT refresh/), expect.objectContaining({ actorType: 'cardholder', sub: 'ch-1' }));
    // un access token cardholder (type cardholder) n'est pas un refresh legacy
    const access = jwt.sign({ sub: 'ch-1', type: 'cardholder' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    expect((await request(app).post('/api/v1/cardholder/auth/refresh').send({ refreshToken: access })).status).toBe(401);
    warn.mockRestore();
  });

  test('partners : login → session + cookie cp_rt_partner ; refresh conserve userType ; ancien refresh JWT 7 j accepte en legacy', async () => {
    const login = await request(app).post('/api/v1/partners/auth/login').send({ email: 'bank@test.io', password: PWD });
    expect(login.status).toBe(200);
    expect(decode(login.body.access_token)).toMatchObject({ type: 'bank_user', role: 'bank_admin', sub: 'bu-1' });
    expect(decode(login.body.access_token).exp - decode(login.body.access_token).iat).toBe(900);
    expectHardenedCookie(login, 'cp_rt_partner', '/api/v1/partners/auth');
    expect(db.refresh[0].meta).toEqual({ userType: 'bank_user', tenantId: null });
    const ref = await request(app).post('/api/v1/partners/auth/refresh').set('Cookie', `cp_rt_partner=${login.body.refresh_token}`);
    expect(ref.status).toBe(200);
    expect(decode(ref.body.access_token)).toMatchObject({ type: 'bank_user', role: 'bank_admin' });

    const legacy = jwt.sign({ sub: 'bu-1', type: 'bank_user', role: 'bank_admin', bankId: 'b1' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    expect((await request(app).post('/api/v1/partners/auth/refresh').send({ refreshToken: legacy })).status).toBe(200);
    // un ancien access token 8 h ne peut pas servir de refresh
    const oldAccess = jwt.sign({ sub: 'bu-1', type: 'bank_user', role: 'bank_admin' }, process.env.JWT_SECRET, { expiresIn: '8h' });
    expect((await request(app).post('/api/v1/partners/auth/refresh').send({ refreshToken: oldAccess })).status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('3. Hygiene mots de passe', () => {
  test('changement de mot de passe merchant → revokeAll, temp_password leve, cookie efface', async () => {
    db.merchantUser.temp_password = true;
    const login = await request(app).post('/api/v1/merchant/auth/login').send({ emailOrPhone: 'm@test.io', password: PWD });
    expect(login.body.mustChangePassword).toBe(true);
    const other = await request(app).post('/api/v1/merchant/auth/login').send({ emailOrPhone: 'm@test.io', password: PWD });
    expect(db.refresh).toHaveLength(2);

    const ch = await request(app).post('/api/v1/merchant/auth/change-password').set(bearer(login.body.access_token))
      .send({ currentPassword: PWD, newPassword: 'N3wPassw0rd!!' });
    expect(ch.status).toBe(200);
    expect(ch.body.sessionsRevoked).toBe(true);
    expect(db.merchantUser.temp_password).toBe(false);
    expect(bcrypt.compareSync('N3wPassw0rd!!', db.merchantUser.password_hash)).toBe(true);
    expect(db.refresh.every(t => t.revoked_at)).toBe(true);
    expect(cookieOf(ch, 'cp_rt_merchant')).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await request(app).post('/api/v1/merchant/auth/refresh').send({ refreshToken: other.body.refresh_token })).status).toBe(401);
    // mauvais mot de passe actuel -> 401, rien de revoque
    db = freshDb(); await request(app).post('/api/v1/merchant/auth/login').send({ emailOrPhone: 'm@test.io', password: PWD });
    const bad = await request(app).post('/api/v1/merchant/account/change-password').set(bearer(login.body.access_token))
      .send({ currentPassword: 'wrong', newPassword: 'N3wPassw0rd!!' });
    expect(bad.status).toBe(401);
    expect(db.refresh.some(t => !t.revoked_at)).toBe(true);
  });

  test('reset mot de passe merchant (lien email) → revokeAll + temp_password=FALSE', async () => {
    await request(app).post('/api/v1/merchant/auth/login').send({ emailOrPhone: 'm@test.io', password: PWD });
    const r = await request(app).post('/api/v1/merchant/auth/reset-password').send({ token: 'reset-raw', newPassword: 'N3wPassw0rd!!' });
    expect(r.status).toBe(200);
    const upd = mockTxQuery.mock.calls.find(([sql]) => /UPDATE merchant_users SET password_hash/.test(sql));
    expect(upd[0]).toMatch(/temp_password=FALSE/);
    expect(db.refresh.every(t => t.revoked_at)).toBe(true);
  });

  test('admin : temp_password → mustChangePassword au login et sur /auth/me ; change-password revoque', async () => {
    db.admin.temp_password = true;
    const login = await request(app).post('/api/v1/admin/auth/login').send({ email: 'admin@test.io', password: PWD });
    expect(login.status).toBe(200);
    expect(login.body.mustChangePassword).toBe(true);
    const me = await request(app).get('/api/v1/admin/auth/me').set(bearer(login.body.access_token));
    expect(me.status).toBe(200);
    expect(me.body.mustChangePassword).toBe(true);
    expect(JSON.stringify(me.body)).not.toMatch(/password_hash|mfa_secret/);
    const ch = await request(app).post('/api/v1/admin/auth/change-password').set(bearer(login.body.access_token))
      .send({ currentPassword: PWD, newPassword: 'N3wPassw0rd!!' });
    expect(ch.status).toBe(200);
    expect(db.admin.temp_password).toBe(false);
    expect(db.refresh.every(t => t.revoked_at)).toBe(true);
  });

  test('cardholder / partners : temp_password → mustChangePassword ; /auth/me sans secrets', async () => {
    db.cardholder.temp_password = true; db.bankUser.temp_password = true;
    const ch = await request(app).post('/api/v1/cardholder/auth/login').send({ emailOrPhone: 'ch@test.io', password: PWD });
    expect(ch.body.mustChangePassword).toBe(true);
    const chMe = await request(app).get('/api/v1/cardholder/auth/me').set(bearer(ch.body.access_token));
    expect(chMe.status).toBe(200);
    expect(chMe.body.cardholder.cardholderId).toBe('ch-1');
    expect(JSON.stringify(chMe.body)).not.toMatch(/password_hash|mfa_secret|card_number/);
    const p = await request(app).post('/api/v1/partners/auth/login').send({ email: 'bank@test.io', password: PWD });
    expect(p.body.mustChangePassword).toBe(true);
    const pMe = await request(app).get('/api/v1/partners/auth/me').set(bearer(p.body.access_token));
    expect(pMe.status).toBe(200);
    expect(pMe.body.mustChangePassword).toBe(true);
    expect(JSON.stringify(pMe.body)).not.toMatch(/password_hash|mfa_secret/);
    const sql = mockDbQuery.mock.calls.find(([q]) => /FROM bank_users u LEFT JOIN banks b/.test(q) && /u\.user_id=\$1/.test(q))[0];
    expect(sql).not.toMatch(/u\.\*/);
  });

  test('mot de passe temporaire : crypto.randomBytes, 16+ caracteres, jamais Math.random', () => {
    const spy = jest.spyOn(Math, 'random');
    const p = auth.generateTempPassword('Bank');
    expect(p).toMatch(/^Bank-[A-Za-z0-9_-]{16}$/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('4. Rate limits et verrouillage', () => {
  test('POST /merchant/auth/register : 5 / h / IP → le 6e est 429', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await request(app).post('/api/v1/merchant/auth/register').send({})).status);
    expect(statuses.slice(0, 5).every(s => s === 422)).toBe(true);
    expect(statuses[5]).toBe(429);
  });

  test('POST /cardholder/auth/register : 5 / h / IP → le 6e est 429', async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await request(app).post('/api/v1/cardholder/auth/register').send({})).status);
    expect(statuses[4]).toBe(422);
    expect(statuses[5]).toBe(429);
  });

  test('POST /merchant/auth/forgot-password : 3 / h par email (cle = email normalise)', async () => {
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await request(app).post('/api/v1/merchant/auth/forgot-password').send({ email: i % 2 ? 'X@Test.io' : 'x@test.io ' })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    // un autre email passe encore (limite IP = 5)
    expect((await request(app).post('/api/v1/merchant/auth/forgot-password').send({ email: 'y@test.io' })).status).toBe(200);
    expect((await request(app).post('/api/v1/merchant/auth/forgot-password').send({ email: 'z@test.io' })).status).toBe(429); // 6e requete IP
  });

  test('POST /merchant/terminals/pair : 10 / 15 min / IP', async () => {
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await request(app).post('/api/v1/merchant/terminals/pair').send({ pairingCode: '123456', androidId: 'a' })).status);
    expect(statuses.slice(0, 10).every(s => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  test('partners : verrouillage apres 10 echecs (423), puis rate limit IP 10 / 15 min (429)', async () => {
    db.bankUser.failed_attempts = 9;
    const fail = await request(app).post('/api/v1/partners/auth/login').send({ email: 'bank@test.io', password: 'nope' });
    expect(fail.status).toBe(401);
    expect(db.bankUser.failed_attempts).toBe(10);
    expect(db.bankUser.locked_until).toBeInstanceOf(Date);
    const locked = await request(app).post('/api/v1/partners/auth/login').send({ email: 'bank@test.io', password: PWD });
    expect(locked.status).toBe(423);
    // rate limit IP : au plus 10 requetes par fenetre (2 deja consommees)
    const statuses = [];
    for (let i = 0; i < 10; i++) statuses.push((await request(app).post('/api/v1/partners/auth/login').send({ email: 'bank@test.io', password: 'nope' })).status);
    expect(statuses).toContain(429);
    expect(statuses.slice(statuses.indexOf(429)).every(s => s === 429)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('5. Middlewares et secrets', () => {
  test('iss/aud obligatoires ; type controle ; cardholderAuth pose req.chId ; partnerAuth refuse les autres types', async () => {
    const noIss = jwt.sign({ sub: 'mu-1', type: 'merchant', merchantId: MERCHANT_ID }, process.env.JWT_SECRET, { expiresIn: '15m' });
    expect((await request(app).get('/api/v1/merchant/auth/me').set(bearer(noIss))).status).toBe(401);
    const badAud = jwt.sign({ sub: 'mu-1', type: 'merchant' }, process.env.JWT_SECRET, { expiresIn: '15m', issuer: auth.JWT_ISSUER, audience: 'other' });
    expect((await request(app).get('/api/v1/merchant/auth/me').set(bearer(badAud))).status).toBe(401);
    const adminTok = auth.signToken({ sub: 'ad-1', type: 'admin', role: 'super_admin' });
    expect((await request(app).get('/api/v1/merchant/auth/me').set(bearer(adminTok))).status).toBe(403);
    // partnerAuth : un JWT distribution (role bank_admin mais type distribution) est refuse
    const dist = auth.signToken({ sub: 'du-1', type: 'distribution', role: 'bank_admin', bankId: 'b1' });
    expect((await request(app).get('/api/v1/partners/auth/me').set(bearer(dist))).status).toBe(403);
    // card2momo : un JWT marchand n'est plus accepte (l'ancien cardAuth acceptait tout JWT signe)
    const merchantTok = auth.signToken({ sub: 'mu-1', type: 'merchant', merchantId: MERCHANT_ID });
    expect((await request(app).get('/api/v1/transfers/x/status').set(bearer(merchantTok))).status).toBe(403);
    // cardholderAuth : req.chId = sub
    const r = express();
    r.get('/t', auth.cardholderAuth, (req, res) => res.json({ chId: req.chId, same: req.cardholder === req.user }));
    const chTok = auth.signToken({ sub: 'ch-1', type: 'cardholder', cardId: 'card-1' });
    const t = await request(r).get('/t').set(bearer(chTok));
    expect(t.body).toEqual({ chId: 'ch-1', same: true });
    expect((await request(r).get('/t').set(bearer(auth.signToken({ type: 'cardholder' })))).status).toBe(403);
  });

  test('PUT /admin/api-configs/:key chiffre apiKey / apiSecret / extraParams via encryptConfigPatch', async () => {
    const tok = auth.signToken({ sub: 'ad-1', type: 'admin', role: 'super_admin', email: 'admin@test.io' });
    const r = await request(app).put('/api/v1/admin/api-configs/mtn_momo_cg').set(bearer(tok))
      .send({ apiKey: 'K', apiSecret: 'S', extraParams: { subKey: 'X' }, baseUrl: 'https://x' });
    expect(r.status).toBe(200);
    expect(mockEncrypt).toHaveBeenCalledWith({ apiKey: 'K', apiSecret: 'S', extraParams: { subKey: 'X' } });
    const params = db.apiConfigUpdates[0];
    expect(params[1]).toBe('enc:K');
    expect(params[2]).toBe('enc:S');
    expect(JSON.parse(params[3])).toEqual({ subKey: 'enc:X' });
    expect(JSON.stringify(db.apiConfigUpdates)).not.toMatch(/"K"|"S"|"X"/);
    // sans secret dans le corps : pas d'appel au chiffrement
    mockEncrypt.mockClear();
    expect((await request(app).put('/api/v1/admin/api-configs/mtn_momo_cg').set(bearer(tok)).send({ notes: 'n' })).status).toBe(200);
    expect(mockEncrypt).not.toHaveBeenCalled();
  });

  test('aucune implementation JWT locale : jwt.verify( / jwt.sign( uniquement dans middleware/auth.js', () => {
    const root = path.resolve(__dirname, '..');
    const files = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'tests' && e.name !== 'node_modules') walk(p); }
      else if (p.endsWith('.js')) files.push(p);
    });
    walk(root);
    const offenders = files.filter(f => /jwt\.(verify|sign)\(/.test(fs.readFileSync(f, 'utf8')))
      .map(f => path.relative(root, f));
    expect(offenders).toEqual(['middleware/auth.js']);
    // et plus aucun `jsonwebtoken` importe dans les routes
    const routeImports = files.filter(f => f.includes(`${path.sep}routes${path.sep}`) && /require\(['"]jsonwebtoken['"]\)/.test(fs.readFileSync(f, 'utf8')));
    expect(routeImports).toEqual([]);
  });
});
