'use strict';
/**
 * Caisse marchande — WAVE-4 (docs/CAISSE-API.md)
 * Monté sur /api/v1/merchant/cash — toutes les routes exigent merchantAuth.
 *
 *   GET  /summary                 solde, activité du jour, limites, profil (§1)
 *   POST /collect                 encaisser : mobile_money (détection opérateur → orchestrateur) | card (lien hébergé) (§2)
 *   GET  /collect/:txnId          statut d'un encaissement (re-interrogation opérateur si pending)
 *   GET|PUT /wallet               wallet du marchand, destination des retraits (§3, step-up)
 *   POST /withdraw                retrait vers le wallet enregistré (§4, step-up, limite journalière)
 *   POST /transfers               wallet_to_bank (step-up) | bank_to_wallet (ordre d'approvisionnement) (§5)
 *   GET  /transfers[/:id]         liste / détail ; POST /transfers/:id/cancel
 *   GET  /history[/export.csv]    journal unique (§7)
 *
 * Toute la logique métier (solde, réservation atomique, rails, step-up) est dans
 * services/cash/cash.service.js, partagée avec /merchant/transfer/payout et l'admin.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { query } = require('../config/database');
const { merchantAuth, requireMerchantOwner } = require('../middleware/auth');
const { idempotency, attachResource } = require('../middleware/idempotency');
const logger = require('../config/logger');
const cash = require('../services/cash/cash.service');

const ZERO_DECIMAL = new Set(['XOF', 'XAF', 'CDF']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mid = (req) => req.merchant?.merchantId || req.user?.merchantId;
const fail = (res, status, error, code, extra = {}) => res.status(status).json({ error, code, ...extra });
const actor = (req) => ({ type: 'merchant', id: req.user?.sub || null, email: req.user?.email || null, role: req.user?.role || null });
// Audit log marchand (best effort) — même table que l'admin
const merchantAudit = async (req, action, entityType, entityId, newValues, oldValues = null) => {
  try {
    await query(
      `INSERT INTO audit_logs (actor_type, actor_id, actor_email, action, entity_type, entity_id, old_values, new_values, ip_address)
       VALUES ('merchant',$1,$2,$3,$4,$5,$6,$7,$8)`,
      [UUID_RE.test(String(req.user?.sub || '')) ? req.user.sub : null, req.user?.email || null, action, entityType,
       UUID_RE.test(String(entityId || '')) ? entityId : null, oldValues ? JSON.stringify(oldValues) : null, JSON.stringify(newValues || {}), req.ip || null]);
  } catch (e) { logger.warn('[cash] audit log failed', { action, err: e.message }); }
};
// WAVE-6 : réponse d'un ordre sortant — `unknown` (résultat opérateur incertain) reste 201 avec outcome
const payoutResponse = (res, t, body) => res.status(201).json({
  ...body, status: t.status,
  ...(t.status === 'unknown' ? { outcome: 'unknown', message: t.message || 'Résultat opérateur incertain — vérification en cours, fonds réservés' } : {}),
});
const featureDisabled = (res, extra = {}) => res.status(410).json({
  error: 'Fonctionnalité désactivée en attendant l’intégration opérateur', code: 'FEATURE_DISABLED', ...extra,
});

/** Montant : nombre > 0 ; entier pour XOF/XAF/CDF. Retourne { amount } ou { error }. */
const parseAmount = (v, currency, min = 1) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return { error: 'Montant invalide' };
  if (ZERO_DECIMAL.has(String(currency || '').toUpperCase()) && !Number.isInteger(n)) return { error: `Montant entier attendu en ${currency}` };
  if (n < min) return { error: `Montant minimum ${min} ${currency || ''}`.trim() };
  return { amount: n };
};

const loadActiveMerchant = async (req, res) => {
  const m = await cash.getMerchant(mid(req));
  if (!m) { fail(res, 404, 'Marchand introuvable', 'MERCHANT_NOT_FOUND'); return null; }
  if (m.merchant_status && m.merchant_status !== 'active') { fail(res, 403, 'Compte marchand inactif', 'MERCHANT_INACTIVE'); return null; }
  return m;
};

