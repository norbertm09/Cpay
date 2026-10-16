#!/usr/bin/env node
'use strict';
// Serveur d'API factice pour développer le portail marchand sans backend.
//
//   node dev/mock-api.js [--port 4010] [--static build] [--no-session] [--no-consent]
//
//   --static <dir>  sert aussi le bundle (repli SPA sur index.html) : même origine, pas de CORS
//   --no-session    le refresh silencieux échoue (pour voir l'écran de connexion)
//   --no-consent    le consentement CGU n'est pas encore donné (écran /accept)
//
// Identifiants : n'importe quel e-mail + mot de passe « secret ». Un e-mail
// contenant « mfa » déclenche l'étape 2FA (code 123456). Confirmation forte :
// code 123456 (2FA) ou mot de passe « secret ». Aucune dépendance.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : def; };
const PORT = Number(opt('--port', 4010));
const STATIC = opt('--static', null);
const NO_SESSION = args.includes('--no-session');
let consented = !args.includes('--no-consent');

// ─── Données ──────────────────────────────────────────────────────
const now = () => new Date();
const iso = (d) => new Date(d).toISOString();
const ago = (days, hours = 0) => { const d = now(); d.setDate(d.getDate() - days); d.setHours(d.getHours() - hours); return d; };
const todayAt = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000);
const uuid = () => crypto.randomUUID();
const ref = (p) => `${p}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const merchant = { merchant_id: 'c1f6a4e2-9b1d-4d7a-8a0e-5f3c2b1a9e77', business_name: 'Boulangerie du Plateau', email: 'contact@plateau.cg', phone: '+242061234567', country: 'CG', currency: 'XAF', kyb_level: 1, kyb_status: 'approved', merchant_status: 'active', rccm: 'CG-BZV-01-2023-B12-00456', nif: 'P2023000456Z', first_name: 'Amélie', last_name: 'Okemba', role: 'owner', created_at: iso(ago(210)), settlement_type: 'mobile_money', settlement_account: '+242061234567' };
const user = { userId: 'u-1', firstName: 'Amélie', lastName: 'Okemba', email: merchant.email, role: 'owner', merchantId: merchant.merchant_id, businessName: merchant.business_name, currency: 'XAF', country: 'CG', kybLevel: 1, mfaEnabled: false };
const token = () => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.userId, type: 'merchant', merchantId: merchant.merchant_id, role: 'owner', businessName: merchant.business_name, country: 'CG', currency: 'XAF', exp: Math.floor(Date.now() / 1000) + 900 })}.${b64('sig')}`;
let wallet = { operator: 'mtn_momo', phone: '+242061234567', verifiedAt: iso(ago(40)) };
const OPS = ['mtn_momo', 'airtel_money'];
const txns = []; let seed = 7;
const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
for (let d = 0; d < 30; d++) for (let k = 0, n = 2 + Math.floor(rnd() * 4); k < n; k++) {
  const card = rnd() < 0.25; const amount = Math.round((2000 + rnd() * 48000) / 100) * 100; const failed = rnd() < 0.08;
  const fee = Math.round(amount * (card ? 0.02 : 0.012));
  txns.push({ transaction_id: uuid(), type: 'collect', amount, currency: 'XAF', payment_method: card ? 'pay_link' : 'mobile_money', status: failed ? 'failed' : (d === 0 && k === 0 ? 'pending' : 'authorized'), description: ['Vente comptoir', 'Commande n° ' + (100 + d * 3 + k), 'Pain & viennoiseries', null][k % 4], auth_code: failed ? null : crypto.randomBytes(3).toString('hex').toUpperCase(), fee_amount: failed ? 0 : fee, net_amount: failed ? 0 : amount - fee, device_id: k % 2 ? 'term-1' : null, settlement_status: d > 1 && !failed ? 'regle' : 'non_regle', settled_at: d > 1 && !failed ? iso(ago(d - 1, 3)) : null, initiated_at: iso(d === 0 ? todayAt(5 + k * 25) : ago(d, 2 + k * 3)), completed_at: failed ? null : iso(d === 0 ? todayAt(4 + k * 25) : ago(d, 2 + k * 3)), gateway_payment_id: 'MP' + crypto.randomBytes(5).toString('hex').toUpperCase(), gateway_order_id: 'ORD-' + (1000 + d * 10 + k), detected_operator: card ? null : OPS[k % 2] });
}
const PLATFORM_ACCOUNT = { bankName: 'BGFI Bank Congo', accountName: 'CALCULUS PLUS SAS', accountNumber: '30011 00012 00123456789 45', iban: 'CG39 3001 1000 1200 1234 5678 945', swift: 'BGFICGCX' };
const transfers = [
  { transfer_id: uuid(), reference: ref('PAY'), direction: 'payout', dest_type: 'wallet', status: 'completed', amount: 150000, fee: 1500, net_amount: 148500, currency: 'XAF', description: 'Caisse du soir', created_at: iso(ago(1, 5)), completed_at: iso(ago(1, 4)), wallet_operator: 'mtn_momo', wallet_phone: '+242061234567' },
  { transfer_id: uuid(), reference: ref('TRF'), direction: 'payout', dest_type: 'bank', status: 'pending_manual', amount: 400000, fee: 4000, net_amount: 396000, currency: 'XAF', description: 'Virement hebdomadaire', created_at: iso(ago(2, 1)), bank_account_id: 'ba-1' },
  { transfer_id: uuid(), reference: ref('FND'), direction: 'funding', dest_type: null, status: 'awaiting_funds', amount: 250000, fee: 0, net_amount: 250000, currency: 'XAF', description: 'Approvisionnement caisse', created_at: iso(ago(3)), expires_at: iso(ago(-4)), instructions: { ...PLATFORM_ACCOUNT, reference: null, expiresAt: iso(ago(-4)) } },
  { transfer_id: uuid(), reference: ref('PAY'), direction: 'payout', dest_type: 'wallet', status: 'failed', amount: 50000, fee: 500, net_amount: 49500, currency: 'XAF', created_at: iso(ago(9)), wallet_operator: 'mtn_momo', wallet_phone: '+242061234567', error_message: 'Compte bénéficiaire indisponible' },
];
transfers[2].instructions.reference = transfers[2].reference;
const bankAccounts = [{ accountId: 'ba-1', accountNumber: '**********6789', accountName: 'BOULANGERIE DU PLATEAU', status: 'verified', isDefault: true, institution: { name: 'BGFI Bank Congo', code: 'BGFI', type: 'bank', country: 'CG' } }];
const institutions = [{ institution_id: 'i-1', code: 'BGFI', name: 'BGFI Bank Congo', type: 'bank', country: 'CG' }, { institution_id: 'i-2', code: 'LCB', name: 'LCB Bank', type: 'bank', country: 'CG' }, { institution_id: 'i-3', code: 'MUCODEC', name: 'MUCODEC', type: 'cooperative', country: 'CG' }];
const payLinks = Array.from({ length: 7 }, (_, i) => ({ pay_link_id: uuid(), short_id: 'Q' + crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 6), amount: [12500, 30000, 7500, 45000, 20000, 9900, 60000][i], currency: 'XAF', description: ['Commande n° 118', 'Gâteau anniversaire', null, 'Facture FACT-021', 'Réservation', 'Panier petit-déjeuner', 'Traiteur'][i], status: ['pending', 'paid', 'expired', 'pending', 'paid', 'cancelled', 'pending'][i], created_at: iso(ago(i)), expires_at: iso(ago(i - 1)), paid_at: [1, 4].includes(i) ? iso(ago(i, -2)) : null, paid_amount: [1, 4].includes(i) ? [12500, 30000, 7500, 45000, 20000, 9900, 60000][i] : null, recipient_phone: i % 2 ? '+242066554433' : null, send_channel: i % 2 ? 'sms' : null, payment_method: i % 3 ? 'card' : 'mobile_money' })).map(l => ({ ...l, short_url: `https://pay.c-pay.global/${l.short_id}` }));
const terminals = [{ terminal_id: 'term-1', terminal_code: 'TERM-C1F6A4-A1B2C3', terminal_name: 'Caisse 1', site_name: 'Boutique Plateau', device_model: 'Samsung A14', app_version: '2.7.0', status: 'active', pairing_code: null, paired_at: iso(ago(60)), last_seen_at: iso(ago(0, 1)), created_at: iso(ago(61)) }, { terminal_id: 'term-2', terminal_code: 'TERM-C1F6A4-D4E5F6', terminal_name: 'Caisse marché', site_name: 'Marché Total', device_model: null, app_version: null, status: 'active', pairing_code: '482913', paired_at: null, last_seen_at: null, created_at: iso(ago(1)) }];
const apiKeys = [{ key_id: 'k-1', key_name: 'Site WooCommerce', key_prefix: 'sk_live_4f8a', permissions: ['collect', 'transactions', 'pay_links'], is_active: true, last_used_at: iso(ago(0, 3)), expires_at: null, created_at: iso(ago(90)), legacy_plaintext: false }, { key_id: 'k-2', key_name: 'Ancienne appli', key_prefix: 'sk_live_09cd', permissions: ['collect'], is_active: false, last_used_at: iso(ago(120)), created_at: iso(ago(300)), legacy_plaintext: true }];
let webhook = { webhook_url: 'https://boutique-plateau.cg/webhooks/c-pay', webhook_secret: { configured: true } };
const integrations = [{ integration_id: 'int-1', integration_type: 'accounting', provider: 'Sage', display_name: 'Compta Sage', endpoint_url: 'https://compta.plateau.cg/cpay', auth_type: 'bearer', auth_config: { configured: true }, event_types: ['transaction.authorized', 'settlement.completed'], status: 'active', signing_secret: 'a81f3c90...', created_at: iso(ago(30)), updated_at: iso(ago(5)) }];
const tickets = [{ ticket_id: 't-1', ticket_number: 'TKT-M3K9Q1', subject: 'Encaissement non crédité (ORD-1032)', priority: 'high', status: 'pending_merchant', created_at: iso(ago(2)), last_message_at: iso(ago(1)), messages: [{ message_id: 'm-1', sender_type: 'merchant', sender_name: 'Boulangerie du Plateau', message: 'Le client a payé 25 000 XAF mais la transaction reste en attente.', created_at: iso(ago(2)), attachments: '[]' }, { message_id: 'm-2', sender_type: 'admin', sender_name: 'Support C-Pay', message: 'Bonjour, nous avons relancé l’opérateur. Pouvez-vous confirmer le numéro du client ?', created_at: iso(ago(1)), attachments: '[]' }] }, { ticket_id: 't-2', ticket_number: 'TKT-L2J8P0', subject: 'Question sur les frais de retrait', priority: 'low', status: 'resolved', created_at: iso(ago(20)), resolved_at: iso(ago(18)), resolution: 'Grille tarifaire expliquée.', messages: [] }];
const kybDocs = [{ doc_id: 'd-1', doc_type: 'rccm', doc_label: 'RCCM', file_name: 'rccm.pdf', status: 'approved', uploaded_at: iso(ago(200)), reviewed_at: iso(ago(198)) }, { doc_id: 'd-2', doc_type: 'nif', doc_label: 'NIF', file_name: 'nif.pdf', status: 'approved', uploaded_at: iso(ago(200)), reviewed_at: iso(ago(198)) }, { doc_id: 'd-3', doc_type: 'id_card', doc_label: 'Pièce d’identité', file_name: 'cni.jpg', status: 'pending', uploaded_at: iso(ago(3)) }];

