// ─────────────────────────────────────────────────────────────────
//  Reconciliation — balaie les transactions 'pending' et interroge
//  les operateurs (Airtel/MTN) pour finaliser leur statut.
//  Independant du polling en memoire : rattrape les transactions
//  bloquees apres un redemarrage. Declenche le settlement si authorized.
//
//  HOTFIX WAVE-1 :
//   * filtre operateur : valeurs legacy minuscules ('mtn','airtel') ET valeurs
//     orchestrateur ('MTN_MOMO','AIRTEL_MONEY') → LOWER(detected_operator) LIKE 'mtn%'/'airtel%'
//   * MTN : statut REEL du provider (provider mtn.provider.getRequestStatus/getTransferStatus
//     avec la config du routeur quand elle existe, sinon rails/mtn-momo.client)
//   * jamais `failed` sur erreur provider/reseau : on laisse pending
//   * montant/devise du provider compares a la transaction avant 'authorized'
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

const opKind = (detectedOperator) => {
  const op = String(detectedOperator || '').toLowerCase();
  if (op.startsWith('mtn'))    return 'mtn';
  if (op.startsWith('airtel')) return 'airtel';
  return null;
};

// Statut MTN reel : provider orchestrateur (config DB/env par pays) si configure,
// sinon client rails (config Congo). Leve en cas d'erreur reseau/HTTP → la
// transaction reste pending.
const mtnStatus = async (t, product) => {
  const ref = t.gateway_payment_id;
  const country = String(t.detected_country || '').toLowerCase();
  if (country) {
    try {
      const router = require('./mobilemoney/mobilemoney.router');
      const config = await router.getConfig(`mtn_${country}`);
      if (config && config.apiKey && config.baseUrl) {
        const provider = require('./mobilemoney/providers/mtn.provider');
        return product === 'collection'
          ? await provider.getRequestStatus(config, ref)
          : await provider.getTransferStatus(config, ref);
      }
    } catch (e) {
      // provider pays non configure ou en erreur → on tente le client rails ci-dessous
      if (e && e.statusCode && e.statusCode !== 404) throw e;
      logger.warn('Reconcile MTN provider fallback to rails client', { txn: t.transaction_id, err: e.message });
    }
  }
  const mtn = require('./rails/mtn-momo.client');
  return product === 'collection'
    ? await mtn.getCollectionStatus(ref)
    : await mtn.getDisbursementStatus(ref);
};

// Montant/devise annonces par le provider vs transaction stockee.
const amountMatches = (t, s) => {
  if (s.amount != null && Number.isFinite(Number(s.amount)) && Number(s.amount) > 0
      && Math.abs(Number(s.amount) - Number(t.amount)) > 0.009) {
    logger.error('Reconcile: amount mismatch — left pending', { txn: t.transaction_id, expected: t.amount, received: s.amount });
    return false;
  }
  if (s.currency && t.currency && String(s.currency).toUpperCase() !== String(t.currency).toUpperCase()) {
    logger.error('Reconcile: currency mismatch — left pending', { txn: t.transaction_id, expected: t.currency, received: s.currency });
    return false;
  }
  return true;
};

