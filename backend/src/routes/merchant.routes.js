const { notify } = require('../services/notifications');
/**
 * Routes Marchands — CPlus 2.6.0 (portail web)
 * Toutes les routes nécessitent merchantAuth
 */
'use strict';

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const { query, withTransaction } = require('../config/database');

// === Regles metier CPay (velocite, limites, frais) ===
const OPERATOR_LIMITS = { airtel: 1000000, mtn: 1000000 };
const FEE_RATES = { collect: 0.015, disburse: 0.01, payout: 0.01 };
const CONFIRM_TIMEOUT_MS = 30000;

function computeFees(amount, rate, status) {
  if (status !== 'authorized') return { fee: 0, net: 0 };
  const fee = Math.round(amount * rate);
  return { fee, net: amount - fee };
}

async function checkVelocity(merchantId, amount, type) {
  const m = await query(`SELECT velocity_max_per_txn, velocity_max_daily_amount,
    velocity_max_daily_count, velocity_max_monthly_amount, velocity_max_monthly_count
    FROM merchants WHERE merchant_id=$1`, [merchantId]);
  if (!m.rows.length) return null;
  const v = m.rows[0];
  if (v.velocity_max_per_txn && amount > parseFloat(v.velocity_max_per_txn))
    return `Montant superieur a la limite par transaction (${v.velocity_max_per_txn} XAF)`;
  const day = await query(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS s
    FROM transactions WHERE merchant_id=$1 AND type=$2 AND status='authorized'
    AND initiated_at::date = CURRENT_DATE`, [merchantId, type]);
  const dn = parseInt(day.rows[0].n), ds = parseFloat(day.rows[0].s);
  if (v.velocity_max_daily_count && dn >= v.velocity_max_daily_count)
    return `Limite quotidienne de transactions atteinte (${v.velocity_max_daily_count})`;
  if (v.velocity_max_daily_amount && (ds + amount) > parseFloat(v.velocity_max_daily_amount))
    return `Limite quotidienne de montant atteinte (${v.velocity_max_daily_amount} XAF)`;
  const mon = await query(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS s
    FROM transactions WHERE merchant_id=$1 AND type=$2 AND status='authorized'
    AND date_trunc('month', initiated_at) = date_trunc('month', CURRENT_DATE)`, [merchantId, type]);
  const mn = parseInt(mon.rows[0].n), ms = parseFloat(mon.rows[0].s);
  if (v.velocity_max_monthly_count && mn >= v.velocity_max_monthly_count)
    return `Limite mensuelle de transactions atteinte (${v.velocity_max_monthly_count})`;
  if (v.velocity_max_monthly_amount && (ms + amount) > parseFloat(v.velocity_max_monthly_amount))
    return `Limite mensuelle de montant atteinte (${v.velocity_max_monthly_amount} XAF)`;
  return null;
}

// Recupere le taux de frais applicable (marchand puis defaut)
async function getFeeRate(merchantId, txnType, operator) {
  try {
    const r = await query(
      `SELECT fee_rate FROM merchant_fees
       WHERE (merchant_id=$1 OR merchant_id IS NULL) AND txn_type=$2 AND operator=$3
       ORDER BY merchant_id NULLS LAST LIMIT 1`,
      [merchantId, txnType, operator]);
    if (r.rows.length) return parseFloat(r.rows[0].fee_rate);
  } catch (e) { console.error('[getFeeRate]', e.message); }
  // Fallback ultime si table indisponible
  const def = { collect: 0.04, disburse: 0.04, payout: 0.04 };
  return def[txnType] || 0.04;
}

// Polling automatique echelonne du statut Airtel (30s, 1min, 3min) apres une collecte
function scheduleAirtelDisbPolling(transactionId, airtelTxId) {
  const delays = [5000, 10000, 15000, 20000, 25000];
  const cfg = {
    baseUrl:   process.env.AIRTEL_CG_BASE_URL,
    apiKey:    process.env.AIRTEL_CG_DISB_CLIENT_ID,
    apiSecret: process.env.AIRTEL_CG_DISB_CLIENT_SECRET,
    env:       process.env.AIRTEL_CG_ENV,
  };
  delays.forEach(d => setTimeout(async () => {
    try {
      const row = await query(`SELECT status FROM transactions WHERE transaction_id=$1`, [transactionId]);
      if (!row.rows.length || row.rows[0].status !== 'pending') return;
      const airtel = require('../services/mobilemoney/providers/airtel.provider');
      const s = await airtel.queryDisbursement({ txId: airtelTxId, currency: 'XAF', config: cfg });
      if (s.success) {
        const auth = 'DSB' + Math.random().toString(36).slice(2, 8).toUpperCase();
        await query(`UPDATE transactions SET status='authorized', auth_code=$1, response_message='Transfert Airtel effectue', gateway_order_id=COALESCE($3, gateway_order_id), provider_raw_response=$4, fee_amount=calc_fee(merchant_id,'payout',detected_operator,amount), net_amount=amount-calc_fee(merchant_id,'payout',detected_operator,amount), completed_at=NOW() WHERE transaction_id=$2`, [auth, transactionId, s.airtelMoneyId || null, s.rawResponse || null]);
      } else if (s.failed) {
        const msg = s.rawStatus === 'TE' ? 'Delai de transfert Airtel depasse.' : (s.message || 'Transfert Airtel echoue.');
        await query(`UPDATE transactions SET status='failed', response_message=$1, provider_raw_response=$3, completed_at=NOW() WHERE transaction_id=$2`, [msg, transactionId, s.rawResponse || null]);
      }
    } catch (e) { console.error('[airtel disb polling]', e.message); }
  }, d));
  // Regle: timeout 30s - dernier check operateur avant echec
  setTimeout(async () => {
    try {
      const row = await query(`SELECT status FROM transactions WHERE transaction_id=$1`, [transactionId]);
      if (!row.rows.length || row.rows[0].status !== 'pending') return;
      const airtel = require('../services/mobilemoney/providers/airtel.provider');
      const s = await airtel.queryDisbursement({ txId: airtelTxId, currency: 'XAF', config: cfg });
      if (s.success) {
        const auth = 'DSB' + Math.random().toString(36).slice(2, 8).toUpperCase();
        await query(`UPDATE transactions SET status='authorized', auth_code=$1, response_message='Transfert Airtel effectue', gateway_order_id=COALESCE($3, gateway_order_id), provider_raw_response=$4, fee_amount=calc_fee(merchant_id,'payout',detected_operator,amount), net_amount=amount-calc_fee(merchant_id,'payout',detected_operator,amount), completed_at=NOW() WHERE transaction_id=$2 AND status='pending'`, [auth, transactionId, s.airtelMoneyId || null, s.rawResponse || null]);
      } else {
        const msg = s.failed ? (s.message || 'Transfert echoue') : 'Timeout: aucune confirmation Airtel/MTN sous 30s';
        await query(`UPDATE transactions SET status='failed', response_message=$1, provider_raw_response=$3, gateway_order_id=COALESCE($4, gateway_order_id), fee_amount=0, net_amount=0, completed_at=NOW() WHERE transaction_id=$2 AND status='pending'`, [msg, transactionId, s.rawResponse || null, s.airtelMoneyId || null]);
      }
    } catch (e) {
      console.error('[airtel disb timeout]', e.message);
      try {
        await query(`UPDATE transactions SET status='failed', response_message='Timeout: confirmation non recue sous 30s (check operateur indisponible)', fee_amount=0, net_amount=0, completed_at=NOW() WHERE transaction_id=$1 AND status='pending'`, [transactionId]);
      } catch (e2) { console.error('[airtel disb timeout fallback]', e2.message); }
    }
  }, 30000);
}

function scheduleAirtelPolling(transactionId, airtelTxId) {
  const delays = [5000, 10000, 15000, 20000, 25000];
  const cfg = {
    baseUrl:   process.env.AIRTEL_CG_BASE_URL,
    apiKey:    process.env.AIRTEL_CG_COLL_CLIENT_ID,
    apiSecret: process.env.AIRTEL_CG_COLL_CLIENT_SECRET,
    env:       process.env.AIRTEL_CG_ENV,
  };
  delays.forEach(d => setTimeout(async () => {
    try {
      const row = await query(`SELECT status FROM transactions WHERE transaction_id=$1`, [transactionId]);
      if (!row.rows.length || row.rows[0].status !== 'pending') return;
      const airtel = require('../services/mobilemoney/providers/airtel.provider');
      const s = await airtel.queryTransaction({ txId: airtelTxId, currency: 'XAF', config: cfg });
      if (s.success) {
        const auth = 'AUTH' + Math.random().toString(36).slice(2, 8).toUpperCase();
        await query(`UPDATE transactions SET status='authorized', auth_code=$1, response_message='Paiement Airtel confirme', gateway_order_id=COALESCE($3, gateway_order_id), provider_raw_response=$4, fee_amount=calc_fee(merchant_id,'collect',detected_operator,amount), net_amount=amount-calc_fee(merchant_id,'collect',detected_operator,amount), completed_at=NOW() WHERE transaction_id=$2`, [auth, transactionId, s.airtelMoneyId || null, s.rawResponse || null]);
        try { const { settleTransaction } = require('../services/settlement.service'); settleTransaction(transactionId).catch(e => console.error('[settlement]', e.message)); } catch(e){}
      } else if (s.failed) {
        const msg = s.rawStatus === 'TE' ? 'Delai de confirmation Airtel depasse.' : (s.message || 'Paiement Airtel echoue.');
        await query(`UPDATE transactions SET status='failed', response_message=$1, completed_at=NOW() WHERE transaction_id=$2`, [msg, transactionId]);
      }
    } catch (e) { console.error('[airtel polling]', e.message); }
  }, d));
  // Regle: timeout 30s - dernier check operateur avant echec
  setTimeout(async () => {
    try {
      const row = await query(`SELECT status FROM transactions WHERE transaction_id=$1`, [transactionId]);
      if (!row.rows.length || row.rows[0].status !== 'pending') return;
      const airtel = require('../services/mobilemoney/providers/airtel.provider');
      const s = await airtel.queryTransaction({ txId: airtelTxId, currency: 'XAF', config: cfg });
      if (s.success) {
        const auth = 'AUTH' + Math.random().toString(36).slice(2, 8).toUpperCase();
        await query(`UPDATE transactions SET status='authorized', auth_code=$1, response_message='Paiement Airtel confirme', gateway_order_id=COALESCE($3, gateway_order_id), provider_raw_response=$4, fee_amount=calc_fee(merchant_id,'collect',detected_operator,amount), net_amount=amount-calc_fee(merchant_id,'collect',detected_operator,amount), completed_at=NOW() WHERE transaction_id=$2 AND status='pending'`, [auth, transactionId, s.airtelMoneyId || null, s.rawResponse || null]);
      } else {
        const msg = s.failed ? (s.message || 'Transaction echouee') : 'Timeout: aucune confirmation Airtel/MTN sous 30s';
        await query(`UPDATE transactions SET status='failed', response_message=$1, provider_raw_response=$3, gateway_order_id=COALESCE($4, gateway_order_id), fee_amount=0, net_amount=0, completed_at=NOW() WHERE transaction_id=$2 AND status='pending'`, [msg, transactionId, s.rawResponse || null, s.airtelMoneyId || null]);
      }
    } catch (e) {
      console.error('[airtel timeout]', e.message);
      // Fallback: si le check operateur echoue, on ne laisse pas pending indefiniment
      try {
        await query(`UPDATE transactions SET status='failed', response_message='Timeout: confirmation non recue sous 30s (check operateur indisponible)', fee_amount=0, net_amount=0, completed_at=NOW() WHERE transaction_id=$1 AND status='pending'`, [transactionId]);
      } catch (e2) { console.error('[airtel timeout fallback]', e2.message); }
    }
  }, 30000);
}
// WAVE-2 : module d'auth unique (audit §1.1) — aucun jwt.sign/verify local
const {
  merchantAuth, issueSession, rotateRefresh, revokeRefreshToken, revokeAll,
  readRefreshToken, clearRefreshCookie, signMfaToken, verifyMfaToken, verifyTotp, buildTotpEnrollment,
} = require('../middleware/auth');
const logger  = require('../config/logger');
const { detectFromPhone, normalizePhone } = require('../services/detection/detection.engine');
const { assignMerchantCountryDefaults } = require('../services/config/country-defaults');
const ticketing = require('../services/support/ticketing.service');
const integrations = require('../services/integrations/integration.service');
const tokenVault = require('../services/tokenization/token-vault.service');
const pilotControl = require('../services/pilot/pilot-control.service');
const { idempotency } = require('../middleware/idempotency');
const rateLimit = require('express-rate-limit');

// ═══════════════════════════════════════════════════════════════════
// HOTFIX WAVE-1 (audit prod 2.6.0) — helpers partages
// ═══════════════════════════════════════════════════════════════════

// Endpoints qui creaient de la valeur sans mouvement reel d'argent : desactives
// (410 Gone) jusqu'a l'integration operateur. Aucune ecriture en base.
const FEATURE_DISABLED_BODY = Object.freeze({
  error: 'Fonctionnalité désactivée en attendant l’intégration opérateur',
  code: 'FEATURE_DISABLED',
});
const featureDisabled = (res) => res.status(410).json(FEATURE_DISABLED_BODY);

