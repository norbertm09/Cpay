'use strict';
/**
 * Caisse marchande (vague 4) — logique métier partagée.
 * Contrat : docs/CAISSE-API.md. Utilisé par routes/cash.routes.js, routes/cash-admin.routes.js
 * et par les routes historiques routes/merchant.routes.js (/balance, /transfer/payout).
 *
 *   - computeAvailableBalance : formule UNIQUE du solde (encaissements autorisés non réglés
 *     + approvisionnements completed − sorties non échouées − décaissements app) ;
 *   - createPayout : réservation atomique des fonds (verrou + INSERT 'pending' DANS la
 *     transaction SQL) puis appel rail HORS transaction — une seule machine d'état pour
 *     /transfer/payout, /cash/withdraw et /cash/transfers (wallet_to_bank) ;
 *   - transitionTransfer : point unique de changement de statut d'un merchant_transfers
 *     (webhooks, polling, admin) ; pose merchants.cash_wallet_verified_at au premier retrait completed ;
 *   - createFundingOrder : ordre d'approvisionnement banque → solde (direction='funding') ;
 *   - verifyStepUp : confirmation forte (TOTP si 2FA, sinon mot de passe), 5 échecs / 15 min → 429 ;
 *   - summary / history / historyCsv.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query, withTransaction } = require('../../config/database');
const logger = require('../../config/logger');
const { detectFromPhone } = require('../detection/detection.engine');
const { verifyTotp } = require('../../middleware/auth');

// ─── Règles ───────────────────────────────────────────────────────
const TRANSFER_MIN = 1000;                       // montant minimum (retrait / transfert), unité devise
const FUNDING_EXPIRES_DAYS = 7;
const FEE_RATES = { collect: 0.015, payout: 0.01 };
const STEP_UP_MAX_FAILURES = 5;
const STEP_UP_WINDOW_MS = 15 * 60 * 1000;

// Limites journalières de retrait par niveau KYB (devise du marchand), surchargeables par env.
const CASH_LIMITS_DEFAULT = { 0: 100000, 1: 500000, 2: 2000000 };
const envInt = (name, fallback) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
const CASH_LIMITS = () => ({
  0: envInt('CASH_WITHDRAW_DAILY_L0', CASH_LIMITS_DEFAULT[0]),
  1: envInt('CASH_WITHDRAW_DAILY_L1', CASH_LIMITS_DEFAULT[1]),
  2: envInt('CASH_WITHDRAW_DAILY_L2', CASH_LIMITS_DEFAULT[2]),
});
const withdrawDailyLimit = (kybLevel) => {
  const limits = CASH_LIMITS();
  const lvl = Math.max(0, Math.min(2, Number(kybLevel) || 0));
  return limits[lvl];
};

// Statuts
const OUT_NOT_FAILED = ['pending', 'processing', 'pending_settlement', 'pending_manual', 'completed'];
const OUT_INFLIGHT   = ['pending', 'processing', 'pending_settlement', 'pending_manual'];
const MANUAL_QUEUE   = ['pending_manual', 'pending_settlement']; // pending_settlement = legacy /transfer/payout
const CANCELLABLE    = ['awaiting_funds', 'pending_manual'];
const REJECTABLE     = ['awaiting_funds', 'pending_manual', 'pending_settlement'];
const FINAL          = ['completed', 'failed', 'cancelled', 'rejected'];
const BANK_QUEUE_STATUSES = new Set(['pending_manual', 'pending_settlement']);

// ─── Opérateurs : codes caisse (minuscules) ↔ detection.engine ────
const OPERATOR_LABELS = {
  mtn_momo: 'MTN MoMo', orange_money: 'Orange Money', airtel_money: 'Airtel Money', wave: 'Wave',
  moov_money: 'Moov Money', free_money: 'Free Money', express_union: 'Express Union Mobile',
  vodacom_mpesa: 'M-Pesa', africell_money: 'Africell Money',
};
const OPERATOR_ALIASES = {
  mtn: 'mtn_momo', momo: 'mtn_momo', airtel: 'airtel_money', orange: 'orange_money', om: 'orange_money',
  moov: 'moov_money', free: 'free_money', mpesa: 'vodacom_mpesa', vodacom: 'vodacom_mpesa',
  africell: 'africell_money', express_union_mobile: 'express_union', eu: 'express_union',
};
const normalizeOperatorCode = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return OPERATOR_ALIASES[s] || s;
};
const operatorLabel = (code) => OPERATOR_LABELS[normalizeOperatorCode(code)] || String(code || '').toUpperCase();

/**
 * Détection du wallet (pays, devise, opérateur, gateway) à partir d'un numéro.
 * `operator` ne sert qu'à forcer un service au choix du client (Wave, Express Union) ou à
 * confirmer l'opérateur détecté ; s'il contredit la détection sans être une alternative → échec.
 */
const detectWallet = (phone, { country, operator } = {}) => {
  const code = normalizeOperatorCode(operator);
  const opts = country ? { defaultCountry: country } : {};
  const d = detectFromPhone(phone, opts);
  if (!code) return d;
  if (d.success && String(d.operator).toLowerCase() === code) return d;
  const o = detectFromPhone(phone, { ...opts, operatorOverride: code.toUpperCase() });
  if (o.success) return o;
  // opérateur demandé indisponible pour ce numéro (ni détecté, ni alternative au choix du client)
  return { ...(o.phone ? o : d), success: false, code: o.code || d.code || 'OPERATOR_UNAVAILABLE', error: o.error || d.error };
};

const maskNumber = (v, keep = 4) => String(v || '').replace(new RegExp(`.(?=.{${keep}})`, 'g'), '*');
const newReference = (prefix) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const event = (type, extra = {}) => ({ at: new Date().toISOString(), type, ...extra });

// Taux de frais : merchant_fees (marchand puis défaut) sinon barème interne
const feeRate = async (merchantId, txnType, operator) => {
  try {
    const r = await query(
      `SELECT fee_rate FROM merchant_fees
       WHERE (merchant_id=$1 OR merchant_id IS NULL) AND txn_type=$2 AND ($3::text IS NULL OR operator=$3)
       ORDER BY merchant_id NULLS LAST LIMIT 1`,
      [merchantId, txnType, operator || null]);
    if (r.rows.length && Number.isFinite(parseFloat(r.rows[0].fee_rate))) return parseFloat(r.rows[0].fee_rate);
  } catch (e) { /* table absente : barème interne */ }
  return FEE_RATES[txnType] ?? 0.01;
};
const computeFee = (amount, rate) => {
  const fee = Math.round(amount * rate);
  return { fee, net: amount - fee };
};

