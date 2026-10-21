'use strict';
/**
 * Administration de la caisse — WAVE-4 (docs/CAISSE-API.md §8)
 * Monté sur /api/v1/admin/cash — rôles super_admin, ops_admin.
 *
 *   GET  /stats                               volumes du jour / 7 j, files d'attente
 *   GET  /transfers?status&direction&merchantId&q&limit&offset
 *   GET  /transfers/:id                       détail + journal des changements (events)
 *   POST /transfers/:id/confirm-funds         awaiting_funds → completed (crédite le solde)
 *   POST /transfers/:id/mark-executed         pending_manual | pending_settlement → completed
 *   POST /transfers/:id/reject                → rejected (libère les fonds)
 *   GET|POST|PATCH /platform-accounts         comptes de collecte C-Pay par devise
 *
 * Chaque action écrit audit_logs et un événement JSONB sur le transfert
 * (cash.service.transitionTransfer : point unique de changement de statut).
 */

const express = require('express');
const router = express.Router();
const { query, withTransaction } = require('../config/database');
const { requireRole } = require('../middleware/auth');
const logger = require('../config/logger');
const cash = require('../services/cash/cash.service');

const cashAdmin = requireRole('super_admin', 'ops_admin');
const fail = (res, status, error, code, extra = {}) => res.status(status).json({ error, code, ...extra });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actorId = (req) => (UUID_RE.test(String(req.user?.sub || '')) ? req.user.sub : null);

const audit = async (req, action, entityType, entityId, newValues, oldValues = null) => {
  try {
    await query(
      `INSERT INTO audit_logs (actor_type, actor_id, actor_email, action, entity_type, entity_id, old_values, new_values, ip_address)
       VALUES ('admin',$1,$2,$3,$4,$5,$6,$7,$8)`,
      [actorId(req), req.user?.email || null, action, entityType, UUID_RE.test(String(entityId || '')) ? entityId : null,
       oldValues ? JSON.stringify(oldValues) : null, JSON.stringify(newValues || {}), req.ip || null]);
  } catch (e) { logger.warn('[cash-admin] audit log failed', { action, err: e.message }); }
};

// Process-local scheduler health; no provider credentials or raw error details.
router.get('/reconcile/status', cashAdmin, (_req, res) => {
  res.json(require('../services/reconciliation-job').getStatus());
});

