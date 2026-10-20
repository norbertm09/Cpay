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

const { query, withTransaction, pool } = require('../../config/database');
const logger = require('../../config/logger');

// ─── Queue de settlement ──────────────────────────────────────────

// WAVE-6 : `client` optionnel (pg client d'une transaction en cours) — finalize.service
// enfile dans la MÊME transaction SQL que le passage à `authorized`.
const enqueue = async ({ txnId, merchantId, amount, currency }, client = null) => {
  const exec = client ? (text, params) => client.query(text, params) : query;
  await exec(
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
  const connection = await pool.connect();
  let acquired = false;
  let discard = false;
  try {
    const lock = await connection.query(`SELECT pg_try_advisory_lock(hashtext('cpay_settlement_run')) AS ok`);
    acquired = lock.rows[0].ok;
    if (!acquired) return { skipped: true, reason: 'already_running', cutoff };
    logger.info(`Settlement: running, cutoff ${cutoff}`);
    const groups = await connection.query(
      `SELECT sq.merchant_id, sq.currency, COUNT(*)::int AS n
       FROM settlement_queue sq JOIN transactions t ON t.transaction_id = sq.transaction_id
       WHERE sq.settled = FALSE AND sq.queued_at < $1::date AND t.status = 'authorized' AND t.type IN ('collect','qr_payment','pay_link')
         AND t.settlement_batch_id IS NULL AND COALESCE(t.settlement_status,'') NOT IN ('regle','soumis','en_cours','echec')
         AND t.net_amount IS NOT NULL AND t.fee_amount IS NOT NULL
       GROUP BY sq.merchant_id, sq.currency ORDER BY sq.merchant_id`, [cutoff]);
    if (!groups.rows.length) { logger.info('Settlement: nothing to process'); return { batches: 0, settled: 0, errors: 0, cutoff }; }

    let settled = 0, errors = 0, batches = 0;
    for (const g of groups.rows) {
      try {
        const n = await settleGroup(g.merchant_id, g.currency, cutoff, connection);
        if (n > 0) { settled += n; batches++; }
      } catch (err) {
        errors++;
        logger.error('Settlement: group failed', { merchantId: g.merchant_id, currency: g.currency, error: err.message });
      }
    }
    logger.info(`Settlement complete: ${batches} batches, ${settled} items, ${errors} errors`);
    return { batches, settled, errors, cutoff };
  } finally {
    if (acquired) {
      try { await connection.query(`SELECT pg_advisory_unlock(hashtext('cpay_settlement_run'))`); }
      catch (err) { discard = true; logger.error('Settlement unlock failed', { err: err.message }); }
    }
    connection.release(discard);
  }
};

/**
 * 1) Transaction SQL : claim des items (FOR UPDATE SKIP LOCKED), batch 'pending', marquage settled — COMMIT.
 * 2) Hors transaction : virement, puis statut du batch selon le résultat réel.
 */
const settleGroup = async (merchantId, currency, cutoff, connection) => {
  const claimed = await withTransaction(async (client) => {
    // Same lock as cash withdrawals and mobile disbursements, before computing availability.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(merchantId)]);
    const { computeAvailableBalance } = require('../cash/cash.service');
    const balance = await computeAvailableBalance((sql, params) => client.query(sql, params), merchantId);
    const items = await client.query(
      `SELECT sq.id, sq.transaction_id, sq.amount, t.payment_method, t.fee_amount, t.net_amount,
              m.settlement_type, m.settlement_account, m.settlement_provider, m.kyb_level, m.country
       FROM settlement_queue sq
       JOIN transactions t ON t.transaction_id = sq.transaction_id
       JOIN merchants m    ON m.merchant_id = sq.merchant_id
       WHERE sq.merchant_id = $1 AND sq.currency = $2 AND sq.settled = FALSE AND sq.queued_at < $3::date
         AND t.status = 'authorized' AND t.type IN ('collect','qr_payment','pay_link')
         AND t.settlement_batch_id IS NULL AND COALESCE(t.settlement_status,'') NOT IN ('regle','soumis','en_cours','echec')
         AND t.net_amount IS NOT NULL AND t.fee_amount IS NOT NULL AND m.currency=sq.currency AND m.merchant_status='active'
       FOR UPDATE OF sq SKIP LOCKED`, [merchantId, currency, cutoff]);
    if (!items.rows.length) return null;
    const head = items.rows[0];
    let totalGross = 0, totalFees = 0;
    for (const it of items.rows) {
      const amount = Number(it.amount);
      const fee = Number(it.fee_amount);
      const net = Number(it.net_amount);
      if (!Number.isFinite(fee) || !Number.isFinite(net) || fee < 0 || net < 0 || Math.abs(amount-fee-net) > 0.001) {
        throw new Error('Montants de transaction incohérents : rapprochement requis');
      }
      it._fee = fee; it._net = net;
      totalGross += amount; totalFees += fee;
    }
    totalGross = round(totalGross, currency); totalFees = round(totalFees, currency);
    const eligibleNet = round(totalGross - totalFees, currency);
    const totalNet = round(Math.min(eligibleNet, balance.available), currency);
    const cashOffset = round(eligibleNet - totalNet, currency);

    const b = await client.query(
      `INSERT INTO settlement_batches
         (merchant_id, batch_date, total_gross, total_fees, total_net, currency, txn_count,
          settlement_type, settlement_account, settlement_provider, cash_offset_amount, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending') RETURNING batch_id`,
      [merchantId, cutoff, totalGross, totalFees, totalNet, currency, items.rows.length,
       head.settlement_type, head.settlement_account, head.settlement_provider, cashOffset]);
    const batchId = b.rows[0].batch_id;
    for (const it of items.rows) {
      await client.query('UPDATE transactions SET settlement_batch_id=$1 WHERE transaction_id=$2', [batchId, it.transaction_id]);
      await client.query(
        `UPDATE settlement_queue SET settled = TRUE, batch_id = $1, settled_at = NOW(), fee_amount = $2, net_amount = $3 WHERE id = $4`,
        [batchId, it._fee, it._net, it.id]);
    }
    return { batchId, head, totalNet, count: items.rows.length };
  }, connection);
  if (!claimed) return 0;

  const { batchId, head, totalNet, count } = claimed;
  if (totalNet === 0) {
    // Already consumed by cash withdrawals: retain the allocation trail, never send again.
    await connection.query("UPDATE settlement_batches SET status='completed', completed_at=NOW() WHERE batch_id=$1", [batchId]);
  } else if (head.settlement_type === 'mobile_money' && head.settlement_account) {
    const r = await initiateMobileMoneyTransfer({ batchId, amount: totalNet, currency, phone: head.settlement_account, country: head.country });
    await connection.query(
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

module.exports = { enqueue, runSettlement };