// Pagination bornee : page >= 1, 1 <= limit <= 100 (audit §3.12)
const parsePagination = (q = {}, defaultLimit = 25) => {
  let page = parseInt(q.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  let limit = parseInt(q.limit, 10);
  if (!Number.isFinite(limit)) limit = defaultLimit;
  limit = Math.min(100, Math.max(1, limit));
  return { page, limit, offset: (page - 1) * limit };
};

// Numero de telephone : E.164 strict (+ indicatif, 8 a 15 chiffres) via normalizePhone
const E164_RE = /^\+[1-9]\d{7,14}$/;
const toE164 = (phone) => {
  if (phone === undefined || phone === null) return null;
  const n = normalizePhone(String(phone));
  return n && E164_RE.test(n) ? n : null;
};

// Rate limit des envois SMS/WhatsApp : 20 / heure / marchand (anti SMS pumping, audit §2.19)
const smsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => `sms:${req.user?.merchantId || req.user?.sub || 'anonymous'}`,
  // la cle n'est pas l'IP : les validations liees a l'IP / au proxy ne s'appliquent pas
  validate: { ip: false, trustProxy: false, xForwardedForHeader: false },
  // POST /pay-links sans destinataire n'envoie rien : ne consomme pas le quota
  skip: (req) => req.method === 'POST' && /^\/pay-links\/?$/.test(req.path) && !req.body?.recipientPhone,
  handler: (req, res) => res.status(429).json({ error: 'Trop d’envois, reessayez plus tard (20/heure)', code: 'SMS_RATE_LIMITED' }),
});

// Pay links : shortId cryptographique + reprise sur collision (audit §3.11)
const SHORT_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const generateShortId = (len = 8) =>
  Array.from({ length: len }, () => SHORT_ID_ALPHABET[crypto.randomInt(SHORT_ID_ALPHABET.length)]).join('');
const withShortIdRetry = async (insertFn, attempts = 5) => {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const shortId = generateShortId();
    try { return await insertFn(shortId); }
    catch (e) {
      lastErr = e;
      if (e.code !== '23505') throw e; // seule la violation d'unicite est rejouee
    }
  }
  throw lastErr;
};
// expiresIn en heures : 1 h .. 30 j (720 h)
const parseExpiresIn = (v, def = 24) => {
  if (v === undefined || v === null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 720) return null;
  return n;
};

// Solde disponible — formule UNIQUE partagee par GET /balance, POST /transfer/payout,
// POST /disburse et la caisse (WAVE-4) : services/cash/cash.service.js
// (+ encaissements autorises non regles, + approvisionnements completed,
//  − merchant_transfers payout non echoues, − transactions payout).
const cash = require('../services/cash/cash.service');
const { computeAvailableBalance } = cash;

// Cles API : seul le SHA-256 est stocke (audit §2.9)
const hashApiKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
const apiKeyPrefix = (key) => String(key).slice(0, 12);
const safeEqualHex = (a, b) => {
  const ba = Buffer.from(String(a || ''), 'hex'), bb = Buffer.from(String(b || ''), 'hex');
  return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

// ═══════════════════════════════════════════════════════════════════
// WAVE-2 — AUTH MARCHAND (sessions unifiees, 2FA, hygiene mots de passe)
// ═══════════════════════════════════════════════════════════════════

// Rate limits dedies (audit §2.19) — par IP, dans le routeur
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Trop d’inscriptions depuis cette adresse, réessayez plus tard', code: 'RATE_LIMITED' }),
});
const pairLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Trop de tentatives d’appairage, réessayez plus tard', code: 'RATE_LIMITED' }),
});

// Colonnes explicites : jamais password_hash / mfa_secret dans une reponse (audit §2.12)
const MERCHANT_USER_COLS = `u.user_id, u.merchant_id, u.email, u.phone, u.first_name, u.last_name, u.role, u.is_active,
              u.mfa_enabled, u.temp_password, u.failed_attempts, u.locked_until, u.last_login_at, u.created_at,
              m.business_name, m.currency, m.kyb_level, m.merchant_status, m.country`;

const merchantClaims = (user) => ({
  type: 'merchant', merchantId: user.merchant_id, role: user.role,
  businessName: user.business_name, country: user.country, currency: user.currency,
});

const merchantProfile = (user) => ({
  userId: user.user_id, firstName: user.first_name, lastName: user.last_name,
  email: user.email, role: user.role,
  merchantId: user.merchant_id, businessName: user.business_name,
  currency: user.currency, country: user.country, kybLevel: user.kyb_level,
  mfaEnabled: !!user.mfa_enabled,
});

// Session complete apres authentification (login, 2FA validee, inscription).
// refresh_token reste dans le JSON pour ne pas casser les portails non encore
// migres vers le cookie — il sera retire en phase 3.
const merchantSessionResponse = async ({ req, res, user, status = 200, extra = {} }) => {
  const session = await issueSession({ actorType: 'merchant', actorId: user.user_id, claims: merchantClaims(user), req, res });
  res.status(status).json({
    ...session,
    mustChangePassword: !!user.temp_password,
    user: merchantProfile(user),
    ...extra,
  });
};

// ─── LOGIN MARCHAND ───────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  const { emailOrPhone, password } = req.body;
  if (!emailOrPhone || !password) return res.status(422).json({ error: 'Identifiants requis' });

  try {
    const result = await query(
      `SELECT ${MERCHANT_USER_COLS}, u.password_hash, u.mfa_secret
       FROM merchant_users u
       JOIN merchants m ON u.merchant_id = m.merchant_id
       WHERE (u.email = $1 OR u.phone = $1) AND u.is_active = TRUE LIMIT 1`,
      [emailOrPhone.trim()]
    );

    if (!result.rows.length) return res.status(401).json({ error: 'Identifiants incorrects' });

    const user = result.rows[0];

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({ error: 'Compte temporairement verrouille', lockedUntil: user.locked_until });
    }
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      const attempts = (user.failed_attempts || 0) + 1;
      const lockUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await query(`UPDATE merchant_users SET failed_attempts=$1, locked_until=$2 WHERE user_id=$3`, [attempts, lockUntil, user.user_id]).catch(() => {});
      return res.status(401).json({ error: 'Identifiants incorrects', attemptsLeft: Math.max(0, 5 - attempts) });
    }
    await query(`UPDATE merchant_users SET failed_attempts=0, locked_until=NULL, last_login_at=NOW() WHERE user_id=$1`, [user.user_id]).catch(() => {});

    if (user.merchant_status === 'suspended') {
      return res.status(403).json({ error: 'Compte suspendu — contactez le support', code: 'SUSPENDED' });
    }

    // 2FA active : pas de session tant que le code TOTP n'est pas valide
    // (POST /auth/2fa/validate). Le jeton MFA vaut 5 minutes.
    if (user.mfa_enabled && user.mfa_secret) {
      const mfaToken = signMfaToken({ actorType: 'merchant', sub: user.user_id });
      return res.json({ mfaRequired: true, mfaToken });
    }

    // NE PAS vérifier les APIs ici — juste l'utilisateur en DB
    await merchantSessionResponse({ req, res, user });
  } catch (err) {
    logger.error('Merchant login error', { err: err.message });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── 2FA : validation du code apres login (emet la session) ──────
router.post('/auth/2fa/validate', async (req, res) => {
  const { mfaToken, code } = req.body;
  if (!mfaToken || !code) return res.status(422).json({ error: 'mfaToken et code requis' });
  try {
    let payload;
    try { payload = verifyMfaToken(mfaToken, 'merchant'); }
    catch (e) { return res.status(401).json({ error: e.message, code: e.code }); }

    const r = await query(
      `SELECT ${MERCHANT_USER_COLS}, u.mfa_secret
       FROM merchant_users u JOIN merchants m ON u.merchant_id = m.merchant_id
       WHERE u.user_id = $1 AND u.is_active = TRUE LIMIT 1`, [payload.sub]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'Utilisateur introuvable' });
    if (user.merchant_status === 'suspended') return res.status(403).json({ error: 'Compte suspendu — contactez le support', code: 'SUSPENDED' });
    if (!user.mfa_secret) return res.status(400).json({ error: '2FA non configuré' });
    if (!verifyTotp(user.mfa_secret, code)) return res.status(401).json({ error: 'Code 2FA invalide', code: 'INVALID_TOTP' });

    await merchantSessionResponse({ req, res, user });
  } catch (err) {
    logger.error('Merchant 2FA validate error', { err: err.message });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── PROFIL (sans secrets) ────────────────────────────────────────
router.get('/auth/me', merchantAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT ${MERCHANT_USER_COLS}
       FROM merchant_users u JOIN merchants m ON u.merchant_id = m.merchant_id
       WHERE u.user_id = $1 LIMIT 1`, [req.user.sub]);
    if (!r.rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    res.json({ user: merchantProfile(r.rows[0]), mustChangePassword: !!r.rows[0].temp_password });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/auth/register', registerLimiter, async (req, res) => {
  const {
    businessName, rccm, nif, phone, email, password,
    settlementType = 'mobile_money', settlementAccount, settlementProvider,
    walletMtn, walletAirtel, bankAccount, bankName, iban,
  } = req.body;

  if (!businessName || !phone || !email || !password) {
    return res.status(422).json({ error: 'businessName, phone, email et password requis' });
  }
  if (!walletMtn && !walletAirtel && !bankAccount) {
    return res.status(422).json({ error: 'Au moins un wallet (MTN ou Airtel) ou un compte bancaire est requis', code: 'WALLET_REQUIRED' });
  }
  if (password.length < 10) {
    return res.status(422).json({ error: 'Mot de passe trop court', code: 'WEAK_PASSWORD' });
  }

  const detection = detectFromPhone(phone);
  if (!detection.success) {
    return res.status(422).json({ error: detection.error, code: 'UNSUPPORTED_PHONE' });
  }

  const { withTransaction } = require('../config/database');
  try {
    const created = await withTransaction(async (client) => {
      const passwordHash = await bcrypt.hash(password, 12);
      const merchant = await client.query(
        `INSERT INTO merchants
          (business_name, rccm, nif, phone, email, country, currency, settlement_type, settlement_account, settlement_provider,
           wallet_mtn, wallet_airtel, bank_account, bank_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING merchant_id, business_name, country, currency, kyb_level`,
        [
          businessName.trim(), rccm || null, nif || null, phone.trim(), email.toLowerCase().trim(),
          detection.country, detection.currency, settlementType, settlementAccount || phone.trim(), settlementProvider || detection.brand,
          walletMtn ? walletMtn.replace(/\s/g, '') : null, walletAirtel ? walletAirtel.replace(/\s/g, '') : null,
          bankAccount ? (bankAccount.trim() + (iban ? ' | IBAN: ' + iban.replace(/\s/g, '').toUpperCase() : '')) : (iban ? 'IBAN: ' + iban.replace(/\s/g, '').toUpperCase() : null),
          bankName ? bankName.trim() : null,
        ]
      );
      const merchantRow = merchant.rows[0];
      const apiDefaults = await assignMerchantCountryDefaults({
        merchantId: merchantRow.merchant_id,
        country: merchantRow.country,
        client,
      });
      const user = await client.query(
        `INSERT INTO merchant_users (merchant_id, email, phone, password_hash, first_name, role)
         VALUES ($1,$2,$3,$4,$5,'owner')
         RETURNING user_id, email, first_name, role`,
        [merchantRow.merchant_id, email.toLowerCase().trim(), phone.trim(), passwordHash, businessName.trim()]
      );
      return { merchant: merchantRow, user: user.rows[0], apiDefaults };
    });

    // Access 15 min (etait 8 h a l'inscription — audit §2.16), refresh en cookie
    await merchantSessionResponse({
      req, res, status: 201,
      user: { ...created.user, ...created.merchant, temp_password: false },
      extra: { apiDefaults: created.apiDefaults },
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email ou telephone deja utilise' });
    logger.error('Merchant register error', { err: err.message });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/auth/refresh', async (req, res) => {
  // Cookie d'abord, corps en repli tant que les portails ne sont pas migres.
  const refreshToken = readRefreshToken(req, 'merchant');
  if (!refreshToken) return res.status(422).json({ error: 'refreshToken requis' });

  try {
    const tokens = await rotateRefresh({
      actorType: 'merchant', token: refreshToken, req, res,
      buildClaims: async ({ actorId }) => {
        const r = await query(
          `SELECT u.user_id, u.role, m.merchant_id, m.business_name, m.country, m.currency
           FROM merchant_users u JOIN merchants m ON u.merchant_id = m.merchant_id
           WHERE u.user_id = $1 AND u.is_active = TRUE AND m.merchant_status = 'active'`,
          [actorId]
        );
        if (!r.rows.length) throw new Error('Utilisateur introuvable');
        return merchantClaims(r.rows[0]);
      },
    });
    res.json({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in });
  } catch (err) {
    res.status(err.statusCode || 401).json({ error: 'Refresh token invalide', code: err.code || 'INVALID_REFRESH' });
  }
});

router.post('/auth/logout', async (req, res) => {
  await revokeRefreshToken(readRefreshToken(req, 'merchant'));
  clearRefreshCookie(res, 'merchant');
  res.json({ success: true });
});

// ─── PROFIL COMPTE ────────────────────────────────────────────────
router.get('/account', merchantAuth, async (req, res) => {
  const result = await query(
    `SELECT m.*, u.email, u.first_name, u.last_name, u.phone, u.role
     FROM merchants m
     JOIN merchant_users u ON m.merchant_id = u.merchant_id AND u.user_id = $1
     WHERE m.merchant_id = $2`,
    [req.user.sub, req.user.merchantId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Compte introuvable' });
  const row = result.rows[0];
  // Ne jamais retourner le password_hash
  delete row.password_hash;
  res.json(row);
});

router.put('/account', merchantAuth, async (req, res) => {
  const destinationFields = ['settlementType', 'settlementAccount', 'settlementProvider', 'walletMtn', 'walletAirtel', 'bankAccount', 'bankName'];
  if (destinationFields.some(key => Object.prototype.hasOwnProperty.call(req.body, key))) {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Seul le propriétaire peut modifier le bénéficiaire', code: 'INSUFFICIENT_ROLE' });
    const step = await require('../services/cash/cash.service').verifyStepUp({ userId: req.user.sub, confirm: req.body.confirm });
    if (!step.ok) return res.status(step.status).json(step.body);
    if (req.body.settlementType && !['bank', 'mobile_money'].includes(req.body.settlementType)) {
      return res.status(422).json({ error: 'Type de règlement invalide', code: 'VALIDATION_ERROR' });
    }
    if (req.body.settlementType === 'mobile_money' || req.body.settlementAccount) {
      const current = await query('SELECT currency, country, settlement_type FROM merchants WHERE merchant_id=$1', [req.user.merchantId]);
      const m = current.rows[0];
      if (!m) return res.status(404).json({ error: 'Marchand introuvable' });
      if ((req.body.settlementType || m.settlement_type) === 'mobile_money' && req.body.settlementAccount) {
        const wallet = require('../services/cash/cash.service').detectWallet(req.body.settlementAccount, { country: m.country });
        if (!wallet.success || wallet.currency !== m.currency) return res.status(422).json({ error: 'Wallet de règlement invalide ou devise incompatible', code: 'CURRENCY_MISMATCH' });
        req.body.settlementAccount = wallet.phone;
      }
    }
  }
  const { firstName, lastName, phone, settlementType, settlementAccount, settlementProvider,
          walletMtn, walletAirtel, bankAccount, bankName } = req.body;
  await withTransaction(async client => {
    const query = (sql, params) => client.query(sql, params);
    const destinationChanged = destinationFields.some(key => Object.prototype.hasOwnProperty.call(req.body,key));
    if (destinationChanged) await query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(req.user.merchantId)]);
    await query(
      `UPDATE merchant_users SET first_name = COALESCE($1, first_name), last_name = COALESCE($2, last_name),
       phone = COALESCE($3, phone) WHERE user_id = $4`,
      [firstName, lastName, phone, req.user.sub]
    );
    // CR#3 : mise a jour des wallets de reglement
    if (walletMtn !== undefined || walletAirtel !== undefined || bankAccount !== undefined || bankName !== undefined) {
      await query(
        `UPDATE merchants SET
           wallet_mtn    = COALESCE($1, wallet_mtn),
           wallet_airtel = COALESCE($2, wallet_airtel),
           bank_account  = COALESCE($3, bank_account),
           bank_name     = COALESCE($4, bank_name), updated_at = NOW()
         WHERE merchant_id = $5`,
        [walletMtn || null, walletAirtel || null, bankAccount || null, bankName || null, req.user.merchantId]
      );
    }
    if (settlementType || settlementAccount || settlementProvider) {
      await query(
        `UPDATE merchants SET settlement_type = COALESCE($1::settlement_type, settlement_type),
         settlement_account = COALESCE($2, settlement_account),
         settlement_provider = COALESCE($3, settlement_provider), updated_at = NOW()
         WHERE merchant_id = $4`,
        [settlementType, settlementAccount, settlementProvider, req.user.merchantId]
      );
    }
    if (destinationChanged) await query(
      `INSERT INTO audit_logs (actor_type,actor_id,actor_email,action,entity_type,entity_id,new_values,ip_address)
       VALUES ('merchant',$1,$2,'SETTLEMENT_DESTINATION_CHANGED','merchant',$3,$4,$5)`,
      [req.user.sub,req.user.email,req.user.merchantId,JSON.stringify({ fields: destinationFields.filter(key => Object.prototype.hasOwnProperty.call(req.body,key)) }),req.ip]);
  });
  res.json({ success: true });
});

// ─── HISTORIQUE TRANSACTIONS ──────────────────────────────────────
router.get('/transactions', merchantAuth, async (req, res) => {
  const { status, type, dateFrom, dateTo, terminalId } = req.query;
  const { page, limit, offset } = parsePagination(req.query, 25);
  const params = [req.user.merchantId];
  let where = 'WHERE merchant_id = $1';
  if (status)     { params.push(status);     where += ` AND status = $${params.length}`; }
  if (type)       { params.push(type);       where += ` AND type = $${params.length}`; }
  if (dateFrom)   { params.push(dateFrom);   where += ` AND initiated_at >= $${params.length}`; }
  if (dateTo)     { params.push(dateTo);     where += ` AND initiated_at <= $${params.length}`; }
  if (terminalId) { params.push(terminalId); where += ` AND device_id = $${params.length}`; }
  if (req.query.settlementStatus) { params.push(req.query.settlementStatus); where += ` AND settlement_status = $${params.length}`; }

  params.push(limit, offset);
  const [data, count] = await Promise.all([
    query(
      `SELECT transaction_id, type, amount, currency, payment_method, status,
              description, auth_code, fee_amount, net_amount,
              device_id, settlement_status, settled_at, initiated_at, completed_at,
              gateway_payment_id, gateway_order_id, detected_operator
       FROM transactions ${where}
       ORDER BY initiated_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    ),
    query(`SELECT COUNT(*) FROM transactions ${where}`, params.slice(0, -2)),
  ]);

  res.json({
    data: data.rows, total: parseInt(count.rows[0].count),
    page, limit, pages: Math.ceil(count.rows[0].count / limit),
  });
});