// ─── Solde disponible — formule UNIQUE (CAISSE-API.md §1) ─────────
//   + encaissements autorisés (net_amount), hors sorties instantanées historiques
//   − net réservé/versé par les lots J+1 (y compris les lots échoués à rapprocher)
//   + approvisionnements (direction='funding') completed
//   − merchant_transfers 'payout' non échoués (pending, processing, pending_settlement, pending_manual, completed)
//   − transactions type='payout' (disburse app + retraits legacy) autorisées ou en cours
// `exec` est soit `query`, soit `client.query` dans une transaction avec verrou.
async function computeAvailableBalance(exec, merchantId) {
  const r = await exec(
    `SELECT
       COALESCE(SUM(net_amount) FILTER (WHERE status='authorized'
         AND (settlement_batch_id IS NOT NULL OR COALESCE(settlement_status,'') NOT IN ('regle','soumis','en_cours','echec'))), 0) AS collected,
       (SELECT COALESCE(SUM(total_net),0) FROM settlement_batches WHERE merchant_id=$1 AND currency=(SELECT currency FROM merchants WHERE merchant_id=$1)) AS settled,
       COALESCE(SUM(net_amount) FILTER (WHERE status='pending'), 0) AS pending,
       COUNT(*) FILTER (WHERE status='authorized') AS nb
     FROM transactions WHERE merchant_id=$1 AND currency=(SELECT currency FROM merchants WHERE merchant_id=$1) AND type IN ('collect','qr_payment','pay_link')`, [merchantId]);
  const t = await exec(
    `SELECT
       COALESCE(SUM(amount) FILTER (WHERE direction='payout' AND status = ANY($2::text[])), 0) AS withdrawn,
       COALESCE(SUM(amount) FILTER (WHERE direction='payout' AND status = ANY($3::text[])), 0) AS reserved,
       COALESCE(SUM(amount) FILTER (WHERE direction='funding' AND status='completed'), 0) AS funded
     FROM merchant_transfers
     WHERE merchant_id=$1 AND currency=(SELECT currency FROM merchants WHERE merchant_id=$1)`, [merchantId, OUT_NOT_FAILED, OUT_INFLIGHT]);
  const p = await exec(
    `SELECT COALESCE(SUM(amount),0) AS disbursed
     FROM transactions
     WHERE merchant_id=$1 AND currency=(SELECT currency FROM merchants WHERE merchant_id=$1) AND type='payout' AND status IN ('authorized','pending')`, [merchantId]);
  const collected = num(r.rows[0]?.collected);
  const settled = num(r.rows[0]?.settled);
  const funded    = num(t.rows[0]?.funded);
  const withdrawn = num(t.rows[0]?.withdrawn) + num(p.rows[0]?.disbursed);
  return {
    available: Math.max(0, collected + funded - withdrawn - settled),
    pending: num(r.rows[0]?.pending),
    reserved: num(t.rows[0]?.reserved),
    totalCollected: collected,
    totalFunded: funded,
    totalSettled: settled,
    totalWithdrawn: withdrawn,
    transactionCount: parseInt(r.rows[0]?.nb, 10) || 0,
  };
}

// Retraits (payout vers wallet) non échoués du jour — limite journalière
async function withdrawnToday(exec, merchantId) {
  const r = await exec(
    `SELECT COALESCE(SUM(amount),0) AS withdrawn_today
     FROM merchant_transfers
     WHERE merchant_id=$1 AND direction='payout' AND dest_type='wallet'
       AND status = ANY($2::text[]) AND created_at::date = CURRENT_DATE`, [merchantId, OUT_NOT_FAILED]);
  return num(r.rows[0]?.withdrawn_today);
}

const MERCHANT_COLS = `merchant_id, business_name, email, merchant_status, currency, country, kyb_level,
                       cash_wallet_operator, cash_wallet_phone, cash_wallet_verified_at`;
const getMerchant = async (merchantId, exec = query) => {
  const r = await exec(`SELECT ${MERCHANT_COLS} FROM merchants WHERE merchant_id=$1`, [merchantId]);
  return r.rows[0] || null;
};

// ─── Rails sortants ───────────────────────────────────────────────
// MTN Congo : client rails historique (env MTN_CG_*, Congo uniquement — toMtnMsisdn force 242).
// Autres opérateurs / autres pays : mobilemoney.router (api_configurations) si le provider
// implémente sendPayout et possède une clé API. Interswitch (RDC) n'a que l'initialisation collecte.
const PAYOUT_UNSUPPORTED_PREFIXES = ['interswitch_'];
async function payoutRail({ operator, gateway, country }) {
  const code = normalizeOperatorCode(operator);
  const label = operatorLabel(code);
  if (code === 'mtn_momo' && String(country || '').toUpperCase() === 'CG') {
    try {
      const mtn = require('../rails/mtn-momo.client');
      const c = (mtn.CONFIG && mtn.CONFIG.disbursements) || {};
      if (c.apiUser && c.apiKey && c.primaryKey) return { available: true, kind: 'mtn_client', gateway: gateway || 'mtn_cg', operatorLabel: label };
    } catch (e) { logger.warn('cash: mtn client unavailable', { err: e.message }); }
  }
  if (gateway && !PAYOUT_UNSUPPORTED_PREFIXES.some((p) => String(gateway).startsWith(p))) {
    try {
      const mm = require('../mobilemoney/mobilemoney.router');
      const provider = mm.getProvider(gateway);
      if (provider && typeof provider.sendPayout === 'function') {
        const cfg = await mm.getConfig(gateway);
        if (cfg && cfg.apiKey) return { available: true, kind: 'mm_router', gateway, operatorLabel: label };
      }
    } catch (e) { logger.warn('cash: payout rail lookup failed', { gateway, err: e.message }); }
  }
  return { available: false, kind: null, gateway: gateway || null, operatorLabel: label };
}