// ─── Stats ────────────────────────────────────────────────────────
router.get('/stats', cashAdmin, async (req, res) => {
  const mt = await query(
    `SELECT
       COUNT(*) FILTER (WHERE status = ANY($1::text[])) AS q_manual,
       COALESCE(SUM(net_amount) FILTER (WHERE status = ANY($1::text[])),0) AS q_manual_amount,
       COUNT(*) FILTER (WHERE status='awaiting_funds') AS q_funding,
       COALESCE(SUM(amount) FILTER (WHERE status='awaiting_funds'),0) AS q_funding_amount,
       COUNT(*) FILTER (WHERE status='processing') AS q_processing,
       COUNT(*) FILTER (WHERE status='unknown') AS q_unknown,
       COALESCE(SUM(amount) FILTER (WHERE status='unknown'),0) AS q_unknown_amount,
       COUNT(*) FILTER (WHERE needs_review AND status NOT IN ('completed','failed','cancelled','rejected')) AS q_review,
       COUNT(*) FILTER (WHERE direction='payout' AND dest_type='wallet' AND status = ANY($2::text[]) AND created_at::date = CURRENT_DATE) AS d_withdraw_n,
       COALESCE(SUM(amount) FILTER (WHERE direction='payout' AND dest_type='wallet' AND status = ANY($2::text[]) AND created_at::date = CURRENT_DATE),0) AS d_withdraw,
       COUNT(*) FILTER (WHERE direction='payout' AND dest_type='bank' AND status = ANY($2::text[]) AND created_at::date = CURRENT_DATE) AS d_out_n,
       COALESCE(SUM(amount) FILTER (WHERE direction='payout' AND dest_type='bank' AND status = ANY($2::text[]) AND created_at::date = CURRENT_DATE),0) AS d_out,
       COUNT(*) FILTER (WHERE direction='funding' AND status='completed' AND completed_at::date = CURRENT_DATE) AS d_in_n,
       COALESCE(SUM(amount) FILTER (WHERE direction='funding' AND status='completed' AND completed_at::date = CURRENT_DATE),0) AS d_in,
       COUNT(*) FILTER (WHERE direction='payout' AND dest_type='wallet' AND status = ANY($2::text[]) AND created_at >= NOW() - INTERVAL '7 days') AS w_withdraw_n,
       COALESCE(SUM(amount) FILTER (WHERE direction='payout' AND dest_type='wallet' AND status = ANY($2::text[]) AND created_at >= NOW() - INTERVAL '7 days'),0) AS w_withdraw,
       COUNT(*) FILTER (WHERE direction='payout' AND dest_type='bank' AND status = ANY($2::text[]) AND created_at >= NOW() - INTERVAL '7 days') AS w_out_n,
       COALESCE(SUM(amount) FILTER (WHERE direction='payout' AND dest_type='bank' AND status = ANY($2::text[]) AND created_at >= NOW() - INTERVAL '7 days'),0) AS w_out,
       COUNT(*) FILTER (WHERE direction='funding' AND status='completed' AND completed_at >= NOW() - INTERVAL '7 days') AS w_in_n,
       COALESCE(SUM(amount) FILTER (WHERE direction='funding' AND status='completed' AND completed_at >= NOW() - INTERVAL '7 days'),0) AS w_in
     FROM merchant_transfers`, [cash.MANUAL_QUEUE, cash.OUT_NOT_FAILED]);
  const tx = await query(
    `SELECT
       COUNT(*) FILTER (WHERE initiated_at::date = CURRENT_DATE) AS d_n,
       COALESCE(SUM(amount) FILTER (WHERE initiated_at::date = CURRENT_DATE),0) AS d_amount,
       COUNT(*) FILTER (WHERE initiated_at >= NOW() - INTERVAL '7 days') AS w_n,
       COALESCE(SUM(amount) FILTER (WHERE initiated_at >= NOW() - INTERVAL '7 days'),0) AS w_amount
     FROM transactions WHERE type='collect' AND status='authorized'`);
  const m = mt.rows[0] || {}; const t = tx.rows[0] || {};
  const n = (v) => parseFloat(v) || 0; const i = (v) => parseInt(v, 10) || 0;
  res.json({
    queues: {
      pendingManual: { count: i(m.q_manual), amount: n(m.q_manual_amount) },
      awaitingFunds: { count: i(m.q_funding), amount: n(m.q_funding_amount) },
      processing: { count: i(m.q_processing) },
      unknown: { count: i(m.q_unknown), amount: n(m.q_unknown_amount) },
      needsReview: { count: i(m.q_review) },
    },
    today: {
      collected: { count: i(t.d_n), amount: n(t.d_amount) },
      withdrawn: { count: i(m.d_withdraw_n), amount: n(m.d_withdraw) },
      transfersOut: { count: i(m.d_out_n), amount: n(m.d_out) },
      transfersIn: { count: i(m.d_in_n), amount: n(m.d_in) },
    },
    last7Days: {
      collected: { count: i(t.w_n), amount: n(t.w_amount) },
      withdrawn: { count: i(m.w_withdraw_n), amount: n(m.w_withdraw) },
      transfersOut: { count: i(m.w_out_n), amount: n(m.w_out) },
      transfersIn: { count: i(m.w_in_n), amount: n(m.w_in) },
    },
  });
});

// ─── Liste / détail ───────────────────────────────────────────────
const DIRECTION_SQL = {
  wallet_to_bank: `mt.direction='payout' AND mt.dest_type='bank'`,
  bank_to_wallet: `mt.direction='funding'`,
  withdraw:       `mt.direction='payout' AND mt.dest_type='wallet'`,
  payout:         `mt.direction='payout'`,
  funding:        `mt.direction='funding'`,
};
const STATUS_ALIASES = { pending_manual: cash.MANUAL_QUEUE, uncertain: cash.UNCERTAIN };

