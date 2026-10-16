#!/usr/bin/env node
/*
 * Serveur d'API factice pour le portail porteur (developpement / captures d'ecran).
 * Node pur, sans dependance. Lancer : node dev/mock-api.js  (port 4011)
 * puis le portail avec REACT_APP_API_BASE_URL=http://127.0.0.1:4011.
 *
 * Comptes :
 *   demo@c-pay.global / Demo1234      -> connexion simple
 *   mfa@c-pay.global  / Demo1234      -> 2FA (code 123456)
 *   temp@c-pay.global / Temp1234      -> mot de passe temporaire (changement force)
 * Code PIN des cartes : 1234.
 * Variables : PORT (4011), MOCK_GTP=1 (service cartes reseau actif), MOCK_CONSENT=0 (modale CGU).
 */
'use strict';
const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT, 10) || 4011;
const GTP_ON = process.env.MOCK_GTP === '1';
const CONSENTED = process.env.MOCK_CONSENT !== '0';
const PIN = '1234';
const MFA_CODE = '123456';

// ─── Donnees ──────────────────────────────────────────────────────
const uuid = () => crypto.randomUUID();
const daysAgo = (d, h = 10, m = 0) => { const x = new Date(); x.setDate(x.getDate() - d); x.setHours(h, m, 0, 0); return x.toISOString(); };

const users = {
  demo: { id: 'ch-demo-0001', cardId: 'card-demo-0001', firstName: 'Aïcha', lastName: 'Ndongo', email: 'demo@c-pay.global', phone: '+237670000001', password: 'Demo1234', mfa: false, temp: false, kycLevel: 1, address: 'Rue 1.234, Bastos', city: 'Yaoundé' },
  mfa: { id: 'ch-demo-0002', cardId: 'card-demo-0002', firstName: 'Serge', lastName: 'Mbarga', email: 'mfa@c-pay.global', phone: '+237670000002', password: 'Demo1234', mfa: true, temp: false, kycLevel: 2, address: 'Akwa', city: 'Douala' },
  temp: { id: 'ch-demo-0003', cardId: 'card-demo-0003', firstName: 'Nadia', lastName: 'Essomba', email: 'temp@c-pay.global', phone: '+237670000003', password: 'Temp1234', mfa: false, temp: true, kycLevel: 1, address: '', city: '' },
};
const cards = {};
Object.values(users).forEach((u, i) => {
  cards[u.cardId] = { card_id: u.cardId, cardholder_id: u.id, card_masked: `4000 **** **** ${7821 + i}`, cardholder_name: `${u.firstName} ${u.lastName}`.toUpperCase(), balance: [184500, 52300, 0][i], currency: 'XAF', status: 'active', expiry_month: 12, expiry_year: 2028, network: 'visa', daily_limit: 500000, monthly_limit: 2000000, label: 'Carte principale' };
});
cards['card-demo-0001b'] = { card_id: 'card-demo-0001b', cardholder_id: 'ch-demo-0001', card_masked: '4000 **** **** 3309', cardholder_name: 'AÏCHA NDONGO', balance: 12000, currency: 'XAF', status: 'frozen', expiry_month: 9, expiry_year: 2027, network: 'visa', daily_limit: 200000, monthly_limit: 1000000, label: 'Achats en ligne' };