// ─── Calculs ──────────────────────────────────────────────────────
const OUT_OK = ['pending', 'processing', 'pending_manual', 'completed'];
const balance = () => {
  const inn = txns.filter(t => t.status === 'authorized').reduce((a, t) => a + t.net_amount, 0) + transfers.filter(t => t.direction === 'funding' && t.status === 'completed').reduce((a, t) => a + t.amount, 0);
  const out = transfers.filter(t => t.direction === 'payout' && OUT_OK.includes(t.status)).reduce((a, t) => a + t.amount, 0);
  return { available: inn - out, pending: txns.filter(t => t.status === 'pending').reduce((a, t) => a + t.amount, 0), reserved: 0 };
};
const summary = () => {
  const today = txns.filter(t => iso(t.initiated_at).slice(0, 10) === iso(now()).slice(0, 10) && t.status === 'authorized');
  const withdrawn = transfers.filter(t => t.dest_type === 'wallet' && iso(t.created_at).slice(0, 10) === iso(now()).slice(0, 10) && OUT_OK.includes(t.status)).reduce((a, t) => a + t.amount, 0);
  return { currency: 'XAF', balance: balance(), fees: { withdraw: { percent: 1, fixed: 0, min: 0 }, transfer: { percent: 1, fixed: 0, min: 0 } },
    today: { collected: today.reduce((a, t) => a + t.net_amount, 0), collectedCount: today.length, byMethod: { mobile_money: today.filter(t => t.payment_method === 'mobile_money').reduce((a, t) => a + t.net_amount, 0), card: today.filter(t => t.payment_method !== 'mobile_money').reduce((a, t) => a + t.net_amount, 0) }, withdrawn, transfersOut: 0, transfersIn: 0 },
    limits: { withdrawDailyMax: 500000, withdrawDailyRemaining: Math.max(0, 500000 - withdrawn), transferMin: 1000, withdrawFeePercent: 1, withdrawFeeFixed: 0, withdrawFeeMin: 0 },
    profile: { kybLevel: merchant.kyb_level, wallet, bankAccounts: bankAccounts.filter(a => a.status === 'verified').length, cardAcceptance: 'link' } };
};
const serializeTransfer = (t) => ({ transferId: t.transfer_id, reference: t.reference, direction: t.direction === 'funding' ? 'bank_to_wallet' : (t.dest_type === 'bank' ? 'wallet_to_bank' : 'withdraw'), type: t.direction === 'funding' ? 'transfer_in' : (t.dest_type === 'bank' ? 'transfer_out' : 'withdraw'), status: t.status, amount: t.amount, fee: t.fee, net: t.net_amount, currency: t.currency, description: t.description || null, createdAt: t.created_at, completedAt: t.completed_at || null, expiresAt: t.expires_at || null, bankReference: t.bank_reference || null, errorMessage: t.error_message || null, ...(t.dest_type === 'wallet' && { wallet: { operator: t.wallet_operator, phone: t.wallet_phone } }), ...(t.dest_type === 'bank' && { bankAccount: { bankName: 'BGFI Bank Congo', accountMasked: '******6789', accountName: 'BOULANGERIE DU PLATEAU' } }), ...(t.direction === 'funding' && { instructions: t.instructions }) });
const historyRows = () => [
  ...txns.map(t => ({ id: t.transaction_id, type: 'collect', reference: t.gateway_order_id, amount: t.amount, fee: t.fee_amount, net: t.net_amount, currency: 'XAF', status: t.status, counterparty: t.detected_operator ? (t.detected_operator === 'mtn_momo' ? 'MTN MoMo' : 'Airtel Money') : null, method: t.payment_method, description: t.description, createdAt: t.initiated_at })),
  ...transfers.map(t => { const s = serializeTransfer(t); return { id: t.transfer_id, type: s.type, reference: t.reference, amount: t.amount, fee: t.fee, net: t.net_amount, currency: 'XAF', status: t.status, counterparty: t.dest_type === 'bank' ? 'BGFI Bank Congo ******6789' : t.direction === 'funding' ? 'BGFI Bank Congo' : 'MTN MoMo +2420612•••567', method: t.dest_type === 'wallet' ? 'mobile_money' : 'bank_transfer', description: t.description || null, createdAt: t.created_at }; }),
].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
const detect = (phone) => {
  const p = String(phone || '').replace(/[^\d+]/g, '');
  const m = p.match(/^\+?(242|237|221|225)(\d+)$/);
  if (!m) return { success: false, error: 'Numéro invalide', code: 'PHONE_INVALID' };
  const [, cc, nat] = m;
  const C = { 242: ['CG', 'Congo-Brazzaville', 'XAF', 9], 237: ['CM', 'Cameroun', 'XAF', 9], 221: ['SN', 'Sénégal', 'XOF', 9], 225: ['CI', 'Côte d’Ivoire', 'XOF', 10] }[cc];
  const base = { phone: '+' + cc + nat, country: C[0], countryName: C[1], currency: C[2], alternatives: C[0] === 'SN' ? [{ operator: 'WAVE', brand: 'Wave' }] : [] };
  if (nat.length !== C[3]) return { success: false, error: `Numéro ${C[1]} invalide (${C[3]} chiffres attendus)`, code: 'PHONE_LENGTH', ...base };
  const op = cc === '242' ? (nat.startsWith('06') ? ['MTN_MOMO', 'MTN MoMo'] : ['AIRTEL_MONEY', 'Airtel Money']) : cc === '237' ? (/^6[5-8]/.test(nat) ? ['MTN_MOMO', 'MTN MoMo'] : ['ORANGE_MONEY', 'Orange Money']) : ['ORANGE_MONEY', 'Orange Money'];
  return { success: true, ...base, operator: op[0], brand: op[1], gateway: 'mm_router' };
};
const stepUp = (body) => { const c = body.confirm || {}; if ((user.mfaEnabled && c.code === '123456') || (!user.mfaEnabled && c.password === 'secret')) return null; return [428, { error: c.code || c.password ? 'Confirmation invalide' : 'Confirmation requise', code: 'STEP_UP_REQUIRED', methods: [user.mfaEnabled ? 'totp' : 'password'] }]; };