router.get('/transactions/:id', merchantAuth, async (req, res) => {
  const result = await query(
    `SELECT * FROM transactions WHERE transaction_id = $1 AND merchant_id = $2`,
    [req.params.id, req.user.merchantId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Transaction introuvable' });
  res.json(result.rows[0]);
});

// ─── TERMINAUX (self-service) ─────────────────────────────────────
router.get('/terminals', merchantAuth, async (req, res) => {
  const result = await query(
    'SELECT * FROM terminals WHERE merchant_id = $1 ORDER BY created_at DESC',
    [req.user.merchantId]
  );
  res.json({ data: result.rows });
});

// Créer un nouveau terminal
router.post('/terminals', merchantAuth, async (req, res) => {
  const { terminalName, siteName, siteCode, deviceModel, androidId, appVersion } = req.body;
  if (!terminalName) return res.status(422).json({ error: 'terminalName requis' });

  try {
    // Générer un code unique
    const terminalCode = `TERM-${req.user.merchantId.slice(0, 6).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    let pairingCode;
    for (let i = 0; i < 10; i++) {
      pairingCode = String(Math.floor(100000 + Math.random() * 900000));
      const dup = await query(`SELECT 1 FROM terminals WHERE pairing_code = $1 AND paired_at IS NULL LIMIT 1`, [pairingCode]);
      if (!dup.rows.length) break;
    }

    const result = await query(
      `INSERT INTO terminals (merchant_id, terminal_code, terminal_name, site_name, site_code, device_model, android_id, app_version, pairing_code, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.user.merchantId, terminalCode, terminalName, siteName||null, siteCode||null, deviceModel||null, androidId||null, appVersion||null, pairingCode, req.user.sub]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ce terminal est déjà enregistré' });
    res.status(500).json({ error: 'Erreur création terminal' });
  }
});

// Mettre à jour un terminal
router.put('/terminals/:id', merchantAuth, async (req, res) => {
  const { terminalName, deviceModel, appVersion } = req.body;
  const result = await query(
    `UPDATE terminals SET terminal_name = COALESCE($1, terminal_name),
     device_model = COALESCE($2, device_model),
     app_version  = COALESCE($3, app_version), updated_at = NOW()
     WHERE terminal_id = $4 AND merchant_id = $5 RETURNING *`,
    [terminalName, deviceModel, appVersion, req.params.id, req.user.merchantId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Terminal introuvable' });
  res.json(result.rows[0]);
});

// Désactiver un terminal (soft delete)
router.delete('/terminals/:id', merchantAuth, async (req, res) => {
  await query(
    `UPDATE terminals SET status = 'inactive', updated_at = NOW()
     WHERE terminal_id = $1 AND merchant_id = $2`,
    [req.params.id, req.user.merchantId]
  );
  res.json({ success: true });
});

// Heartbeat depuis l'app Android
router.post('/terminals/:id/heartbeat', merchantAuth, async (req, res) => {
  const { appVersion, androidId } = req.body;
  await query(
    `UPDATE terminals SET last_seen_at = NOW(), last_ip = $1,
     app_version = COALESCE($2, app_version),
     android_id  = COALESCE($3, android_id)
     WHERE terminal_id = $4 AND merchant_id = $5`,
    [req.ip, appVersion||null, androidId||null, req.params.id, req.user.merchantId]
  );
  res.json({ ok: true });
});

// ─── RÈGLEMENTS ────────────────────────────────────────────────────
router.get('/settlements', merchantAuth, async (req, res) => {
  const result = await query(
    `SELECT batch_id, batch_date, total_gross, total_fees, total_net,
            currency, txn_count, settlement_type, status, created_at
     FROM settlement_batches WHERE merchant_id = $1
     ORDER BY batch_date DESC LIMIT 50`,
    [req.user.merchantId]
  );
  res.json({ data: result.rows });
});

// ─── DASHBOARD ────────────────────────────────────────────────────
router.get('/support/tickets', merchantAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM support_tickets WHERE merchant_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [req.user.merchantId]
    );
    res.json({ data: r.rows, total: r.rowCount });
  } catch(err){ res.status(500).json({ error: err.message }); }
});

router.post('/support/tickets', merchantAuth, async (req, res) => {
  const { subject, category, priority, message, description } = req.body;
  if (!subject) return res.status(422).json({ error: 'Sujet requis' });
  try {
    const num = 'TKT-' + Date.now().toString(36).toUpperCase();
    const r = await query(
      `INSERT INTO support_tickets (merchant_id, ticket_number, subject, priority, status)
       VALUES ($1,$2,$3,$4,'open') RETURNING *`,
      [req.user.merchantId, num, subject, priority || 'normal']
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});





router.get('/dashboard', merchantAuth, async (req, res) => {
  const [today, month, terminals] = await Promise.all([
    query(
      `SELECT COUNT(*)::int as txn_count, COALESCE(SUM(amount),0) as volume
       FROM transactions WHERE merchant_id = $1 AND DATE(initiated_at) = CURRENT_DATE AND status = 'authorized'`,
      [req.user.merchantId]
    ),
    query(
      `SELECT COUNT(*)::int as txn_count, COALESCE(SUM(amount),0) as volume
       FROM transactions WHERE merchant_id = $1 AND DATE_TRUNC('month', initiated_at) = DATE_TRUNC('month', NOW()) AND status = 'authorized'`,
      [req.user.merchantId]
    ),
    query('SELECT COUNT(*)::int as count FROM terminals WHERE merchant_id = $1 AND status = \'active\'', [req.user.merchantId]),
  ]);

  const settling = await query(
    `SELECT COALESCE(SUM(sq.amount),0) as amount
     FROM settlement_queue sq WHERE sq.merchant_id = $1 AND sq.settled = FALSE`,
    [req.user.merchantId]
  );

  res.json({
    today: {
      txn_count: today.rows[0].txn_count,
      volume: parseFloat(today.rows[0].volume),
    },
    thisMonth: {
      txn_count: month.rows[0].txn_count,
      volume: parseFloat(month.rows[0].volume),
    },
    activeTerminals: terminals.rows[0].count,
    settlingTomorrow: parseFloat(settling.rows[0].amount),
  });
});

router.get('/pilot/state', merchantAuth, async (req, res) => {
  res.json(await pilotControl.getMerchantPilotState(req.user.merchantId));
});

// Integrations comptabilite / CRM
router.get('/integrations', merchantAuth, async (req, res) => {
  res.json({ data: await integrations.listIntegrations(req.user.merchantId) });
});

router.post('/integrations', merchantAuth, async (req, res) => {
  try {
    const integration = await integrations.upsertIntegration({
      merchantId: req.user.merchantId,
      integrationType: req.body.integrationType,
      provider: req.body.provider,
      displayName: req.body.displayName,
      endpointUrl: req.body.endpointUrl,
      authType: req.body.authType,
      authConfig: req.body.authConfig,
      eventTypes: req.body.eventTypes,
      status: req.body.status,
    });
    res.status(201).json(integration);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code || 'INTEGRATION_SAVE_FAILED' });
  }
});

router.put('/integrations/:id', merchantAuth, async (req, res) => {
  try {
    const integration = await integrations.upsertIntegration({
      merchantId: req.user.merchantId,
      integrationId: req.params.id,
      integrationType: req.body.integrationType,
      provider: req.body.provider,
      displayName: req.body.displayName,
      endpointUrl: req.body.endpointUrl,
      authType: req.body.authType,
      authConfig: req.body.authConfig,
      eventTypes: req.body.eventTypes,
      status: req.body.status,
    });
    if (!integration) return res.status(404).json({ error: 'Integration introuvable' });
    res.json(integration);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code || 'INTEGRATION_SAVE_FAILED' });
  }
});

router.get('/exports/transactions', merchantAuth, async (req, res) => {
  const exported = await integrations.exportTransactions({
    merchantId: req.user.merchantId,
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
    format: req.query.format || 'json',
  });
  res.type(exported.contentType).send(exported.body);
});

// Tokenisation
router.get('/tokens', merchantAuth, async (req, res) => {
  const gate = await pilotControl.evaluateFeature({
    merchantId: req.user.merchantId,
    flagKey: 'tokenization',
    context: { action: 'list_tokens' },
    requestId: req.id,
  });
  if (!gate.allowed) return res.status(403).json({ error: gate.reason, code: 'FEATURE_NOT_ENABLED', gate });
  res.json({ data: await tokenVault.listTokens({ merchantId: req.user.merchantId, customerRef: req.query.customerRef }) });
});