const MERCHANTS = [['m-001', 'Boulangerie du Centre'], ['m-002', 'Pharmacie Bastos'], ['m-003', 'Supermarché Mahima'], ['m-004', 'Station Total Melen'], ['m-005', 'Restaurant Le Biniou'], ['m-006', 'Taxi Yango']];
const txns = [];
const mkTxn = (cardId, chId, t) => {
  const row = { txn_id: uuid(), card_id: cardId, cardholder_id: chId, currency: 'XAF', status: 'completed', description: null, merchant_name: null, merchant_id: null, auth_code: null, mobile_money_op: null, mobile_money_phone: null, mm_reference: null, fee: 0, net_amount: 0, balance_before: 0, balance_after: 0, completed_at: null, ...t };
  if (!row.completed_at && row.status === 'completed') row.completed_at = row.initiated_at;
  txns.push(row);
  return row;
};
(() => {
  const u = users.demo; let bal = 60000; let d = 44;
  const seq = [
    ['topup', 100000, 'mtn'], ['payment', 4500, 0], ['payment', 12300, 2], ['payment', 2000, 5], ['payment', 8900, 1], ['payment', 35000, 3],
    ['topup', 50000, 'orange'], ['payment', 1500, 0], ['payment', 6700, 4], ['refund', 6700, 4], ['payment', 22000, 2], ['payment', 3000, 5],
    ['payment', 15000, 1], ['topup', 75000, 'mtn'], ['payment', 9800, 2], ['failed', 25000, 3], ['payment', 25000, 3], ['payment', 1200, 0],
    ['payment', 48000, 2], ['payment', 2500, 5], ['topup', 100000, 'mtn'], ['payment', 7800, 4], ['payment', 3400, 0], ['payment', 18500, 1],
    ['payment', 2000, 5], ['payment', 11000, 2],
  ];
  seq.forEach(([kind, amount, extra], i) => {
    d -= Math.max(1, Math.round(44 / seq.length)); const when = daysAgo(Math.max(0, d), 8 + (i % 10), (i * 7) % 60);
    if (kind === 'topup') { const fee = Math.round(amount * 0.01); const before = bal; bal += amount - fee; mkTxn(u.cardId, u.id, { type: 'topup', amount, fee, net_amount: amount - fee, balance_before: before, balance_after: bal, description: `Top-up via ${extra.toUpperCase()}`, mobile_money_op: extra, mobile_money_phone: u.phone, mm_reference: `MM${extra.toUpperCase()}${1700000000 + i * 9137}`, initiated_at: when }); }
    else if (kind === 'payment') { const fee = Math.round(amount * 0.005); const before = bal; bal -= amount + fee; const [mid, name] = MERCHANTS[extra]; mkTxn(u.cardId, u.id, { type: 'payment', amount, fee, net_amount: amount - fee, balance_before: before, balance_after: bal, merchant_id: mid, merchant_name: name, auth_code: crypto.randomBytes(3).toString('hex').toUpperCase(), initiated_at: when }); }
    else if (kind === 'refund') { const before = bal; bal += amount; const [mid, name] = MERCHANTS[extra]; mkTxn(u.cardId, u.id, { type: 'refund', amount, balance_before: before, balance_after: bal, merchant_id: mid, merchant_name: name, description: 'Remboursement commerçant', initiated_at: when }); }
    else if (kind === 'failed') { const [mid, name] = MERCHANTS[extra]; mkTxn(u.cardId, u.id, { type: 'payment', amount, fee: 0, status: 'failed', merchant_id: mid, merchant_name: name, failure_reason: 'PIN incorrect', balance_before: bal, balance_after: bal, initiated_at: when }); }
  });
  cards[u.cardId].balance = bal;
  const m = users.mfa;
  mkTxn(m.cardId, m.id, { type: 'topup', amount: 60000, fee: 600, net_amount: 59400, balance_before: 0, balance_after: 59400, description: 'Top-up via MTN', mobile_money_op: 'mtn', mobile_money_phone: m.phone, mm_reference: 'MMMTN1700009999', initiated_at: daysAgo(12) });
  mkTxn(m.cardId, m.id, { type: 'payment', amount: 7100, fee: 36, net_amount: 7064, balance_before: 59400, balance_after: 52264, merchant_id: 'm-002', merchant_name: 'Pharmacie Bastos', auth_code: 'A1B2C3', initiated_at: daysAgo(3, 18, 42) });
})();

