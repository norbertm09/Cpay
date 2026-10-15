'use strict';
// ================================================================
// HOTFIX P0 wave 1 — tests supertest (DB stubée)
// Couvre : IDOR cartes virtuelles / GTP, 410 FEATURE_DISABLED, réponse
// après COMMIT, scoping tickets, pagination bornée, 2FA partenaires.
// ================================================================

process.env.JWT_SECRET = process.env.JWT_SECRET || 'hotfix-test-secret';
process.env.NODE_ENV   = 'test';

jest.mock('../config/database', () => ({
  query: jest.fn(),
  withTransaction: jest.fn(),
  pool: {},
}));
jest.mock('../services/rails/gtp.client', () => ({
  isConfigured: () => true,
  callSoap: jest.fn(),
  tagAll: () => [],
  parseFlat: () => ({}),
}));
jest.mock('../services/transfer/transfer.service', () => ({
  initiate: jest.fn(),
  getStatus: jest.fn(),
}));
jest.mock('../services/notifications/email.service', () => ({
  send: jest.fn().mockResolvedValue(true),
}));

const express   = require('express');
const request   = require('supertest');
const jwt       = require('jsonwebtoken');
const bcrypt    = require('bcryptjs');
const speakeasy = require('speakeasy');

const db        = require('../config/database');
const gtpClient = require('../services/rails/gtp.client');

const cardholderRouter = require('../routes/cardholder.routes');
const gtpRouter        = require('../routes/gtp-card.routes');
const partnersRouter   = require('../routes/partners.routes');

const app = express();
app.use(express.json());
app.use('/api/v1/cardholder', cardholderRouter);
app.use('/api/v1/cardholder/gtp', gtpRouter);
app.use('/api/v1/partners', partnersRouter);

// ─── Fixtures ────────────────────────────────────────────────────
const OWNER      = '11111111-1111-4111-8111-111111111111';
const OTHER      = '22222222-2222-4222-8222-222222222222';
const CARD_OWNER = 'card-owner';
const CARD_OTHER = 'card-other';
const PIN_HASH   = bcrypt.hashSync('1234', 4);

const cards = {
  [CARD_OWNER]: { card_id: CARD_OWNER, cardholder_id: OWNER, status: 'active', balance: '5000', currency: 'XAF', pin_hash: PIN_HASH },
  [CARD_OTHER]: { card_id: CARD_OTHER, cardholder_id: OTHER, status: 'active', balance: '5000', currency: 'XAF', pin_hash: PIN_HASH },
};
const gtpCards = { 500: { gtp_card_id: 500, cardholder_id: OWNER, last4: '1234', status: 'active' },
                   600: { gtp_card_id: 600, cardholder_id: OTHER, last4: '9999', status: 'active' } };
const tickets  = { 't-owner': { ticket_id: 't-owner', cardholder_id: OWNER, subject: 'x' },
                   't-other': { ticket_id: 't-other', cardholder_id: OTHER, subject: 'y' } };

// WAVE-2 : les access tokens portent iss/aud (middleware/auth.js) — on signe via le module commun
const { signToken } = require('../middleware/auth');
// Mot de passe de fixture généré à l'exécution (rien de codé en dur)
const TEST_PASSWORD = 'Aa1!' + require('crypto').randomBytes(8).toString('hex');
const chToken = (sub = OWNER, cardId = CARD_OWNER, type = 'cardholder') =>
  'Bearer ' + signToken({ sub, cardId, type, email: 'o@c-pay.test' }, '1h');