// ─── Routeur ──────────────────────────────────────────────────────
const routes = [];
const on = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });
const M = '/api/v1/merchant';
const session = () => ({ access_token: token(), refresh_token: 'r', expires_in: 900, mustChangePassword: false, user });

on('POST', `${M}/auth/login`, (q, b) => !b.password || b.password !== 'secret' ? [401, { error: 'Identifiants incorrects', attemptsLeft: 4 }] : /mfa/i.test(b.emailOrPhone || '') ? (user.mfaEnabled = true, [200, { mfaRequired: true, mfaToken: 'mfa-token' }]) : [200, session()]);
on('POST', `${M}/auth/2fa/validate`, (q, b) => b.code === '123456' ? [200, session()] : [401, { error: 'Code 2FA invalide', code: 'INVALID_TOTP' }]);
on('POST', `${M}/auth/refresh`, () => NO_SESSION ? [401, { error: 'Refresh token invalide', code: 'INVALID_REFRESH' }] : [200, { access_token: token(), expires_in: 900 }]);
on('POST', `${M}/auth/logout`, () => [200, { success: true }]);
on('GET', `${M}/auth/me`, () => [200, { user, mustChangePassword: false }]);
on('POST', `${M}/auth/register`, (q, b) => [201, { ...session(), user: { ...user, businessName: b.businessName } }]);
on('POST', `${M}/auth/change-password`, (q, b) => b.currentPassword === 'secret' ? [200, { success: true, sessionsRevoked: true }] : [401, { error: 'Mot de passe actuel incorrect' }]);
on('POST', `${M}/auth/forgot-password`, () => [200, { success: true }]);
on('POST', `${M}/auth/reset-password`, (q, b) => b.token === 'bad' ? [400, { error: 'Lien invalide ou expiré', code: 'INVALID_TOKEN' }] : [200, { success: true }]);
on('GET', `${M}/auth/2fa/status`, () => [200, { mfaEnabled: user.mfaEnabled, mfaMethod: user.mfaEnabled ? 'totp' : null, daysSinceCreation: 6, daysLeft: 4, required: false }]);
on('POST', `${M}/auth/2fa/setup`, () => [200, { secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', qrCode: 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#fff"/><rect x="20" y="20" width="60" height="60"/><rect x="120" y="20" width="60" height="60"/><rect x="20" y="120" width="60" height="60"/><rect x="110" y="110" width="20" height="20"/><rect x="150" y="130" width="30" height="30"/></svg>').toString('base64') }]);
on('POST', `${M}/auth/2fa/verify`, (q, b) => b.token === '123456' ? (user.mfaEnabled = true, [200, { success: true }]) : [400, { error: 'Code invalide' }]);
on('POST', `${M}/auth/2fa/disable`, (q, b) => b.token === '123456' ? (user.mfaEnabled = false, [200, { success: true }]) : [400, { error: 'Code invalide' }]);
on('GET', '/api/v1/consent/check', () => [200, { hasConsented: consented }]);
on('POST', '/api/v1/consent/accept', () => { consented = true; return [200, { success: true }]; });
on('POST', '/api/v1/detect/phone', (q, b) => [200, detect(b.phone)]);
on('GET', `${M}/institutions`, () => [200, { institutions }]);