const claims = [
  { claim_id: uuid(), claim_ref: 'REC-7F3K2Q', cardholder_id: 'ch-demo-0001', claim_type: 'unrecognized_transaction', description: 'Paiement de 25 000 XAF chez Station Total Melen que je ne reconnais pas, je n’étais pas sur place ce jour-là.', status: 'in_progress', txn_amount: 25000, opened_at: daysAgo(6, 14) },
  { claim_id: uuid(), claim_ref: 'REC-2BD9XA', cardholder_id: 'ch-demo-0001', claim_type: 'card_issue', description: 'Ma carte secondaire est gelée depuis la semaine dernière et je ne parviens pas à la réactiver.', status: 'resolved', txn_amount: null, opened_at: daysAgo(20, 9) },
];
const tickets = [
  { ticket_id: 'tk-1', ticket_number: 'TKT-CH4F8A2Q', cardholder_id: 'ch-demo-0001', subject: 'Plafond journalier', category: 'card', priority: 'normal', status: 'pending_customer', description: 'Bonjour, est-il possible d’augmenter mon plafond journalier à 1 000 000 XAF ?', created_at: daysAgo(4, 11), updated_at: daysAgo(3, 16),
    messages: [
      { message_id: 'm1', sender_type: 'merchant', sender_name: 'Aïcha Ndongo', message: 'Bonjour, est-il possible d’augmenter mon plafond journalier à 1 000 000 XAF ?', created_at: daysAgo(4, 11) },
      { message_id: 'm2', sender_type: 'admin', sender_name: 'Support C-Pay', message: 'Bonjour Aïcha, oui dès validation de votre niveau 2 (justificatif de domicile). Souhaitez-vous que nous lancions la demande ?', created_at: daysAgo(3, 16) },
    ] },
];
const kycDocs = [
  { doc_id: 'd1', cardholder_id: 'ch-demo-0001', doc_type: 'id_card', doc_label: 'Pièce d’identité', file_name: 'cni-recto-verso.pdf', status: 'approved', rejection_reason: null, uploaded_at: daysAgo(30), reviewed_at: daysAgo(28) },
  { doc_id: 'd2', cardholder_id: 'ch-demo-0001', doc_type: 'address_proof', doc_label: 'Justificatif de domicile', file_name: 'facture-eneo.jpg', status: 'rejected', rejection_reason: 'Document de plus de 3 mois', uploaded_at: daysAgo(10), reviewed_at: daysAgo(9) },
];
const events = [
  { event_type: 'AUTH_SUCCESS', success: true, ip_address: '41.202.219.14', created_at: daysAgo(0, 8, 12) },
  { event_type: 'AUTH_FAILURE', success: false, ip_address: '41.202.219.14', created_at: daysAgo(1, 21, 3) },
  { event_type: 'AUTH_SUCCESS', success: true, ip_address: '154.72.160.9', created_at: daysAgo(2, 12, 40) },
  { event_type: 'AUTH_LOGOUT', success: true, ip_address: '154.72.160.9', created_at: daysAgo(2, 13, 5) },
];
const enrolled = [{ enrollment_id: 'enr-1', cardholder_id: 'ch-demo-0001', card_masked: '5412 **** **** 9001', cardholder_name: 'AICHA NDONGO', network: 'mastercard', expiry_month: 6, expiry_year: 2027, is_default: true, status: 'active' }];
const gtpCards = [{ gtp_card_id: 10234567, cardholder_id: 'ch-demo-0001', cardMasked: '5355 **** **** 4421', last4: '4421', cardholderName: 'Aïcha Ndongo', status: 'active', balance: 32500, currency: 'XAF' }];
const consents = new Set(CONSENTED ? Object.values(users).map((u) => u.id) : []);
const mfaTokens = new Map();
const refreshTokens = new Map(); // token -> userKey
const emailTokens = new Map([['demo-verify-token', 'demo']]);
const resetTokens = new Map([['demo-reset-token', 'demo']]);