// ─── §1 Résumé ────────────────────────────────────────────────────
router.get('/summary', merchantAuth, async (req, res) => {
  const s = await cash.summary(mid(req));
  if (!s) return fail(res, 404, 'Marchand introuvable', 'MERCHANT_NOT_FOUND');
  res.json(s);
});

// ─── §2 Encaisser ─────────────────────────────────────────────────
const SHORT_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const generateShortId = (len = 8) =>
  Array.from({ length: len }, () => SHORT_ID_ALPHABET[crypto.randomInt(SHORT_ID_ALPHABET.length)]).join('');

const createCardPayLink = async ({ merchantId, amount, currency, description, gateway }) => {
  const baseUrl = (process.env.PAY_LINK_BASE_URL || 'https://pay.c-pay.global').replace(/\/+$/, '');
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
  let lastErr;
  for (let i = 0; i < 5; i++) {
    const shortId = generateShortId();
    try {
      const r = await query(
        `INSERT INTO pay_links (pay_link_id, merchant_id, short_id, amount, currency, description, short_url, expires_at, psp, payment_method, status, type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'card','pending','paylink')
         RETURNING pay_link_id, short_id, short_url, expires_at`,
        [crypto.randomUUID(), merchantId, shortId, amount, currency, description || 'Encaissement carte', `${baseUrl}/${shortId}`, expiresAt, gateway]);
      return r.rows[0] || { pay_link_id: null, short_id: shortId, short_url: `${baseUrl}/${shortId}`, expires_at: expiresAt };
    } catch (e) {
      lastErr = e;
      if (e.code !== '23505') throw e; // seule la collision de short_id est rejouée
    }
  }
  throw lastErr;
};

router.post('/collect', merchantAuth, idempotency, async (req, res) => {
  const { method, customerPhone, operator, description, reference, terminalId, deviceId } = req.body || {};
  if (!['mobile_money', 'card'].includes(method)) return fail(res, 422, 'method: mobile_money | card', 'VALIDATION_ERROR');
  const merchant = await loadActiveMerchant(req, res);
  if (!merchant) return;
  const merchantId = merchant.merchant_id;
  const merchantCurrency = String(merchant.currency || 'XAF').toUpperCase();
  const { amount, error: amountError } = parseAmount(req.body?.amount, merchantCurrency);
  if (amountError) return fail(res, 422, amountError, 'VALIDATION_ERROR');
  const requestedCurrency = req.body?.currency ? String(req.body.currency).toUpperCase() : null;
  if (requestedCurrency && requestedCurrency !== merchantCurrency) {
    return fail(res, 422, `Devise ${requestedCurrency} différente de celle du marchand (${merchantCurrency})`, 'CURRENCY_MISMATCH', { currency: requestedCurrency, merchantCurrency });
  }
  const desc = [reference, description].filter(Boolean).join(' — ') || null;

  // ── Carte : lien de paiement hébergé si une passerelle carte est configurée pour le pays ──
  if (method === 'card') {
    const gateway = await cash.cardGatewayFor(merchant.country);
    if (!gateway) return featureDisabled(res, { method: 'card', reason: 'Aucune passerelle carte configurée pour ce pays' });
    const link = await createCardPayLink({ merchantId, amount, currency: merchantCurrency, description: desc, gateway });
    return res.status(201).json({
      txnId: null, status: 'pending', method: 'card', gateway, amount, currency: merchantCurrency,
      payLink: { shortId: link.short_id, shortUrl: link.short_url, expiresAt: link.expires_at },
      message: 'Lien de paiement carte créé — le client paie sur la page hébergée',
    });
  }

  // ── Mobile Money : détection depuis le numéro, devise = pays du numéro ──
  if (!customerPhone) return fail(res, 422, 'customerPhone requis', 'VALIDATION_ERROR');
  const d = cash.detectWallet(customerPhone, { country: merchant.country, operator });
  if (!d.success) {
    return fail(res, 422, d.error || 'Numéro invalide', d.code || 'PHONE_INVALID',
      d.alternatives && d.alternatives.length ? { alternatives: d.alternatives.map((a) => ({ operator: String(a.operator).toLowerCase(), label: a.brand })) } : {});
  }
  const operatorCode = cash.normalizeOperatorCode(d.operator);
  const operatorLabel = d.brand || cash.operatorLabel(operatorCode);
  if (String(d.currency).toUpperCase() !== merchantCurrency) {
    return fail(res, 422, `Numéro ${d.countryName || d.country} en ${d.currency} : devise différente de celle du marchand (${merchantCurrency})`,
      'CURRENCY_MISMATCH', { currency: d.currency, merchantCurrency, country: d.country });
  }
  const rail = cash.collectRail(d.gateway);
  if (!rail.available) return featureDisabled(res, { method: 'mobile_money', operator: operatorCode, operatorLabel, country: d.country });

  // Même chemin que /merchant/collect et POST /api/v1/collect : orchestrateur (plafonds KYB, fraude, routage, journal)
  const orchestrator = require('../services/orchestration/orchestrator');
  const result = await orchestrator.processTransaction({
    merchantId, type: 'collect', amount, customerPhone: d.phone, description: desc || 'Encaissement caisse',
    deviceId: terminalId || deviceId || null, operatorOverride: d.overridden ? d.operator : undefined,
  });
  if (result.txnId) await attachResource(req, { type: 'transaction', id: result.txnId });
  if (!result.success && !result.pending) {
    if (result.code === 'FRAUD_UNAVAILABLE') return fail(res, 503, result.error, 'FRAUD_UNAVAILABLE', { txnId: result.txnId || null });
    if (result.limitInfo) return fail(res, 429, result.error || 'Plafond atteint', 'LIMIT_EXCEEDED', { txnId: result.txnId || null, limit: result.limitInfo.limit, currentVolume: result.limitInfo.currentVolume });
    if (result.status === 'failed' || result.code === 'PAYMENT_DECLINED') return fail(res, 402, result.error || result.message || 'Paiement refusé', 'PAYMENT_DECLINED', { txnId: result.txnId || null });
    return fail(res, result.statusCode || 422, result.error || 'Encaissement impossible', result.code || 'VALIDATION_ERROR', { txnId: result.txnId || null });
  }
  const { fee, net } = cash.computeFee(amount, await cash.feeRate(merchantId, 'collect', operatorCode));
  res.status(201).json({
    txnId: result.txnId, status: result.status || 'pending', method: 'mobile_money',
    operator: operatorCode, operatorLabel, country: d.country, currency: merchantCurrency,
    amount, fee, net, feeEstimated: true,
    statusUrl: `/api/v1/merchant/cash/collect/${result.txnId}`,
    message: result.message || 'Demande envoyée — le client confirme sur son téléphone',
  });
});