on('GET', `${M}/cash/summary`, () => [200, summary()]);
on('POST', `${M}/cash/collect`, (q, b) => {
  if (b.method === 'card') { const l = { pay_link_id: uuid(), short_id: 'C' + crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 6), amount: b.amount, currency: 'XAF', description: b.description || 'Encaissement carte', status: 'pending', created_at: iso(now()), expires_at: iso(ago(-1)), payment_method: 'card' }; l.short_url = `https://pay.c-pay.global/${l.short_id}`; payLinks.unshift(l); return [201, { txnId: null, status: 'pending', method: 'card', amount: b.amount, currency: 'XAF', payLink: { shortId: l.short_id, shortUrl: l.short_url, expiresAt: l.expires_at } }]; }
  const d = detect(b.customerPhone); if (!d.success) return [422, { error: d.error, code: d.code }];
  if (d.currency !== 'XAF') return [422, { error: `Numéro ${d.countryName} en ${d.currency} : devise différente`, code: 'CURRENCY_MISMATCH' }];
  const fee = Math.round(b.amount * 0.012); const op = d.operator.toLowerCase();
  const t = { transaction_id: uuid(), type: 'collect', amount: b.amount, currency: 'XAF', payment_method: 'mobile_money', status: 'pending', description: b.description || 'Encaissement caisse', fee_amount: fee, net_amount: b.amount - fee, initiated_at: iso(now()), gateway_order_id: b.reference || 'ORD-' + Date.now().toString(36).toUpperCase(), detected_operator: op, settlement_status: 'non_regle', _finalizeAt: Date.now() + 9000 };
  txns.unshift(t);
  return [201, { txnId: t.transaction_id, status: 'pending', method: 'mobile_money', operator: op, operatorLabel: d.brand, country: d.country, currency: 'XAF', amount: b.amount, fee, net: b.amount - fee, feeEstimated: true, message: 'Demande envoyée — le client confirme sur son téléphone' }];
});
on('GET', `${M}/cash/collect/:id`, (q, b, p) => { const t = txns.find(x => x.transaction_id === p.id); if (!t) return [404, { error: 'Transaction introuvable', code: 'NOT_FOUND' }]; if (t._finalizeAt && Date.now() > t._finalizeAt) { t.status = t.amount % 1000 === 999 ? 'failed' : 'authorized'; t.completed_at = iso(now()); t.auth_code = crypto.randomBytes(3).toString('hex').toUpperCase(); delete t._finalizeAt; } return [200, { txnId: t.transaction_id, status: t.status, amount: t.amount, fee: t.fee_amount, net: t.net_amount, currency: 'XAF', method: 'mobile_money', operator: t.detected_operator, operatorLabel: t.detected_operator === 'mtn_momo' ? 'MTN MoMo' : 'Airtel Money', reference: t.gateway_order_id, createdAt: t.initiated_at, finalizedAt: t.completed_at || null }]; });
on('GET', `${M}/cash/wallet`, () => wallet ? [200, wallet] : [204, null]);
on('PUT', `${M}/cash/wallet`, (q, b) => { const e = stepUp(b); if (e) return e; const d = detect(b.phone); if (!d.success) return [422, { error: d.error, code: d.code }]; wallet = { operator: b.operator, phone: d.phone, operatorLabel: d.brand, verifiedAt: null }; return [200, wallet]; });
on('POST', `${M}/cash/withdraw`, (q, b) => { if (!(b.amount >= 1000)) return [422, { error: 'Montant minimum 1000 XAF', code: 'VALIDATION_ERROR' }]; const e = stepUp(b); if (e) return e; if (!wallet) return [422, { error: 'Aucun wallet enregistré', code: 'WALLET_MISSING' }]; if (b.amount > balance().available) return [422, { error: 'Solde insuffisant', code: 'INSUFFICIENT_BALANCE', available: balance().available }]; const fee = Math.round(b.amount * 0.01); const t = { transfer_id: uuid(), reference: ref('PAY'), direction: 'payout', dest_type: 'wallet', status: 'processing', amount: b.amount, fee, net_amount: b.amount - fee, currency: 'XAF', description: b.description || 'Retrait', created_at: iso(now()), wallet_operator: wallet.operator, wallet_phone: wallet.phone }; transfers.unshift(t); return [201, { transferId: t.transfer_id, reference: t.reference, status: t.status, amount: t.amount, fee, net: t.net_amount, currency: 'XAF', wallet: { operator: wallet.operator, phone: wallet.phone, operatorLabel: 'MTN MoMo' } }]; });
on('POST', `${M}/cash/transfers`, (q, b) => {
  if (!(b.amount >= 1000)) return [422, { error: 'Montant minimum 1000 XAF', code: 'VALIDATION_ERROR' }];
  if (b.direction === 'wallet_to_bank') { const e = stepUp(b); if (e) return e; if (b.amount > balance().available) return [422, { error: 'Solde insuffisant', code: 'INSUFFICIENT_BALANCE', available: balance().available }]; const fee = Math.round(b.amount * 0.01); const t = { transfer_id: uuid(), reference: ref('TRF'), direction: 'payout', dest_type: 'bank', status: 'pending_manual', amount: b.amount, fee, net_amount: b.amount - fee, currency: 'XAF', description: b.description || 'Transfert vers banque', created_at: iso(now()), bank_account_id: b.accountId }; transfers.unshift(t); return [201, { ...serializeTransfer(t), message: 'Virement exécuté par les opérations C-Pay (J+1 ouvré)' }]; }
  const t = { transfer_id: uuid(), reference: ref('FND'), direction: 'funding', status: 'awaiting_funds', amount: b.amount, fee: 0, net_amount: b.amount, currency: 'XAF', description: b.description || null, created_at: iso(now()), expires_at: iso(ago(-7)) }; t.instructions = { ...PLATFORM_ACCOUNT, reference: t.reference, expiresAt: t.expires_at }; transfers.unshift(t); return [201, serializeTransfer(t)];
});
on('GET', `${M}/cash/transfers`, (q) => { let l = transfers; if (q.direction) l = l.filter(t => serializeTransfer(t).direction === q.direction); if (q.status) l = l.filter(t => t.status === q.status); const off = Number(q.offset || 0), lim = Number(q.limit || 50); return [200, { data: l.slice(off, off + lim).map(serializeTransfer), total: l.length, limit: lim, offset: off }]; });
on('GET', `${M}/cash/transfers/:id`, (q, b, p) => { const t = transfers.find(x => x.transfer_id === p.id); return t ? [200, serializeTransfer(t)] : [404, { error: 'Transfert introuvable', code: 'TRANSFER_NOT_FOUND' }]; });
on('POST', `${M}/cash/transfers/:id/cancel`, (q, b, p) => { const t = transfers.find(x => x.transfer_id === p.id); if (!t) return [404, { error: 'Transfert introuvable' }]; if (!['awaiting_funds', 'pending_manual'].includes(t.status)) return [409, { error: 'Non annulable', code: 'TRANSFER_NOT_CANCELLABLE', status: t.status }]; t.status = 'cancelled'; return [200, { success: true, ...serializeTransfer(t) }]; });
const histFilter = (q) => historyRows().filter(r => (!q.from || r.createdAt >= q.from) && (!q.to || r.createdAt.slice(0, 10) <= q.to) && (!q.type || r.type === q.type));
on('GET', `${M}/cash/history`, (q) => { const l = histFilter(q); const off = Number(q.offset || 0), lim = Number(q.limit || 50); return [200, { data: l.slice(off, off + lim), total: l.length, totals: { in: l.filter(r => ['collect', 'transfer_in'].includes(r.type) && ['authorized', 'completed'].includes(r.status)).reduce((a, r) => a + r.net, 0), out: l.filter(r => ['withdraw', 'transfer_out'].includes(r.type) && !['failed', 'cancelled', 'rejected', 'expired'].includes(r.status)).reduce((a, r) => a + r.amount, 0) }, limit: lim, offset: off }]; });
on('GET', `${M}/cash/history/export.csv`, (q) => [200, '﻿' + ['date;type;reference;montant;frais;net;devise;statut;contrepartie;methode;description', ...histFilter(q).map(r => [r.createdAt, r.type, r.reference, r.amount, r.fee, r.net, r.currency, r.status, r.counterparty || '', r.method || '', r.description || ''].join(';'))].join('\r\n'), 'text/csv; charset=utf-8']);

