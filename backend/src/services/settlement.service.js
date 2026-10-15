// ─────────────────────────────────────────────────────────────────
//  Settlement temps réel — reglement marchand
//  Sur encaissement confirmé (authorized), reverse au marchand le net
//  (montant - commission) selon SON mode de reglement choisi :
//   - mobile_money instantane : versement Airtel/MTN immediat
//   - bank : marque pour reglement J+2 manuel
//  Secours optionnel si le principal echoue. Idempotent.
// ─────────────────────────────────────────────────────────────────
const { query } = require('../config/database');
const logger = require('../config/logger');

// Verse via le rail du bon opérateur
async function payout({ operator, amount, phone, description, externalId }) {
  if (operator === 'mtn') {
    const mtn = require('./rails/mtn-momo.client');
    const r = await mtn.transfer({ amount, phone, description, externalId });
    return { ref: r.referenceId || externalId, raw: r };
  }
  if (operator === 'airtel') {
    const airtel = require('./mobilemoney/providers/airtel.provider');
    const cfg = {
      baseUrl:      process.env.AIRTEL_CG_BASE_URL,
      apiKey:       process.env.AIRTEL_CG_DISB_CLIENT_ID,
      apiSecret:    process.env.AIRTEL_CG_DISB_CLIENT_SECRET,
      env:          process.env.AIRTEL_CG_ENV,
      pin:          process.env.AIRTEL_CG_DISB_PIN,
      rsaPubKey:    process.env.AIRTEL_CG_DISB_RSA_PUBKEY,
    };
    const r = await airtel.sendPayout({ txnId: externalId, amount, currency: 'XAF', phone, config: cfg });
    if (r.pending) return { ref: r.transactionId || externalId, raw: r, pending: true };
    if (!r.success) throw new Error(r.errorMessage || 'Airtel payout failed');
    return { ref: r.transactionId || externalId, raw: r };
  }
  throw new Error('Operateur de settlement non supporte: ' + operator);
}

// Determine le(s) moyen(s) de reglement du marchand : principal + secours
// Retourne { mode, targets: [{operator, account}], bank }
function resolveSettlement(m) {
  const targets = [];
  const stype = m.settlement_type || (m.wallet_mtn || m.wallet_airtel ? 'mobile_money' : null);

  // Mode bancaire : pas de versement MoMo, reglement J+2 manuel
  if (stype === 'bank') {
    return { mode: 'bank', targets: [], bank: true };
  }

  // Mode mobile money : principal
  if (stype === 'mobile_money') {
    const prov = (m.settlement_provider || '').toLowerCase();
    const acct = m.settlement_account
      || (prov === 'mtn' ? m.wallet_mtn : prov === 'airtel' ? m.wallet_airtel : null);
    if (prov && acct) targets.push({ operator: prov, account: acct });
  }

  // Fallback pour marchands existants (sans settlement_type) : wallets directs
  if (!targets.length) {
    if (m.wallet_mtn)    targets.push({ operator: 'mtn',    account: m.wallet_mtn });
    if (m.wallet_airtel) targets.push({ operator: 'airtel', account: m.wallet_airtel });
  }

  // Secours optionnel : settlement_backup_*
  if (m.settlement_backup_type === 'mobile_money' && m.settlement_backup_provider && m.settlement_backup_account) {
    targets.push({ operator: m.settlement_backup_provider.toLowerCase(), account: m.settlement_backup_account, backup: true });
  }

  return { mode: 'mobile_money', targets, bank: false };
}

