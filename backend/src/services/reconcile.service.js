// ─────────────────────────────────────────────────────────────────
//  Reconciliation — balaie les transactions 'pending' et interroge
//  les operateurs (Airtel/MTN, et depuis la WAVE-3 Orange/Wave/Africell/
//  Express Union/Free Money/Moov via getStatus()) pour finaliser leur statut.
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

// ─── WAVE-3 : providers de la vague 2 (Orange, Wave, Africell, Express Union,
// Free Money, Moov) via mobilemoney.router.getProvider(key).getStatus(), finalisés
// par la MEME machine d'état que les webhooks (services/mobilemoney/finalize.service).
const WAVE2_PROVIDERS = ['orange', 'wave', 'africell', 'express_union', 'free_money', 'moov'];
// detected_operator (orchestrateur ou legacy minuscule) → provider
const OPERATOR_TO_PROVIDER = {
  orange_money: 'orange', orange: 'orange',
  wave: 'wave',
  africell_money: 'africell', africell: 'africell',
  express_union: 'express_union', express_union_mobile: 'express_union',
  free_money: 'free_money', free: 'free_money',
  moov_money: 'moov', moov: 'moov',
};
const WAVE2_OPERATOR_VALUES = Object.keys(OPERATOR_TO_PROVIDER);

const providerKeys = () => {
  const { PROVIDERS } = require('./mobilemoney/mobilemoney.router');
  return Object.keys(PROVIDERS || {});
};
/** Clés de gateway (mtn_cm, orange_sn, …) rattachées à un provider de la vague 2. */
const keysForProvider = (provider) => providerKeys().filter(k => k.startsWith(`${provider}_`) && /_[a-z]{2}$/.test(k));
const wave2GatewayKeys = () => WAVE2_PROVIDERS.flatMap(keysForProvider);

/** Provider vague 2 d'une transaction (gateway_name prioritaire, sinon detected_operator), ou null. */
const wave2Provider = (t) => {
  const gw = String(t.gateway_name || '').toLowerCase();
  if (gw && providerKeys().includes(gw)) {
    const p = gw.replace(/_[a-z]{2}$/, '');
    if (WAVE2_PROVIDERS.includes(p)) return p;
  }
  return OPERATOR_TO_PROVIDER[String(t.detected_operator || '').toLowerCase()] || null;
};

/** Clé de gateway à utiliser pour charger la config / le module (même logique que les webhooks). */
const gatewayKeyFor = (provider, t) => {
  const gw = String(t.gateway_name || '').toLowerCase();
  const keys = keysForProvider(provider);
  if (gw && keys.includes(gw)) return gw;
  const country = String(t.detected_country || '').toLowerCase();
  if (country) { const byCountry = keys.find(k => k.endsWith(`_${country}`)); if (byCountry) return byCountry; }
  return keys[0] || null;
};

/**
 * Réconciliation d'un provider vague 2 : statut réel via getStatus() quand il existe,
 * finalisation par finalize.service (claim atomique, règlement, pay_link). Toute
 * indisponibilité (pas d'endpoint, statusPath absent, erreur réseau) laisse pending.
 */