// ─── Utilitaires HTTP ─────────────────────────────────────────────
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const signJwt = (u) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: u.id, type: 'cardholder', cardId: u.cardId, email: u.email, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 15 * 60 })}.${crypto.randomBytes(16).toString('base64url')}`;
const readJwt = (req) => {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  try { const p = JSON.parse(Buffer.from(h.slice(7).split('.')[1], 'base64url').toString()); if (p.exp * 1000 < Date.now()) return null; return Object.values(users).find((u) => u.id === p.sub) || null; } catch (e) { return null; }
};
const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x[0]));
const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { resolve({}); } }); });
const profile = (u) => ({ cardholderId: u.id, firstName: u.firstName, lastName: u.lastName, email: u.email, phone: u.phone, kycLevel: u.kycLevel, mfaEnabled: u.mfa });
const summary = (c) => ({ cardId: c.card_id, cardMasked: c.card_masked, cardholderName: c.cardholder_name, balance: c.balance, currency: c.currency, status: c.status, expiryMonth: c.expiry_month, expiryYear: c.expiry_year, network: c.network, dailyLimit: c.daily_limit, monthlyLimit: c.monthly_limit, label: c.label });
const session = (res, u, status = 200) => {
  const rt = crypto.randomBytes(24).toString('hex'); refreshTokens.set(rt, u);
  json(res, status, { access_token: signJwt(u), refresh_token: rt, expires_in: 900, mustChangePassword: u.temp, cardholder: profile(u), card: summary(cards[u.cardId]) },
    { 'Set-Cookie': `cp_rt_cardholder=${rt}; Path=/api/v1/cardholder/auth; HttpOnly; SameSite=Lax; Max-Age=604800` });
};
const DISABLED = (res) => json(res, 410, { error: 'Fonctionnalité désactivée en attendant l’intégration opérateur', code: 'FEATURE_DISABLED' });

// ─── Routeur ──────────────────────────────────────────────────────
const routes = [];
const on = (method, pattern, handler, auth = true) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler, auth });

on('POST', '/api/v1/cardholder/auth/login', async (req, res, b) => {
  const u = Object.values(users).find((x) => x.email === String(b.emailOrPhone || '').trim().toLowerCase() || x.phone === String(b.emailOrPhone || '').replace(/\s/g, ''));
  if (!u || u.password !== b.password) return json(res, 401, { error: 'Identifiants incorrects', attemptsLeft: 4 });
  if (u.mfa) { const t = crypto.randomBytes(12).toString('hex'); mfaTokens.set(t, u); return json(res, 200, { mfaRequired: true, mfaToken: t }); }
  session(res, u);
}, false);
on('POST', '/api/v1/cardholder/auth/2fa/validate', async (req, res, b) => {
  const u = mfaTokens.get(b.mfaToken);
  if (!u) return json(res, 401, { error: 'Jeton MFA invalide ou expiré', code: 'INVALID_MFA_TOKEN' });
  if (b.code !== MFA_CODE) return json(res, 401, { error: 'Code 2FA invalide', code: 'INVALID_TOTP' });
  mfaTokens.delete(b.mfaToken); session(res, u);
}, false);
on('POST', '/api/v1/cardholder/auth/refresh', async (req, res) => {
  const rt = cookies(req).cp_rt_cardholder; const u = refreshTokens.get(rt);
  if (!u) return json(res, 401, { error: 'Refresh token invalide', code: 'INVALID_REFRESH' });
  refreshTokens.delete(rt); session(res, u);
}, false);
on('POST', '/api/v1/cardholder/auth/register', async (req, res, b) => {
  if (!b.firstName || !b.lastName || !b.phone || !b.email || !b.password) return json(res, 422, { error: 'Champs requis : prénom, nom, téléphone, email, mot de passe' });
  if (Object.values(users).some((u) => u.email === b.email)) return json(res, 409, { error: 'Email ou téléphone déjà utilisé', code: 'DUPLICATE' });
  const key = `u${Date.now()}`; const id = uuid(); const cardId = uuid(); const last4 = String(1000 + Math.floor(Math.random() * 9000));
  users[key] = { id, cardId, firstName: b.firstName, lastName: b.lastName, email: b.email, phone: b.phone, password: b.password, mfa: false, temp: false, kycLevel: 1, address: '', city: '' };
  cards[cardId] = { card_id: cardId, cardholder_id: id, card_masked: `4000 **** **** ${last4}`, cardholder_name: `${b.firstName} ${b.lastName}`.toUpperCase(), balance: 0, currency: 'XAF', status: 'active', expiry_month: 12, expiry_year: new Date().getFullYear() + 3, network: 'visa', daily_limit: 100000, monthly_limit: 500000, label: 'Carte principale' };
  if (CONSENTED) consents.add(id);
  session(res, users[key], 201);
}, false);
on('GET', '/api/v1/cardholder/auth/verify-email', async (req, res, b, q) => {
  const k = emailTokens.get(q.get('token')); if (!k) return json(res, 400, { error: 'Lien invalide ou deja utilise', code: 'INVALID_TOKEN' });
  emailTokens.delete(q.get('token')); json(res, 200, { success: true, email: users[k].email });
}, false);
on('POST', '/api/v1/cardholder/auth/forgot-password', async (req, res) => json(res, 200, { success: true, message: 'Si cet email existe, un lien de réinitialisation a été envoyé.' }), false);
on('POST', '/api/v1/cardholder/auth/reset-password', async (req, res, b) => {
  const k = resetTokens.get(b.token); if (!k) return json(res, 400, { error: 'Lien invalide ou expiré', code: 'INVALID_TOKEN' });
  if (!/[A-Z]/.test(b.newPassword || '') || !/[a-z]/.test(b.newPassword || '') || !/[0-9]/.test(b.newPassword || '') || b.newPassword.length < 8) return json(res, 422, { error: 'Le mot de passe doit contenir majuscule, minuscule et chiffre' });
  users[k].password = b.newPassword; users[k].temp = false; resetTokens.delete(b.token); json(res, 200, { success: true, sessionsRevoked: true });
}, false);

on('GET', '/api/v1/cardholder/auth/me', async (req, res, b, q, u) => json(res, 200, { cardholder: profile(u), card: summary(cards[u.cardId]), mustChangePassword: u.temp }));
on('POST', '/api/v1/cardholder/auth/logout', async (req, res) => { refreshTokens.delete(cookies(req).cp_rt_cardholder); json(res, 200, { success: true }, { 'Set-Cookie': 'cp_rt_cardholder=; Path=/api/v1/cardholder/auth; Max-Age=0' }); });
on('POST', '/api/v1/cardholder/auth/resend-verification', async (req, res, b, q, u) => json(res, 200, { success: true, alreadyVerified: u.email === 'mfa@c-pay.global' }));
const changePwd = async (req, res, b, q, u) => {
  if (!b.currentPassword || !b.newPassword) return json(res, 422, { error: 'Champs requis' });
  if (b.currentPassword !== u.password) return json(res, 401, { error: 'Mot de passe actuel incorrect', code: 'WRONG_PASSWORD' });
  if (b.newPassword.length < 8) return json(res, 422, { error: 'Mot de passe trop court (min 8 car.)' });
  u.password = b.newPassword; u.temp = false; json(res, 200, { success: true, sessionsRevoked: true });
};
on('POST', '/api/v1/cardholder/profile/change-password', changePwd);
on('POST', '/api/v1/cardholder/auth/change-password', changePwd);
on('GET', '/api/v1/cardholder/auth/2fa/status', async (req, res, b, q, u) => json(res, 200, { mfaEnabled: u.mfa, mfaMethod: u.mfa ? 'totp' : null, daysSinceCreation: 4, daysLeft: 6, required: false }));
on('POST', '/api/v1/cardholder/auth/2fa/setup', async (req, res, b, q, u) => {
  u.pendingSecret = 'JBSWY3DPEHPK3PXP';
  const otp = `otpauth://totp/C-Pay:${encodeURIComponent(u.email)}?secret=${u.pendingSecret}&issuer=C-Pay`;
  // QR factice (SVG) : le vrai backend renvoie un PNG en data-URL
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 21 21' shape-rendering='crispEdges'><rect width='21' height='21' fill='#fff'/>${Array.from({ length: 160 }, (_, i) => { const x = (i * 7) % 21; const y = Math.floor((i * 13) / 21) % 21; return ((x * 31 + y * 17 + i) % 3 === 0) ? `<rect x='${x}' y='${y}' width='1' height='1'/>` : ''; }).join('')}<rect x='0' y='0' width='7' height='7'/><rect x='1' y='1' width='5' height='5' fill='#fff'/><rect x='2' y='2' width='3' height='3'/><rect x='14' y='0' width='7' height='7'/><rect x='15' y='1' width='5' height='5' fill='#fff'/><rect x='16' y='2' width='3' height='3'/><rect x='0' y='14' width='7' height='7'/><rect x='1' y='15' width='5' height='5' fill='#fff'/><rect x='2' y='16' width='3' height='3'/></svg>`;
  json(res, 200, { secret: u.pendingSecret, otpauthUrl: otp, qrCode: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}` });
});
on('POST', '/api/v1/cardholder/auth/2fa/verify', async (req, res, b, q, u) => { if (b.token !== MFA_CODE) return json(res, 400, { error: 'Code invalide' }); u.mfa = true; json(res, 200, { success: true }); });
on('POST', '/api/v1/cardholder/auth/2fa/disable', async (req, res, b, q, u) => { if (!u.mfa) return json(res, 400, { error: '2FA non configuré' }); if (b.token !== MFA_CODE) return json(res, 400, { error: 'Code invalide' }); u.mfa = false; json(res, 200, { success: true }); });
on('GET', '/api/v1/cardholder/security/events', async (req, res) => json(res, 200, { events }));

on('GET', '/api/v1/cardholder/card', async (req, res, b, q, u) => { const c = cards[u.cardId]; json(res, 200, { ...summary(c), cardholder: { firstName: u.firstName, lastName: u.lastName, email: u.email, phone: u.phone, kycLevel: u.kycLevel, address: u.address, city: u.city } }); });
on('PATCH', '/api/v1/cardholder/card/status', async (req, res, b, q, u) => {
  if (!['freeze', 'unfreeze'].includes(b.action)) return json(res, 422, { error: 'Action invalide' });
  cards[u.cardId].status = b.action === 'freeze' ? 'frozen' : 'active'; json(res, 200, { success: true, status: cards[u.cardId].status });
});
on('POST', '/api/v1/cardholder/card/pin', async (req, res, b, q, u) => {
  const target = b.cardId || u.cardId; const c = cards[target];
  if (!c || c.cardholder_id !== u.id) return json(res, 404, { error: 'Carte introuvable' });
  if (!/^[0-9]{4}$/.test(b.newPin || b.pin || '')) return json(res, 422, { error: 'PIN doit etre 4 chiffres' });
  if (b.currentPin !== undefined && b.currentPin !== (c.pin || PIN)) return json(res, 401, { error: 'PIN actuel incorrect' });
  c.pin = b.newPin || b.pin; json(res, 200, { success: true, message: 'PIN defini', cardId: target });
});
on('PATCH', '/api/v1/cardholder/profile', async (req, res, b, q, u) => { ['email', 'phone', 'address', 'city'].forEach((k) => { if (b[k] !== undefined) u[k] = b[k]; }); json(res, 200, { success: true }); });
on('GET', '/api/v1/cardholder/transactions', async (req, res, b, q, u) => {
  const limit = Math.min(100, Math.max(1, parseInt(q.get('limit'), 10) || 20)); const page = Math.max(1, parseInt(q.get('page'), 10) || 1);
  let rows = txns.filter((t) => t.card_id === u.cardId);
  if (q.get('type')) rows = rows.filter((t) => t.type === q.get('type'));
  if (q.get('status')) rows = rows.filter((t) => t.status === q.get('status'));
  rows.sort((a, c) => new Date(c.initiated_at) - new Date(a.initiated_at));
  json(res, 200, { data: rows.slice((page - 1) * limit, page * limit), total: rows.length, page, limit });
});
on('GET', '/api/v1/cardholder/dashboard', async (req, res, b, q, u) => {
  const c = cards[u.cardId]; const since = Date.now() - 30 * 86400000; const mine = txns.filter((t) => t.card_id === u.cardId);
  const ok = mine.filter((t) => t.status === 'completed' && new Date(t.initiated_at).getTime() >= since);
  const sum = (type) => ok.filter((t) => t.type === type).reduce((s, t) => s + Number(t.amount), 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  json(res, 200, { card: { ...c }, stats: { monthSpent: sum('payment'), monthTopup: sum('topup'), monthUnload: sum('unload'), monthCount: ok.length, todayCount: mine.filter((t) => new Date(t.initiated_at) >= today).length },
    recentTransactions: [...mine].sort((a, d) => new Date(d.initiated_at) - new Date(a.initiated_at)).slice(0, 5) });
});
on('POST', '/api/v1/cardholder/payment', async (req, res, b, q, u) => {
  const c = cards[u.cardId]; const amount = Number(b.amount);
  if (!(amount > 0)) return json(res, 422, { error: 'Montant invalide' });
  if (!b.pin) return json(res, 422, { error: 'PIN requis' });
  if (c.status !== 'active') return json(res, 422, { error: `Carte ${c.status === 'frozen' ? 'gelée' : 'inactive'}` });
  if (b.pin !== (c.pin || PIN)) return json(res, 422, { error: 'PIN incorrect' });
  const fee = Math.round(amount * 0.005); if (c.balance < amount + fee) return json(res, 422, { error: 'Solde insuffisant (frais inclus)' });
  const merchant = MERCHANTS.find((m) => m[0] === b.merchantId); const before = c.balance; c.balance -= amount + fee;
  const txn = mkTxn(c.card_id, u.id, { type: 'payment', amount, fee, net_amount: amount - fee, balance_before: before, balance_after: c.balance, merchant_id: b.merchantId || null, merchant_name: merchant ? merchant[1] : 'Marchand inconnu', description: b.description || null, auth_code: crypto.randomBytes(3).toString('hex').toUpperCase(), initiated_at: new Date().toISOString() });
  json(res, 200, { success: true, txn, newBalance: c.balance, authCode: txn.auth_code });
});
on('POST', '/api/v1/cardholder/topup', async (req, res) => DISABLED(res));
on('POST', '/api/v1/cardholder/unload', async (req, res) => DISABLED(res));
on('POST', '/api/v1/cardholder/payment/tokenized', async (req, res) => DISABLED(res));

on('GET', '/api/v1/cardholder/cards/created', async (req, res, b, q, u) => { const list = Object.values(cards).filter((c) => c.cardholder_id === u.id && c.status !== 'cancelled'); json(res, 200, { data: list.map((c) => ({ ...summary(c), cardType: 'created' })), total: list.length, max: 3 }); });
on('POST', '/api/v1/cardholder/cards/create', async (req, res, b, q, u) => {
  if (!GTP_ON) return json(res, 503, { error: "Service cartes en cours d'activation", code: 'GTP_NOT_CONFIGURED' });
  const id = uuid(); const last4 = String(1000 + Math.floor(Math.random() * 9000));
  cards[id] = { card_id: id, cardholder_id: u.id, card_masked: `4000 **** **** ${last4}`, cardholder_name: `${u.firstName} ${u.lastName}`.toUpperCase(), balance: 0, currency: 'XAF', status: 'active', expiry_month: 12, expiry_year: 2029, network: 'visa', daily_limit: 200000, monthly_limit: 1000000, label: b.label || 'Ma carte' };
  json(res, 200, { ...summary(cards[id]), cardType: 'gtp' });
});
on('DELETE', '/api/v1/cardholder/cards/created/:cardId', async (req, res, b, q, u, p) => { const c = cards[p.cardId]; if (!c || c.cardholder_id !== u.id) return json(res, 404, { error: 'Carte introuvable' }); if (c.balance > 0) return json(res, 422, { error: 'Dechargez la carte avant de la supprimer' }); c.status = 'cancelled'; json(res, 200, { success: true }); });
on('GET', '/api/v1/cardholder/cards', async (req, res, b, q, u) => json(res, 200, { data: enrolled.filter((e) => e.cardholder_id === u.id && e.status === 'active').map((e) => ({ enrollmentId: e.enrollment_id, cardMasked: e.card_masked, cardholderName: e.cardholder_name, network: e.network, expiryMonth: e.expiry_month, expiryYear: e.expiry_year, isDefault: e.is_default, status: e.status, cardType: 'enrolled' })), total: 1 }));
on('PATCH', '/api/v1/cardholder/cards/:id/default', async (req, res, b, q, u, p) => { enrolled.forEach((e) => { if (e.cardholder_id === u.id) e.is_default = e.enrollment_id === p.id; }); json(res, 200, { success: true }); });
on('DELETE', '/api/v1/cardholder/cards/:id', async (req, res, b, q, u, p) => { enrolled.forEach((e) => { if (e.enrollment_id === p.id) e.status = 'removed'; }); json(res, 200, { success: true }); });

on('GET', '/api/v1/cardholder/gtp/status', async (req, res, b, q, u) => json(res, 200, { configured: GTP_ON, hasCard: GTP_ON && gtpCards.some((c) => c.cardholder_id === u.id), message: GTP_ON ? 'Service cartes actif' : "Service cartes en cours d'activation" }));
on('GET', '/api/v1/cardholder/gtp/cards', async (req, res, b, q, u) => json(res, 200, { data: gtpCards.filter((c) => c.cardholder_id === u.id && c.status !== 'cancelled'), total: 1 }));
on('GET', '/api/v1/cardholder/gtp/cards/:id', async (req, res, b, q, u, p) => { const c = gtpCards.find((x) => String(x.gtp_card_id) === p.id); if (!c) return json(res, 404, { error: 'Carte introuvable' }); json(res, 200, { gtpCardId: c.gtp_card_id, ...c }); });
on('GET', '/api/v1/cardholder/gtp/cards/:id/transactions', async (req, res) => json(res, 200, { data: [{ transactionId: 'G1', date: daysAgo(2), time: '14:02', amount: 4500, fee: 0, totalAmount: 4500, runningBalance: 32500, description: 'Achat SUPERMARCHE MAHIMA' }, { transactionId: 'G2', date: daysAgo(9), time: '09:15', amount: 37000, fee: 0, totalAmount: 37000, runningBalance: 37000, description: 'Chargement WalletToCard' }], total: 2 }));
on('POST', '/api/v1/cardholder/gtp/issue', async (req, res, b, q, u) => { if (!GTP_ON) return json(res, 503, { error: 'Service GTP non configure (token manquant)', code: 'GTP_NOT_CONFIGURED' }); gtpCards.push({ gtp_card_id: 10000000 + Math.floor(Math.random() * 999999), cardholder_id: u.id, cardMasked: '5355 **** **** 8812', last4: '8812', cardholderName: `${u.firstName} ${u.lastName}`, status: 'active', balance: 0, currency: 'XAF' }); json(res, 200, { success: true }); });
on('PATCH', '/api/v1/cardholder/gtp/cards/:id/freeze', async (req, res, b, q, u, p) => { const c = gtpCards.find((x) => String(x.gtp_card_id) === p.id); if (c) c.status = 'frozen'; json(res, 200, { success: true }); });
on('PATCH', '/api/v1/cardholder/gtp/cards/:id/unfreeze', async (req, res, b, q, u, p) => { const c = gtpCards.find((x) => String(x.gtp_card_id) === p.id); if (c) c.status = 'active'; json(res, 200, { success: true }); });
on('POST', '/api/v1/cardholder/gtp/cards/:id/pin', async (req, res, b) => { if (!/^[0-9]{4}$/.test(b.pin || '')) return json(res, 422, { error: 'PIN 4 chiffres requis' }); json(res, 200, { success: true }); });
on('POST', '/api/v1/cardholder/gtp/cards/:id/payment', async (req, res, b, q, u, p) => { const c = gtpCards.find((x) => String(x.gtp_card_id) === p.id); if (!c) return json(res, 404, { error: 'Carte introuvable' }); if (c.balance < b.amount) return json(res, 422, { error: 'Solde insuffisant' }); c.balance -= Number(b.amount); json(res, 200, { success: true, transactionId: 'G' + Date.now(), newBalance: c.balance }); });
on('POST', '/api/v1/cardholder/gtp/cards/:id/topup', async (req, res) => DISABLED(res));
on('POST', '/api/v1/cardholder/gtp/cards/:id/unload', async (req, res) => DISABLED(res));

on('GET', '/api/v1/cardholder/claims', async (req, res, b, q, u) => json(res, 200, { data: claims.filter((c) => c.cardholder_id === u.id) }));
on('POST', '/api/v1/cardholder/claims', async (req, res, b, q, u) => {
  if (!b.claimType || !b.description) return json(res, 422, { error: 'claimType et description requis' });
  const c = { claim_id: uuid(), claim_ref: `REC-${crypto.randomBytes(3).toString('hex').toUpperCase()}`, cardholder_id: u.id, claim_type: b.claimType, description: b.description, status: 'open', txn_id: b.txnId || null, txn_amount: b.txnAmount || null, txn_date: b.txnDate || null, opened_at: new Date().toISOString() };
  claims.unshift(c); json(res, 201, { success: true, claim_id: c.claim_id, claim_ref: c.claim_ref, status: c.status, opened_at: c.opened_at });
});
on('GET', '/api/v1/cardholder/support/tickets', async (req, res, b, q, u) => { const rows = tickets.filter((t) => t.cardholder_id === u.id).map(({ messages, ...t }) => ({ ...t, last_message: messages[messages.length - 1]?.message })); json(res, 200, { data: rows, tickets: rows }); });
on('POST', '/api/v1/cardholder/support/tickets', async (req, res, b, q, u) => {
  if (!b.subject || !b.message) return json(res, 422, { error: 'Sujet et message requis' });
  const t = { ticket_id: `tk-${Date.now()}`, ticket_number: `TKT-CH${crypto.randomBytes(3).toString('hex').toUpperCase()}`, cardholder_id: u.id, subject: b.subject, category: b.category || 'general', priority: b.priority || 'normal', status: 'open', description: b.message, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), messages: [{ message_id: uuid(), sender_type: 'merchant', sender_name: `${u.firstName} ${u.lastName}`, message: b.message, created_at: new Date().toISOString() }] };
  tickets.unshift(t); const { messages, ...out } = t; json(res, 201, out);
});
on('GET', '/api/v1/cardholder/support/tickets/:id', async (req, res, b, q, u, p) => { const t = tickets.find((x) => x.ticket_id === p.id && x.cardholder_id === u.id); if (!t) return json(res, 404, { error: 'Ticket introuvable' }); json(res, 200, t); });
on('POST', '/api/v1/cardholder/support/tickets/:id/messages', async (req, res, b, q, u, p) => { const t = tickets.find((x) => x.ticket_id === p.id && x.cardholder_id === u.id); if (!t) return json(res, 404, { error: 'Ticket introuvable' }); if (!b.message) return json(res, 422, { error: 'Message requis' }); t.messages.push({ message_id: uuid(), sender_type: 'merchant', sender_name: `${u.firstName} ${u.lastName}`, message: b.message, created_at: new Date().toISOString() }); t.status = 'pending_admin'; t.updated_at = new Date().toISOString(); json(res, 201, { success: true }); });
on('GET', '/api/v1/cardholder/kyc', async (req, res, b, q, u) => json(res, 200, { kyc_level: u.kycLevel, first_name: u.firstName, last_name: u.lastName, documents: kycDocs.filter((d) => d.cardholder_id === u.id) }));
on('POST', '/api/v1/cardholder/kyc/documents', async (req, res, b, q, u) => { if (!b.docType || !b.fileUrl) return json(res, 422, { error: 'docType et fileUrl requis' }); const d = { doc_id: uuid(), cardholder_id: u.id, doc_type: b.docType, doc_label: b.docLabel || b.docType, file_name: b.fileName || null, status: 'pending', rejection_reason: null, uploaded_at: new Date().toISOString(), reviewed_at: null }; kycDocs.unshift(d); json(res, 201, d); });
on('GET', '/api/v1/consent/check', async (req, res, b, q, u) => json(res, 200, { hasConsented: consents.has(u.id), consent: null }));
on('POST', '/api/v1/consent/accept', async (req, res, b, q, u) => { consents.add(u.id); json(res, 200, { success: true }); });
on('GET', '/api/v1/pay/:shortId/status', async (req, res, b, q, u, p) => { if (p.shortId === 'ABC123') return json(res, 200, { shortId: 'ABC123', amount: 15000, currency: 'XAF', status: 'pending' }); json(res, 404, { error: 'Lien invalide', code: 'LINK_NOT_FOUND' }); }, false);

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
  if (!route) return json(res, 404, { error: `Route inconnue : ${req.method} ${url.pathname}` });
  const user = readJwt(req);
  if (route.auth && !user) return json(res, 401, { error: 'Non authentifié', code: 'UNAUTHORIZED' });
  const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
  const params = url.pathname.match(route.re).groups || {};
  await new Promise((r) => setTimeout(r, 120 + Math.random() * 180)); // latence realiste
  try { await route.handler(req, res, body, url.searchParams, user, params); }
  catch (e) { json(res, 500, { error: e.message }); }
  process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${req.method} ${url.pathname} -> ${res.statusCode}\n`);
});
server.listen(PORT, '127.0.0.1', () => process.stdout.write(`Mock API C-Pay porteur : http://127.0.0.1:${PORT}  (GTP ${GTP_ON ? 'actif' : 'inactif'}, consentement ${CONSENTED ? 'accepté' : 'à recueillir'})\n`));