async function settleTransaction(txnId) {
  // Claim atomique : une seule exécution concurrente peut passer ici (audit §6, double règlement).
  // Seules les transactions collect autorisées jamais réglées sont éligibles ; un échec ('echec')
  // n'est PAS rejoué automatiquement (l'opérateur a peut-être déjà versé) : action manuelle.
  const claim = await query(
    `UPDATE transactions SET settlement_status = 'en_cours'
     WHERE transaction_id = $1 AND status = 'authorized' AND type = 'collect'
       AND (settlement_status IS NULL OR settlement_status = 'en_attente_cumul')
     RETURNING transaction_id`, [txnId]);
  if (!claim.rows.length) {
    logger.info('Settlement: transaction non éligible ou déjà traitée', { txnId });
    return;
  }
  const r = await query(
    `SELECT t.transaction_id, t.amount, t.detected_operator, t.settlement_status, t.merchant_id,
            m.wallet_mtn, m.wallet_airtel, m.commission_rate, m.business_name,
            m.settlement_type, m.settlement_provider, m.settlement_account, m.settlement_instant,
            m.settlement_backup_type, m.settlement_backup_provider, m.settlement_backup_account
     FROM transactions t JOIN merchants m ON t.merchant_id = m.merchant_id
     WHERE t.transaction_id = $1`, [txnId]);
  if (!r.rows.length) { logger.warn('Settlement: txn introuvable', { txnId }); return; }
  const t = r.rows[0];

  const plan = resolveSettlement(t);

  // Mode bancaire : reglement J+2 manuel
  if (plan.bank) {
    await query(`UPDATE transactions SET settlement_status='en_attente_bancaire',
                 response_message='Reglement bancaire J+2 (manuel)' WHERE transaction_id=$1`, [txnId]);
    logger.info('Settlement bancaire J+2', { txnId, merchant: t.business_name });
    return { ok: true, mode: 'bank_pending' };
  }

  // Reglement mobile money non-instantane : marquer cumul
  if (t.settlement_instant === false) {
    await query(`UPDATE transactions SET settlement_status='en_attente_cumul'
                 WHERE transaction_id=$1`, [txnId]);
    logger.info('Settlement cumul (non instantane)', { txnId });
    return { ok: true, mode: 'cumul_pending' };
  }

  if (!plan.targets.length) {
    await query(`UPDATE transactions SET settlement_status='echec',
                 response_message='Aucun moyen de reglement configure' WHERE transaction_id=$1`, [txnId]);
    logger.warn('Settlement: aucun moyen', { txnId, merchant: t.business_name });
    return;
  }

  const rate = parseFloat(t.commission_rate ?? 0.02);
  const gross = parseFloat(t.amount);
  const net = Math.round(gross * (1 - rate));

  // Essayer principal puis secours — externalId stable par (transaction, cible) pour que
  // l'opérateur dédoublonne un éventuel rejeu
  let lastErr = null;
  for (const [i, tg] of plan.targets.entries()) {
    const externalId = 'STL-' + txnId.replace(/-/g, '').slice(0, 20) + '-' + i;
    try {
      const res = await payout({
        operator: tg.operator, amount: net, phone: tg.account,
        description: 'Reglement CPay ' + (t.business_name || ''), externalId,
      });
      if (res.pending) {
        // Versement accepté mais non confirmé : reste 'soumis' jusqu'à confirmation opérateur
        await query(
          `UPDATE transactions SET settlement_status='soumis', settlement_ref=$1 WHERE transaction_id=$2`,
          [String(res.ref).slice(0, 80), txnId]);
        logger.info('Settlement soumis (en attente opérateur)', { txnId, net, operator: tg.operator });
        return { ok: true, pending: true, net, ref: res.ref, operator: tg.operator };
      }
      await query(
        `UPDATE transactions SET settlement_status='regle', settled_at=NOW(), settlement_ref=$1
         WHERE transaction_id=$2`, [String(res.ref).slice(0, 80), txnId]);
      logger.info('Settlement OK', { txnId, net, operator: tg.operator, backup: !!tg.backup });
      return { ok: true, net, ref: res.ref, operator: tg.operator, backup: !!tg.backup };
    } catch (e) {
      lastErr = e;
      logger.warn('Settlement tentative echouee', { txnId, operator: tg.operator, backup: !!tg.backup, err: e.message });
      // continuer vers le secours
    }
  }

  await query(
    `UPDATE transactions SET settlement_status='echec', settlement_ref=$1
     WHERE transaction_id=$2`, [('ERR: ' + (lastErr ? lastErr.message : 'inconnu')).slice(0, 80), txnId]);
  logger.error('Settlement echec (tous moyens)', { txnId, err: lastErr ? lastErr.message : '?' });
  return { ok: false, error: lastErr ? lastErr.message : 'echec' };
}

module.exports = { settleTransaction, resolveSettlement, payout };