// Rail d'encaissement : provider enregistré pour la gateway détectée et implémentant collectPayment.
const collectRail = (gateway) => {
  if (!gateway) return { available: false };
  try {
    const mm = require('../mobilemoney/mobilemoney.router');
    const provider = mm.getProvider(gateway);
    return { available: !!(provider && typeof provider.collectPayment === 'function'), gateway };
  } catch (e) { return { available: false, gateway }; }
};

// Passerelle carte pour le pays du marchand : uniquement si un checkout HÉBERGÉ est réellement
// utilisable (services/cash/card-link.service : migs / mpgs configurés par env) — sinon null → 410.
async function cardGatewayFor(country) {
  try { return await require('./card-link.service').hostedCardGatewayFor(country); }
  catch (e) { logger.warn('cash: card gateway lookup failed', { err: e.message }); return null; }
}

// ─── Confirmation forte (step-up, §6) ─────────────────────────────
const stepUpFailures = new Map(); // userId → { count, first }
const stepUpState = (userId) => {
  const s = stepUpFailures.get(userId);
  if (!s || Date.now() - s.first > STEP_UP_WINDOW_MS) return null;
  return s;
};
const recordStepUpFailure = (userId) => {
  const s = stepUpState(userId) || { count: 0, first: Date.now() };
  s.count += 1;
  stepUpFailures.set(userId, s);
  return s.count;
};
const _resetStepUp = () => stepUpFailures.clear();

/**
 * @returns {{ ok:true }} ou {{ ok:false, status, body }}
 */
async function verifyStepUp({ userId, confirm }) {
  if (!userId) return { ok: false, status: 401, body: { error: 'Utilisateur non identifié', code: 'MISSING_TOKEN' } };
  const u = await query(`SELECT user_id, password_hash, mfa_enabled, mfa_secret FROM merchant_users WHERE user_id=$1`, [userId]);
  const user = u.rows[0];
  if (!user) return { ok: false, status: 401, body: { error: 'Utilisateur introuvable', code: 'INVALID_TOKEN' } };
  const methods = user.mfa_enabled && user.mfa_secret ? ['totp'] : ['password'];
  const locked = stepUpState(userId);
  if (locked && locked.count >= STEP_UP_MAX_FAILURES) {
    return { ok: false, status: 429, body: { error: 'Trop d’échecs de confirmation, réessayez dans 15 minutes', code: 'STEP_UP_LOCKED', methods } };
  }
  const c = confirm && typeof confirm === 'object' ? confirm : null;
  let ok = false;
  if (c) {
    if (methods[0] === 'totp') ok = verifyTotp(user.mfa_secret, c.code);
    else if (c.password !== undefined && c.password !== null && String(c.password) !== '') {
      ok = await bcrypt.compare(String(c.password), String(user.password_hash || ''));
    }
  }
  if (ok) { stepUpFailures.delete(userId); return { ok: true, method: methods[0] }; }
  const count = c ? recordStepUpFailure(userId) : 0;
  if (count >= STEP_UP_MAX_FAILURES) {
    return { ok: false, status: 429, body: { error: 'Trop d’échecs de confirmation, réessayez dans 15 minutes', code: 'STEP_UP_LOCKED', methods } };
  }
  return { ok: false, status: 428, body: { error: c ? 'Confirmation invalide' : 'Confirmation requise', code: 'STEP_UP_REQUIRED', methods } };
}

// ─── Sérialisation d'un merchant_transfers ────────────────────────
const transferKind = (t) => (t.direction === 'funding' ? 'transfer_in' : (t.dest_type === 'bank' ? 'transfer_out' : 'withdraw'));
const serializeTransfer = (t, { admin = false } = {}) => {
  const kind = transferKind(t);
  const out = {
    transferId: t.transfer_id,
    reference: t.reference,
    direction: t.direction === 'funding' ? 'bank_to_wallet' : (t.dest_type === 'bank' ? 'wallet_to_bank' : 'withdraw'),
    type: kind,
    status: t.status,
    amount: num(t.amount),
    fee: num(t.fee),
    net: t.net_amount === null || t.net_amount === undefined ? num(t.amount) : num(t.net_amount),
    currency: t.currency || null,
    description: t.description || null,
    createdAt: t.created_at,
    completedAt: t.completed_at || null,
    cancelledAt: t.cancelled_at || null,
    expiresAt: t.expires_at || null,
    bankReference: t.bank_reference || t.settlement_ref || null,
    errorMessage: t.error_message || null,
  };
  if (t.dest_type === 'wallet') out.wallet = { operator: t.wallet_operator || null, phone: t.wallet_phone || null };
  if (t.dest_type === 'bank') out.bankAccount = { bankName: t.inst_name || null, accountMasked: maskNumber(t.account_number), accountName: t.account_name || null };
  if (t.direction === 'funding') out.instructions = t.instructions || null;
  if (t.amount_requested !== null && t.amount_requested !== undefined) out.amountRequested = num(t.amount_requested);
  if (admin) {
    out.merchantId = t.merchant_id;
    out.merchant = t.business_name || null;
    out.merchantEmail = t.merchant_email || null;
    out.events = Array.isArray(t.events) ? t.events : [];
    out.executedBy = t.executed_by || t.settled_by || null;
    out.adminNote = t.admin_note || null;
    out.gatewayReference = t.gateway_reference || null;
    if (t.dest_type === 'bank') out.bankAccount.accountNumber = t.account_number || null;
  }
  return out;
};

const TRANSFER_SELECT = `
  SELECT mt.*, fi.name AS inst_name, ba.account_number, ba.account_name,
         m.business_name, m.email AS merchant_email, m.country AS merchant_country
  FROM merchant_transfers mt
  LEFT JOIN bank_accounts ba ON ba.account_id = mt.bank_account_id
  LEFT JOIN financial_institutions fi ON fi.institution_id = ba.institution_id
  LEFT JOIN merchants m ON m.merchant_id = mt.merchant_id`;

async function getTransfer(transferId, { merchantId } = {}) {
  const params = [transferId];
  let where = `WHERE mt.transfer_id=$1`;
  if (merchantId) { params.push(merchantId); where += ` AND mt.merchant_id=$2`; }
  const r = await query(`${TRANSFER_SELECT} ${where}`, params);
  return r.rows[0] || null;
}