on('GET', `${M}/dashboard`, () => [200, { today: { txn_count: summary().today.collectedCount, volume: summary().today.collected }, thisMonth: { txn_count: txns.length, volume: txns.reduce((a, t) => a + t.amount, 0) }, activeTerminals: terminals.filter(t => t.status === 'active').length, settlingTomorrow: txns.filter(t => t.settlement_status === 'non_regle' && t.status === 'authorized').reduce((a, t) => a + t.net_amount, 0) }]);
on('GET', `${M}/transactions`, (q) => { let l = txns.filter(t => (!q.status || t.status === q.status) && (!q.type || t.type === q.type) && (!q.dateFrom || t.initiated_at >= q.dateFrom) && (!q.dateTo || t.initiated_at.slice(0, 10) <= q.dateTo)); const lim = Math.min(100, Number(q.limit || 25)), page = Number(q.page || 1); return [200, { data: l.slice((page - 1) * lim, page * lim), total: l.length, page, limit: lim, pages: Math.ceil(l.length / lim) }]; });
on('GET', `${M}/transactions/:id`, (q, b, p) => { const t = txns.find(x => x.transaction_id === p.id); return t ? [200, t] : [404, { error: 'Transaction introuvable' }]; });
on('GET', `${M}/settlements`, () => [200, { data: [2, 3, 4, 7].map((d, i) => { const l = txns.filter(t => t.settlement_status === 'regle' && t.settled_at && t.settled_at.slice(0, 10) === iso(ago(d - 1)).slice(0, 10)); return { batch_id: uuid(), batch_date: iso(ago(d - 1)).slice(0, 10), total_gross: l.reduce((a, t) => a + t.amount, 0), total_fees: l.reduce((a, t) => a + t.fee_amount, 0), total_net: l.reduce((a, t) => a + t.net_amount, 0), currency: 'XAF', txn_count: l.length, settlement_type: 'mobile_money', status: i === 0 ? 'processing' : 'completed', created_at: iso(ago(d - 1)) }; }) }]);
on('GET', `${M}/settlements/daily`, () => { const by = {}; txns.filter(t => t.settlement_status === 'regle').forEach(t => { const j = t.settled_at.slice(0, 10); by[j] = by[j] || { jour: j, nb: 0, total_brut: 0, total_net: 0 }; by[j].nb++; by[j].total_brut += t.amount; by[j].total_net += t.net_amount; }); return [200, { days: Object.values(by).sort((a, b) => b.jour.localeCompare(a.jour)) }]; });
on('GET', `${M}/settlements/daily/:date`, (q, b, p) => [200, { date: p.date, transactions: txns.filter(t => t.settlement_status === 'regle' && t.settled_at.slice(0, 10) === p.date).map(t => ({ transaction_id: t.transaction_id, amount: t.amount, net_amount: t.net_amount, fee_amount: t.fee_amount, payment_method: t.payment_method, detected_operator: t.detected_operator, settlement_ref: 'STL-' + p.date.replace(/-/g, ''), settled_at: t.settled_at, initiated_at: t.initiated_at })) }]);
on('POST', `${M}/receipts/sms`, (q, b) => [200, { success: true, sent: true, phone: b.phone }]);