router.get('/collect/:txnId', merchantAuth, async (req, res) => {
  const merchantId = mid(req);
  const load = () => query(
    `SELECT transaction_id, merchant_id, type, amount, currency, fee_amount, net_amount, status, payment_method,
            detected_operator, detected_country, gateway_name, gateway_payment_id, gateway_order_id, pay_link_id,
            auth_code, response_message, description, initiated_at, completed_at
     FROM transactions WHERE transaction_id=$1 AND merchant_id=$2`, [req.params.txnId, merchantId]);
  let r = await load();
  if (!r.rows[0]) return fail(res, 404, 'Transaction introuvable', 'NOT_FOUND');
  let t = r.rows[0];
  // En attente : re-interroger l'opérateur (même machine d'état que la réconciliation / les webhooks)
  if (t.status === 'pending' && t.gateway_payment_id) {
    try {
      const { reconcileOne } = require('../services/reconcile.service');
      const out = await reconcileOne(t);
      if (out && out.updated) { r = await load(); t = r.rows[0] || t; }
    } catch (e) { logger.warn('cash: collect status poll failed', { txnId: t.transaction_id, err: e.message }); }
  }
  const operatorCode = cash.normalizeOperatorCode(t.detected_operator);
  res.json({
    txnId: t.transaction_id, status: t.status, amount: Number(t.amount),
    fee: Number(t.fee_amount || 0), net: Number(t.net_amount || 0), currency: t.currency,
    method: t.payment_method, operator: operatorCode, operatorLabel: operatorCode ? cash.operatorLabel(operatorCode) : null,
    country: t.detected_country || null, customerPhone: null, // le numéro client n'est pas conservé en clair
    reference: t.gateway_order_id || null, description: t.description || null, message: t.response_message || null,
    createdAt: t.initiated_at, finalizedAt: t.completed_at || null,
  });
});