// ─── Changement de statut — point unique ──────────────────────────
/**
 * @param {object} p
 * @param {string}   p.transferId
 * @param {string[]} p.from   statuts acceptés (claim atomique)
 * @param {string}   p.to
 * @param {object}   [p.patch]  { gatewayReference, bankReference, errorMessage, executedBy, adminNote, amount, amountRequested }
 * @param {object}   p.event    événement ajouté au journal JSONB
 * @param {string}   [p.merchantId]  garde d'appartenance (routes marchand)
 * @returns ligne mise à jour ou null (statut déjà changé)
 */
async function transitionTransfer({ transferId, from, to, patch = {}, event: ev, exec = query, merchantId = null }) {
  const r = await exec(
    `UPDATE merchant_transfers
     SET status=$2,
         updated_at=NOW(),
         completed_at = CASE WHEN $2 = ANY($3::text[]) THEN NOW() ELSE completed_at END,
         cancelled_at = CASE WHEN $2 = 'cancelled' THEN NOW() ELSE cancelled_at END,
         settled_at   = CASE WHEN $2 = 'completed' THEN NOW() ELSE settled_at END,
         events = COALESCE(events, '[]'::jsonb) || $4::jsonb,
         gateway_reference = COALESCE($5::text, gateway_reference),
         bank_reference    = COALESCE($6::text, bank_reference),
         settlement_ref    = COALESCE($6::text, settlement_ref),
         error_message     = COALESCE($7::text, error_message),
         executed_by       = COALESCE($8::uuid, executed_by),
         settled_by        = COALESCE($8::uuid, settled_by),
         admin_note        = COALESCE($9::text, admin_note),
         amount            = COALESCE($10::numeric, amount),
         net_amount        = CASE WHEN $10::numeric IS NOT NULL THEN $10::numeric - COALESCE(fee,0) ELSE net_amount END,
         amount_requested  = COALESCE($11::numeric, amount_requested)
     WHERE transfer_id=$1 AND status = ANY($12::text[])
       AND ($13::uuid IS NULL OR merchant_id = $13::uuid)
     RETURNING *`,
    [transferId, to, FINAL, JSON.stringify([ev || event(to)]),
     patch.gatewayReference ?? null, patch.bankReference ?? null, patch.errorMessage ?? null,
     patch.executedBy ?? null, patch.adminNote ?? null,
     patch.amount ?? null, patch.amountRequested ?? null, from, merchantId ?? null]);
  const row = r.rows[0];
  if (!row) return null;
  // Premier retrait completed vers le wallet enregistré → wallet vérifié
  if (to === 'completed' && row.direction === 'payout' && row.dest_type === 'wallet' && row.wallet_phone) {
    await exec(
      `UPDATE merchants SET cash_wallet_verified_at = NOW(), updated_at = NOW()
       WHERE merchant_id=$1 AND cash_wallet_phone=$2 AND cash_wallet_verified_at IS NULL`,
      [row.merchant_id, row.wallet_phone]).catch((e) => logger.warn('cash: wallet verify failed', { err: e.message }));
  }
  return row;
}

// ─── Création d'un paiement sortant (retrait wallet / transfert banque) ───
/**
 * @param {object} p
 * @param {string} p.merchantId
 * @param {'wallet'|'bank'} p.destType
 * @param {string} [p.accountId]        bank_accounts.account_id (destType=bank)
 * @param {object} [p.wallet]           { operator, phone, gateway, country } (destType=wallet)
 * @param {object} [p.rail]             résultat de payoutRail (destType=wallet)
 * @param {number} p.amount
 * @param {string} [p.description]
 * @param {string} [p.refPrefix='PAY']
 * @param {string} [p.bankQueueStatus='pending_manual']  'pending_settlement' pour la route historique
 * @param {number|null} [p.dailyLimit]  limite journalière (retrait) vérifiée sous verrou
 * @param {string} [p.actor]
 * @returns {{ error:{status, body} }} | {{ transfer, bankAcc, merchant, fee, net, reference }}
 */
