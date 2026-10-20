'use strict';
/**
 * WAVE-6 (audit 17/10/2026 §2) — job de réparation de la file de règlement.
 *
 * Depuis la vague 6, finalize.service écrit `authorized` + settlement_queue + pay_link dans UNE
 * transaction SQL. Ce balayage couvre l'historique (confirmations antérieures dont l'enfilement
 * avait échoué silencieusement) et toute écriture directe de `authorized` hors de cette machine
 * d'état : encaissement autorisé, réglable, sans ligne settlement_queue, plus vieux que
 * `minAgeMinutes` (défaut 5) → enfilé (ON CONFLICT DO NOTHING : jamais deux lignes) + événement
 * `SETTLEMENT_QUEUE_REPAIRED` dans transaction_events.
 *
 * Appelé par scripts/reconcile-pending.js et POST /admin/cash/repair/settlement-queue.
 */
const { query } = require('../../config/database');
const logger = require('../../config/logger');
const { enqueue } = require('./settlement.queue');

const SETTLEABLE_TYPES = ['collect', 'qr_payment', 'pay_link'];

async function sweepAuthorizedWithoutQueue({ minAgeMinutes = 5, limit = 500, actor = 'system' } = {}) {
  let minAge = parseInt(minAgeMinutes, 10);
  if (!Number.isFinite(minAge) || minAge < 0) minAge = 5;
  let lim = parseInt(limit, 10);
  if (!Number.isFinite(lim) || lim < 1) lim = 500;
  const r = await query(
    `SELECT t.transaction_id, t.merchant_id, t.amount, t.currency, t.type, t.completed_at, t.initiated_at
     FROM transactions t
     LEFT JOIN settlement_queue sq ON sq.transaction_id = t.transaction_id
     WHERE t.status = 'authorized' AND t.type::text = ANY($1::text[])
       AND sq.transaction_id IS NULL
       AND t.settlement_batch_id IS NULL
       AND COALESCE(t.settlement_status, '') NOT IN ('regle', 'soumis', 'en_cours', 'echec')
       AND COALESCE(t.completed_at, t.initiated_at) < NOW() - ($2 || ' minutes')::interval
     ORDER BY COALESCE(t.completed_at, t.initiated_at) ASC
     LIMIT $3`,
    [SETTLEABLE_TYPES, String(minAge), lim]);
  const repaired = [];
  const errors = [];
  for (const t of r.rows) {
    try {
      await enqueue({ txnId: t.transaction_id, merchantId: t.merchant_id, amount: Number(t.amount), currency: t.currency });
      await query(
        `INSERT INTO transaction_events (transaction_id, merchant_id, event_type, payload) VALUES ($1,$2,'SETTLEMENT_QUEUE_REPAIRED',$3)`,
        [t.transaction_id, t.merchant_id, JSON.stringify({ by: actor, amount: Number(t.amount), currency: t.currency, authorizedAt: t.completed_at || t.initiated_at })]);
      repaired.push(t.transaction_id);
    } catch (e) {
      errors.push({ txn: t.transaction_id, error: e.message });
      logger.error('settlement repair: enqueue failed', { txn: t.transaction_id, err: e.message });
    }
  }
  const summary = { scanned: r.rows.length, repaired: repaired.length, errors: errors.length, minAgeMinutes: minAge };
  if (r.rows.length) logger.warn('settlement repair: authorized transactions without queue row', summary);
  return { ...summary, transactionIds: repaired, failed: errors };
}

module.exports = { sweepAuthorizedWithoutQueue, SETTLEABLE_TYPES };