async function reconcileOne(t) {
  const op  = opKind(t.detected_operator);
  const ref = t.gateway_payment_id;
  if (!ref) return { txn: t.transaction_id, skipped: 'no_ref' };
  const currency = t.currency || 'XAF';

  try {
    // ---- COLLECTE ----
    if (t.type === 'collect' || t.type === 'qr_payment' || t.type === 'pay_link') {
      if (op === 'mtn') {
        const s = await mtnStatus(t, 'collection');
        const st = String(s.status || '').toUpperCase();
        if (st === 'SUCCESSFUL') {
          if (!amountMatches(t, s)) return { txn: t.transaction_id, still: 'pending', mismatch: true };
          return await markCollectOk(t, s.financialTransactionId || s.financialTxnId);
        }
        if (st === 'FAILED')     return await markFailed(t, s.reason || 'MTN failed');
        return { txn: t.transaction_id, still: 'pending', providerStatus: st || null };
      }
      if (op === 'airtel') {
        const airtel = require('./mobilemoney/providers/airtel.provider');
        const s = await airtel.queryTransaction({ txId: ref, currency, config: airtelCfg() });
        if (s.success) return await markCollectOk(t, s.airtelMoneyId);
        if (s.failed)  return await markFailed(t, s.message || 'Airtel failed');
        return { txn: t.transaction_id, still: 'pending', providerStatus: s.rawStatus || null };
      }
    }
    // ---- VERSEMENT ----
    if (t.type === 'payout') {
      if (op === 'mtn') {
        const s = await mtnStatus(t, 'disbursement');
        const st = String(s.status || '').toUpperCase();
        if (st === 'SUCCESSFUL') {
          if (!amountMatches(t, s)) return { txn: t.transaction_id, still: 'pending', mismatch: true };
          return await markPayoutOk(t, s.financialTransactionId || s.financialTxnId);
        }
        if (st === 'FAILED')     return await markFailed(t, s.reason || 'MTN failed');
        return { txn: t.transaction_id, still: 'pending', providerStatus: st || null };
      }
      if (op === 'airtel') {
        const airtel = require('./mobilemoney/providers/airtel.provider');
        const s = await airtel.queryDisbursement({ txId: ref, currency, config: airtelDisbCfg() });
        if (s.success) return await markPayoutOk(t, s.airtelMoneyId);
        if (s.failed)  return await markFailed(t, s.message || 'Airtel failed');
        return { txn: t.transaction_id, still: 'pending', providerStatus: s.rawStatus || null };
      }
    }
    return { txn: t.transaction_id, skipped: 'no_rule' };
  } catch (e) {
    // Erreur provider / reseau : on ne touche pas au statut (reste pending)
    logger.warn('Reconcile erreur txn (left pending)', { txn: t.transaction_id, err: e.message });
    return { txn: t.transaction_id, error: e.message, still: 'pending' };
  }
}

async function markCollectOk(t, operatorId) {
  const auth = 'AUTH' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const r = await query(`UPDATE transactions SET status='authorized', auth_code=$1,
               response_message='Paiement confirme (reconcile)',
               gateway_order_id=COALESCE($3, gateway_order_id),
               fee_amount=calc_fee(merchant_id,'collect',detected_operator,amount), net_amount=amount-calc_fee(merchant_id,'collect',detected_operator,amount), completed_at=NOW()
               WHERE transaction_id=$2 AND status='pending'`, [auth, t.transaction_id, operatorId || null]);
  if (r && r.rowCount === 0) return { txn: t.transaction_id, skipped: 'already_final' };
  // declencher le reglement automatique
  try {
    const { settleTransaction } = require('./settlement.service');
    settleTransaction(t.transaction_id).catch(e => logger.error('reconcile settlement', { err: e.message }));
  } catch (e) {}
  return { txn: t.transaction_id, updated: 'authorized' };
}
async function markPayoutOk(t, operatorId) {
  const auth = 'DSB' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const r = await query(`UPDATE transactions SET status='authorized', auth_code=$1,
               response_message='Transfert effectue (reconcile)',
               gateway_order_id=COALESCE($3, gateway_order_id),
               fee_amount=calc_fee(merchant_id,'payout',detected_operator,amount), net_amount=amount-calc_fee(merchant_id,'payout',detected_operator,amount), completed_at=NOW()
               WHERE transaction_id=$2 AND status='pending'`, [auth, t.transaction_id, operatorId || null]);
  if (r && r.rowCount === 0) return { txn: t.transaction_id, skipped: 'already_final' };
  return { txn: t.transaction_id, updated: 'authorized' };
}
// Uniquement sur un statut FAILED explicite du provider (jamais sur erreur reseau)
async function markFailed(t, reason) {
  const r = await query(`UPDATE transactions SET status='failed', response_message=$1,
               fee_amount=0, net_amount=0, completed_at=NOW()
               WHERE transaction_id=$2 AND status='pending'`, [String(reason).slice(0, 120), t.transaction_id]);
  if (r && r.rowCount === 0) return { txn: t.transaction_id, skipped: 'already_final' };
  return { txn: t.transaction_id, updated: 'failed', reason };
}

// Balaye les transactions pending recentes (fenetre configurable, defaut 24h)
async function reconcilePending({ maxAgeHours = 24, limit = 100 } = {}) {
  const r = await query(
    `SELECT transaction_id, type, amount, currency, detected_operator, detected_country, gateway_payment_id, status
     FROM transactions
     WHERE status='pending' AND gateway_payment_id IS NOT NULL
       AND (LOWER(detected_operator) LIKE 'mtn%' OR LOWER(detected_operator) LIKE 'airtel%')
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
    errors: results.filter(x => x.error).length,
  };
  logger.info('Reconcile termine', summary);
  return { summary, results };
}

module.exports = { reconcilePending, reconcileOne, opKind };