async function createPayout(p) {
  const {
    merchantId, destType, accountId, wallet, rail, amount, description,
    refPrefix = 'PAY', bankQueueStatus = 'pending_manual', dailyLimit = null, actor = 'merchant',
  } = p;
  if (!BANK_QUEUE_STATUSES.has(bankQueueStatus)) throw new Error(`bankQueueStatus invalide: ${bankQueueStatus}`);
  const amt = Number(amount);
  const rate = await feeRate(merchantId, 'payout', wallet ? normalizeOperatorCode(wallet.operator) : null);
  const { fee, net } = computeFee(amt, rate);
  const ref = newReference(refPrefix);
  const walletOperator = wallet ? normalizeOperatorCode(wallet.operator) : null;
  const walletPhone = wallet ? wallet.phone : null;
  let bankAcc = null;
  let merchant = null;

  // 1) Réservation atomique des fonds (solde calculé sous verrou, ligne 'pending' insérée AVANT tout appel rail)
  const reservation = await withTransaction(async (client) => {
    const exec = (text, params) => client.query(text, params);
    await exec('SELECT pg_advisory_xact_lock(hashtext($1))', [String(merchantId)]);
    const m = await exec(`SELECT ${MERCHANT_COLS} FROM merchants WHERE merchant_id=$1 FOR UPDATE`, [merchantId]);
    if (!m.rows.length) return { status: 404, body: { error: 'Marchand introuvable', code: 'MERCHANT_NOT_FOUND' } };
    merchant = m.rows[0];
    if (merchant.merchant_status && merchant.merchant_status !== 'active')
      return { status: 403, body: { error: 'Compte marchand inactif', code: 'MERCHANT_INACTIVE' } };

    const bal = await computeAvailableBalance(exec, merchantId);
    if (bal.available < amt) {
      return { status: 422, body: { error: 'Solde insuffisant', code: 'INSUFFICIENT_BALANCE', available: bal.available, requested: amt } };
    }

    if (destType === 'bank') {
      const a = await exec(
        `SELECT ba.*, fi.name AS inst_name FROM bank_accounts ba
         LEFT JOIN financial_institutions fi ON fi.institution_id = ba.institution_id
         WHERE ba.account_id=$1 AND ba.owner_id=$2 AND ba.status='verified'`,
        [accountId, merchantId]);
      if (!a.rows[0]) return { status: 404, body: { error: 'Compte bancaire introuvable ou non vérifié', code: 'BANK_ACCOUNT_NOT_FOUND' } };
      bankAcc = a.rows[0];
    }

    if (dailyLimit !== null && dailyLimit !== undefined) {
      const today = await withdrawnToday(exec, merchantId);
      if (today + amt > dailyLimit) {
        return { status: 422, body: {
          error: 'Limite journalière de retrait dépassée', code: 'DAILY_LIMIT_EXCEEDED',
          limit: dailyLimit, withdrawnToday: today, remaining: Math.max(0, dailyLimit - today), requested: amt,
        } };
      }
    }

    const currency = merchant.currency || 'XAF';
    const t = await exec(
      `INSERT INTO merchant_transfers (merchant_id, direction, dest_type, bank_account_id,
        wallet_operator, wallet_phone, amount, fee, net_amount, currency, status, reference, description, events)
       VALUES ($1,'payout',$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11,$12::jsonb)
       RETURNING transfer_id, created_at`,
      [merchantId, destType, destType === 'bank' ? accountId : null,
       walletOperator, walletPhone, amt, fee, net, currency, ref,
       description || (destType === 'bank' ? 'Transfert vers banque' : 'Retrait'),
       JSON.stringify([event('created', { by: actor, status: 'pending', destType })])]);
    return { transferId: t.rows[0].transfer_id, createdAt: t.rows[0].created_at, currency };
  });

  if (reservation.status) return { error: reservation };
  const transferId = reservation.transferId;
  const base = {
    transferId, reference: ref, amount: amt, fee, net, currency: reservation.currency,
    createdAt: reservation.createdAt, destType, merchant, bankAcc,
    wallet: wallet ? { operator: walletOperator, phone: walletPhone } : null,
  };

  // 2) Appel rail HORS transaction — la ligne 'pending' est déjà comptée dans le solde
  try {
    if (destType === 'wallet') {
      if (!rail || !rail.available) {
        await transitionTransfer({ transferId, from: ['pending'], to: 'failed',
          patch: { errorMessage: 'Opérateur non configuré' }, event: event('failed', { reason: 'rail_unavailable' }) });
        return { error: { status: 503, body: { error: `${operatorLabel(walletOperator)} non configuré`, code: 'OPERATOR_NOT_CONFIGURED', transferId } } };
      }
      if (rail.kind === 'mtn_client') {
        const mtn = require('../rails/mtn-momo.client');
        const d = await mtn.transfer({ amount: net, phone: walletPhone, description: description || 'Retrait C-Pay', externalId: ref });
        await transitionTransfer({ transferId, from: ['pending'], to: 'processing',
          patch: { gatewayReference: d.referenceId || null }, event: event('processing', { rail: 'mtn_client', gatewayReference: d.referenceId || null }) });
        return { transfer: { ...base, status: 'processing', gatewayReference: d.referenceId || null } };
      }
      // mobilemoney.router
      const mm = require('../mobilemoney/mobilemoney.router');
      const res = await mm.sendPayout({
        txnId: transferId, amount: net, currency: reservation.currency, phone: walletPhone,
        operator: String(walletOperator || '').toUpperCase(), gateway: rail.gateway, country: wallet.country || null,
      });
      if (res.approved) {
        await transitionTransfer({ transferId, from: ['pending'], to: 'completed',
          patch: { gatewayReference: res.gatewayRef || res.authCode || null }, event: event('completed', { rail: rail.gateway, responseCode: res.responseCode }) });
        return { transfer: { ...base, status: 'completed', gatewayReference: res.gatewayRef || res.authCode || null } };
      }
      if (res.pending) {
        await transitionTransfer({ transferId, from: ['pending'], to: 'processing',
          patch: { gatewayReference: res.gatewayRef || res.authCode || null }, event: event('processing', { rail: rail.gateway, responseCode: res.responseCode }) });
        return { transfer: { ...base, status: 'processing', gatewayReference: res.gatewayRef || res.authCode || null } };
      }
      await transitionTransfer({ transferId, from: ['pending'], to: 'failed',
        patch: { errorMessage: String(res.declineReason || 'Retrait refusé').slice(0, 200) }, event: event('failed', { rail: rail.gateway, responseCode: res.responseCode, reason: res.declineReason || null }) });
      return { error: { status: 502, body: { error: res.declineReason || 'Retrait refusé par l’opérateur', code: 'GATEWAY_ERROR', transferId, retryable: !!res.retryable } } };
    }

    // Vers une banque : aucun rail bancaire branché → file d'attente manuelle (opérations C-Pay, J+1 ouvré)
    await query(
      `UPDATE merchant_transfers SET status='${bankQueueStatus}', settlement_method='manual', updated_at=NOW(),
         events = COALESCE(events,'[]'::jsonb) || $2::jsonb
       WHERE transfer_id=$1`, [transferId, JSON.stringify([event(bankQueueStatus, { rail: 'manual' })])]);
    notifyOpsBankPayout({ merchant, merchantId, ref, amt, fee, net, currency: reservation.currency, bankAcc }).catch(() => {});
    return { transfer: { ...base, status: bankQueueStatus } };
  } catch (err) {
    logger.error('cash: payout rail error', { transferId, err: err.message });
    await transitionTransfer({ transferId, from: ['pending'], to: 'failed',
      patch: { errorMessage: String(err.message || 'erreur rail').slice(0, 200) }, event: event('failed', { reason: 'rail_error' }) }).catch(() => {});
    return { error: { status: 502, body: { error: err.message, code: 'GATEWAY_ERROR', transferId } } };
  }
}