// ─── §3 Wallet du marchand ────────────────────────────────────────
router.get('/wallet', merchantAuth, async (req, res) => {
  const m = await cash.getMerchant(mid(req));
  if (!m) return fail(res, 404, 'Marchand introuvable', 'MERCHANT_NOT_FOUND');
  if (!m.cash_wallet_phone) return res.status(204).end();
  res.json({ operator: m.cash_wallet_operator, phone: m.cash_wallet_phone, verifiedAt: m.cash_wallet_verified_at || null });
});

// WAVE-6 (audit §3) : rôle owner + step-up ; historique beneficiary_events + audit + e-mail au propriétaire
router.put('/wallet', requireMerchantOwner, async (req, res) => {
  const { operator, phone, confirm } = req.body || {};
  if (!phone) return fail(res, 422, 'phone requis', 'VALIDATION_ERROR');
  const step = await cash.verifyStepUp({ userId: req.user?.sub, confirm });
  if (!step.ok) return res.status(step.status).json(step.body);
  const m = await loadActiveMerchant(req, res);
  if (!m) return;
  const d = cash.detectWallet(phone, { country: m.country, operator });
  if (!d.success) return fail(res, 422, d.error || 'Numéro invalide', d.code || 'PHONE_INVALID');
  const merchantCurrency = String(m.currency || 'XAF').toUpperCase();
  if (String(d.currency).toUpperCase() !== merchantCurrency) {
    return fail(res, 422, `Wallet en ${d.currency} : devise différente de celle du marchand (${merchantCurrency})`, 'CURRENCY_MISMATCH', { currency: d.currency, merchantCurrency });
  }
  const code = cash.normalizeOperatorCode(d.operator);
  const r = await query(
    `UPDATE merchants
     SET cash_wallet_verified_at = CASE WHEN cash_wallet_phone IS DISTINCT FROM $2 OR cash_wallet_operator IS DISTINCT FROM $1 THEN NULL ELSE cash_wallet_verified_at END,
         cash_wallet_operator=$1, cash_wallet_phone=$2, updated_at=NOW()
     WHERE merchant_id=$3
     RETURNING cash_wallet_operator, cash_wallet_phone, cash_wallet_verified_at`, [code, d.phone, m.merchant_id]);
  const w = r.rows[0] || { cash_wallet_operator: code, cash_wallet_phone: d.phone, cash_wallet_verified_at: null };
  const changed = m.cash_wallet_phone !== d.phone || cash.normalizeOperatorCode(m.cash_wallet_operator) !== code;
  if (changed) {
    const oldValues = cash.maskWallet(m.cash_wallet_operator, m.cash_wallet_phone);
    const newValues = cash.maskWallet(code, d.phone);
    await cash.recordBeneficiaryEvent({ merchantId: m.merchant_id, actor: actor(req), eventType: 'wallet_updated', entityType: 'wallet', entityId: m.merchant_id, oldValues, newValues, ip: req.ip })
      .catch((e) => logger.error('[cash] beneficiary event failed', { err: e.message }));
    await merchantAudit(req, 'CASH_WALLET_UPDATE', 'merchant', m.merchant_id, { ...newValues, stepUp: step.method }, oldValues);
    cash.notifyBeneficiaryChange(m, { eventType: 'wallet_updated', summary: `${cash.operatorLabel(code)} ${cash.maskNumber(d.phone, 3)}`, ip: req.ip }).catch(() => {});
  }
  res.json({ operator: w.cash_wallet_operator, phone: w.cash_wallet_phone, operatorLabel: cash.operatorLabel(code), country: d.country, verifiedAt: w.cash_wallet_verified_at || null });
});

// WAVE-6 : historique des changements de bénéficiaire (wallet, comptes bancaires)
router.get('/beneficiaries/history', merchantAuth, async (req, res) => {
  res.json(await cash.beneficiaryHistory(mid(req), req.query));
});