// Stub SQL minimal : émule le scoping propriétaire des tables sensibles.
// Il vérifie aussi qu'aucune requête ne réintroduit `cardholder_id IS NULL`.
const sqlLog = [];
const fakeQuery = async (sql, params = []) => {
  sqlLog.push({ sql, params });
  expect(sql).not.toMatch(/cardholder_id\s+IS\s+NULL/i);

  if (/FROM virtual_cards/i.test(sql) && /card_id=\$1/.test(sql)) {
    const c = cards[params[0]];
    if (!c) return { rows: [] };
    if (/cardholder_id=\$2/.test(sql) && c.cardholder_id !== params[1]) return { rows: [] };
    return { rows: [{ ...c }] };
  }
  if (/UPDATE virtual_cards SET balance = balance - \$1/i.test(sql)) {
    const c = cards[params[1]];
    if (!c || c.cardholder_id !== params[2] || parseFloat(c.balance) < params[0]) return { rows: [] };
    return { rows: [{ balance: String(parseFloat(c.balance) - params[0]) }] };
  }
  if (/FROM gtp_cards/i.test(sql)) {
    const g = gtpCards[params[0]];
    if (!g) return { rows: [] };
    if (/cardholder_id=\$2/.test(sql) && g.cardholder_id !== params[1]) return { rows: [] };
    return { rows: [{ ...g }] };
  }
  if (/FROM support_tickets/i.test(sql)) {
    const t = tickets[params[0]];
    if (!t) return { rows: [] };
    if (/cardholder_id=\$2/.test(sql) && t.cardholder_id !== params[1]) return { rows: [] };
    return { rows: [{ ...t }] };
  }
  if (/INSERT INTO card_transactions/i.test(sql)) return { rows: [{ txn_id: 'txn-1', amount: params[3], fee_amount: params[4], status: 'completed', auth_code: params[6] }] };
  if (/SELECT COUNT\(\*\)/i.test(sql)) return { rows: [{ count: '0' }] };
  if (/FROM cardholders/i.test(sql)) return { rows: [{ phone: '242060000000', email: 'o@c-pay.test', first_name: 'O' }] };
  return { rows: [] };
};

beforeEach(() => {
  sqlLog.length = 0;
  db.query.mockReset();
  db.withTransaction.mockReset();
  gtpClient.callSoap.mockReset();
  db.query.mockImplementation(fakeQuery);
  // Transaction "normale" : exécute fn(client) puis COMMIT
  db.withTransaction.mockImplementation(async (fn) => fn({ query: fakeQuery }));
});

// ================================================================
// 1. IDOR cartes virtuelles
// ================================================================
describe('IDOR cartes virtuelles (cardholder.routes)', () => {
  test('POST /card/pin sur la carte d un autre porteur → 404', async () => {
    const r = await request(app).post('/api/v1/cardholder/card/pin')
      .set('Authorization', chToken()).send({ cardId: CARD_OTHER, pin: '4321' });
    expect(r.status).toBe(404);
    expect(sqlLog.some(q => /UPDATE virtual_cards SET pin_hash/i.test(q.sql))).toBe(false);
  });

  test('POST /card/pin sur sa propre carte → 200 et UPDATE scopé au porteur', async () => {
    const r = await request(app).post('/api/v1/cardholder/card/pin')
      .set('Authorization', chToken()).send({ cardId: CARD_OWNER, currentPin: '1234', newPin: '4321' });
    expect(r.status).toBe(200);
    const upd = sqlLog.find(q => /UPDATE virtual_cards SET pin_hash/i.test(q.sql));
    expect(upd.sql).toMatch(/cardholder_id=\$3/);
    expect(upd.params[2]).toBe(OWNER);
  });

  test('POST /payment/tokenized (cas 1) avec la carte d un autre porteur → 404, aucun débit', async () => {
    const r = await request(app).post('/api/v1/cardholder/payment/tokenized')
      .set('Authorization', chToken()).send({ cardId: CARD_OTHER, amount: 100, pin: '1234' });
    expect(r.status).toBe(404);
    expect(sqlLog.some(q => /UPDATE virtual_cards SET balance/i.test(q.sql))).toBe(false);
  });

  test('POST /payment/tokenized (cas 1) : SELECT ... FOR UPDATE dans une transaction, débit conditionnel', async () => {
    const r = await request(app).post('/api/v1/cardholder/payment/tokenized')
      .set('Authorization', chToken()).send({ cardId: CARD_OWNER, amount: 100, pin: '1234' });
    expect(r.status).toBe(200);
    expect(r.body.paymentSource).toBe('created_card');
    expect(db.withTransaction).toHaveBeenCalledTimes(1);
    const sel = sqlLog.find(q => /FROM virtual_cards/i.test(q.sql));
    expect(sel.sql).toMatch(/FOR UPDATE/);
    const upd = sqlLog.find(q => /UPDATE virtual_cards SET balance = balance - \$1/i.test(q.sql));
    expect(upd.sql).toMatch(/balance >= \$1/);
  });

  test('POST /payment/tokenized (cas 1) : solde insuffisant → 422', async () => {
    const r = await request(app).post('/api/v1/cardholder/payment/tokenized')
      .set('Authorization', chToken()).send({ cardId: CARD_OWNER, amount: 999999, pin: '1234' });
    expect(r.status).toBe(422);
  });

  test('GET /support/tickets/:id d un autre porteur → 404 ; POST messages → 404', async () => {
    const r1 = await request(app).get('/api/v1/cardholder/support/tickets/t-other').set('Authorization', chToken());
    expect(r1.status).toBe(404);
    const r2 = await request(app).post('/api/v1/cardholder/support/tickets/t-other/messages')
      .set('Authorization', chToken()).send({ message: 'hi' });
    expect(r2.status).toBe(404);
    expect(sqlLog.some(q => /INSERT INTO ticket_messages/i.test(q.sql))).toBe(false);
    const r3 = await request(app).get('/api/v1/cardholder/support/tickets/t-owner').set('Authorization', chToken());
    expect(r3.status).toBe(200);
  });

  test('GET /transactions : limit borné à [1,100], page ≥ 1', async () => {
    await request(app).get('/api/v1/cardholder/transactions?page=0&limit=5000').set('Authorization', chToken());
    const q = sqlLog.find(x => /FROM card_transactions WHERE/i.test(x.sql) && /LIMIT/i.test(x.sql));
    expect(q.params.slice(-2)).toEqual([100, 0]);
  });
});