async function notifyOpsBankPayout({ merchant, merchantId, ref, amt, fee, net, currency, bankAcc }) {
  try {
    const email = require('../notifications/email.service');
    const name = merchant?.business_name || merchantId;
    await email.send({
      to: process.env.ADMIN_ALERT_EMAIL || 'support@c-pay.global',
      subject: `Virement à traiter — ${net} ${currency} — ${name}`,
      html: `<h2>Nouvelle demande de transfert vers banque</h2>
        <table style="border-collapse:collapse">
        <tr><td style="padding:6px 12px"><b>Marchand</b></td><td>${name}</td></tr>
        <tr><td style="padding:6px 12px"><b>Référence</b></td><td>${ref}</td></tr>
        <tr><td style="padding:6px 12px"><b>Montant brut</b></td><td>${amt} ${currency}</td></tr>
        <tr><td style="padding:6px 12px"><b>Frais</b></td><td>${fee} ${currency}</td></tr>
        <tr><td style="padding:6px 12px"><b>Net à virer</b></td><td><b>${net} ${currency}</b></td></tr>
        <tr><td style="padding:6px 12px"><b>Banque</b></td><td>${bankAcc?.inst_name || ''}</td></tr>
        <tr><td style="padding:6px 12px"><b>Compte</b></td><td>${bankAcc?.account_number || ''}</td></tr>
        <tr><td style="padding:6px 12px"><b>Titulaire</b></td><td>${bankAcc?.account_name || ''}</td></tr>
        </table>
        <p>Traitez ce virement dans le back-office admin (Caisse → transferts en attente).</p>`,
    });
  } catch (e) { logger.warn('cash: ops email failed', { err: e.message }); }
}

// ─── Statut réel d'un retrait 'processing' (polling opérateur) ────
// Appelé par GET /cash/transfers/:id et l'admin : MTN (client rails Congo ou provider pays),
// autres providers via getStatus({ product:'disbursement' }) quand il existe. Toute
// indisponibilité laisse 'processing'.
async function refreshPayoutStatus(t) {
  if (!t || t.status !== 'processing' || t.direction !== 'payout' || t.dest_type !== 'wallet' || !t.gateway_reference) return t;
  const code = normalizeOperatorCode(t.wallet_operator);
  const country = String(t.merchant_country || '').toUpperCase();
  try {
    let st = null; let reason = null; let gatewayRef = null;
    if (code === 'mtn_momo') {
      let s = null;
      if (country && country !== 'CG') {
        try {
          const mm = require('../mobilemoney/mobilemoney.router');
          const cfg = await mm.getConfig(`mtn_${country.toLowerCase()}`);
          if (cfg && cfg.apiKey && cfg.baseUrl) s = await require('../mobilemoney/providers/mtn.provider').getTransferStatus(cfg, t.gateway_reference);
        } catch (e) { s = null; }
      }
      if (!s) s = await require('../rails/mtn-momo.client').getDisbursementStatus(t.gateway_reference);
      st = String(s?.status || '').toUpperCase(); reason = s?.reason || null; gatewayRef = s?.financialTxnId || s?.financialTransactionId || null;
    } else {
      const d = detectWallet(t.wallet_phone, { country, operator: code });
      const gateway = d.success ? d.gateway : null;
      if (!gateway) return t;
      const mm = require('../mobilemoney/mobilemoney.router');
      const provider = mm.getProvider(gateway);
      if (!provider || typeof provider.getStatus !== 'function') return t;
      const cfg = await mm.getConfig(gateway);
      const s = await provider.getStatus({ txnId: t.transfer_id, gatewayRef: t.gateway_reference, config: cfg, product: 'disbursement' });
      if (!s || s.available === false) return t;
      st = String(s.status || '').toUpperCase(); reason = s.reason || null; gatewayRef = s.gatewayRef || null;
    }
    if (st === 'SUCCESSFUL') {
      const row = await transitionTransfer({ transferId: t.transfer_id, from: ['processing'], to: 'completed',
        patch: { gatewayReference: gatewayRef }, event: event('completed', { source: 'status_poll' }) });
      return row ? { ...t, ...row } : t;
    }
    if (st === 'FAILED') {
      const row = await transitionTransfer({ transferId: t.transfer_id, from: ['processing'], to: 'failed',
        patch: { errorMessage: String(reason || 'Retrait échoué').slice(0, 200) }, event: event('failed', { source: 'status_poll', reason }) });
      return row ? { ...t, ...row } : t;
    }
  } catch (e) {
    logger.warn('cash: payout status poll failed (left processing)', { transferId: t.transfer_id, err: e.message });
  }
  return t;
}

// ─── Ordre d'approvisionnement (bank_to_wallet) ───────────────────
async function platformAccountFor(currency) {
  const r = await query(
    `SELECT * FROM platform_bank_accounts WHERE currency=$1 AND active = TRUE ORDER BY updated_at DESC LIMIT 1`,
    [String(currency || '').toUpperCase()]);
  return r.rows[0] || null;
}

async function createFundingOrder({ merchantId, amount, description, accountId, actor = 'merchant' }) {
  const merchant = await getMerchant(merchantId);
  if (!merchant) return { error: { status: 404, body: { error: 'Marchand introuvable', code: 'MERCHANT_NOT_FOUND' } } };
  if (merchant.merchant_status && merchant.merchant_status !== 'active')
    return { error: { status: 403, body: { error: 'Compte marchand inactif', code: 'MERCHANT_INACTIVE' } } };
  const amt = Number(amount);
  const currency = merchant.currency || 'XAF';
  const platform = await platformAccountFor(currency);
  if (!platform) return { error: { status: 409, body: { error: `Aucun compte de collecte C-Pay pour la devise ${currency}`, code: 'FUNDING_UNAVAILABLE', currency } } };
  if (accountId) {
    const a = await query(`SELECT account_id FROM bank_accounts WHERE account_id=$1 AND owner_id=$2 AND status != 'removed'`, [accountId, merchantId]);
    if (!a.rows[0]) return { error: { status: 404, body: { error: 'Compte bancaire introuvable', code: 'BANK_ACCOUNT_NOT_FOUND' } } };
  }
  const ref = newReference('FND');
  const expiresAt = new Date(Date.now() + FUNDING_EXPIRES_DAYS * 24 * 3600 * 1000);
  const instructions = {
    bankName: platform.bank_name, accountName: platform.account_name, accountNumber: platform.account_number,
    iban: platform.iban || undefined, swift: platform.swift || undefined,
    reference: ref, expiresAt: expiresAt.toISOString(), currency, amount: amt,
  };
  const r = await query(
    `INSERT INTO merchant_transfers (merchant_id, direction, dest_type, bank_account_id, amount, fee, net_amount, currency,
        status, reference, description, instructions, expires_at, events)
     VALUES ($1,'funding','balance',$2,$3,0,$3,$4,'awaiting_funds',$5,$6,$7::jsonb,$8,$9::jsonb)
     RETURNING *`,
    [merchantId, accountId || null, amt, currency, ref, description || 'Approvisionnement',
     JSON.stringify(instructions), expiresAt, JSON.stringify([event('created', { by: actor, status: 'awaiting_funds' })])]);
  return { transfer: r.rows[0], instructions, reference: ref, currency, expiresAt };
}