// ─── §4 Retirer ───────────────────────────────────────────────────
router.post('/withdraw', merchantAuth, idempotency, async (req, res) => {
  const { description, confirm } = req.body || {};
  const merchant = await cash.getMerchant(mid(req));
  if (!merchant) return fail(res, 404, 'Marchand introuvable', 'MERCHANT_NOT_FOUND');
  const currency = String(merchant.currency || 'XAF').toUpperCase();
  const { amount, error: amountError } = parseAmount(req.body?.amount, currency, cash.TRANSFER_MIN);
  if (amountError) return fail(res, 422, amountError, 'VALIDATION_ERROR');
  const step = await cash.verifyStepUp({ userId: req.user?.sub, confirm });
  if (!step.ok) return res.status(step.status).json(step.body);
  if (merchant.merchant_status && merchant.merchant_status !== 'active') return fail(res, 403, 'Compte marchand inactif', 'MERCHANT_INACTIVE');
  if (!merchant.cash_wallet_phone) return fail(res, 422, 'Aucun wallet enregistré (PUT /merchant/cash/wallet)', 'WALLET_MISSING');

  const operatorCode = cash.normalizeOperatorCode(merchant.cash_wallet_operator);
  const d = cash.detectWallet(merchant.cash_wallet_phone, { country: merchant.country, operator: operatorCode });
  const country = d.success ? d.country : merchant.country;
  const rail = await cash.payoutRail({ operator: operatorCode, gateway: d.success ? d.gateway : null, country });
  if (!rail.available) return featureDisabled(res, { operator: operatorCode, operatorLabel: rail.operatorLabel, reason: 'Aucun rail de paiement sortant configuré pour cet opérateur' });

  const r = await cash.createPayout({
    merchantId: merchant.merchant_id, destType: 'wallet',
    wallet: { operator: operatorCode, phone: merchant.cash_wallet_phone, gateway: rail.gateway, country },
    rail, amount, description: description || 'Retrait', refPrefix: 'PAY',
    dailyLimit: cash.withdrawDailyLimit(merchant.kyb_level), actor: `merchant:${req.user?.sub || ''}`,
    onReserved: ({ transferId }) => attachResource(req, { type: 'merchant_transfer', id: transferId }),
  });
  if (r.error) return res.status(r.error.status).json(r.error.body);
  const t = r.transfer;
  payoutResponse(res, t, {
    transferId: t.transferId, reference: t.reference, status: t.status,
    amount: t.amount, fee: t.fee, net: t.net, currency: t.currency,
    wallet: { operator: operatorCode, phone: merchant.cash_wallet_phone, operatorLabel: rail.operatorLabel },
  });
});

// ─── §5 Transférer ────────────────────────────────────────────────
router.post('/transfers', merchantAuth, idempotency, async (req, res) => {
  const { direction, accountId, description, confirm } = req.body || {};
  if (!['wallet_to_bank', 'bank_to_wallet'].includes(direction)) return fail(res, 422, 'direction: wallet_to_bank | bank_to_wallet', 'VALIDATION_ERROR');
  const merchant = await cash.getMerchant(mid(req));
  if (!merchant) return fail(res, 404, 'Marchand introuvable', 'MERCHANT_NOT_FOUND');
  const currency = String(merchant.currency || 'XAF').toUpperCase();
  const { amount, error: amountError } = parseAmount(req.body?.amount, currency, cash.TRANSFER_MIN);
  if (amountError) return fail(res, 422, amountError, 'VALIDATION_ERROR');

  if (direction === 'wallet_to_bank') {
    if (!accountId) return fail(res, 422, 'accountId requis', 'VALIDATION_ERROR');
    const step = await cash.verifyStepUp({ userId: req.user?.sub, confirm });
    if (!step.ok) return res.status(step.status).json(step.body);
    const r = await cash.createPayout({
      merchantId: merchant.merchant_id, destType: 'bank', accountId, amount, description: description || 'Transfert vers banque',
      refPrefix: 'TRF', bankQueueStatus: 'pending_manual', actor: `merchant:${req.user?.sub || ''}`,
      onReserved: ({ transferId }) => attachResource(req, { type: 'merchant_transfer', id: transferId }),
    });
    if (r.error) return res.status(r.error.status).json(r.error.body);
    const t = r.transfer;
    return res.status(201).json({
      transferId: t.transferId, reference: t.reference, direction, status: t.status,
      amount: t.amount, fee: t.fee, net: t.net, currency: t.currency,
      bankAccount: { bankName: t.bankAcc?.inst_name || null, accountMasked: cash.maskNumber(t.bankAcc?.account_number), accountName: t.bankAcc?.account_name || null },
      message: t.status === 'pending_manual' ? 'Virement exécuté par les opérations C-Pay (J+1 ouvré)' : 'Virement en cours',
    });
  }

  // bank_to_wallet : ordre d'approvisionnement (aucun mouvement avant confirmation de réception)
  const r = await cash.createFundingOrder({ merchantId: merchant.merchant_id, amount, description, accountId, actor: `merchant:${req.user?.sub || ''}` });
  if (r.error) return res.status(r.error.status).json(r.error.body);
  await attachResource(req, { type: 'merchant_transfer', id: r.transfer.transfer_id });
  res.status(201).json({
    transferId: r.transfer.transfer_id, reference: r.reference, direction, status: 'awaiting_funds',
    amount, currency: r.currency, instructions: r.instructions, expiresAt: r.expiresAt,
    message: `Virez ${amount} ${r.currency} sur le compte indiqué avec la référence ${r.reference} ; le solde est crédité à réception`,
  });
});

