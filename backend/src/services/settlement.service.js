'use strict';
// Legacy entry point: all collections now share the J+1 queue and the cash reservation.
// No independent instant payout can compete with withdrawals or the nightly engine.
const { query } = require('../config/database');
const { enqueue } = require('./settlement/settlement.queue');
async function settleTransaction(txnId) {
  const r = await query(`SELECT transaction_id, merchant_id, amount, currency FROM transactions
    WHERE transaction_id=$1 AND status='authorized' AND type IN ('collect','qr_payment','pay_link')
      AND settlement_batch_id IS NULL
      AND COALESCE(settlement_status,'') NOT IN ('regle','soumis','en_cours','echec')`, [txnId]);
  if (!r.rows.length) return;
  const t = r.rows[0];
  await enqueue({ txnId: t.transaction_id, merchantId: t.merchant_id, amount: Number(t.amount), currency: t.currency });
  return { ok: true, pending: true, mode: 'j1_queue' };
}
module.exports = { settleTransaction };