async function cancelTransfer({ merchantId, transferId, actor = 'merchant' }) {
  const row = await transitionTransfer({ transferId, merchantId, from: CANCELLABLE, to: 'cancelled', event: event('cancelled', { by: actor }) });
  if (row) return { transfer: row };
  const t = await getTransfer(transferId, { merchantId });
  if (!t) return { error: { status: 404, body: { error: 'Transfert introuvable', code: 'TRANSFER_NOT_FOUND' } } };
  return { error: { status: 409, body: { error: `Transfert non annulable (statut ${t.status})`, code: 'TRANSFER_NOT_CANCELLABLE', status: t.status } } };
}

// ─── Résumé (§1) ──────────────────────────────────────────────────
async function summary(merchantId) {
  const merchant = await getMerchant(merchantId);
  if (!merchant) return null;
  const currency = merchant.currency || 'XAF';
  const bal = await computeAvailableBalance(query, merchantId);
  const today = await query(
    `SELECT COALESCE(SUM(net_amount) FILTER (WHERE status='authorized'),0) AS collected,
            COUNT(*) FILTER (WHERE status='authorized') AS n,
            COALESCE(SUM(net_amount) FILTER (WHERE status='authorized' AND payment_method='mobile_money'),0) AS mm,
            COALESCE(SUM(net_amount) FILTER (WHERE status='authorized' AND payment_method IN ('card_nfc','pay_link')),0) AS card
     FROM transactions WHERE merchant_id=$1 AND currency=(SELECT currency FROM merchants WHERE merchant_id=$1) AND type IN ('collect','qr_payment','pay_link') AND initiated_at::date = CURRENT_DATE`, [merchantId]);
  const moves = await query(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE direction='payout' AND dest_type='wallet' AND status = ANY($2::text[])),0) AS withdrawn,
            COALESCE(SUM(amount) FILTER (WHERE direction='payout' AND dest_type='bank' AND status = ANY($2::text[])),0) AS transfers_out,
            COALESCE(SUM(amount) FILTER (WHERE direction='funding' AND status='completed'),0) AS transfers_in
     FROM merchant_transfers WHERE merchant_id=$1 AND created_at::date = CURRENT_DATE`, [merchantId, OUT_NOT_FAILED]);
  const banks = await query(
    `SELECT COUNT(*)::int AS n FROM bank_accounts WHERE owner_type='merchant' AND owner_id=$1 AND status='verified'`, [merchantId]);
  const limit = withdrawDailyLimit(merchant.kyb_level);
  const withdrawnDay = num(moves.rows[0]?.withdrawn);
  const cardGw = await cardGatewayFor(merchant.country);
  // Aperçu des frais (règle plateforme : pourcentage, pas de part fixe ni de minimum)
  const withdrawRate = await feeRate(merchantId, 'payout', normalizeOperatorCode(merchant.cash_wallet_operator));
  const transferRate = await feeRate(merchantId, 'payout', null);
  const feeRule = (rate) => ({ percent: Math.round(rate * 10000) / 100, fixed: 0, min: 0 });
  const fees = { withdraw: feeRule(withdrawRate), transfer: feeRule(transferRate) };
  return {
    currency,
    balance: { available: bal.available, pending: bal.pending, reserved: bal.reserved },
    fees,
    today: {
      collected: num(today.rows[0]?.collected), collectedCount: parseInt(today.rows[0]?.n, 10) || 0,
      byMethod: { mobile_money: num(today.rows[0]?.mm), card: num(today.rows[0]?.card) },
      withdrawn: withdrawnDay, transfersOut: num(moves.rows[0]?.transfers_out), transfersIn: num(moves.rows[0]?.transfers_in),
    },
    limits: {
      withdrawDailyMax: limit, withdrawDailyRemaining: Math.max(0, limit - withdrawnDay), transferMin: TRANSFER_MIN,
      withdrawFeePercent: fees.withdraw.percent, withdrawFeeFixed: fees.withdraw.fixed, withdrawFeeMin: fees.withdraw.min,
    },
    profile: {
      kybLevel: Number(merchant.kyb_level) || 0,
      wallet: merchant.cash_wallet_phone
        ? { operator: merchant.cash_wallet_operator, phone: merchant.cash_wallet_phone, verifiedAt: merchant.cash_wallet_verified_at || null }
        : null,
      bankAccounts: banks.rows[0]?.n || 0,
      cardAcceptance: cardGw ? 'link' : 'unavailable',
    },
  };
}

// ─── Journal (§7) ─────────────────────────────────────────────────
const HISTORY_TYPES = ['collect', 'withdraw', 'transfer_out', 'transfer_in'];
const HISTORY_CTE = `
  WITH j AS (
    SELECT t.transaction_id::text AS id,
           CASE WHEN t.type='payout' THEN 'withdraw' ELSE 'collect' END AS type,
           COALESCE(t.gateway_order_id, t.transaction_id::text) AS reference,
           t.amount AS amount, COALESCE(t.fee_amount,0) AS fee, COALESCE(t.net_amount, t.amount) AS net,
           t.currency::text AS currency, t.status::text AS status,
           'operator' AS cp_kind, COALESCE(t.detected_operator, '') AS cp_name, '' AS cp_number,
           t.payment_method::text AS method, t.initiated_at AS created_at, t.description AS description
    FROM transactions t
    WHERE t.merchant_id=$1 AND t.type IN ('collect','payout')
    UNION ALL
    SELECT mt.transfer_id::text,
           CASE WHEN mt.direction='funding' THEN 'transfer_in' WHEN mt.dest_type='bank' THEN 'transfer_out' ELSE 'withdraw' END,
           COALESCE(mt.reference, mt.transfer_id::text),
           mt.amount, COALESCE(mt.fee,0), COALESCE(mt.net_amount, mt.amount),
           mt.currency::text, mt.status::text,
           CASE WHEN mt.direction='funding' THEN 'platform' WHEN mt.dest_type='bank' THEN 'bank' ELSE 'wallet' END,
           CASE WHEN mt.direction='funding' THEN COALESCE(mt.instructions->>'bankName','C-Pay') WHEN mt.dest_type='bank' THEN COALESCE(fi.name,'') ELSE COALESCE(mt.wallet_operator,'') END,
           CASE WHEN mt.dest_type='bank' THEN COALESCE(ba.account_number,'') WHEN mt.dest_type='wallet' THEN COALESCE(mt.wallet_phone,'') ELSE '' END,
           CASE WHEN mt.dest_type='wallet' THEN 'mobile_money' ELSE 'bank_transfer' END,
           mt.created_at, mt.description
    FROM merchant_transfers mt
    LEFT JOIN bank_accounts ba ON ba.account_id = mt.bank_account_id
    LEFT JOIN financial_institutions fi ON fi.institution_id = ba.institution_id
    WHERE mt.merchant_id=$1
  )`;
const HISTORY_WHERE = `WHERE ($2::timestamptz IS NULL OR created_at >= $2::timestamptz)
    AND ($3::timestamptz IS NULL OR created_at < $3::timestamptz)
    AND ($4::text IS NULL OR type = $4::text)`;

const parseDate = (v, endOfDay = false) => {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z` : s);
  if (Number.isNaN(d.getTime())) return undefined; // invalide
  return d;
};