// ================================================================
// 2. 410 FEATURE_DISABLED (création de monnaie sans mouvement réel)
// ================================================================
describe('Endpoints désactivés (410 FEATURE_DISABLED)', () => {
  const expect410 = (r) => {
    expect(r.status).toBe(410);
    expect(r.body.code).toBe('FEATURE_DISABLED');
    expect(db.withTransaction).not.toHaveBeenCalled();
    expect(sqlLog.filter(q => /INSERT|UPDATE/i.test(q.sql))).toHaveLength(0);
  };

  test('POST /cardholder/topup → 410 sans écriture DB', async () => {
    expect410(await request(app).post('/api/v1/cardholder/topup')
      .set('Authorization', chToken()).send({ amount: 1000, operator: 'mtn', phone: '242060000000' }));
  });

  test('POST /cardholder/unload → 410 sans écriture DB', async () => {
    expect410(await request(app).post('/api/v1/cardholder/unload')
      .set('Authorization', chToken()).send({ amount: 1000, operator: 'mtn', phone: '242060000000', pin: '1234' }));
  });

  test('POST /cardholder/payment/tokenized (cas 2 carte enrôlée) → 410', async () => {
    expect410(await request(app).post('/api/v1/cardholder/payment/tokenized')
      .set('Authorization', chToken()).send({ enrollmentId: 'enr-1', amount: 100, pin: '1234' }));
  });

  const agentToken = 'Bearer ' + signToken({ sub: 'ag-1', role: 'agent', type: 'agent', agentId: 'ag-1', bankId: 'b1', agencyId: 'a1', email: 'ag@x' });

  test('POST /partners/collect → 410', async () => {
    expect410(await request(app).post('/api/v1/partners/collect')
      .set('Authorization', agentToken).send({ amount: 1000, customerPhone: '242060000000', method: 'cash' }));
  });

  test('POST /partners/disburse → 410', async () => {
    expect410(await request(app).post('/api/v1/partners/disburse')
      .set('Authorization', agentToken).send({ amount: 1000, recipientPhone: '242060000000', method: 'cash' }));
  });
});