on('GET', `${M}/pay-links/stats`, () => [200, { pending: payLinks.filter(l => l.status === 'pending').length, paid: payLinks.filter(l => l.status === 'paid').length, cancelled: payLinks.filter(l => l.status === 'cancelled').length, expired: payLinks.filter(l => l.status === 'expired').length, total_collected: payLinks.filter(l => l.status === 'paid').reduce((a, l) => a + l.amount, 0) }]);
on('GET', `${M}/pay-links`, (q) => { const l = payLinks.filter(x => !q.status || x.status === q.status); const lim = Number(q.limit || 20), page = Number(q.page || 1); return [200, { data: l.slice((page - 1) * lim, page * lim), total: l.length, page, limit: lim }]; });
on('POST', `${M}/pay-links`, (q, b) => { const l = { pay_link_id: uuid(), short_id: 'L' + crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 6), amount: Number(b.amount), currency: 'XAF', description: b.description || null, status: 'pending', created_at: iso(now()), expires_at: iso(new Date(Date.now() + (b.expiresIn || 24) * 3600e3)), recipient_phone: b.recipientPhone || null, send_channel: b.recipientPhone ? b.channel : null, payment_method: b.payment_method || 'card' }; l.short_url = `https://pay.c-pay.global/${l.short_id}`; payLinks.unshift(l); return [201, { success: true, link: l }]; });
on('POST', `${M}/pay-links/:id/send`, (q, b, p) => { const l = payLinks.find(x => x.pay_link_id === p.id); if (!l) return [404, { error: 'Lien introuvable' }]; l.recipient_phone = b.phone; l.send_channel = b.channel; return [200, { success: true }]; });
on('DELETE', `${M}/pay-links/:id`, (q, b, p) => { const l = payLinks.find(x => x.pay_link_id === p.id); if (l && l.status === 'pending') l.status = 'cancelled'; return [200, { success: true }]; });
on('GET', `${M}/terminals`, () => [200, { data: terminals }]);
on('POST', `${M}/terminals`, (q, b) => { const t = { terminal_id: 'term-' + Date.now(), terminal_code: 'TERM-C1F6A4-' + crypto.randomBytes(3).toString('hex').toUpperCase(), terminal_name: b.terminalName, site_name: b.siteName || null, device_model: b.deviceModel || null, app_version: null, status: 'active', pairing_code: String(100000 + Math.floor(Math.random() * 900000)), paired_at: null, last_seen_at: null, created_at: iso(now()) }; terminals.unshift(t); return [201, t]; });
on('PUT', `${M}/terminals/:id`, (q, b, p) => { const t = terminals.find(x => x.terminal_id === p.id); if (!t) return [404, { error: 'Terminal introuvable' }]; Object.assign(t, { terminal_name: b.terminalName || t.terminal_name, device_model: b.deviceModel || t.device_model }); return [200, t]; });
on('DELETE', `${M}/terminals/:id`, (q, b, p) => { const t = terminals.find(x => x.terminal_id === p.id); if (t) t.status = 'inactive'; return [200, { success: true }]; });
on('POST', `${M}/terminals/:id/regenerate-code`, (q, b, p) => { const t = terminals.find(x => x.terminal_id === p.id); if (!t) return [404, { error: 'Terminal introuvable' }]; t.pairing_code = String(100000 + Math.floor(Math.random() * 900000)); t.paired_at = null; return [200, { success: true, terminalId: t.terminal_id, pairingCode: t.pairing_code }]; });

