// ─────────────────────────────────────────────────────────────────
//  Reconciliation — balaie les transactions 'pending' et interroge
//  les operateurs (Airtel/MTN) pour finaliser leur statut.
//  Independant du polling en memoire : rattrape les transactions
//  bloquees apres un redemarrage. Declenche le settlement si authorized.
// ─────────────────────────────────────────────────────────────────
const { query } = require('../config/database');
const logger = require('../config/logger');

const airtelCfg = () => ({
  baseUrl:   process.env.AIRTEL_CG_BASE_URL,
  apiKey:    process.env.AIRTEL_CG_COLL_CLIENT_ID,
  apiSecret: process.env.AIRTEL_CG_COLL_CLIENT_SECRET,
  env:       process.env.AIRTEL_CG_ENV,
});
const airtelDisbCfg = () => ({
  baseUrl:   process.env.AIRTEL_CG_BASE_URL,
  apiKey:    process.env.AIRTEL_CG_DISB_CLIENT_ID,
  apiSecret: process.env.AIRTEL_CG_DISB_CLIENT_SECRET,
  env:       process.env.AIRTEL_CG_ENV,
});

async function reconcileOne(t) {
  const op = t.detected_operator;
  const ref = t.gateway_payment_id;
  if (!ref) return { txn: t.transaction_id, skipped: 'no_ref' };

  try {
    // ---- COLLECTE ----
    if (t.type === 'collect') {
      if (op === 'mtn') {
        const mtn = require('./rails/mtn-momo.client');
        const s = await mtn.getCollectionStatus(ref);
        if (s.status === 'SUCCESSFUL') return await markCollectOk(t, s.financialTransactionId);
        if (s.status === 'FAILED')     return await markFailed(t, s.reason || 'MTN failed');
        return { txn: t.transaction_id, still: 'pending' };
      }
      if (op === 'airtel') {
        const airtel = require('./mobilemoney/providers/airtel.provider');
        const s = await airtel.queryTransaction({ txId: ref, currency: 'XAF', config: airtelCfg() });
        if (s.success) return await markCollectOk(t, s.airtelMoneyId);
        if (s.failed)  return await markFailed(t, s.message || 'Airtel failed');
        return { txn: t.transaction_id, still: 'pending' };
      }
    }
    // ---- VERSEMENT ----
    if (t.type === 'payout') {
      if (op === 'mtn') {
        const mtn = require('./rails/mtn-momo.client');
        const s = await mtn.getDisbursementStatus(ref);
        if (s.status === 'SUCCESSFUL') return await markPayoutOk(t, s.financialTransactionId);
        if (s.status === 'FAILED')     return await markFailed(t, s.reason || 'MTN failed');
        return { txn: t.transaction_id, still: 'pending' };
      }
      if (op === 'airtel') {
        const airtel = require('./mobilemoney/providers/airtel.provider');
        const s = await airtel.queryDisbursement({ txId: ref, currency: 'XAF', config: airtelDisbCfg() });
        if (s.success) return await markPayoutOk(t, s.airtelMoneyId);
        if (s.failed)  return await markFailed(t, s.message || 'Airtel failed');
        return { txn: t.transaction_id, still: 'pending' };
      }
    }
    return { txn: t.transaction_id, skipped: 'no_rule' };
  } catch (e) {
    logger.warn('Reconcile erreur txn', { txn: t.transaction_id, err: e.message });
    return { txn: t.transaction_id, error: e.message };
  }
}

async function markCollectOk(t, operatorId) {
  const auth = 'AUTH' + Math.random().toString(36).slice(2, 8).toUpperCase();
  await query(`UPDATE transactions SET status='authorized', auth_code=$1,
               response_message='Paiement confirme (reconcile)',
               gateway_order_id=COALESCE($3, gateway_order_id),
               fee_amount=calc_fee(merchant_id,'collect',detected_operator,amount), net_amount=amount-calc_fee(merchant_id,'collect',detected_operator,amount), completed_at=NOW()
               WHERE transaction_id=$2 AND status='pending'`, [auth, t.transaction_id, operatorId || null]);
  // declencher le reglement automatique
  try {
    const { settleTransaction } = require('./settlement.service');
    settleTransaction(t.transaction_id).catch(e => logger.error('reconcile settlement', { err: e.message }));
  } catch (e) {}
  return { txn: t.transaction_id, updated: 'authorized' };
}
async function markPayoutOk(t, operatorId) {
  const auth = 'DSB' + Math.random().toString(36).slice(2, 8).toUpperCase();
  await query(`UPDATE transactions SET status='authorized', auth_code=$1,
               response_message='Transfert effectue (reconcile)',
               gateway_order_id=COALESCE($3, gateway_order_id),
               fee_amount=calc_fee(merchant_id,'payout',detected_operator,amount), net_amount=amount-calc_fee(merchant_id,'payout',detected_operator,amount), completed_at=NOW()
               WHERE transaction_id=$2 AND status='pending'`, [auth, t.transaction_id, operatorId || null]);
  return { txn: t.transaction_id, updated: 'authorized' };
}
async function markFailed(t, reason) {
  await query(`UPDATE transactions SET status='failed', response_message=$1,
               fee_amount=0, net_amount=0, completed_at=NOW()
               WHERE transaction_id=$2 AND status='pending'`, [String(reason).slice(0, 120), t.transaction_id]);
  return { txn: t.transaction_id, updated: 'failed', reason };
}

// Balaye les transactions pending recentes (fenetre configurable, defaut 24h)
async function reconcilePending({ maxAgeHours = 24, limit = 100 } = {}) {
  const r = await query(
    `SELECT transaction_id, type, amount, detected_operator, gateway_payment_id, status
     FROM transactions
     WHERE status='pending' AND gateway_payment_id IS NOT NULL
       AND detected_operator IN ('mtn','airtel')
       AND initiated_at > NOW() - ($1 || ' hours')::interval
     ORDER BY initiated_at DESC LIMIT $2`, [String(maxAgeHours), limit]);
  const results = [];
  for (const t of r.rows) {
    results.push(await reconcileOne(t));
  }
  const summary = {
    scanned: r.rows.length,
    authorized: results.filter(x => x.updated === 'authorized').length,
    failed: results.filter(x => x.updated === 'failed').length,
    still_pending: results.filter(x => x.still === 'pending').length,
  };
  logger.info('Reconcile termine', summary);
  return { summary, results };
}

module.exports = { reconcilePending, reconcileOne };
