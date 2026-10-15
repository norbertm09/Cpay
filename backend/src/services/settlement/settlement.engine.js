/**
 * Settlement Engine — CPlus 2.6.0
 *
 * Flux complet :
 *   Transaction autorisée
 *     → Queue de settlement
 *     → Réconciliation nocturne (23h)
 *     → Calcul commissions (taux marchand)
 *     → Règlement J+1 (banque ou wallet)
 *     → Notification marchand
 */

'use strict';

const { query, withTransaction } = require('../../config/database');
const logger = require('../../config/logger');

// ─── Taux de commission par méthode et niveau ─────────────────────

const COMMISSION_RATES = {
  mobile_money: {
    default: 0.015,   // 1.5%
    level1:  0.012,   // 1.2% si KYB validé
    level2:  0.010,   // 1.0% si contrat
  },
  card_nfc: {
    default: 0.025,   // 2.5%
    level1:  0.020,
    level2:  0.018,
  },
  qr: {
    default: 0.015,
    level1:  0.012,
    level2:  0.010,
  },
};

// ─── Queue de settlement ──────────────────────────────────────────

const enqueue = async ({ txnId, merchantId, amount, currency }) => {
  await query(
    `INSERT INTO settlement_queue (transaction_id, merchant_id, amount, currency, queued_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (transaction_id) DO NOTHING`,
    [txnId, merchantId, amount, currency]
  );
  logger.debug('Settlement: enqueued', { txnId });
};

// ─── Job de settlement (J+1 : règle tout ce qui a été mis en file AVANT le jour courant) ───

const ZERO_DECIMAL = new Set(['XOF', 'XAF', 'CDF', 'GNF', 'RWF', 'UGX']);
const round = (n, currency) => ZERO_DECIMAL.has(currency) ? Math.round(n) : Math.round(n * 100) / 100;

/**
 * @param {string} [cutoffDate] YYYY-MM-DD : règle les items mis en file avant ce jour (défaut : aujourd'hui → J-1 et avant)
 * Verrou global PostgreSQL : deux appels concurrents ne règlent jamais les mêmes items.
 */
const runSettlement = async (cutoffDate = null) => {
  const cutoff = (cutoffDate && /^\d{4}-\d{2}-\d{2}$/.test(cutoffDate)) ? cutoffDate : new Date().toISOString().slice(0, 10);
  const lock = await query(`SELECT pg_try_advisory_lock(hashtext('cpay_settlement_run')) AS ok`);
  if (!lock.rows[0].ok) { logger.warn('Settlement: déjà en cours, exécution ignorée'); return { skipped: true, reason: 'already_running', cutoff }; }
  try {
    logger.info(`Settlement: running, cutoff ${cutoff}`);
    const groups = await query(
      `SELECT sq.merchant_id, sq.currency, COUNT(*)::int AS n
       FROM settlement_queue sq JOIN transactions t ON t.transaction_id = sq.transaction_id
       WHERE sq.settled = FALSE AND sq.queued_at < $1::date AND t.status = 'authorized' AND t.type = 'collect'
       GROUP BY sq.merchant_id, sq.currency ORDER BY sq.merchant_id`, [cutoff]);
    if (!groups.rows.length) { logger.info('Settlement: nothing to process'); return { batches: 0, settled: 0, errors: 0, cutoff }; }

    let settled = 0, errors = 0, batches = 0;
    for (const g of groups.rows) {
      try {
        const n = await settleGroup(g.merchant_id, g.currency, cutoff);
        if (n > 0) { settled += n; batches++; }
      } catch (err) {
        errors++;
        logger.error('Settlement: group failed', { merchantId: g.merchant_id, currency: g.currency, error: err.message });
      }
    }
    logger.info(`Settlement complete: ${batches} batches, ${settled} items, ${errors} errors`);
    return { batches, settled, errors, cutoff };
  } finally {
    await query(`SELECT pg_advisory_unlock(hashtext('cpay_settlement_run'))`).catch(() => {});
  }
};

/**
 * 1) Transaction SQL : claim des items (FOR UPDATE SKIP LOCKED), batch 'pending', marquage settled — COMMIT.
 * 2) Hors transaction : virement, puis statut du batch selon le résultat réel.
 */
