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
const { query, withTransaction } = require('../../config/database');
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
      const applied = await withTransaction(async (client) => {
        const locked = await client.query(
          `SELECT transaction_id, merchant_id, amount, currency, completed_at, initiated_at
           FROM transactions WHERE transaction_id=$1 AND status='authorized'
             AND type::text=ANY($2::text[]) AND settlement_batch_id IS NULL
             AND COALESCE(settlement_status,'') NOT IN ('regle','soumis','en_cours','echec')
           FOR UPDATE`, [t.transaction_id, SETTLEABLE_TYPES]);
        const current = locked.rows[0];
        if (!current) return false;
        const inserted = await enqueue({ txnId: current.transaction_id, merchantId: current.merchant_id,
          amount: Number(current.amount), currency: current.currency }, client);
        if (!inserted) return false;
        await client.query(
          `INSERT INTO transaction_events (transaction_id, merchant_id, event_type, payload) VALUES ($1,$2,'SETTLEMENT_QUEUE_REPAIRED',$3)`,
          [current.transaction_id, current.merchant_id, JSON.stringify({ by: actor, amount: Number(current.amount), currency: current.currency, authorizedAt: current.completed_at || current.initiated_at })]);
        return true;
      });
      if (applied) repaired.push(t.transaction_id);
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