router.post('/tokens', merchantAuth, async (req, res) => {
  try {
    const gate = await pilotControl.evaluateFeature({
      merchantId: req.user.merchantId,
      flagKey: 'tokenization',
      context: { action: 'create_token', provider: req.body.provider, network: req.body.network },
      requestId: req.id,
    });
    if (!gate.allowed) return res.status(403).json({ error: gate.reason, code: 'FEATURE_NOT_ENABLED', gate });

    const token = await tokenVault.createToken({
      merchantId: req.user.merchantId,
      customerRef: req.body.customerRef,
      provider: req.body.provider,
      tokenRef: req.body.tokenRef,
      network: req.body.network,
      last4: req.body.last4,
      expiryMonth: req.body.expiryMonth,
      expiryYear: req.body.expiryYear,
      metadata: req.body.metadata,
    });
    res.status(201).json(token);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code || 'TOKEN_CREATE_FAILED' });
  }
});

router.delete('/tokens/:id', merchantAuth, async (req, res) => {
  const token = await tokenVault.revokeToken({ merchantId: req.user.merchantId, tokenId: req.params.id });
  if (!token) return res.status(404).json({ error: 'Token introuvable' });
  res.json(token);
});


// ═══════════════════════════════════════════════════════════════════
// TRANSFERTS MERCHANT — comptes bancaires + retraits
// ═══════════════════════════════════════════════════════════════════