const settleGroup = async (merchantId, currency, cutoff) => {
  const claimed = await withTransaction(async (client) => {
    const items = await client.query(
      `SELECT sq.id, sq.transaction_id, sq.amount, t.payment_method,
              m.settlement_type, m.settlement_account, m.settlement_provider, m.kyb_level, m.country
       FROM settlement_queue sq
       JOIN transactions t ON t.transaction_id = sq.transaction_id
       JOIN merchants m    ON m.merchant_id = sq.merchant_id
       WHERE sq.merchant_id = $1 AND sq.currency = $2 AND sq.settled = FALSE AND sq.queued_at < $3::date
         AND t.status = 'authorized' AND t.type = 'collect'
       FOR UPDATE OF sq SKIP LOCKED`, [merchantId, currency, cutoff]);
    if (!items.rows.length) return null;
    const head = items.rows[0];
    const kybLevel = head.kyb_level || 0;
    let totalGross = 0, totalFees = 0;
    for (const it of items.rows) {
      const amount = Number(it.amount);
      const fee = round(amount * getCommissionRate(it.payment_method, kybLevel), currency);
      it._fee = fee; it._net = round(amount - fee, currency);
      totalGross += amount; totalFees += fee;
    }
    totalGross = round(totalGross, currency); totalFees = round(totalFees, currency);
    const totalNet = round(totalGross - totalFees, currency);

    const b = await client.query(
      `INSERT INTO settlement_batches
         (merchant_id, batch_date, total_gross, total_fees, total_net, currency, txn_count,
          settlement_type, settlement_account, settlement_provider, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING batch_id`,
      [merchantId, cutoff, totalGross, totalFees, totalNet, currency, items.rows.length,
       head.settlement_type, head.settlement_account, head.settlement_provider]);
    const batchId = b.rows[0].batch_id;
    for (const it of items.rows) {
      await client.query(
        `UPDATE settlement_queue SET settled = TRUE, batch_id = $1, settled_at = NOW(), fee_amount = $2, net_amount = $3 WHERE id = $4`,
        [batchId, it._fee, it._net, it.id]);
    }
    return { batchId, head, totalNet, count: items.rows.length };
  });
  if (!claimed) return 0;

  const { batchId, head, totalNet, count } = claimed;
  if (head.settlement_type === 'mobile_money' && head.settlement_account) {
    const r = await initiateMobileMoneyTransfer({ batchId, amount: totalNet, currency, phone: head.settlement_account, country: head.country });
    await query(
      `UPDATE settlement_batches SET status = $1, submitted_at = CASE WHEN $1 = 'submitted' THEN NOW() ELSE submitted_at END,
         failure_reason = $2, payout_ref = $3 WHERE batch_id = $4`,
      [r.ok ? 'submitted' : 'failed', r.ok ? null : r.reason, r.ref || null, batchId]).catch(err => logger.error('Settlement: batch status update failed', { batchId, err: err.message }));
  } else {
    // Banque : virement manuel / API bancaire à brancher — le batch reste 'pending' et apparaît au back office finance
    logger.info('Settlement: bank batch awaiting manual transfer', { batchId, amount: totalNet, currency });
  }
  logger.info('Settlement: batch created', { batchId, merchantId, items: count, totalNet, currency });
  return count;
};

// ─── Virements ────────────────────────────────────────────────────

const initiateMobileMoneyTransfer = async ({ batchId, amount, currency, phone, country }) => {
  const mmRouter = require('../mobilemoney/mobilemoney.router');
  const detection = require('../detection/detection.engine').detectFromPhone(phone, { defaultCountry: country });
  if (!detection.success) return { ok: false, reason: `Numéro de règlement invalide : ${detection.error}` };
  if (detection.currency && detection.currency !== currency) return { ok: false, reason: `Devise du compte de règlement (${detection.currency}) différente de ${currency}` };
  const r = await mmRouter.sendPayout({
    txnId: `SETTLE-${batchId}`, amount, currency, phone: detection.phone,
    operator: detection.operator, gateway: detection.gateway, country: detection.country,
  });
  if (r.approved || r.pending) return { ok: true, ref: r.gatewayRef || r.authCode || null };
  return { ok: false, reason: r.declineReason || r.message || 'Virement Mobile Money refusé' };
};

// ─── Helpers ──────────────────────────────────────────────────────

const getCommissionRate = (paymentMethod, kybLevel) => {
  const rates = COMMISSION_RATES[paymentMethod] || COMMISSION_RATES.mobile_money;
  if (kybLevel >= 2) return rates.level2;
  if (kybLevel >= 1) return rates.level1;
  return rates.default;
};

module.exports = { enqueue, runSettlement, getCommissionRate, COMMISSION_RATES };