on('GET', `${M}/api-keys`, () => [200, { data: apiKeys.map(k => ({ ...k, api_key: k.key_prefix + '****' })) }]);
on('POST', `${M}/api-keys`, (q, b) => { const key = 'sk_live_' + crypto.randomBytes(24).toString('hex'); const k = { key_id: 'k-' + Date.now(), key_name: b.keyName, key_prefix: key.slice(0, 12), permissions: b.permissions || [], is_active: true, last_used_at: null, expires_at: null, created_at: iso(now()), legacy_plaintext: false }; apiKeys.unshift(k); return [201, { success: true, key: { ...k, api_key: key, api_secret: 'sk_secret_' + crypto.randomBytes(32).toString('hex') } }]; });
on('DELETE', `${M}/api-keys/:id/permanent`, (q, b, p) => { const i = apiKeys.findIndex(k => k.key_id === p.id); if (i >= 0) apiKeys.splice(i, 1); return [200, { success: true }]; });
on('DELETE', `${M}/api-keys/:id`, (q, b, p) => { const k = apiKeys.find(x => x.key_id === p.id); if (k) k.is_active = false; return [200, { success: true }]; });
on('GET', `${M}/webhook-config`, () => [200, webhook]);
on('PATCH', `${M}/webhook-config`, (q, b) => { if (!/^https:\/\//.test(b.webhookUrl || '')) return [422, { error: 'URL https:// requise', code: 'UNSAFE_WEBHOOK_URL' }]; const fresh = !webhook.webhook_secret.configured || b.rotateSecret; webhook = { webhook_url: b.webhookUrl, webhook_secret: { configured: true } }; return [200, { success: true, ...webhook, ...(fresh && { webhook_secret: { configured: true, value: crypto.randomBytes(32).toString('hex') } }) }]; });
on('POST', `${M}/webhook-config/test`, () => [200, { success: true }]);
on('GET', `${M}/integrations`, () => [200, { data: integrations }]);
on('POST', `${M}/integrations`, (q, b) => { const i = { integration_id: 'int-' + Date.now(), integration_type: b.integrationType, provider: b.provider, display_name: b.displayName, endpoint_url: b.endpointUrl, auth_type: b.authType, auth_config: { configured: true }, event_types: b.eventTypes, status: b.status, signing_secret: crypto.randomBytes(4).toString('hex') + '...', created_at: iso(now()), updated_at: iso(now()) }; integrations.unshift(i); return [201, i]; });
on('PUT', `${M}/integrations/:id`, (q, b, p) => { const i = integrations.find(x => x.integration_id === p.id); if (!i) return [404, { error: 'Integration introuvable' }]; Object.assign(i, { integration_type: b.integrationType, provider: b.provider, display_name: b.displayName, endpoint_url: b.endpointUrl, auth_type: b.authType, event_types: b.eventTypes, status: b.status, updated_at: iso(now()) }); return [200, i]; });

on('GET', `${M}/account`, () => [200, merchant]);
on('PUT', `${M}/account`, (q, b) => { Object.assign(merchant, { first_name: b.firstName ?? merchant.first_name, last_name: b.lastName ?? merchant.last_name, phone: b.phone ?? merchant.phone }); return [200, { success: true }]; });
on('GET', `${M}/kyb`, () => [200, { documents: kybDocs }]);
on('POST', `${M}/kyb/documents`, (q, b) => { const d = { doc_id: 'd-' + Date.now(), doc_type: b.docType, doc_label: b.docLabel, file_name: b.fileName, status: 'pending', uploaded_at: iso(now()) }; kybDocs.unshift(d); return [201, d]; });
on('GET', `${M}/bank-accounts`, () => [200, { data: bankAccounts, total: bankAccounts.length }]);
on('POST', `${M}/bank-accounts`, (q, b) => { const inst = institutions.find(i => i.institution_id === b.institutionId); const a = { accountId: 'ba-' + Date.now(), accountNumber: String(b.accountNumber).replace(/.(?=.{4})/g, '*'), accountName: String(b.accountName).toUpperCase(), status: 'verified', isDefault: bankAccounts.length === 0, institution: inst ? { name: inst.name, code: inst.code, type: inst.type, country: inst.country } : null }; bankAccounts.push(a); return [200, a]; });
on('DELETE', `${M}/bank-accounts/:id`, (q, b, p) => { const i = bankAccounts.findIndex(a => a.accountId === p.id); if (i >= 0) bankAccounts.splice(i, 1); return [200, { success: true }]; });
on('GET', `${M}/support/tickets`, () => [200, { data: tickets.map(({ messages, ...t }) => t), total: tickets.length }]);
on('POST', `${M}/support/tickets`, (q, b) => { const t = { ticket_id: 't-' + Date.now(), ticket_number: 'TKT-' + Date.now().toString(36).toUpperCase(), subject: b.subject, priority: b.priority || 'normal', status: 'open', created_at: iso(now()), last_message_at: iso(now()), messages: [{ message_id: 'm-' + Date.now(), sender_type: 'merchant', sender_name: merchant.business_name, message: b.message, created_at: iso(now()), attachments: '[]' }] }; tickets.unshift(t); return [201, t]; });
on('GET', `${M}/support/tickets/:id`, (q, b, p) => { const t = tickets.find(x => x.ticket_id === p.id); return t ? [200, { ...t, ticket: t, messages: t.messages }] : [404, { error: 'Ticket introuvable' }]; });
on('POST', `${M}/support/tickets/:id/messages`, (q, b, p) => { const t = tickets.find(x => x.ticket_id === p.id); if (!t) return [404, { error: 'Ticket introuvable' }]; const m = { message_id: 'm-' + Date.now(), sender_type: 'merchant', sender_name: merchant.business_name, message: b.message, created_at: iso(now()), attachments: JSON.stringify(b.attachments || []) }; t.messages.push(m); if (t.status === 'pending_merchant') t.status = 'open'; t.last_message_at = m.created_at; return [201, m]; });
on('PATCH', `${M}/support/tickets/:id/resolve`, (q, b, p) => { const t = tickets.find(x => x.ticket_id === p.id); if (t) t.status = 'resolved'; return [200, { success: true }]; });

// ─── Serveur ──────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain', '.woff2': 'font/woff2' };
const serveStatic = (urlPath, res) => {
  const root = path.resolve(STATIC);
  let file = path.join(root, decodeURIComponent(urlPath.split('?')[0]));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
};
http.createServer((req, res) => {
  const origin = req.headers.origin;
  const cors = origin ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key', 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', Vary: 'Origin' } : {};
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const [pathname, qs] = req.url.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  const route = routes.find(r => r.method === req.method && r.re.test(pathname));
  if (!route) {
    if (STATIC && req.method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(pathname, res);
    res.writeHead(404, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Route inconnue (mock)', code: 'NOT_FOUND' }));
  }
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch (e) { body = {}; }
    const params = pathname.match(route.re).groups || {};
    const protectedRoute = pathname.startsWith('/api/v1/merchant/') && !/\/auth\/(login|refresh|register|2fa\/validate|forgot-password|reset-password)$|\/institutions$/.test(pathname);
    if (protectedRoute && !(req.headers.authorization || '').startsWith('Bearer ')) { res.writeHead(401, { ...cors, 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Non authentifié', code: 'MISSING_TOKEN' })); }
    const [status, payload, type] = route.handler(query, body, params) || [204, null];
    const delay = 120 + Math.random() * 250;
    setTimeout(() => {
      if (payload === null || payload === undefined) { res.writeHead(status, cors); return res.end(); }
      res.writeHead(status, { ...cors, 'Content-Type': type || 'application/json; charset=utf-8', 'Set-Cookie': 'cp_rt_merchant=mock; Path=/; HttpOnly; SameSite=Lax' });
      res.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
    }, delay);
  });
}).listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`C-Pay mock API : http://127.0.0.1:${PORT}${STATIC ? ` (bundle servi depuis ${STATIC})` : ''}\n` + `Connexion : n'importe quel e-mail / mot de passe « secret » (e-mail contenant « mfa » → code 123456)\n`);
});