router.get('/bank-accounts', merchantAuth, async (req, res) => {
  const mid = req.merchant?.merchantId || req.user?.merchantId;
  try {
    const r = await query(
      `SELECT ba.account_id, ba.account_number, ba.account_name, ba.iban,
              ba.status, ba.is_default, fi.name AS inst_name, fi.code AS inst_code,
              fi.type AS inst_type, fi.country
       FROM bank_accounts ba
       LEFT JOIN financial_institutions fi ON fi.institution_id = ba.institution_id
       WHERE ba.owner_type='merchant' AND ba.owner_id=$1 AND ba.status != 'removed'
       ORDER BY ba.is_default DESC, ba.created_at ASC`, [mid]);

    res.json({
      data: r.rows.map(a => ({
        accountId: a.account_id,
        accountNumber: a.account_number.replace(/.(?=.{4})/g, '*'),
        accountName: a.account_name,
        status: a.status,
        isDefault: a.is_default,
        institution: { name: a.inst_name, code: a.inst_code,
                       type: a.inst_type, country: a.country },
      })),
      total: r.rows.length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/bank-accounts', merchantAuth, async (req, res) => {
  const mid = req.merchant?.merchantId || req.user?.merchantId;
  const { institutionId, accountNumber, accountName, iban } = req.body;
  if (!institutionId || !accountNumber || !accountName)
    return res.status(422).json({ error: 'institutionId, accountNumber, accountName requis' });
  try {
    const ex = await query(
      `SELECT COUNT(*)::int AS n FROM bank_accounts
       WHERE owner_type='merchant' AND owner_id=$1 AND status != 'removed'`, [mid]);

    const r = await query(
      `INSERT INTO bank_accounts (owner_type, owner_id, institution_id, account_number,
        account_name, iban, status, is_default)
       VALUES ('merchant',$1,$2,$3,$4,$5,'verified',$6)
       RETURNING account_id, account_number, account_name, is_default`,
      [mid, institutionId, accountNumber, accountName.toUpperCase(),
       iban || null, ex.rows[0].n === 0]);

    const a = r.rows[0];
    res.json({
      accountId: a.account_id,
      accountNumber: a.account_number.replace(/.(?=.{4})/g, '*'),
      accountName: a.account_name,
      isDefault: a.is_default,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/bank-accounts/:accountId', merchantAuth, async (req, res) => {
  const mid = req.merchant?.merchantId || req.user?.merchantId;
  try {
    await query(
      `UPDATE bank_accounts SET status='removed', updated_at=NOW()
       WHERE account_id=$1 AND owner_id=$2`, [req.params.accountId, mid]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Retrait du solde marchand ───────────────────────────────────
// HOTFIX double depense (audit §2.7) : solde calcule DANS une transaction SQL,
// sous verrou (FOR UPDATE sur la ligne marchand + advisory lock), ligne de
// transfert inseree AVANT tout appel operateur, qui a lieu hors transaction.
// WAVE-4 : implementation unique dans cash.service.createPayout (partagee avec
// POST /merchant/cash/withdraw et POST /merchant/cash/transfers). La route
// historique conserve son contrat (200, statut 'pending_settlement' pour une banque).
router.post('/transfer/payout', merchantAuth, idempotency, async (req, res) => {
  const mid = req.merchant?.merchantId || req.user?.merchantId;
  const { destType, accountId, operator, phone, amount, description } = req.body;

  if (['bank', 'wallet'].indexOf(destType) === -1)
    return res.status(422).json({ error: "destType: bank | wallet" });
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt < 1000)
    return res.status(422).json({ error: 'Montant minimum 1000 XAF' });
  if (destType === 'bank' && !accountId) return res.status(422).json({ error: 'accountId requis' });
  if (destType === 'wallet' && (!phone || !operator))
    return res.status(422).json({ error: 'operator et phone requis' });
  const walletPhone = destType === 'wallet' ? String(phone).replace(/[^0-9]/g, '') : null;
  if (destType === 'wallet' && walletPhone.length < 8)
    return res.status(422).json({ error: 'phone invalide' });

  try {
    let wallet = null;
    let rail = null;
    if (destType === 'wallet') {
      // Rail sortant verifie AVANT la reservation des fonds (MTN Congo : client rails ; autres : routeur MM)
      const code = cash.normalizeOperatorCode(operator);
      const m = await query('SELECT country FROM merchants WHERE merchant_id=$1', [mid]);
      const country = m.rows[0]?.country || 'CG';
      const d = cash.detectWallet(String(phone), { country, operator: code });
      rail = await cash.payoutRail({ operator: code, gateway: d.success ? d.gateway : null, country: d.success ? d.country : country });
      if (!rail.available) {
        return res.status(503).json({ error: String(operator).toUpperCase() + ' non configure', code: 'OPERATOR_NOT_CONFIGURED' });
      }
      wallet = { operator: code, phone: walletPhone, gateway: rail.gateway, country: d.success ? d.country : country };
    }

    const r = await cash.createPayout({
      merchantId: mid, destType, accountId, wallet, rail, amount: amt, description,
      refPrefix: 'PAY', bankQueueStatus: 'pending_settlement',
    });
    if (r.error) return res.status(r.error.status).json(r.error.body);
    const t = r.transfer;

    if (destType === 'wallet') {
      return res.json({
        success: true,
        transferId: t.transferId,
        reference: t.reference,
        amount: amt, fee: t.fee, net: t.net,
        status: t.status,
        destination: { type: 'wallet', operator, phone },
      });
    }

    res.json({
      success: true,
      transferId: t.transferId,
      reference: t.reference,
      amount: amt, fee: t.fee, net: t.net,
      status: t.status,
      message: 'Demande enregistree — virement sous 24-48h ouvrees',
      destination: {
        type: 'bank',
        institution: t.bankAcc?.inst_name,
        accountNumber: cash.maskNumber(t.bankAcc?.account_number),
      },
    });
  } catch (err) {
    console.error('[payout]', err.message);
    res.status(502).json({ error: err.message, code: 'GATEWAY_ERROR' });
  }
});

router.get('/transfers', merchantAuth, async (req, res) => {
  const mid = req.merchant?.merchantId || req.user?.merchantId;
  try {
    const r = await query(
      `SELECT mt.*, fi.name AS inst_name
       FROM merchant_transfers mt
       LEFT JOIN bank_accounts ba ON ba.account_id = mt.bank_account_id
       LEFT JOIN financial_institutions fi ON fi.institution_id = ba.institution_id
       WHERE mt.merchant_id=$1
       ORDER BY mt.created_at DESC LIMIT 50`, [mid]);

    res.json({
      data: r.rows.map(t => ({
        transferId: t.transfer_id,
        reference: t.reference,
        destType: t.dest_type,
        amount: parseFloat(t.amount),
        fee: parseFloat(t.fee || 0),
        net: parseFloat(t.net_amount || 0),
        currency: t.currency,
        status: t.status,
        institution: t.inst_name,
        operator: t.wallet_operator,
        phone: t.wallet_phone,
        createdAt: t.created_at,
        completedAt: t.completed_at,
      })),
      total: r.rows.length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/balance', merchantAuth, async (req, res) => {
  const mid = req.merchant?.merchantId || req.user?.merchantId;
  try {
    // Meme formule que POST /transfer/payout et la caisse (cash.service.computeAvailableBalance)
    const bal = await computeAvailableBalance(query, mid);
    const m = await query('SELECT currency FROM merchants WHERE merchant_id=$1', [mid]);
    res.json({ ...bal, currency: m.rows[0]?.currency || 'XAF' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- APPAIRAGE MULTI-SITES ---
router.post('/terminals/check', async (req, res) => {
  const { androidId } = req.body;
  if (!androidId) return res.status(422).json({ error: 'androidId requis' });
  try {
    const r = await query(
      `SELECT t.terminal_id, t.terminal_name, t.site_name, m.business_name
       FROM terminals t JOIN merchants m ON m.merchant_id = t.merchant_id
       WHERE t.android_id = $1 AND t.status = 'active' AND t.paired_at IS NOT NULL LIMIT 1`, [androidId]);
    if (r.rows[0]) {
      const t = r.rows[0];
      return res.json({ paired: true, terminalId: t.terminal_id,
        terminalName: t.terminal_name, siteName: t.site_name, merchantName: t.business_name });
    }
    return res.json({ paired: false });
  } catch (err) {
    console.error('[terminal check]', err.message);
    res.status(500).json({ error: 'Erreur verification' });
  }
});
// WAVE-2 : 10 tentatives / 15 min / IP (code a 6 chiffres — audit §2.19)
router.post('/terminals/pair', pairLimiter, async (req, res) => {
  const { pairingCode, androidId, deviceModel, appVersion } = req.body;
  if (!pairingCode || !androidId)
    return res.status(422).json({ error: 'pairingCode et androidId requis' });
  try {
    const existing = await query(
      `SELECT t.terminal_id, t.terminal_name, t.site_name, m.business_name
       FROM terminals t JOIN merchants m ON m.merchant_id = t.merchant_id
       WHERE t.android_id = $1 AND t.status = 'active' AND t.paired_at IS NOT NULL`, [androidId]);
    if (existing.rows[0]) {
      const t = existing.rows[0];
      return res.json({ success: true, alreadyPaired: true, terminalId: t.terminal_id,
        terminalName: t.terminal_name, siteName: t.site_name, merchantName: t.business_name });
    }
    const term = await query(
      `SELECT t.terminal_id, t.terminal_name, t.site_name, m.business_name
       FROM terminals t JOIN merchants m ON m.merchant_id = t.merchant_id
       WHERE t.pairing_code = $1 AND t.status = 'active' AND t.paired_at IS NULL LIMIT 1`, [pairingCode]);
    if (!term.rows[0])
      return res.status(404).json({ error: 'Code invalide ou deja utilise', code: 'INVALID_PAIRING' });
    const t = term.rows[0];
    await query(
      `UPDATE terminals SET android_id = $1, device_model = COALESCE($2, device_model),
         app_version = COALESCE($3, app_version), paired_at = NOW(), pairing_code = NULL,
         last_seen_at = NOW(), last_ip = $4, updated_at = NOW() WHERE terminal_id = $5`,
      [androidId, deviceModel||null, appVersion||null, req.ip, t.terminal_id]);
    res.json({ success: true, alreadyPaired: false, terminalId: t.terminal_id,
      terminalName: t.terminal_name, siteName: t.site_name, merchantName: t.business_name });
  } catch (err) {
    if (err.code === '23505')
      return res.status(409).json({ error: 'Cet appareil est deja lie a un autre terminal' });
    console.error('[pair]', err.message);
    res.status(500).json({ error: 'Erreur appairage' });
  }
});

router.post('/terminals/:id/regenerate-code', merchantAuth, async (req, res) => {
  try {
    let pairingCode;
    for (let i = 0; i < 10; i++) {
      pairingCode = String(Math.floor(100000 + Math.random() * 900000));
      const dup = await query(`SELECT 1 FROM terminals WHERE pairing_code = $1 AND paired_at IS NULL LIMIT 1`, [pairingCode]);
      if (!dup.rows.length) break;
    }
    const r = await query(
      `UPDATE terminals SET pairing_code = $1, android_id = NULL, paired_at = NULL, updated_at = NOW()
       WHERE terminal_id = $2 AND merchant_id = $3 RETURNING terminal_id, terminal_name, pairing_code`,
      [pairingCode, req.params.id, req.user.merchantId]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Terminal introuvable' });
    res.json({ success: true, terminalId: r.rows[0].terminal_id, pairingCode: r.rows[0].pairing_code });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ─── Referentiel institutions financieres (public, pour formulaire inscription) ───
router.get('/institutions', async (req, res) => {
  try {
    const { country, type } = req.query;
    const conds = ["COALESCE(status,'active') = 'active'"];
    const params = [];
    if (country) { params.push(country.toUpperCase()); conds.push(`country = $${params.length}`); }
    if (type)    { params.push(type); conds.push(`type = $${params.length}`); }
    const r = await query(
      `SELECT institution_id, code, name, type, country
       FROM financial_institutions
       WHERE ${conds.join(' AND ')}
       ORDER BY type, name`, params);
    res.json({ institutions: r.rows });
  } catch (err) {
    console.error('[institutions]', err.message);
    res.status(500).json({ error: 'Erreur chargement institutions' });
  }
});


// ─── Reconciliation manuelle : deplacee vers admin.routes.js (POST /admin/reconcile,
//     requireRole super_admin|ops_admin). Un JWT marchand ne doit pas lancer une
//     reconciliation globale (audit §2.18).


// ─── Reglements groupes par journee ───
router.get('/settlements/daily', merchantAuth, async (req, res) => {
  const merchantId = req.merchant?.merchantId || req.user?.merchantId;
  try {
    const days = await query(
      `SELECT DATE(COALESCE(settled_at, completed_at, initiated_at)) AS jour,
              COUNT(*) AS nb,
              SUM(amount) AS total_brut,
              SUM(COALESCE(net_amount, amount)) AS total_net
       FROM transactions
       WHERE merchant_id = $1 AND settlement_status = 'regle'
       GROUP BY DATE(COALESCE(settled_at, completed_at, initiated_at))
       ORDER BY jour DESC LIMIT 90`, [merchantId]);
    res.json({ days: days.rows });
  } catch (err) {
    console.error('[settlements/daily]', err.message);
    res.status(500).json({ error: 'Erreur reglements journaliers' });
  }
});

// ─── Detail des transactions reglees d'une journee ───
router.get('/settlements/daily/:date', merchantAuth, async (req, res) => {
  const merchantId = req.merchant?.merchantId || req.user?.merchantId;
  try {
    const r = await query(
      `SELECT transaction_id, amount, net_amount, fee_amount, payment_method,
              detected_operator, settlement_ref, settled_at, initiated_at,
              gateway_payment_id
       FROM transactions
       WHERE merchant_id = $1 AND settlement_status = 'regle'
         AND DATE(COALESCE(settled_at, completed_at, initiated_at)) = $2
       ORDER BY COALESCE(settled_at, initiated_at) DESC`, [merchantId, req.params.date]);
    res.json({ date: req.params.date, transactions: r.rows });
  } catch (err) {
    console.error('[settlements/daily/date]', err.message);
    res.status(500).json({ error: 'Erreur detail journee' });
  }
});

// GET /merchant/config - frais + velocite + consommation (lecture seule marchand)
router.get('/config', merchantAuth, async (req, res) => {
  const merchantId = req.merchant?.merchantId || req.user?.merchantId;
  try {
    // Frais configures
    const fees = await query(
      `SELECT payment_type, direction, fee_rate, fee_fixed, fee_min, fee_max, is_active
       FROM merchant_fee_configs WHERE merchant_id=$1 ORDER BY direction, payment_type`,
      [merchantId]);
    // Velocite
    const vel = await query(
      `SELECT velocity_max_per_txn, velocity_max_daily_amount, velocity_max_daily_count,
              velocity_max_monthly_amount, velocity_max_monthly_count
       FROM merchants WHERE merchant_id=$1`, [merchantId]);
    // Consommation du jour
    const day = await query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS s FROM transactions
       WHERE merchant_id=$1 AND status='authorized' AND initiated_at::date = CURRENT_DATE`,
      [merchantId]);
    // Consommation du mois
    const mon = await query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS s FROM transactions
       WHERE merchant_id=$1 AND status='authorized'
         AND date_trunc('month', initiated_at) = date_trunc('month', CURRENT_DATE)`,
      [merchantId]);
    res.json({
      fees: fees.rows,
      velocity: vel.rows[0] || {},
      consumption: {
        daily:   { count: parseInt(day.rows[0].n), amount: parseFloat(day.rows[0].s) },
        monthly: { count: parseInt(mon.rows[0].n), amount: parseFloat(mon.rows[0].s) },
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PAY LINKS (routes merchant) ─────────────────────────────────

// Liste des pay links du marchand
router.get('/pay-links', merchantAuth, async (req, res) => {
  const { status } = req.query;
  const { page, limit, offset } = parsePagination(req.query, 20);
  try {
    const conditions = ['merchant_id = $1'];
    const params = [req.user.merchantId];
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    const r = await query(
      `SELECT pay_link_id, short_id, amount, currency, description, status,
              short_url, created_at, expires_at, paid_at, paid_amount,
              recipient_phone, send_channel
       FROM pay_links WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    const cnt = await query(`SELECT COUNT(*) FROM pay_links WHERE ${conditions.join(' AND ')}`, params);
    res.json({ data: r.rows, total: parseInt(cnt.rows[0].count), page, limit });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Créer un pay link
router.post('/pay-links', merchantAuth, smsLimiter, idempotency, async (req, res) => {
  const { v4: uuidv4 } = require('uuid');
  const { amount, description, channel = 'sms' } = req.body;
  if (!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0) return res.status(422).json({ error: 'Montant invalide' });
  const expiresIn = parseExpiresIn(req.body.expiresIn, 24);
  if (expiresIn === null) return res.status(422).json({ error: 'expiresIn invalide (1 a 720 heures)', code: 'INVALID_EXPIRES_IN' });
  let recipientPhone = null;
  if (req.body.recipientPhone) {
    recipientPhone = toE164(req.body.recipientPhone);
    if (!recipientPhone) return res.status(422).json({ error: 'recipientPhone invalide (format E.164 attendu, ex: +242061234567)', code: 'INVALID_PHONE' });
  }
  try {
    const merchant = await query('SELECT currency FROM merchants WHERE merchant_id=$1', [req.user.merchantId]);
    const currency = merchant.rows[0]?.currency || 'XAF';
    const expiresAt = new Date(Date.now() + expiresIn * 3600 * 1000);
    const baseUrl = process.env.PAY_LINK_BASE_URL || 'https://pay.c-pay.global';
    const r = await withShortIdRetry((shortId) => query(
      `INSERT INTO pay_links (pay_link_id, merchant_id, short_id, amount, currency, description, short_url, expires_at, recipient_phone, send_channel, psp, payment_method, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending') RETURNING *`,
      [uuidv4(), req.user.merchantId, shortId, amount, currency, description || null, `${baseUrl}/${shortId}`, expiresAt, recipientPhone, channel, req.body.psp || (req.body.payment_method==='mobile_money'?'momo':'cybersource'), req.body.payment_method || req.body.paymentMethod || 'card']
    ));
    const link = r.rows[0];
    const shortUrl = link.short_url;
    // Envoyer automatiquement si numéro fourni
    if (recipientPhone) {
      const text = `${description ? description + ' - ' : ''}Payez ${parseFloat(amount).toLocaleString()} ${currency} via: ${shortUrl}`;
      try {
        if (channel === 'whatsapp') {
          const { sendWhatsAppText } = require('../services/notifications/whatsapp.service');
          await sendWhatsAppText({ to: recipientPhone, text });
        } else {
          const { sendSmsSmpp } = require('../services/notifications/smpp.service');
          await sendSmsSmpp({ to: recipientPhone, text });
        }
        await query(`UPDATE pay_links SET sent_at=NOW() WHERE pay_link_id=$1`, [link.pay_link_id]);
      } catch (sendErr) {
        // Lien créé mais envoi échoué — pas bloquant
      }
    }
    res.status(201).json({ success: true, link });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Envoyer un pay link existant
router.post('/pay-links/:id/send', merchantAuth, smsLimiter, async (req, res) => {
  const { channel = 'sms' } = req.body;
  if (!req.body.phone) return res.status(422).json({ error: 'phone requis' });
  const phone = toE164(req.body.phone);
  if (!phone) return res.status(422).json({ error: 'phone invalide (format E.164 attendu, ex: +242061234567)', code: 'INVALID_PHONE' });
  try {
    const r = await query(
      `SELECT * FROM pay_links WHERE (pay_link_id::text=$1 OR short_id=$1) AND merchant_id=$2`,
      [req.params.id, req.user.merchantId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Lien introuvable' });
    const link = r.rows[0];
    const text = `${link.description ? link.description + ' - ' : ''}Payez ${parseFloat(link.amount).toLocaleString()} ${link.currency} via: ${link.short_url}`;
    if (channel === 'whatsapp') {
      const { sendWhatsAppText } = require('../services/notifications/whatsapp.service');
      await sendWhatsAppText({ to: phone, text });
    } else {
      const { notifyMultiChannel } = require('../services/notifications/smpp.service');
      await notifyMultiChannel({ phone, email: req.body.email || null, text, subject: 'C-Pay — lien de paiement' });
    }
    await query(`UPDATE pay_links SET recipient_phone=$1, send_channel=$2, sent_at=NOW() WHERE pay_link_id=$3`, [phone, channel, link.pay_link_id]);
    res.json({ success: true, message: `Lien envoyé via ${channel}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Annuler un pay link
router.delete('/pay-links/:id', merchantAuth, async (req, res) => {
  const { query } = require('../config/database');
  try {
    await query(
      `UPDATE pay_links SET status='cancelled' WHERE (pay_link_id::text=$1 OR short_id=$1) AND merchant_id=$2 AND status='pending'`,
      [req.params.id, req.user.merchantId]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stats pay links
router.get('/pay-links/stats', merchantAuth, async (req, res) => {
  const { query } = require('../config/database');
  try {
    const r = await query(
      `SELECT
        COUNT(*) FILTER (WHERE status='pending')   as pending,
        COUNT(*) FILTER (WHERE status='paid')      as paid,
        COUNT(*) FILTER (WHERE status='cancelled') as cancelled,
        COUNT(*) FILTER (WHERE status='expired')   as expired,
        COALESCE(SUM(amount) FILTER (WHERE status='paid'), 0) as total_collected
       FROM pay_links WHERE merchant_id=$1`,
      [req.user.merchantId]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/fees', merchantAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT payment_type, direction, fee_rate, fee_fixed, fee_min, fee_max
       FROM merchant_fee_configs WHERE merchant_id=$1 AND is_active=TRUE ORDER BY direction, payment_type`,
      [req.user.merchantId]
    );
    const fees = {};
    r.rows.forEach(f => {
      if (!fees[f.direction]) fees[f.direction] = {};
      fees[f.direction][f.payment_type] = {
        rate: parseFloat(f.fee_rate), fixed: parseFloat(f.fee_fixed),
        min: parseFloat(f.fee_min), max: f.fee_max ? parseFloat(f.fee_max) : null,
      };
    });
    res.json({ fees });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// POST /merchant/kyb/documents — Merchant soumet un document (URL base64 ou lien)
router.post('/kyb/documents', merchantAuth, async (req, res) => {
  const { docType, docLabel, fileUrl, fileName, fileSize, mimeType } = req.body;
  if (!docType || !fileUrl) return res.status(422).json({error:'docType et fileUrl requis'});
  try {
    const r = await query(
      `INSERT INTO kyb_documents (merchant_id, doc_type, doc_label, file_url, file_name, file_size, mime_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING doc_id, doc_type, doc_label, status, uploaded_at`,
      [req.user.merchantId, docType, docLabel||docType, fileUrl, fileName||null, fileSize||null, mimeType||null]
    );
    await query(`UPDATE merchants SET kyb_submitted_at=NOW() WHERE merchant_id=$1`, [req.user.merchantId]);
    // Notification admin KYB
    try {
      const m = await query('SELECT business_name FROM merchants WHERE merchant_id=$1', [req.user.merchantId]);
      await notify({ type:'kyb_document_submitted', title:'Nouveau document KYB', message:(m.rows[0]?.business_name||'Merchant')+' a soumis: '+(docLabel||docType), entityType:'merchant', entityId:req.user.merchantId, metadata:{docType,docLabel,fileName} });
    } catch(ne){ console.error('Notify error:', ne.message); }
    res.status(201).json(r.rows[0]);
  } catch(err){ res.status(500).json({error:err.message}); }
});

// GET /merchant/kyb — Merchant voit ses documents soumis
router.get('/kyb', merchantAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT doc_id, doc_type, doc_label, file_name, status, rejection_reason, uploaded_at, reviewed_at
       FROM kyb_documents WHERE merchant_id=$1 ORDER BY uploaded_at DESC`,
      [req.user.merchantId]
    );
    res.json({ documents: r.rows });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── TICKET DETAIL + MESSAGES ─────────────────────────────────────
router.get('/support/tickets/:id', merchantAuth, async (req, res) => {
  try {
    const ticket = await query(
      `SELECT * FROM support_tickets WHERE ticket_id=$1 AND merchant_id=$2`,
      [req.params.id, req.user.merchantId]
    );
    if (!ticket.rows.length) return res.status(404).json({ error: 'Ticket introuvable' });
    const messages = await query(
      `SELECT * FROM ticket_messages WHERE ticket_id=$1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({ ...ticket.rows[0], ticket: ticket.rows[0], messages: messages.rows });
  } catch(err){ res.status(500).json({ error: err.message }); }
});

// POST /support/tickets/:id/messages — Merchant répond
router.post('/support/tickets/:id/messages', merchantAuth, async (req, res) => {
  const { message, attachments } = req.body;
  if (!message?.trim()) return res.status(422).json({ error: 'Message requis' });
  try {
    // Vérifier que le ticket appartient au merchant
    const t = await query('SELECT ticket_id, status FROM support_tickets WHERE ticket_id=$1 AND merchant_id=$2', [req.params.id, req.user.merchantId]);
    if (!t.rows.length) return res.status(404).json({ error: 'Ticket introuvable' });

    const r = await query(
      `INSERT INTO ticket_messages (ticket_id, sender_type, sender_id, sender_name, message, attachments)
       VALUES ($1,'merchant',$2,$3,$4,$5) RETURNING *`,
      [req.params.id, req.user.sub, req.user.businessName || 'Marchand', message.trim(), JSON.stringify(attachments || [])]
    );
    // Remettre en open si was waiting_merchant
    await query(
      `UPDATE support_tickets SET status='open', last_message_at=NOW(), updated_at=NOW() WHERE ticket_id=$1 AND status='pending_merchant'`,
      [req.params.id]
    );
    res.status(201).json(r.rows[0]);
  } catch(err){ res.status(500).json({ error: err.message }); }
});

// PATCH /support/tickets/:id/resolve — Merchant valide la résolution
router.patch('/support/tickets/:id/resolve', merchantAuth, async (req, res) => {
  try {
    await query(
      `UPDATE support_tickets SET status='resolved', resolved_at=NOW(), updated_at=NOW() WHERE ticket_id=$1 AND merchant_id=$2`,
      [req.params.id, req.user.merchantId]
    );
    res.json({ success: true });
  } catch(err){ res.status(500).json({ error: err.message }); }
});

// ─── PAIEMENT SANS CONTACT (NFC) ─────────────────────────────────
// ─── MOBILE APP COLLECT (JWT Auth) ───────────────────────────────
router.post('/collect', merchantAuth, idempotency, async (req, res) => {
  const { amount, customerPhone, method, description, terminalId } = req.body;
  if (!amount || parseFloat(amount) < 1)
    return res.status(422).json({ error: 'Montant minimum 1 XAF' });
  if (!customerPhone) return res.status(422).json({ error: 'customerPhone requis' });
  if (!method) return res.status(422).json({ error: 'method requis (airtel_money, mtn_momo)' });

  const merchantId = req.merchant?.merchantId || req.user?.merchantId;
  const amt   = parseFloat(amount);
  const fee   = 0;
  const net   = 0;
  const ref   = 'MOB-' + Date.now().toString(36).toUpperCase();
  const phone = String(customerPhone).replace(/[^0-9]/g, '');

  const pmMap = { airtel_money: 'mobile_money', mtn_momo: 'mobile_money', card: 'card_nfc', qr: 'qr' };
  const pm = pmMap[method] || 'mobile_money';

  const operator = method === 'mtn_momo' ? 'mtn'
                 : method === 'airtel_money' ? 'airtel' : null;
  if (operator && OPERATOR_LIMITS[operator] && amt > OPERATOR_LIMITS[operator])
    return res.status(422).json({ error: 'Montant superieur a la limite operateur (max ' + OPERATOR_LIMITS[operator] + ' XAF)' });
  const velErr = await checkVelocity(merchantId, amt, 'collect');
  if (velErr) return res.status(422).json({ error: velErr });

  let txnId = null;

  try {
    // 1. Creer la transaction en PENDING
    const txn = await query(
      `INSERT INTO transactions (
        merchant_id, type, amount, currency, fee_amount, net_amount,
        payment_method, status, detected_operator, gateway_name,
        description, initiated_at
        , device_id
      ) VALUES ($1,'collect',$2,'XAF',$3,$4,$5,'pending',$6,$7,$8,NOW(),$9)
      RETURNING transaction_id`,
      [merchantId, amt, fee, net, pm, operator, operator || 'unknown',
       description || 'Encaissement mobile', terminalId || null]);
    txnId = txn.rows[0].transaction_id;

    // 2. Appel reel a l'operateur
    if (operator === 'mtn') {
      const mtn = require('../services/rails/mtn-momo.client');

      const rtp = await mtn.requestToPay({
        amount: amt,
        phone,
        description: description || 'Paiement C-Pay',
        externalId: ref,
      });

      await query(
        `UPDATE transactions
         SET gateway_payment_id=$1, gateway_order_id=$2, response_message=$3
         WHERE transaction_id=$4`,
        [rtp.referenceId, ref, 'Push USSD envoye — en attente de confirmation', txnId]);

      return res.json({
        success: true,
        txnId,
        reference: ref,
        gatewayReference: rtp.referenceId,
        amount: amt,
        fee,
        net,
        status: 'pending',
        message: 'Demande envoyee — le client doit confirmer sur son telephone',
        requiresConfirmation: true,
      });
    }

    if (operator === 'airtel') {
      const airtel = require('../services/mobilemoney/providers/airtel.provider');
      const airtelConfig = {
        baseUrl:   process.env.AIRTEL_CG_BASE_URL,
        apiKey:    process.env.AIRTEL_CG_COLL_CLIENT_ID,
        apiSecret: process.env.AIRTEL_CG_COLL_CLIENT_SECRET,
        env:       process.env.AIRTEL_CG_ENV,
      };
      const ar = await airtel.collectPayment({ txnId, amount: amt, currency: 'XAF', phone, config: airtelConfig });
      const ok = ar?.success === true;
      await query(
        `UPDATE transactions SET gateway_payment_id=$1, response_message=$2, provider_raw_response=$4 WHERE transaction_id=$3`,
        [ar?.transactionId || ref, ok ? 'Airtel: demande envoyee' : (ar?.errorMessage || 'Airtel: echec'), txnId, ar?.rawResponse || null]);
      if (ok) scheduleAirtelPolling(txnId, ar?.transactionId || ref);
      return res.json({
        success: !!ok,
        txnId,
        reference: ref,
        amount: amt, fee, net,
        status: ok ? 'pending' : 'failed',
        message: ok ? 'Demande Airtel envoyee — le client doit confirmer' : (ar?.errorMessage || 'Echec Airtel'),
        requiresConfirmation: !!ok,
      });
    }

    // Autres methodes (card_nfc, qr) : pas encore branchees
    await query(
      `UPDATE transactions SET status='failed',
       response_message='Methode non supportee' WHERE transaction_id=$1`, [txnId]);
    return res.status(422).json({ error: 'Methode non supportee: ' + method, txnId });

  } catch (err) {
    console.error('[collect]', err.message);
    if (txnId) {
      await query(
        `UPDATE transactions SET status='failed', response_message=$1
         WHERE transaction_id=$2`, [err.message.slice(0, 200), txnId]).catch(() => {});
    }
    res.status(502).json({ error: err.message, txnId, code: 'GATEWAY_ERROR' });
  }
});

// ─── STATUT D'UNE TRANSACTION ────────────────────────────────────
router.get('/collect/:txnId/status', merchantAuth, async (req, res) => {
  const merchantId = req.merchant?.merchantId || req.user?.merchantId;
  try {
    const r = await query(
      `SELECT transaction_id, amount, fee_amount, net_amount, status,
              detected_operator, gateway_payment_id, gateway_order_id,
              auth_code, response_message, initiated_at, completed_at
       FROM transactions
       WHERE transaction_id=$1 AND merchant_id=$2`,
      [req.params.txnId, merchantId]);

    if (!r.rows[0]) return res.status(404).json({ error: 'Transaction introuvable' });
    const t = r.rows[0];

    // Si en attente, interroger l'operateur
    if (t.status === 'pending' && t.gateway_payment_id && t.detected_operator === 'mtn') {
      try {
        const mtn = require('../services/rails/mtn-momo.client');
        const s = await mtn.getCollectionStatus(t.gateway_payment_id);

        if (s.status === 'SUCCESSFUL') {
          const auth = 'AUTH' + Math.random().toString(36).slice(2, 8).toUpperCase();
          await query(
            `UPDATE transactions SET status='authorized', auth_code=$1,
             response_message='Paiement confirme',
             fee_amount=calc_fee(merchant_id,'collect',detected_operator,amount), net_amount=amount-calc_fee(merchant_id,'collect',detected_operator,amount), completed_at=NOW()
             WHERE transaction_id=$2`, [auth, t.transaction_id]);
          t.status = 'authorized';
          t.auth_code = auth;
          t.response_message = 'Paiement confirme';
          t.completed_at = new Date();
          // CR#3 : settlement temps reel (non bloquant)
          try {
            const { settleTransaction } = require('../services/settlement.service');
            settleTransaction(t.transaction_id).catch(e => console.error('[settlement]', e.message));
          } catch(e) { console.error('[settlement trigger]', e.message); }
        } else if (s.status === 'FAILED') {
          const raisonsMtn = {
            COULD_NOT_PERFORM_TRANSACTION: 'Transaction impossible. Vérifiez que le compte Mobile Money est actif et approvisionné.',
            NOT_ENOUGH_FUNDS:              'Solde insuffisant sur le compte du client.',
            PAYER_LIMIT_REACHED:           'Plafond de transaction atteint pour ce compte.',
            PAYER_NOT_FOUND:               'Numéro Mobile Money introuvable.',
            PAYEE_NOT_ALLOWED_TO_RECEIVE:  'Ce compte marchand ne peut pas recevoir ce paiement.',
            APPROVAL_REJECTED:             'Paiement refusé par le client.',
            EXPIRED:                       'Délai de confirmation dépassé.',
            INTERNAL_PROCESSING_ERROR:     'Erreur temporaire MTN. Veuillez réessayer.',
            ACCOUNT_HOLDER_NOT_ACTIVE:     'Le compte Mobile Money du client n\'est pas actif.',
          };
          const msg = raisonsMtn[s.reason] || s.reason || 'Paiement refusé';
          await query(
            `UPDATE transactions SET status='failed', response_message=$1,
             completed_at=NOW() WHERE transaction_id=$2`,
            [msg, t.transaction_id]);
          t.status = 'failed';
          t.response_message = msg;
        }
      } catch (e) { /* on renvoie le statut en base */ }
    }
    // Airtel : enquiry si en attente (GET /standard/v1/payments/{id})
    if (t.status === 'pending' && t.gateway_payment_id && t.detected_operator === 'airtel') {
      try {
        const airtel = require('../services/mobilemoney/providers/airtel.provider');
        const airtelConfig = {
          baseUrl:   process.env.AIRTEL_CG_BASE_URL,
          apiKey:    process.env.AIRTEL_CG_COLL_CLIENT_ID,
          apiSecret: process.env.AIRTEL_CG_COLL_CLIENT_SECRET,
          env:       process.env.AIRTEL_CG_ENV,
        };
        const s = await airtel.queryTransaction({ txId: t.gateway_payment_id, currency: 'XAF', config: airtelConfig });
        if (s.success) {
          const auth = 'AUTH' + Math.random().toString(36).slice(2, 8).toUpperCase();
          await query(
            `UPDATE transactions SET status='authorized', auth_code=$1,
             response_message='Paiement Airtel confirme',
             gateway_order_id=COALESCE($3, gateway_order_id),
             fee_amount=calc_fee(merchant_id,'collect',detected_operator,amount), net_amount=amount-calc_fee(merchant_id,'collect',detected_operator,amount), completed_at=NOW()
             WHERE transaction_id=$2`, [auth, t.transaction_id, s.airtelMoneyId || null]);
          t.status = 'authorized';
          t.auth_code = auth;
          t.response_message = 'Paiement Airtel confirme';
          t.completed_at = new Date();
          try {
            const { settleTransaction } = require('../services/settlement.service');
            settleTransaction(t.transaction_id).catch(e => console.error('[settlement]', e.message));
          } catch(e) { console.error('[settlement trigger]', e.message); }
        } else if (s.failed) {
          const msg = s.rawStatus === 'TE' ? 'Delai de confirmation Airtel depasse.' : (s.message || 'Paiement Airtel refuse.');
          await query(
            `UPDATE transactions SET status='failed', response_message=$1,
             completed_at=NOW() WHERE transaction_id=$2`, [msg, t.transaction_id]);
          t.status = 'failed';
          t.response_message = msg;
        }
      } catch (e) { /* garder pending */ }
    }

    const labels = {
      pending:    'En attente de confirmation client',
      authorized: 'Paiement confirme',
      failed:     'Paiement echoue',
      reversed:   'Transaction annulee',
    };

    res.json({
      txnId: t.transaction_id,
      amount: parseFloat(t.amount),
      fee: parseFloat(t.fee_amount || 0),
      net: parseFloat(t.net_amount || 0),
      status: t.status,
      label: labels[t.status] || t.status,
      operator: t.detected_operator,
      authCode: t.auth_code,
      message: t.response_message,
      reference: t.gateway_order_id,
      initiatedAt: t.initiated_at,
      completedAt: t.completed_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── MOBILE APP DISBURSE (JWT Auth) ──────────────────────────────
router.post('/disburse', merchantAuth, idempotency, async (req, res) => {
  const { amount, recipientPhone, method, description } = req.body;
  if (!amount || parseFloat(amount) < 1)
    return res.status(422).json({ error: 'Montant minimum 1 XAF' });
  if (!recipientPhone) return res.status(422).json({ error: 'recipientPhone requis' });
  if (!method) return res.status(422).json({ error: 'method requis (airtel_money, mtn_momo)' });

  const merchantId = req.merchant?.merchantId || req.user?.merchantId;
  const amt   = parseFloat(amount);
  const fee   = 0;
  const total = amt;
  const ref   = 'DSB-' + Date.now().toString(36).toUpperCase();
  const phone = String(recipientPhone).replace(/[^0-9]/g, '');

  const operator = method === 'mtn_momo' ? 'mtn'
                 : method === 'airtel_money' ? 'airtel' : null;
  if (operator && OPERATOR_LIMITS[operator] && amt > OPERATOR_LIMITS[operator])
    return res.status(422).json({ error: 'Montant superieur a la limite operateur (max ' + OPERATOR_LIMITS[operator] + ' XAF)' });
  const velErrD = await checkVelocity(merchantId, amt, 'payout');
  if (velErrD) return res.status(422).json({ error: velErrD });

  let txnId = null;

  try {
    // Réservation atomique des fonds (même verrou et même formule que /transfer/payout) :
    // la ligne 'pending' est insérée dans la transaction SQL, donc comptée par tout appel concurrent.
    const reservation = await withTransaction(async (client) => {
      const exec = (text, params) => client.query(text, params);
      await exec('SELECT pg_advisory_xact_lock(hashtext($1))', [String(merchantId)]);
      const bal = await computeAvailableBalance(exec, merchantId);
      if (bal.available < total) {
        return { status: 422, body: { error: 'Solde insuffisant', code: 'INSUFFICIENT_BALANCE', available: bal.available, requested: total } };
      }
      const txn = await exec(
        `INSERT INTO transactions (
          merchant_id, type, amount, currency, fee_amount, net_amount,
          payment_method, status, detected_operator, gateway_name,
          description, initiated_at
        ) VALUES ($1,'payout',$2,'XAF',$3,$4,'mobile_money','pending',$5,$6,$7,NOW())
        RETURNING transaction_id`,
        [merchantId, amt, fee, total, operator, operator || 'unknown',
         description || 'Decaissement mobile']);
      return { txnId: txn.rows[0].transaction_id };
    });
    if (reservation.status) return res.status(reservation.status).json(reservation.body);
    txnId = reservation.txnId;

    if (operator === 'mtn') {
      const mtn = require('../services/rails/mtn-momo.client');

      const d = await mtn.transfer({
        amount: amt,
        phone,
        description: description || 'Paiement C-Pay',
        externalId: ref,
      });

      await query(
        `UPDATE transactions
         SET gateway_payment_id=$1, gateway_order_id=$2, response_message=$3
         WHERE transaction_id=$4`,
        [d.referenceId, ref, 'Transfert initie', txnId]);

      return res.json({
        success: true,
        txnId,
        reference: ref,
        gatewayReference: d.referenceId,
        amount: amt,
        fee,
        total,
        status: 'pending',
        message: 'Transfert en cours vers ' + phone,
      });
    }

    if (operator === 'airtel') {
      const airtel = require('../services/mobilemoney/providers/airtel.provider');
      const airtelConfig = {
        baseUrl:   process.env.AIRTEL_CG_BASE_URL,
        apiKey:    process.env.AIRTEL_CG_DISB_CLIENT_ID,
        apiSecret: process.env.AIRTEL_CG_DISB_CLIENT_SECRET,
        env:       process.env.AIRTEL_CG_ENV,
        pin:       process.env.AIRTEL_CG_DISB_PIN,
        rsaPubKey: process.env.AIRTEL_CG_DISB_RSA_PUBKEY,
      };
      const ar = await airtel.sendPayout({ txnId, amount: amt, currency: 'XAF', phone, config: airtelConfig });
      const ok = ar?.success === true;
      await query(
        `UPDATE transactions SET status=$1, gateway_payment_id=$2, response_message=$3, gateway_order_id=COALESCE($5, gateway_order_id), provider_raw_response=$6 WHERE transaction_id=$4`,
        [ok ? 'pending' : 'failed', ar?.transactionId || txnId, ok ? 'Versement Airtel en cours' : 'Echec versement Airtel', txnId, ar?.airtelMoneyId || null, ar?.rawResponse || null]);
      if (ok) scheduleAirtelDisbPolling(txnId, ar?.transactionId || txnId);
      return res.status(ok ? 200 : 502).json({
        success: !!ok, txnId, amount: amt,
        status: ok ? 'pending' : 'failed',
        message: ok ? 'Versement Airtel en cours' : 'Echec versement Airtel',
      });
    }

    await query(
      `UPDATE transactions SET status='failed',
       response_message='Methode non supportee' WHERE transaction_id=$1`, [txnId]);
    return res.status(422).json({ error: 'Methode non supportee: ' + method, txnId });

  } catch (err) {
    console.error('[disburse]', err.message);
    if (txnId) {
      await query(
        `UPDATE transactions SET status='failed', response_message=$1
         WHERE transaction_id=$2`, [err.message.slice(0, 200), txnId]).catch(() => {});
    }
    res.status(502).json({ error: err.message, txnId, code: 'GATEWAY_ERROR' });
  }
});

// ─── STATUT D'UN DECAISSEMENT ────────────────────────────────────
router.get('/disburse/:txnId/status', merchantAuth, async (req, res) => {
  const merchantId = req.merchant?.merchantId || req.user?.merchantId;
  try {
    const r = await query(
      `SELECT transaction_id, amount, fee_amount, net_amount, status,
              detected_operator, gateway_payment_id, gateway_order_id,
              auth_code, response_message, initiated_at, completed_at
       FROM transactions
       WHERE transaction_id=$1 AND merchant_id=$2 AND type='payout'`,
      [req.params.txnId, merchantId]);

    if (!r.rows[0]) return res.status(404).json({ error: 'Transaction introuvable' });
    const t = r.rows[0];

    if (t.status === 'pending' && t.gateway_payment_id && t.detected_operator === 'mtn') {
      try {
        const mtn = require('../services/rails/mtn-momo.client');
        const s = await mtn.getDisbursementStatus(t.gateway_payment_id);

        if (s.status === 'SUCCESSFUL') {
          const auth = 'DSB' + Math.random().toString(36).slice(2, 8).toUpperCase();
          await query(
            `UPDATE transactions SET status='authorized', auth_code=$1,
             response_message='Transfert effectue',
             fee_amount=calc_fee(merchant_id,'payout',detected_operator,amount), net_amount=amount-calc_fee(merchant_id,'payout',detected_operator,amount), completed_at=NOW()
             WHERE transaction_id=$2`, [auth, t.transaction_id]);
          t.status = 'authorized';
          t.auth_code = auth;
          t.response_message = 'Transfert effectue';
          t.completed_at = new Date();
        } else if (s.status === 'FAILED') {
          await query(
            `UPDATE transactions SET status='failed', response_message=$1,
             completed_at=NOW() WHERE transaction_id=$2`,
            [s.reason || 'Transfert refuse', t.transaction_id]);
          t.status = 'failed';
          t.response_message = s.reason || 'Transfert refuse';
        }
      } catch (e) { }
    }

    if (t.status === 'pending' && t.gateway_payment_id && t.detected_operator === 'airtel') {
      try {
        const airtel = require('../services/mobilemoney/providers/airtel.provider');
        const cfg = { baseUrl: process.env.AIRTEL_CG_BASE_URL, apiKey: process.env.AIRTEL_CG_DISB_CLIENT_ID, apiSecret: process.env.AIRTEL_CG_DISB_CLIENT_SECRET, env: process.env.AIRTEL_CG_ENV };
        const s = await airtel.queryDisbursement({ txId: t.gateway_payment_id, currency: 'XAF', config: cfg });
        if (s.success) {
          const auth = 'DSB' + Math.random().toString(36).slice(2, 8).toUpperCase();
          await query(`UPDATE transactions SET status='authorized', auth_code=$1, response_message='Transfert Airtel effectue', fee_amount=calc_fee(merchant_id,'payout',detected_operator,amount), net_amount=amount-calc_fee(merchant_id,'payout',detected_operator,amount), completed_at=NOW() WHERE transaction_id=$2`, [auth, t.transaction_id]);
          t.status = 'authorized'; t.auth_code = auth; t.response_message = 'Transfert Airtel effectue'; t.completed_at = new Date();
        } else if (s.failed) {
          const msg = s.rawStatus === 'TE' ? 'Delai de transfert Airtel depasse.' : (s.message || 'Transfert Airtel echoue.');
          await query(`UPDATE transactions SET status='failed', response_message=$1, completed_at=NOW() WHERE transaction_id=$2`, [msg, t.transaction_id]);
          t.status = 'failed'; t.response_message = msg;
        }
      } catch (e) { }
    }
    const labels = {
      pending:    'Transfert en cours',
      authorized: 'Transfert effectue',
      failed:     'Transfert echoue',
    };

    res.json({
      txnId: t.transaction_id,
      amount: parseFloat(t.amount),
      fee: parseFloat(t.fee_amount || 0),
      status: t.status,
      label: labels[t.status] || t.status,
      operator: t.detected_operator,
      authCode: t.auth_code,
      message: t.response_message,
      reference: t.gateway_order_id,
      completedAt: t.completed_at,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── WITHDRAW (retrait solde marchand vers Mobile Money) ─────────
// HOTFIX (audit §2.6) : ce endpoint marquait un payout 'authorized' sans aucun
// transfert operateur et sans deduire les retraits precedents (retraits illimites).
// Desactive : 410 Gone, aucune ecriture. Utiliser POST /transfer/payout.
router.post('/withdraw', merchantAuth, (req, res) => featureDisabled(res));

// ─── RECEIPTS SMS ────────────────────────────────────────────────
router.post('/receipts/sms', merchantAuth, smsLimiter, async (req, res) => {
  const { txnId, amount, reference, type } = req.body;
  if (!req.body.phone) return res.status(422).json({ error: 'phone requis' });
  const phone = toE164(req.body.phone);
  if (!phone) return res.status(422).json({ error: 'phone invalide (format E.164 attendu, ex: +242061234567)', code: 'INVALID_PHONE' });
  try {
    const text = `C-Pay - ${(type||'Transaction').toUpperCase()}\nMontant: ${amount} XAF\nRef: ${reference||txnId}\nMerci de votre confiance.\nc-pay.global`;
    try {
      const { sendSmsSmpp } = require('../services/notifications/smpp.service');
      await sendSmsSmpp({ to: phone, text });
      res.json({ success:true, sent:true, phone });
    } catch(smsErr) {
      res.json({ success:true, sent:false, phone, note:'SMS gateway indisponible', text });
    }
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ─── ACCOUNT CHANGE PASSWORD ─────────────────────────────────────
// WAVE-2 (audit §2.13, §2.15) : leve temp_password et revoque toutes les
// sessions (refresh) du marchand ; l'access en cours expire sous 15 min.
const changeMerchantPassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(422).json({ error: 'currentPassword et newPassword requis' });
  if (newPassword.length < 8) return res.status(422).json({ error: 'Minimum 8 caracteres' });
  try {
    // Le JWT marchand porte l'identifiant utilisateur dans `sub` (audit §3.3)
    const userId = req.user?.sub;
    if (!userId) return res.status(401).json({ error: 'Utilisateur non identifie' });
    const u = await query(`SELECT password_hash FROM merchant_users WHERE user_id=$1`, [userId]);
    if (!u.rows[0]) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const ok = await bcrypt.compare(currentPassword, u.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    const hash = await bcrypt.hash(newPassword, 12);
    await query(`UPDATE merchant_users SET password_hash=$1, temp_password=FALSE, updated_at=NOW() WHERE user_id=$2`, [hash, userId]);
    await revokeAll('merchant', userId);
    clearRefreshCookie(res, 'merchant');
    res.json({ success:true, message:'Mot de passe modifie', sessionsRevoked: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
};
router.post('/account/change-password', merchantAuth, changeMerchantPassword);
router.post('/auth/change-password',    merchantAuth, changeMerchantPassword);

// HOTFIX (audit §2.6, §3.4) : autorisation NFC simulee (auth code aleatoire, aucun
// appel PSP, req.merchant undefined). Desactive : 410 Gone, aucune ecriture.
router.post('/collect/contactless', merchantAuth, (req, res) => featureDisabled(res));

// ─── 2FA MERCHANT ─────────────────────────────────────────────────
// WAVE-2 (audit §2.11) : TOTP reel (speakeasy, fenetre 1), secret base32 sur
// la ligne utilisateur, QR genere cote serveur. Le login emet un mfaToken
// quand mfa_enabled (voir POST /auth/2fa/validate plus haut).

// Setup 2FA — générer secret + QR (non activé tant que /verify n'a pas réussi)
router.post('/auth/2fa/setup', merchantAuth, async (req, res) => {
  try {
    const u = await query(`SELECT email FROM merchant_users WHERE user_id=$1`, [req.user.sub]);
    const label = u.rows[0]?.email || req.user.email || String(req.user.sub);
    const enrollment = await buildTotpEnrollment({ label, issuer: 'C-Pay Merchant' });
    await query(
      `UPDATE merchant_users SET mfa_secret=$1, mfa_enabled=FALSE WHERE user_id=$2`,
      [enrollment.secret, req.user.sub]
    );
    res.json(enrollment);
  } catch(err){ res.status(500).json({error:err.message}); }
});

// Vérifier et activer 2FA
router.post('/auth/2fa/verify', merchantAuth, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') return res.status(422).json({error:'Token requis'});
  try {
    const u = await query(`SELECT mfa_secret FROM merchant_users WHERE user_id=$1`, [req.user.sub]);
    if (!u.rows[0]?.mfa_secret) return res.status(400).json({error:'2FA non configuré'});
    if (!verifyTotp(u.rows[0].mfa_secret, token)) return res.status(400).json({error:'Code invalide'});
    await query(`UPDATE merchant_users SET mfa_enabled=TRUE WHERE user_id=$1`, [req.user.sub]);
    res.json({success:true, message:'2FA activé ✅'});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// Désactiver 2FA — code TOTP valide obligatoire (mfa_secret NULL → 400, plus de TypeError, audit §3.8)
router.post('/auth/2fa/disable', merchantAuth, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') return res.status(422).json({error:'Token requis'});
  try {
    const u = await query(`SELECT mfa_secret FROM merchant_users WHERE user_id=$1`, [req.user.sub]);
    if (!u.rows[0]?.mfa_secret) return res.status(400).json({error:'2FA non configuré'});
    if (!verifyTotp(u.rows[0].mfa_secret, token)) return res.status(400).json({error:'Code invalide'});
    await query(`UPDATE merchant_users SET mfa_enabled=FALSE, mfa_secret=NULL WHERE user_id=$1`, [req.user.sub]);
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// Statut 2FA
router.get('/auth/2fa/status', merchantAuth, async (req, res) => {
  try {
    const u = await query(
      `SELECT mfa_enabled, mfa_method, first_login_at, created_at FROM merchant_users WHERE user_id=$1`,
      [req.user.sub]
    );
    const user = u.rows[0];
    const daysSinceCreation = Math.floor((Date.now() - new Date(user.first_login_at||user.created_at)) / 86400000);
    const daysLeft = Math.max(0, 10 - daysSinceCreation);
    const required = daysSinceCreation >= 10;
    res.json({ mfaEnabled: user.mfa_enabled, mfaMethod: user.mfa_method, daysSinceCreation, daysLeft, required });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// (WAVE-2) L'ancienne route /auth/2fa/validate attendait un jeton `mfa_pending`
// que personne n'emettait ; elle est remplacee par la route du meme nom
// declaree avec le login (mfaToken de type merchant_mfa).

// ─── API KEYS MANAGEMENT ──────────────────────────────────────────
// HOTFIX (audit §2.9) : la cle `sk_live_…` n'est plus stockee en clair.
//   - api_key_hash  = SHA-256(cle)      (recherche a l'authentification)
//   - key_prefix    = 12 premiers chars (affichage)
//   - api_secret_hash = SHA-256(secret) (verification X-API-Secret, nouvelles cles)
// Compatibilite : les lignes legacy dont `api_key` contient encore la cle brute
// restent acceptees ; au premier usage reussi la ligne est migree (hash renseigne,
// colonne brute mise a NULL). Voir database/007c_hotfix_merchant_admin.sql.

// Lister les API keys du merchant (jamais la cle, ni le hash)
router.get('/api-keys', merchantAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT key_id, key_name, key_prefix, api_key, permissions, is_active, last_used_at, expires_at, created_at
       FROM merchant_api_keys WHERE merchant_id=$1 ORDER BY created_at DESC`,
      [req.user.merchantId]
    );
    const keys = r.rows.map(k => {
      const prefix = k.key_prefix || (k.api_key ? apiKeyPrefix(k.api_key) : 'sk_live_');
      const { api_key, key_prefix, ...rest } = k;
      return { ...rest, key_prefix: prefix, api_key: prefix + '****', legacy_plaintext: !!api_key };
    });
    res.json({ data: keys });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// Créer une nouvelle API key — la cle et le secret bruts sont renvoyes UNE SEULE FOIS
router.post('/api-keys', merchantAuth, async (req, res) => {
  const { keyName, permissions, expiresAt } = req.body;
  if (!keyName) return res.status(422).json({error:'Nom de la clé requis'});
  try {
    const apiKey    = 'sk_live_' + crypto.randomBytes(24).toString('hex');
    const apiSecret = 'sk_secret_' + crypto.randomBytes(32).toString('hex');
    const r = await query(
      `INSERT INTO merchant_api_keys (merchant_id, key_name, api_key, api_key_hash, key_prefix, api_secret, api_secret_hash, permissions, expires_at, created_by)
       VALUES ($1,$2,NULL,$3,$4,NULL,$5,$6,$7,$8)
       RETURNING key_id, key_name, key_prefix, permissions, is_active, expires_at, created_at`,
      [req.user.merchantId, keyName, hashApiKey(apiKey), apiKeyPrefix(apiKey), hashApiKey(apiSecret),
       JSON.stringify(permissions || ['collect','disburse','transactions','pay_links']),
       expiresAt || null, req.user.sub]
    );
    res.status(201).json({
      success: true,
      message: 'Conservez ces credentials — ils ne seront plus affichés.',
      key: { ...r.rows[0], api_key: apiKey, api_secret: apiSecret },
    });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// Révoquer une API key
router.delete('/api-keys/:keyId', merchantAuth, async (req, res) => {
  try {
    await query(
      `UPDATE merchant_api_keys SET is_active=FALSE, updated_at=NOW()
       WHERE key_id=$1 AND merchant_id=$2`,
      [req.params.keyId, req.user.merchantId]
    );
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// Supprimer une API key
router.delete('/api-keys/:keyId/permanent', merchantAuth, async (req, res) => {
  try {
    await query(
      `DELETE FROM merchant_api_keys WHERE key_id=$1 AND merchant_id=$2`,
      [req.params.keyId, req.user.merchantId]
    );
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── MIDDLEWARE API KEY AUTH ───────────────────────────────────────
// Recherche par hash ; repli sur la colonne brute legacy (migree au premier succes).
// X-API-Secret : verifie uniquement si la ligne possede un api_secret_hash (cles
// creees apres ce hotfix) ; pour les cles legacy l'en-tete est ignore, comme avant.
const apiKeyAuth = async (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || typeof apiKey !== 'string' || apiKey.length > 128)
    return res.status(401).json({error:'X-API-Key header requis', code:'API_KEY_REQUIRED'});
  try {
    const keyHash = hashApiKey(apiKey);
    const r = await query(
      `SELECT k.*, m.merchant_id, m.business_name, m.merchant_status
       FROM merchant_api_keys k
       JOIN merchants m ON m.merchant_id=k.merchant_id
       WHERE (k.api_key_hash=$1 OR (k.api_key_hash IS NULL AND k.api_key=$2))
         AND k.is_active=TRUE
         AND (k.expires_at IS NULL OR k.expires_at > NOW())
       LIMIT 1`,
      [keyHash, apiKey]
    );
    if (!r.rows.length) return res.status(401).json({error:'Clé API invalide ou expirée', code:'INVALID_API_KEY'});
    const key = r.rows[0];
    // Defense en profondeur : la ligne doit correspondre au hash OU a la cle brute exacte
    const matchesHash = key.api_key_hash && safeEqualHex(key.api_key_hash, keyHash);
    const matchesLegacy = !key.api_key_hash && typeof key.api_key === 'string'
      && key.api_key.length === apiKey.length
      && crypto.timingSafeEqual(Buffer.from(key.api_key), Buffer.from(apiKey));
    if (!matchesHash && !matchesLegacy) return res.status(401).json({error:'Clé API invalide ou expirée', code:'INVALID_API_KEY'});

    if (key.api_secret_hash) {
      const secret = req.headers['x-api-secret'];
      if (!secret || typeof secret !== 'string' || !safeEqualHex(key.api_secret_hash, hashApiKey(secret)))
        return res.status(401).json({error:'X-API-Secret invalide', code:'INVALID_API_SECRET'});
    }
    if (key.merchant_status !== 'active') return res.status(403).json({error:'Compte merchant inactif', code:'MERCHANT_INACTIVE'});

    let permissions = key.permissions;
    if (typeof permissions === 'string') { try { permissions = JSON.parse(permissions); } catch (e) { permissions = []; } }
    if (!Array.isArray(permissions)) permissions = [];

    req.user = { merchantId: key.merchant_id, sub: key.merchant_id, email: key.business_name, role:'api', permissions };
    req.apiKey = { ...key, permissions, api_key: undefined, api_secret: undefined, api_key_hash: undefined, api_secret_hash: undefined };

    if (matchesLegacy) {
      // Migration transparente : hash + prefixe, cle brute effacee
      query(`UPDATE merchant_api_keys SET api_key_hash=$1, key_prefix=$2, api_key=NULL, last_used_at=NOW() WHERE key_id=$3 AND api_key_hash IS NULL`,
        [keyHash, apiKeyPrefix(apiKey), key.key_id]).catch((e) => logger.warn('api key legacy migration failed', { err: e.message }));
    } else {
      query(`UPDATE merchant_api_keys SET last_used_at=NOW() WHERE key_id=$1`, [key.key_id]).catch(()=>{});
    }
    next();
  } catch(err){ res.status(500).json({error:err.message}); }
};

// ─── ROUTES PUBLIQUES API (authentification par API Key) ──────────
// HOTFIX (audit §2.6) : /public/collect rejouait /merchant/collect via axios (non
// installe) avec un Bearer factice et renvoyait success:true + txnId 'SIM-…' fictif.
// Desactive : 410 Gone, aucune ecriture.
router.post('/public/collect', apiKeyAuth, (req, res) => featureDisabled(res));

router.get('/public/transactions', apiKeyAuth, async (req, res) => {
  if (!req.apiKey.permissions.includes('transactions')) return res.status(403).json({error:'Permission transactions non accordée'});
  const { status } = req.query;
  const { page, limit, offset } = parsePagination(req.query, 20);
  try {
    const conds = ['merchant_id=$1']; const params = [req.user.merchantId];
    if (status) { params.push(status); conds.push(`status=$${params.length}`); }
    const r = await query(
      `SELECT transaction_id, type, amount, currency, status, payment_method, auth_code, reference, initiated_at
       FROM transactions WHERE ${conds.join(' AND ')}
       ORDER BY initiated_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    const cnt = await query(`SELECT COUNT(*) FROM transactions WHERE ${conds.join(' AND ')}`, params);
    res.json({ data: r.rows, total: parseInt(cnt.rows[0].count), page, limit });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/public/pay-links', apiKeyAuth, async (req, res) => {
  if (!req.apiKey.permissions.includes('pay_links')) return res.status(403).json({error:'Permission pay_links non accordée'});
  const { amount, currency='XAF', description, recipientPhone, psp='cybersource', paymentMethod='card' } = req.body;
  if (!amount || !Number.isFinite(Number(amount)) || Number(amount) <= 0) return res.status(422).json({error:'amount requis'});
  const expiresIn = parseExpiresIn(req.body.expiresIn, 24);
  if (expiresIn === null) return res.status(422).json({ error: 'expiresIn invalide (1 a 720 heures)', code: 'INVALID_EXPIRES_IN' });
  try {
    const baseUrl = process.env.PAY_LINK_BASE_URL||'https://pay.c-pay.global';
    const expiresAt = new Date(Date.now() + expiresIn*3600000);
    const r = await withShortIdRetry((shortId) => query(
      `INSERT INTO pay_links (merchant_id, short_id, amount, currency, description, short_url, expires_at, psp, payment_method, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') RETURNING pay_link_id, short_id, short_url, amount, currency, expires_at`,
      [req.user.merchantId, shortId, amount, currency, description||null, `${baseUrl}/${shortId}`, expiresAt, psp, paymentMethod]
    ));
    res.status(201).json({ success:true, ...r.rows[0] });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── WEBHOOK CONFIG ───────────────────────────────────────────────
// HOTFIX (audit §2.12, §2.22) : le secret n'est jamais renvoye apres sa creation,
// l'URL doit etre https:// et ne pas pointer vers une adresse privee (SSRF).
router.get('/webhook-config', merchantAuth, async (req, res) => {
  try {
    const r = await query(`SELECT webhook_url, webhook_secret FROM merchants WHERE merchant_id=$1`, [req.user.merchantId]);
    const row = r.rows[0] || {};
    res.json({
      webhook_url: row.webhook_url || null,
      webhook_secret: { configured: !!row.webhook_secret },
    });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.patch('/webhook-config', merchantAuth, async (req, res) => {
  const { webhookUrl, rotateSecret } = req.body || {};
  try {
    let safeUrl = null;
    if (webhookUrl) {
      try { safeUrl = await integrations.assertSafeWebhookUrl(webhookUrl); }
      catch (e) { return res.status(e.statusCode || 422).json({ error: e.message, code: e.code || 'UNSAFE_WEBHOOK_URL' }); }
    }
    const cur = await query(`SELECT webhook_secret FROM merchants WHERE merchant_id=$1`, [req.user.merchantId]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Marchand introuvable' });

    let newSecret = null;
    if (!cur.rows[0].webhook_secret || rotateSecret === true) {
      newSecret = crypto.randomBytes(32).toString('hex');
    }
    await query(
      `UPDATE merchants SET webhook_url=$1, webhook_secret=COALESCE($2, webhook_secret), updated_at=NOW() WHERE merchant_id=$3`,
      [safeUrl, newSecret, req.user.merchantId]
    );
    const body = { success: true, webhook_url: safeUrl, webhook_secret: { configured: true } };
    if (newSecret) {
      // Renvoye UNE SEULE FOIS : il n'est plus jamais lisible via l'API ensuite
      body.webhook_secret = { configured: true, value: newSecret, message: 'Conservez ce secret — il ne sera plus affiché.' };
    }
    res.json(body);
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/webhook-config/test', merchantAuth, async (req, res) => {
  try {
    const r = await query(`SELECT webhook_url, webhook_secret FROM merchants WHERE merchant_id=$1`, [req.user.merchantId]);
    const { webhook_url, webhook_secret } = r.rows[0] || {};
    if (!webhook_url) return res.status(400).json({error:'URL webhook non configurée'});
    if (!webhook_secret) return res.status(400).json({error:'Secret webhook non configuré — enregistrez la configuration (PATCH /webhook-config)', code:'WEBHOOK_SECRET_MISSING'});

    let safeUrl;
    try { safeUrl = await integrations.assertSafeWebhookUrl(webhook_url); }
    catch (e) { return res.status(e.statusCode || 422).json({ error: e.message, code: e.code || 'UNSAFE_WEBHOOK_URL' }); }

    const payload = JSON.stringify({
      event: 'webhook.test', txnId: 'test-' + Date.now(),
      reference: 'TEST-001', amount: 100, currency: 'XAF',
      status: 'authorized', method: 'test',
      timestamp: new Date().toISOString()
    });
    // WAVE-3 : signature + en-têtes partagés (X-CPay-* et X-CPlus-* de transition)
    const resp = await integrations.fetchWithTimeout(safeUrl, {
      method: 'POST',
      headers: require('../services/webhooks/outgoing').buildHeaders({ secret: webhook_secret, rawBody: payload, event: 'webhook.test' }),
      body: payload,
    });

    res.json({success:true, statusCode: resp.status, message:'Webhook test envoyé ✅'});
  } catch(err){ res.status(400).json({error:'Endpoint inaccessible: ' + err.message}); }
});

module.exports = router;