const reconcileWave2 = async (t, provider) => {
  const mmRouter = require('./mobilemoney/mobilemoney.router');
  const key = gatewayKeyFor(provider, t);
  const mod = key ? mmRouter.getProvider(key) : null;
  if (!mod || typeof mod.getStatus !== 'function') return { txn: t.transaction_id, provider, skipped: 'no_status_endpoint' };
  const config = await mmRouter.getConfig(key);
  const product = t.type === 'payout' ? 'disbursement' : 'collection';
  const s = await mod.getStatus({ txnId: t.transaction_id, gatewayRef: t.gateway_payment_id, config, product });
  if (!s || s.available === false) return { txn: t.transaction_id, provider, skipped: 'status_unavailable' };
  const st = String(s.status || '').toUpperCase();
  if (st !== 'SUCCESSFUL' && st !== 'FAILED') return { txn: t.transaction_id, provider, still: 'pending', providerStatus: st || null };
  if (st === 'SUCCESSFUL' && !amountMatches(t, s)) return { txn: t.transaction_id, provider, still: 'pending', mismatch: true };
  const { finalizeTransaction } = require('./mobilemoney/finalize.service');
  const outcome = st === 'SUCCESSFUL' ? 'authorized' : 'failed';
  const fin = await finalizeTransaction({
    txn: t, provider, outcome, authCode: s.gatewayRef || null, gatewayRef: s.gatewayRef || null,
    reason: s.reason || null, source: 'reconcile', eventPayload: { providerStatus: st, gatewayKey: key },
  });
  if (!fin.applied) return { txn: t.transaction_id, provider, skipped: 'already_final' };
  return { txn: t.transaction_id, provider, updated: outcome, ...(outcome === 'failed' ? { reason: s.reason || null } : {}) };
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
    // ---- Providers vague 2 (Orange, Wave, Africell, Express Union, Free Money, Moov) ----
    if (!op) {
      const provider = wave2Provider(t);
      if (provider) return await reconcileWave2(t, provider);
    }
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

// Balaye les transactions pending recentes (fenetre configurable, defaut 24h).
// WAVE-3 : couvre aussi les providers de la vague 2 (par gateway_name ou detected_operator) ;
// minAgeMinutes (defaut 5) evite de concurrencer un push / webhook encore en vol.
async function reconcilePending({ maxAgeHours = 24, limit = 100, minAgeMinutes = 5 } = {}) {
  let minAge = parseInt(minAgeMinutes, 10);
  if (!Number.isFinite(minAge) || minAge < 0) minAge = 5;
  const r = await query(
    `SELECT transaction_id, merchant_id, type, amount, currency, detected_operator, detected_country,
            gateway_name, gateway_payment_id, pay_link_id, status
     FROM transactions
     WHERE status='pending' AND gateway_payment_id IS NOT NULL
       AND (LOWER(detected_operator) LIKE 'mtn%' OR LOWER(detected_operator) LIKE 'airtel%'
            OR LOWER(detected_operator) = ANY($3::text[]) OR LOWER(gateway_name) = ANY($4::text[]))
       AND initiated_at > NOW() - ($1 || ' hours')::interval
       AND initiated_at < NOW() - ($5 || ' minutes')::interval
     ORDER BY initiated_at DESC LIMIT $2`,
    [String(maxAgeHours), limit, WAVE2_OPERATOR_VALUES, wave2GatewayKeys(), String(minAge)]);
  const results = [];
  for (const t of r.rows) {
    results.push(await reconcileOne(t));
  }
  const byProvider = {};
  for (const x of results) {
    const p = x.provider || 'mtn_airtel';
    byProvider[p] = byProvider[p] || { authorized: 0, failed: 0, still_pending: 0, skipped: 0, errors: 0 };
    if (x.updated === 'authorized') byProvider[p].authorized++;
    else if (x.updated === 'failed') byProvider[p].failed++;
    else if (x.error) byProvider[p].errors++;
    else if (x.still === 'pending') byProvider[p].still_pending++;
    else if (x.skipped) byProvider[p].skipped++;
  }
  const summary = {
    scanned: r.rows.length,
    authorized: results.filter(x => x.updated === 'authorized').length,
    failed: results.filter(x => x.updated === 'failed').length,
    still_pending: results.filter(x => x.still === 'pending').length,
    skipped: results.filter(x => x.skipped).length,
    errors: results.filter(x => x.error).length,
    by_provider: byProvider,
  };
  logger.info('Reconcile termine', summary);
  return { summary, results };
}

// ─── WAVE-6 (audit 17/10/2026 §1) : retraits et décaissements incertains ───
// 1) merchant_transfers `unknown` / `processing` : statut réel opérateur via
//    cash.service.refreshPayoutStatus (completed / failed uniquement sur statut explicite ;
//    « introuvable » → failed seulement après CASH_UNKNOWN_GRACE_MINUTES) ; needs_review + e-mail
//    ops après CASH_UNKNOWN_ALERT_HOURS.
// 2) transactions type='payout' restées `pending` avec response_message='pending_unknown'
//    (orchestrateur, exception gateway) : reconcileOne quand une référence existe, sinon alerte
//    ops (une seule fois, événement PAYOUT_NEEDS_REVIEW) après CASH_UNKNOWN_ALERT_HOURS.
async function reconcileUncertainPayouts({ graceMinutes = null, alertHours = null, limit = 200 } = {}) {
  const cash = require('./cash/cash.service');
  const transfers = await cash.sweepUncertainPayouts({ graceMinutes, alertHours, limit });
  const alertH = alertHours === null || alertHours === undefined ? cash.unknownAlertHours() : Number(alertHours);
  const r = await query(
    `SELECT t.transaction_id, t.merchant_id, t.type, t.amount, t.currency, t.detected_operator, t.detected_country,
            t.gateway_name, t.gateway_payment_id, t.pay_link_id, t.status, t.initiated_at, m.business_name
     FROM transactions t LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
     WHERE t.type='payout' AND t.status='pending' AND t.response_message='pending_unknown'
       AND t.initiated_at > NOW() - INTERVAL '30 days'
       AND NOT EXISTS (SELECT 1 FROM transaction_events e WHERE e.transaction_id = t.transaction_id AND e.event_type = 'PAYOUT_NEEDS_REVIEW')
     ORDER BY t.initiated_at ASC LIMIT $1`, [Math.min(1000, Math.max(1, parseInt(limit, 10) || 200))]);
  const txResults = [];
  for (const t of r.rows) {
    let out = null;
    if (t.gateway_payment_id) out = await reconcileOne(t);
    const ageH = (Date.now() - new Date(t.initiated_at).getTime()) / 3600000;
    const stillPending = !out || !out.updated;
    if (stillPending && ageH >= alertH) {
      await query(`INSERT INTO transaction_events (transaction_id, merchant_id, event_type, payload) VALUES ($1,$2,'PAYOUT_NEEDS_REVIEW',$3)`,
        [t.transaction_id, t.merchant_id, JSON.stringify({ ageHours: Math.round(ageH * 10) / 10, alertHours: alertH, source: 'reconcile' })]).catch((e) => logger.error('reconcile: needs_review event failed', { txn: t.transaction_id, err: e.message }));
      await cash.notifyOps({
        subject: `Décaissement à vérifier (résultat opérateur incertain) — ${t.transaction_id}`,
        html: `<p>Décaissement <code>${t.transaction_id}</code> (${Number(t.amount)} ${t.currency || ''}, ${t.detected_operator || ''}) du marchand ${t.business_name || t.merchant_id}
          est <b>pending / pending_unknown</b> depuis ${Math.round(ageH * 10) / 10} h${t.gateway_payment_id ? '' : ' et ne possède aucune référence opérateur'}.</p>
          <p>Les fonds restent réservés. Vérifiez le relevé opérateur puis finalisez (webhook rejoué, réconciliation ou décision Finance documentée).</p>`,
      });
      txResults.push({ txn: t.transaction_id, needsReview: true, ...(out || {}) });
    } else {
      txResults.push({ txn: t.transaction_id, ...(out || { skipped: 'no_ref', still: 'pending' }) });
    }
  }
  return {
    transfers,
    transactions: { scanned: r.rows.length, flagged: txResults.filter((x) => x.needsReview).length, results: txResults },
  };
}

module.exports = { reconcilePending, reconcileOne, reconcileUncertainPayouts, opKind, wave2Provider, gatewayKeyFor, WAVE2_PROVIDERS };