// ================================================================
// 3. Inscription : réponse après COMMIT, carte rattachée au porteur
// ================================================================
describe('POST /auth/register', () => {
  const body = { firstName: 'Ana', lastName: 'Doe', phone: '242060000001', email: 'ana@c-pay.test', password: TEST_PASSWORD };

  test('répond 201 seulement après COMMIT et renseigne virtual_cards.cardholder_id', async () => {
    const events = [];
    db.withTransaction.mockImplementation(async (fn) => {
      events.push('BEGIN');
      const out = await fn({ query: async (sql, params) => { events.push(sql.slice(0, 30)); return fakeQuery(sql, params); } });
      events.push('COMMIT');
      return out;
    });
    const r = await request(app).post('/api/v1/cardholder/auth/register').send(body);
    expect(r.status).toBe(201);
    expect(r.body.access_token).toBeTruthy();
    expect(events[0]).toBe('BEGIN');
    expect(events[events.length - 1]).toBe('COMMIT');

    const insCard = sqlLog.find(q => /INSERT INTO virtual_cards/i.test(q.sql));
    const insCh   = sqlLog.find(q => /INSERT INTO cardholders/i.test(q.sql));
    expect(insCard.sql).toMatch(/\(card_id,cardholder_id,/);
    expect(insCard.params[1]).toBe(insCh.params[0]);         // même cardholder_id
    expect(r.body.cardholder.cardholderId).toBe(insCh.params[0]);
    expect(r.body.card.cardId).toBe(insCard.params[0]);
  });

  test('si le COMMIT échoue, aucune réponse 201 (le JWT n est pas émis avant COMMIT)', async () => {
    db.withTransaction.mockImplementation(async (fn) => {
      await fn({ query: fakeQuery });
      throw new Error('COMMIT failed');            // simule un échec au COMMIT
    });
    const r = await request(app).post('/api/v1/cardholder/auth/register').send(body);
    expect(r.status).toBe(500);
    expect(r.body.access_token).toBeUndefined();
  });
});

// ================================================================
// 4. IDOR cartes GTP
// ================================================================
describe('IDOR cartes GTP (gtp-card.routes)', () => {
  test('cardAuth refuse un JWT non-porteur (type merchant) → 403', async () => {
    const r = await request(app).get('/api/v1/cardholder/gtp/cards/500').set('Authorization', chToken(OWNER, CARD_OWNER, 'merchant'));
    expect(r.status).toBe(403);
  });

  test('GET /cards/:gtpCardId d un autre porteur → 404 sans appel SOAP', async () => {
    const r = await request(app).get('/api/v1/cardholder/gtp/cards/600').set('Authorization', chToken());
    expect(r.status).toBe(404);
    expect(gtpClient.callSoap).not.toHaveBeenCalled();
  });

  test('PATCH /cards/:gtpCardId/freeze, POST /pin, POST /topup d un autre porteur → 404', async () => {
    for (const [m, path, body] of [
      ['patch', '/cards/600/freeze', {}],
      ['post',  '/cards/600/pin', { pin: '1234' }],
      ['post',  '/cards/600/topup', { amount: 1000, operator: 'mtn' }],
      ['delete','/cards/600', {}],
    ]) {
      const r = await request(app)[m]('/api/v1/cardholder/gtp' + path).set('Authorization', chToken()).send(body);
      expect(r.status).toBe(404);
    }
    expect(gtpClient.callSoap).not.toHaveBeenCalled();
  });

  test('le service refuse aussi sans passer par la route (fundTransfer / changePin)', async () => {
    const gtp = require('../services/rails/gtp-card.service');
    await expect(gtp.fundTransfer({ gtpCardId: 600, cardholderId: OWNER, amount: 10, transferType: 'WalletToCard' }))
      .rejects.toMatchObject({ code: 'GTP_CARD_NOT_OWNED' });
    await expect(gtp.changePin(600, '1234', OWNER)).rejects.toMatchObject({ code: 'GTP_CARD_NOT_OWNED' });
    await expect(gtp.freezeCard(500, '242060000000')).rejects.toMatchObject({ code: 'GTP_CARD_NOT_OWNED' }); // owner manquant
    expect(gtpClient.callSoap).not.toHaveBeenCalled();
  });

  test('sa propre carte GTP : freeze passe le contrôle et appelle SOAP', async () => {
    gtpClient.callSoap.mockResolvedValue({ parsed: { Success: 'true' } });
    const r = await request(app).patch('/api/v1/cardholder/gtp/cards/500/freeze').set('Authorization', chToken());
    expect(r.status).toBe(200);
    expect(gtpClient.callSoap).toHaveBeenCalledWith('DeactivateCardRequest', expect.objectContaining({ CustomerID: '500', Last4Digits: '1234' }));
  });
});

// ================================================================
// 5. 2FA partenaires
// ================================================================
describe('2FA partenaires (partners.routes)', () => {
  const SECRET = speakeasy.generateSecret({ length: 20 }).base32;
  const PWD_HASH = bcrypt.hashSync(TEST_PASSWORD, 4);
  const bankUser = { user_id: 'u1', email: 'bank@c-pay.test', first_name: 'B', last_name: 'U', role: 'bank_admin', bank_id: 'b1',
                     agency_id: null, status: 'active', password_hash: PWD_HASH, bank_name: 'Bank', mfa_secret: SECRET, is_mfa_enabled: true };
  const partnerToken = 'Bearer ' + signToken({ sub: 'u1', role: 'bank_admin', type: 'bank_user', bankId: 'b1', agencyId: null, email: bankUser.email });

  const partnersQuery = async (sql, params = []) => {
    sqlLog.push({ sql, params });
    if (/SELECT mfa_secret FROM bank_users/i.test(sql)) return { rows: [{ mfa_secret: SECRET }] };
    if (/FROM bank_users u/i.test(sql)) return { rows: [bankUser] };
    if (/FROM agents a/i.test(sql)) return { rows: [] };
    return { rows: [] };
  };

  beforeEach(() => db.query.mockImplementation(partnersQuery));

  test('POST /auth/2fa/setup : secret base32 + otpauth + QR serveur, stocké sur l utilisateur', async () => {
    const r = await request(app).post('/api/v1/partners/auth/2fa/setup').set('Authorization', partnerToken);
    expect(r.status).toBe(200);
    expect(r.body.secret).toMatch(/^[A-Z2-7]+=*$/);
    expect(r.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(r.body.qrCode).toMatch(/^data:image\/png;base64,/);
    const upd = sqlLog.find(q => /UPDATE bank_users SET mfa_secret=\$1, is_mfa_enabled=FALSE/i.test(q.sql));
    expect(upd.params[0]).toBe(r.body.secret);
    expect(sqlLog.some(q => /admin_notifications/i.test(q.sql))).toBe(false);
  });

  test('POST /auth/2fa/verify refuse un code faux (6 chiffres) → 400', async () => {
    const wrong = String((parseInt(speakeasy.totp({ secret: SECRET, encoding: 'base32' }), 10) + 1) % 1000000).padStart(6, '0');
    const r = await request(app).post('/api/v1/partners/auth/2fa/verify').set('Authorization', partnerToken).send({ token: wrong });
    expect(r.status).toBe(400);
    expect(sqlLog.some(q => /is_mfa_enabled=TRUE/i.test(q.sql))).toBe(false);
  });

  test('POST /auth/2fa/verify accepte un code speakeasy.totp() valide → is_mfa_enabled=TRUE', async () => {
    const code = speakeasy.totp({ secret: SECRET, encoding: 'base32' });
    const r = await request(app).post('/api/v1/partners/auth/2fa/verify').set('Authorization', partnerToken).send({ token: code });
    expect(r.status).toBe(200);
    expect(sqlLog.some(q => /UPDATE bank_users SET is_mfa_enabled=TRUE/i.test(q.sql))).toBe(true);
  });

  test('POST /auth/2fa/verify|disable sans secret ou sans code → 400 (pas de TypeError 500)', async () => {
    db.query.mockImplementation(async (sql) => (/SELECT mfa_secret/i.test(sql) ? { rows: [{ mfa_secret: null }] } : { rows: [] }));
    expect((await request(app).post('/api/v1/partners/auth/2fa/verify').set('Authorization', partnerToken).send({ token: '123456' })).status).toBe(400);
    expect((await request(app).post('/api/v1/partners/auth/2fa/disable').set('Authorization', partnerToken).send({ token: '123456' })).status).toBe(400);
    expect((await request(app).post('/api/v1/partners/auth/2fa/verify').set('Authorization', partnerToken).send({})).status).toBe(400);
  });

  test('login avec 2FA active → { mfaRequired, mfaToken } sans session ; /auth/2fa/validate émet la session', async () => {
    const login = await request(app).post('/api/v1/partners/auth/login').send({ email: bankUser.email, password: TEST_PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.mfaRequired).toBe(true);
    expect(login.body.access_token).toBeUndefined();
    const decoded = jwt.verify(login.body.mfaToken, process.env.JWT_SECRET);
    expect(decoded.type).toBe('partner_mfa');
    expect(decoded.exp - decoded.iat).toBe(300);

    const bad = await request(app).post('/api/v1/partners/auth/2fa/validate').send({ mfaToken: login.body.mfaToken, code: '000000' });
    expect([400, 401]).toContain(bad.status);

    const code = speakeasy.totp({ secret: SECRET, encoding: 'base32' });
    const ok = await request(app).post('/api/v1/partners/auth/2fa/validate').send({ mfaToken: login.body.mfaToken, code });
    expect(ok.status).toBe(200);
    expect(ok.body.access_token).toBeTruthy();
    expect(jwt.verify(ok.body.access_token, process.env.JWT_SECRET).role).toBe('bank_admin');

    // Un access token ordinaire ne peut pas servir de mfaToken
    const forged = await request(app).post('/api/v1/partners/auth/2fa/validate').send({ mfaToken: partnerToken.slice(7), code });
    expect(forged.status).toBe(401);
  });

  test('POST /users/:id/reset-link ne renvoie pas le token et scope :id à la banque', async () => {
    db.query.mockImplementation(async (sql, params = []) => {
      sqlLog.push({ sql, params });
      if (/FROM bank_users WHERE user_id=\$1 AND bank_id=\$2/i.test(sql))
        return params[1] === 'b1' && params[0] === 'u2' ? { rows: [{ user_id: 'u2', email: 'x@y', first_name: 'X' }] } : { rows: [] };
      return { rows: [] };
    });
    const r = await request(app).post('/api/v1/partners/users/u2/reset-link').set('Authorization', partnerToken);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toMatch(/token|resetUrl/);
    const ins = sqlLog.find(q => /INSERT INTO partner_password_resets/i.test(q.sql));
    expect(ins.params[1]).toMatch(/^[a-f0-9]{64}$/);          // hash SHA-256, pas le token brut
    const other = await request(app).post('/api/v1/partners/users/u-other-bank/reset-link').set('Authorization', partnerToken);
    expect(other.status).toBe(404);
  });

  test('PATCH /agents/:id/status hors banque → 404 (scopé bank_id)', async () => {
    db.query.mockImplementation(async (sql, params = []) => { sqlLog.push({ sql, params }); return { rows: [] }; });
    const r = await request(app).patch('/api/v1/partners/agents/ag-x/status').set('Authorization', partnerToken).send({ status: 'suspended' });
    expect(r.status).toBe(404);
    const upd = sqlLog.find(q => /UPDATE agents SET status/i.test(q.sql));
    expect(upd.sql).toMatch(/bank_id=\$3/);
    expect(upd.params[2]).toBe('b1');
  });

  test('POST /users : mot de passe temporaire aléatoire, renvoyé une fois, jamais en clair en DB', async () => {
    db.query.mockImplementation(async (sql, params = []) => { sqlLog.push({ sql, params }); return { rows: [{ user_id: 'u9', email: 'n@x', role: 'bank_user' }] }; });
    const r = await request(app).post('/api/v1/partners/users').set('Authorization', partnerToken)
      .send({ firstName: 'N', email: 'n@x', role: 'bank_user' });
    expect(r.status).toBe(201);
    expect(r.body.tempPassword).toMatch(/^User@[A-Za-z0-9_-]{8}$/);
    const ins = sqlLog.find(q => /INSERT INTO bank_users/i.test(q.sql));
    expect(ins.params).not.toContain(r.body.tempPassword);
    expect(bcrypt.compareSync(r.body.tempPassword, ins.params[6])).toBe(true);
    expect(sqlLog.some(q => /admin_notifications/i.test(q.sql))).toBe(false);
  });
});