const counterpartyLabel = (r) => {
  const name = r.cp_name ? operatorLabel(r.cp_name) === String(r.cp_name).toUpperCase() ? r.cp_name : operatorLabel(r.cp_name) : '';
  if (r.cp_kind === 'bank')   return `${name} ${maskNumber(r.cp_number)}`.trim();
  if (r.cp_kind === 'wallet') return `${name} ${maskNumber(r.cp_number, 3)}`.trim();
  return name || null;
};
const serializeHistoryRow = (r) => ({
  id: r.id, type: r.type, reference: r.reference,
  amount: num(r.amount), fee: num(r.fee), net: num(r.net), currency: r.currency || null,
  status: r.status, counterparty: counterpartyLabel(r), method: r.method || null,
  description: r.description || null, createdAt: r.created_at,
});

/**
 * @returns {{ data, total, totals:{in,out} }} ou {{ error }} (paramètres invalides)
 */
async function history(merchantId, { from, to, type, limit, offset } = {}) {
  const f = parseDate(from); const t = parseDate(to, true);
  if (f === undefined || t === undefined) return { error: { status: 422, body: { error: 'from / to invalides (ISO 8601)', code: 'VALIDATION_ERROR' } } };
  if (type !== undefined && type !== null && type !== '' && !HISTORY_TYPES.includes(type))
    return { error: { status: 422, body: { error: `type: ${HISTORY_TYPES.join('|')}`, code: 'VALIDATION_ERROR' } } };
  let lim = parseInt(limit, 10); if (!Number.isFinite(lim)) lim = 50; lim = Math.min(200, Math.max(1, lim));
  let off = parseInt(offset, 10); if (!Number.isFinite(off) || off < 0) off = 0;
  const params = [merchantId, f, t, type || null];
  const rows = await query(`${HISTORY_CTE} SELECT * FROM j ${HISTORY_WHERE} ORDER BY created_at DESC LIMIT $5 OFFSET $6`, [...params, lim, off]);
  const tot = await query(
    `${HISTORY_CTE} SELECT COUNT(*)::int AS total,
       COALESCE(SUM(net) FILTER (WHERE type IN ('collect','transfer_in') AND status IN ('authorized','completed')),0) AS total_in,
       COALESCE(SUM(amount) FILTER (WHERE type IN ('withdraw','transfer_out') AND status NOT IN ('failed','cancelled','rejected','expired','reversed','refunded')),0) AS total_out
     FROM j ${HISTORY_WHERE}`, params);
  return {
    data: rows.rows.map(serializeHistoryRow),
    total: parseInt(tot.rows[0]?.total, 10) || 0,
    totals: { in: num(tot.rows[0]?.total_in), out: num(tot.rows[0]?.total_out) },
    limit: lim, offset: off,
  };
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
async function historyCsv(merchantId, { from, to, type } = {}) {
  const f = parseDate(from); const t = parseDate(to, true);
  if (f === undefined || t === undefined) return { error: { status: 422, body: { error: 'from / to invalides (ISO 8601)', code: 'VALIDATION_ERROR' } } };
  if (type && !HISTORY_TYPES.includes(type)) return { error: { status: 422, body: { error: `type: ${HISTORY_TYPES.join('|')}`, code: 'VALIDATION_ERROR' } } };
  const rows = await query(`${HISTORY_CTE} SELECT * FROM j ${HISTORY_WHERE} ORDER BY created_at DESC LIMIT 10000`, [merchantId, f, t, type || null]);
  const header = ['date', 'type', 'reference', 'montant', 'frais', 'net', 'devise', 'statut', 'contrepartie', 'methode', 'description'];
  const lines = [header.join(';')];
  for (const r of rows.rows.map(serializeHistoryRow)) {
    lines.push([
      r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt, r.type, r.reference, r.amount, r.fee, r.net,
      r.currency, r.status, r.counterparty, r.method, r.description,
    ].map(csvCell).join(';'));
  }
  return { csv: '﻿' + lines.join('\r\n') + '\r\n', count: rows.rows.length };
}

module.exports = {
  // règles
  TRANSFER_MIN, FUNDING_EXPIRES_DAYS, FEE_RATES, CASH_LIMITS, CASH_LIMITS_DEFAULT, withdrawDailyLimit,
  OUT_NOT_FAILED, OUT_INFLIGHT, MANUAL_QUEUE, CANCELLABLE, REJECTABLE, FINAL, HISTORY_TYPES,
  // opérateurs
  OPERATOR_LABELS, normalizeOperatorCode, operatorLabel, detectWallet, maskNumber,
  // solde / frais
  computeAvailableBalance, withdrawnToday, getMerchant, feeRate, computeFee,
  // rails
  payoutRail, collectRail, cardGatewayFor,
  // step-up
  verifyStepUp, _resetStepUp,
  // transferts
  createPayout, transitionTransfer, refreshPayoutStatus, createFundingOrder, cancelTransfer,
  getTransfer, serializeTransfer, transferKind, platformAccountFor, newReference, event,
  // résumé / journal
  summary, history, historyCsv,
};