const DIRECTION_SQL = {
  wallet_to_bank: `mt.direction='payout' AND mt.dest_type='bank'`,
  bank_to_wallet: `mt.direction='funding'`,
  withdraw:       `mt.direction='payout' AND mt.dest_type='wallet'`,
  out:            `mt.direction='payout'`,
};
router.get('/transfers', merchantAuth, async (req, res) => {
  const { direction, status } = req.query;
  if (direction && !DIRECTION_SQL[direction]) return fail(res, 422, `direction: ${Object.keys(DIRECTION_SQL).join(' | ')}`, 'VALIDATION_ERROR');
  let limit = parseInt(req.query.limit, 10); if (!Number.isFinite(limit)) limit = 50; limit = Math.min(200, Math.max(1, limit));
  let offset = parseInt(req.query.offset, 10); if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const params = [mid(req)];
  const conds = ['mt.merchant_id=$1'];
  if (direction) conds.push(DIRECTION_SQL[direction]);
  if (status) { params.push(String(status)); conds.push(`mt.status=$${params.length}`); }
  const where = `WHERE ${conds.join(' AND ')}`;
  const r = await query(
    `SELECT mt.*, fi.name AS inst_name, ba.account_number, ba.account_name
     FROM merchant_transfers mt
     LEFT JOIN bank_accounts ba ON ba.account_id = mt.bank_account_id
     LEFT JOIN financial_institutions fi ON fi.institution_id = ba.institution_id
     ${where} ORDER BY mt.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]);
  const c = await query(`SELECT COUNT(*)::int AS total FROM merchant_transfers mt ${where}`, params);
  res.json({ data: r.rows.map((t) => cash.serializeTransfer(t)), total: parseInt(c.rows[0]?.total, 10) || 0, limit, offset });
});

router.get('/transfers/:id', merchantAuth, async (req, res) => {
  let t = await cash.getTransfer(req.params.id, { merchantId: mid(req) });
  if (!t) return fail(res, 404, 'Transfert introuvable', 'TRANSFER_NOT_FOUND');
  if (cash.UNCERTAIN.includes(t.status)) t = await cash.refreshPayoutStatus(t);
  res.json(cash.serializeTransfer(t));
});

router.post('/transfers/:id/cancel', merchantAuth, async (req, res) => {
  const r = await cash.cancelTransfer({ merchantId: mid(req), transferId: req.params.id, actor: `merchant:${req.user?.sub || ''}` });
  if (r.error) return res.status(r.error.status).json(r.error.body);
  res.json({ success: true, ...cash.serializeTransfer(r.transfer) });
});

// ─── §7 Journal ───────────────────────────────────────────────────
router.get('/history', merchantAuth, async (req, res) => {
  const r = await cash.history(mid(req), req.query);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  res.json(r);
});

router.get('/history/export.csv', merchantAuth, async (req, res) => {
  const r = await cash.historyCsv(mid(req), req.query);
  if (r.error) return res.status(r.error.status).json(r.error.body);
  const tag = [req.query.from, req.query.to].filter(Boolean).map((v) => String(v).slice(0, 10)).join('_') || new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="caisse-${tag.replace(/[^0-9A-Za-z_-]/g, '')}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(r.csv);
});

module.exports = router;