router.get('/transfers', cashAdmin, async (req, res) => {
  const { status, direction, merchantId, q, needsReview } = req.query;
  if (direction && !DIRECTION_SQL[direction]) return fail(res, 422, `direction: ${Object.keys(DIRECTION_SQL).join(' | ')}`, 'VALIDATION_ERROR');
  let limit = parseInt(req.query.limit, 10); if (!Number.isFinite(limit)) limit = 50; limit = Math.min(200, Math.max(1, limit));
  let offset = parseInt(req.query.offset, 10); if (!Number.isFinite(offset) || offset < 0) offset = 0;
  const params = []; const conds = [];
  if (status) {
    const list = String(status).split(',').map((s) => s.trim()).filter(Boolean).flatMap((s) => STATUS_ALIASES[s] || [s]);
    params.push(list); conds.push(`mt.status = ANY($${params.length}::text[])`);
  }
  if (direction) conds.push(DIRECTION_SQL[direction]);
  if (needsReview !== undefined && ['1', 'true'].includes(String(needsReview))) conds.push('mt.needs_review = TRUE');
  if (merchantId) { params.push(String(merchantId)); conds.push(`mt.merchant_id::text = $${params.length}`); }
  if (q) { params.push(`%${String(q).trim()}%`); conds.push(`(mt.reference ILIKE $${params.length} OR m.business_name ILIKE $${params.length} OR m.email ILIKE $${params.length} OR mt.bank_reference ILIKE $${params.length})`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const base = `FROM merchant_transfers mt
     LEFT JOIN merchants m ON m.merchant_id = mt.merchant_id
     LEFT JOIN bank_accounts ba ON ba.account_id = mt.bank_account_id
     LEFT JOIN financial_institutions fi ON fi.institution_id = ba.institution_id ${where}`;
  const r = await query(
    `SELECT mt.*, fi.name AS inst_name, ba.account_number, ba.account_name, m.business_name, m.email AS merchant_email, m.country AS merchant_country
     ${base} ORDER BY mt.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]);
  const c = await query(`SELECT COUNT(*)::int AS total ${base}`, params);
  res.json({ data: r.rows.map((t) => cash.serializeTransfer(t, { admin: true })), total: parseInt(c.rows[0]?.total, 10) || 0, limit, offset });
});

// WAVE-6 : rafraîchit `processing` ET `unknown` ; contexte bénéficiaire (derniers changements du marchand)
router.get('/transfers/:id', cashAdmin, async (req, res) => {
  let t = await cash.getTransfer(req.params.id);
  if (!t) return fail(res, 404, 'Transfert introuvable', 'TRANSFER_NOT_FOUND');
  if (cash.UNCERTAIN.includes(t.status)) t = await cash.refreshPayoutStatus(t);
  let beneficiaryHistory = [];
  try { beneficiaryHistory = (await cash.beneficiaryHistory(t.merchant_id, { limit: 10 })).data; }
  catch (e) { logger.warn('[cash-admin] beneficiary history failed', { err: e.message }); }
  res.json({ ...cash.serializeTransfer(t, { admin: true }), context: { beneficiaryHistory, statusCheck: t._statusCheck || null } });
});

// ─── WAVE-6 : retraits incertains / réparations ───────────────────
// Interroge l'opérateur pour tous les retraits `unknown` / `processing` (même logique que le cron)
router.post('/reconcile/uncertain-payouts', cashAdmin, async (req, res) => {
  const { reconcileUncertainPayouts } = require('../services/reconcile.service');
  const graceMinutes = req.body?.graceMinutes !== undefined ? Number(req.body.graceMinutes) : null;
  const r = await reconcileUncertainPayouts({ graceMinutes: Number.isFinite(graceMinutes) ? graceMinutes : null, limit: req.body?.limit || 200 });
  await audit(req, 'CASH_RECONCILE_UNCERTAIN', 'system', null, { transfers: r.transfers.summary, transactions: { scanned: r.transactions.scanned, flagged: r.transactions.flagged } });
  res.json(r);
});

// Encaissements `authorized` sans ligne settlement_queue (> 5 min) → enfilés (audit §2, job de réparation)
router.post('/repair/settlement-queue', cashAdmin, async (req, res) => {
  const { sweepAuthorizedWithoutQueue } = require('../services/settlement/settlement.repair');
  const minAge = req.body?.minAgeMinutes !== undefined ? Number(req.body.minAgeMinutes) : 5;
  const r = await sweepAuthorizedWithoutQueue({ minAgeMinutes: Number.isFinite(minAge) && minAge >= 0 ? minAge : 5, actor: `admin:${req.user?.sub || ''}` });
  await audit(req, 'SETTLEMENT_QUEUE_REPAIR', 'system', null, { scanned: r.scanned, repaired: r.repaired, errors: r.errors, transactionIds: r.transactionIds });
  res.json({ success: true, ...r });
});

// ─── WAVE-6 : vérification d'un compte bancaire marchand ─────────
const VERIFY_METHODS = ['document', 'micro_deposit', 'manual'];
const BANK_STATUSES = ['pending_verification', 'pending', 'verified', 'rejected', 'removed'];

// Row lock and mandatory audit/event writes share one transaction: no untraced
// decision and no resurrection of an account concurrently removed by its owner.
const bankDecision = (decision) => async (req, res) => {
  const verified = decision === 'verified';
  const { method, reference, note, reason } = req.body || {};
  if (verified && (!VERIFY_METHODS.includes(method) || typeof reference !== 'string' || !reference.trim() || reference.trim().length > 128)) {
    return fail(res, 422, 'Méthode de contrôle et référence (1 à 128 caractères) requises', 'VALIDATION_ERROR');
  }
  if (verified && note != null && (typeof note !== 'string' || note.length > 1000)) return fail(res, 422, 'Note limitée à 1000 caractères', 'VALIDATION_ERROR');
  if (!verified && (typeof reason !== 'string' || reason.trim().length < 5 || reason.trim().length > 500)) {
    return fail(res, 422, 'Motif requis : 5 à 500 caractères', 'VALIDATION_ERROR');
  }
  if (!UUID_RE.test(req.params.id)) return fail(res, 404, 'Compte bancaire introuvable', 'NOT_FOUND');
  try {
    const result = await withTransaction(async (client) => {
      const exec = (...args) => client.query(...args);
      const cur = await exec(
        `SELECT ba.*, fi.name AS inst_name, m.email AS merchant_email, m.business_name
         FROM bank_accounts ba LEFT JOIN financial_institutions fi ON fi.institution_id = ba.institution_id
         LEFT JOIN merchants m ON m.merchant_id = ba.owner_id
         WHERE ba.account_id=$1 AND ba.owner_type='merchant' FOR UPDATE OF ba`, [req.params.id]);
      const a = cur.rows[0];
      if (!a) return { error: [404, 'Compte bancaire introuvable', 'NOT_FOUND'] };
      if (!['pending_verification', 'pending'].includes(a.status)) {
        return { error: [409, a.status === 'verified' ? 'Compte déjà vérifié' : 'Ce compte ne peut plus être traité', a.status === 'verified' ? 'ALREADY_VERIFIED' : 'INVALID_STATUS'], status: a.status };
      }
      const updated = verified ? await exec(
        `UPDATE bank_accounts SET status='verified', verified_at=NOW(), verified_by=$2, verification_method=$3, verification_reference=$4, updated_at=NOW()
         WHERE account_id=$1 AND status IN ('pending_verification','pending') RETURNING *`,
        [a.account_id, actorId(req), method, reference.trim()]) : await exec(
        `UPDATE bank_accounts SET status='rejected', updated_at=NOW()
         WHERE account_id=$1 AND status IN ('pending_verification','pending') RETURNING *`, [a.account_id]);
      const row = updated.rows[0];
      if (!row) return { error: [409, 'Compte déjà traité', 'INVALID_STATUS'] };
      const eventType = verified ? 'bank_account_verified' : 'bank_account_rejected';
      const values = { ...cash.maskBankAccount({ ...row, inst_name: a.inst_name }),
        ...(verified ? { method, reference: reference.trim(), note: note?.trim() || null } : { reason: reason.trim() }) };
      await cash.recordBeneficiaryEvent({
        merchantId: a.owner_id, actor: { type: 'admin', id: actorId(req), email: req.user?.email || null, role: req.user?.role || null },
        eventType, entityType: 'bank_account', entityId: a.account_id,
        oldValues: { status: a.status }, newValues: values, ip: req.ip, exec,
      });
      await exec(
        `INSERT INTO audit_logs (actor_type, actor_id, actor_email, action, entity_type, entity_id, old_values, new_values, ip_address)
         VALUES ('admin',$1,$2,$3,'bank_account',$4,$5,$6,$7)`,
        [actorId(req), req.user?.email || null, verified ? 'BANK_ACCOUNT_VERIFY' : 'BANK_ACCOUNT_REJECT', a.account_id,
          JSON.stringify({ status: a.status }), JSON.stringify(values), req.ip || null]);
      return { account: a, row, eventType, values };
    });
    if (result.error) return fail(res, ...result.error, { status: result.status || null });
    const { account, row, eventType, values } = result;
    // Notification is best effort, after the decision has committed.
    cash.notifyBeneficiaryChange({ email: account.merchant_email, business_name: account.business_name },
      { eventType, summary: `${account.inst_name || 'Banque'} ${cash.maskNumber(row.account_number)}` }).catch(() => {});
    return res.json({ success: true, ...values, verifiedAt: row.verified_at || null });
  } catch (err) {
    logger.error('[cash-admin] bank decision rolled back', { err: err.message, accountId: req.params.id });
    return fail(res, 503, 'Décision non enregistrée : réessayez après vérification du statut', 'BANK_ACCOUNT_DECISION_UNAVAILABLE');
  }
};
router.post('/bank-accounts/:id/verify', cashAdmin, bankDecision('verified'));
router.post('/bank-accounts/:id/reject', cashAdmin, bankDecision('rejected'));

// Masked bank accounts, including historical pending entries in the pending queue.
router.get('/bank-accounts', cashAdmin, async (req, res) => {
  const status = req.query.status ? String(req.query.status) : 'pending_verification';
  if (!BANK_STATUSES.includes(status)) return fail(res, 422, 'Statut de compte bancaire invalide', 'VALIDATION_ERROR');
  const statuses = status === 'pending_verification' ? ['pending_verification', 'pending'] : [status];
  const r = await query(
    `SELECT ba.account_id, ba.owner_id AS merchant_id, ba.account_number, ba.account_name, ba.status, ba.created_at, ba.verified_at, ba.verification_method, ba.verification_reference,
            fi.name AS inst_name, m.business_name, m.email AS merchant_email,
            (SELECT ev.new_values->>'reason' FROM beneficiary_events ev
             WHERE ev.entity_id=ba.account_id AND ev.merchant_id=ba.owner_id AND ev.event_type='bank_account_rejected'
             ORDER BY ev.created_at DESC LIMIT 1) AS rejection_reason
     FROM bank_accounts ba LEFT JOIN financial_institutions fi ON fi.institution_id = ba.institution_id
     LEFT JOIN merchants m ON m.merchant_id = ba.owner_id
     WHERE ba.owner_type='merchant' AND ba.status = ANY($1::text[]) ORDER BY ba.created_at ASC LIMIT 200`, [statuses]);
  res.json({ data: r.rows.map((a) => ({ ...cash.maskBankAccount(a), merchantId: a.merchant_id, merchant: a.business_name || null, merchantEmail: a.merchant_email || null, createdAt: a.created_at, verifiedAt: a.verified_at || null, verificationMethod: a.verification_method || null, verificationReference: a.verification_reference || null, rejectionReason: a.status === 'rejected' ? a.rejection_reason || null : null })), total: r.rows.length });
});

// ─── Actions ──────────────────────────────────────────────────────
const notifyMerchant = async (t, subject, html) => {
  if (!t.merchant_email) return;
  try {
    const email = require('../services/notifications/email.service');
    await email.send({ to: t.merchant_email, subject, html });
  } catch (e) { logger.warn('[cash-admin] merchant email failed', { err: e.message }); }
};

// awaiting_funds → completed : le solde est crédité (direction='funding' completed entre dans computeAvailableBalance)
router.post('/transfers/:id/confirm-funds', cashAdmin, async (req, res) => {
  const { amountReceived, bankReference, note } = req.body || {};
  const received = Number(amountReceived);
  if (!Number.isFinite(received) || received <= 0) return fail(res, 422, 'amountReceived requis (> 0)', 'VALIDATION_ERROR');
  if (!bankReference) return fail(res, 422, 'bankReference requis', 'VALIDATION_ERROR');
  const t = await cash.getTransfer(req.params.id);
  if (!t) return fail(res, 404, 'Transfert introuvable', 'TRANSFER_NOT_FOUND');
  if (t.direction !== 'funding') return fail(res, 409, 'Ce transfert n’est pas un ordre d’approvisionnement', 'NOT_FUNDING_ORDER', { status: t.status });
  const requested = Number(t.amount);
  const differs = Math.abs(received - requested) > 0.009;
  const row = await cash.transitionTransfer({
    transferId: t.transfer_id, from: ['awaiting_funds'], to: 'completed',
    patch: {
      bankReference: String(bankReference), executedBy: actorId(req), adminNote: note || null,
      amount: differs ? received : null, amountRequested: differs ? requested : null,
    },
    event: cash.event('completed', {
      by: `admin:${req.user?.sub || ''}`, action: 'confirm_funds', bankReference: String(bankReference),
      amountRequested: requested, amountReceived: received, ...(differs ? { note: 'montant reçu différent du montant demandé' } : {}),
    }),
  });
  if (!row) return fail(res, 409, `Transfert non confirmable (statut ${t.status})`, 'INVALID_STATUS', { status: t.status });
  await audit(req, 'CASH_FUNDING_CONFIRM', 'merchant_transfer', t.transfer_id,
    { reference: t.reference, merchantId: t.merchant_id, amountRequested: requested, amountReceived: received, bankReference }, { status: t.status });
  notifyMerchant(t, `Approvisionnement reçu — ${received} ${t.currency || ''}`,
    `<p>Bonjour ${t.business_name || ''},</p><p>Votre virement <b>${t.reference}</b> de <b>${received} ${t.currency || ''}</b> a été reçu : votre solde C-Pay est crédité.</p>${differs ? `<p>Montant demandé : ${requested} ${t.currency || ''}.</p>` : ''}`).catch(() => {});
  res.json({ success: true, ...cash.serializeTransfer({ ...t, ...row }, { admin: true }), amountRequested: requested, amountReceived: received });
});

// pending_manual | pending_settlement → completed (virement bancaire exécuté par les opérations)
router.post('/transfers/:id/mark-executed', cashAdmin, async (req, res) => {
  const { bankReference, note } = req.body || {};
  if (!bankReference) return fail(res, 422, 'bankReference requis', 'VALIDATION_ERROR');
  const t = await cash.getTransfer(req.params.id);
  if (!t) return fail(res, 404, 'Transfert introuvable', 'TRANSFER_NOT_FOUND');
  const row = await cash.transitionTransfer({
    transferId: t.transfer_id, from: cash.MANUAL_QUEUE, to: 'completed',
    patch: { bankReference: String(bankReference), executedBy: actorId(req), adminNote: note || null },
    event: cash.event('completed', { by: `admin:${req.user?.sub || ''}`, action: 'mark_executed', bankReference: String(bankReference) }),
  });
  if (!row) return fail(res, 409, `Transfert non exécutable (statut ${t.status})`, 'INVALID_STATUS', { status: t.status });
  await audit(req, 'CASH_TRANSFER_EXECUTED', 'merchant_transfer', t.transfer_id,
    { reference: t.reference, merchantId: t.merchant_id, net: Number(t.net_amount || t.amount), bankReference }, { status: t.status });
  notifyMerchant(t, `Virement effectué — ${Number(t.net_amount || t.amount)} ${t.currency || ''}`,
    `<p>Bonjour ${t.business_name || ''},</p><p>Le virement <b>${t.reference}</b> de <b>${Number(t.net_amount || t.amount)} ${t.currency || ''}</b> vers ${t.inst_name || 'votre banque'} (compte ${cash.maskNumber(t.account_number)}) a été exécuté.</p><p>Référence bancaire : <code>${String(bankReference)}</code>. Le crédit peut prendre 24 à 48 h selon votre banque.</p>`).catch(() => {});
  res.json({ success: true, ...cash.serializeTransfer({ ...t, ...row }, { admin: true }) });
});

// → rejected : libère les fonds (le statut sort des sorties comptées dans le solde)
router.post('/transfers/:id/reject', cashAdmin, async (req, res) => {
  const { reason } = req.body || {};
  if (!reason || !String(reason).trim()) return fail(res, 422, 'reason requis', 'VALIDATION_ERROR');
  const t = await cash.getTransfer(req.params.id);
  if (!t) return fail(res, 404, 'Transfert introuvable', 'TRANSFER_NOT_FOUND');
  const row = await cash.transitionTransfer({
    transferId: t.transfer_id, from: cash.REJECTABLE, to: 'rejected',
    patch: { errorMessage: String(reason).slice(0, 500), executedBy: actorId(req), adminNote: String(reason).slice(0, 500) },
    event: cash.event('rejected', { by: `admin:${req.user?.sub || ''}`, action: 'reject', reason: String(reason).slice(0, 500) }),
  });
  if (!row) return fail(res, 409, `Transfert non rejetable (statut ${t.status})`, 'INVALID_STATUS', { status: t.status, rejectable: cash.REJECTABLE });
  await audit(req, 'CASH_TRANSFER_REJECT', 'merchant_transfer', t.transfer_id,
    { reference: t.reference, merchantId: t.merchant_id, reason: String(reason).slice(0, 500) }, { status: t.status });
  notifyMerchant(t, `Opération rejetée — ${t.reference}`,
    `<p>Bonjour ${t.business_name || ''},</p><p>L’opération <b>${t.reference}</b> (${Number(t.amount)} ${t.currency || ''}) a été rejetée : ${String(reason).slice(0, 500)}.</p>${t.direction === 'payout' ? '<p>Les fonds sont de nouveau disponibles sur votre solde.</p>' : ''}`).catch(() => {});
  res.json({ success: true, released: t.direction === 'payout' ? Number(t.amount) : 0, ...cash.serializeTransfer({ ...t, ...row }, { admin: true }) });
});

// ─── Comptes de collecte C-Pay ────────────────────────────────────
const serializeAccount = (a) => ({
  accountId: a.account_id, currency: a.currency, bankName: a.bank_name, accountName: a.account_name,
  accountNumber: a.account_number, iban: a.iban || null, swift: a.swift || null, active: !!a.active,
  notes: a.notes || null, createdAt: a.created_at, updatedAt: a.updated_at,
});

router.get('/platform-accounts', cashAdmin, async (req, res) => {
  const r = await query(`SELECT * FROM platform_bank_accounts ORDER BY currency, active DESC, updated_at DESC`);
  res.json({ data: r.rows.map(serializeAccount), total: r.rows.length });
});

router.post('/platform-accounts', cashAdmin, async (req, res) => {
  const { currency, bankName, accountName, accountNumber, iban, swift, notes } = req.body || {};
  const active = req.body?.active === undefined ? true : !!req.body.active;
  if (!currency || !/^[A-Za-z]{3}$/.test(String(currency))) return fail(res, 422, 'currency (ISO 4217, 3 lettres) requis', 'VALIDATION_ERROR');
  if (!bankName || !accountName || !accountNumber) return fail(res, 422, 'bankName, accountName, accountNumber requis', 'VALIDATION_ERROR');
  const r = await query(
    `INSERT INTO platform_bank_accounts (currency, bank_name, account_name, account_number, iban, swift, active, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [String(currency).toUpperCase(), String(bankName).trim(), String(accountName).trim(), String(accountNumber).trim(),
     iban ? String(iban).trim() : null, swift ? String(swift).trim() : null, active, notes || null, actorId(req)]);
  const a = r.rows[0];
  await audit(req, 'CASH_PLATFORM_ACCOUNT_CREATE', 'platform_bank_account', a?.account_id, { currency: String(currency).toUpperCase(), bankName, active });
  res.status(201).json(serializeAccount(a || {}));
});

const PATCHABLE = { bankName: 'bank_name', accountName: 'account_name', accountNumber: 'account_number', iban: 'iban', swift: 'swift', active: 'active', notes: 'notes', currency: 'currency' };
router.patch('/platform-accounts/:id', cashAdmin, async (req, res) => {
  const sets = []; const params = [];
  for (const [k, col] of Object.entries(PATCHABLE)) {
    if (req.body?.[k] === undefined) continue;
    let v = req.body[k];
    if (k === 'active') v = !!v;
    else if (k === 'currency') { if (!/^[A-Za-z]{3}$/.test(String(v))) return fail(res, 422, 'currency invalide', 'VALIDATION_ERROR'); v = String(v).toUpperCase(); }
    else v = v === null || v === '' ? null : String(v).trim();
    if (['bank_name', 'account_name', 'account_number'].includes(col) && !v) return fail(res, 422, `${k} ne peut pas être vide`, 'VALIDATION_ERROR');
    params.push(v); sets.push(`${col}=$${params.length}`);
  }
  if (!sets.length) return fail(res, 422, 'Aucun champ à modifier', 'VALIDATION_ERROR');
  params.push(req.params.id);
  const r = await query(`UPDATE platform_bank_accounts SET ${sets.join(', ')}, updated_at=NOW() WHERE account_id=$${params.length} RETURNING *`, params);
  if (!r.rows[0]) return fail(res, 404, 'Compte introuvable', 'NOT_FOUND');
  await audit(req, 'CASH_PLATFORM_ACCOUNT_UPDATE', 'platform_bank_account', req.params.id, req.body || {});
  res.json(serializeAccount(r.rows[0]));
});

module.exports = router;
