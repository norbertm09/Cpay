/**
 * WAVE-3 — finalisation d'une transaction Mobile Money `pending`.
 *
 * UNIQUE machine d'état partagée par :
 *   - les webhooks opérateurs (routes/webhooks-mm.routes.js) ;
 *   - la réconciliation (services/reconcile.service.js, POST /admin/reconcile,
 *     scripts/reconcile-pending.js).
 *
 * Règles (inchangées depuis la vague 2) :
 *   - claim atomique `WHERE status='pending'` : un rejeu / une course ne change rien ;
 *   - `authorized` : response_code '00', règlement enfilé pour les encaissements,
 *     lien de paiement marqué `paid` ;
 *   - `failed` : response_code conservé ou '05', message = raison opérateur ;
 *   - un événement `transaction_events` est journalisé à chaque application.
 */
'use strict';

const { query } = require('../../config/database');
const logger = require('../../config/logger');
const settlementQueue = require('../settlement/settlement.queue');

const SETTLEABLE_TYPES = new Set(['collect', 'qr_payment', 'pay_link']);

const recordTransactionEvent = async ({ transactionId, merchantId, eventType, payload }) => {
  try {
    await query(
      `INSERT INTO transaction_events (transaction_id, merchant_id, event_type, payload)
       VALUES ($1,$2,$3,$4)`,
      [transactionId, merchantId || null, eventType, JSON.stringify(payload || {})]
    );
  } catch (err) {
    logger.warn('transaction_events insert failed', { transactionId, eventType, err: err.message });
  }
};

/**
 * Applique un résultat final (`authorized` | `failed`) à une transaction pending.
 *
 * @param {object} o
 * @param {object} o.txn          ligne transactions (transaction_id, merchant_id, type, amount, currency, pay_link_id)
 * @param {string} o.provider     clé provider (orange, wave, africell, …) — pour les messages / événements
 * @param {'authorized'|'failed'} o.outcome
 * @param {string} [o.authCode]   référence finale opérateur (auth_code)
 * @param {string} [o.gatewayRef] référence de session / ordre (gateway_order_id)
 * @param {string} [o.reason]     raison d'échec opérateur
 * @param {string} [o.source]     'webhook' | 'reconcile' — suffixe de l'event_type et du message
 * @param {object} [o.eventPayload] détail journalisé dans transaction_events
 * @returns {Promise<{applied:boolean, status:string}>}
 */
const finalizeTransaction = async ({ txn, provider, outcome, authCode, gatewayRef, reason, source = 'webhook', eventPayload = {} }) => {
  if (outcome !== 'authorized' && outcome !== 'failed') throw new Error(`finalizeTransaction: outcome invalide (${outcome})`);
  const label = source === 'reconcile' ? `${provider}, reconcile` : provider;
  const message = outcome === 'authorized' ? `Paiement confirmé (${label})` : (reason || `Paiement refusé (${label})`);
  const upd = await query(
    `UPDATE transactions
        SET status = $1, auth_code = COALESCE($2, auth_code),
            gateway_order_id = COALESCE($3, gateway_order_id),
            response_code = CASE WHEN $1 = 'authorized' THEN '00' ELSE COALESCE(response_code, '05') END,
            response_message = $4,
            completed_at = NOW(),
            fee_amount = CASE WHEN $1 = 'authorized' THEN COALESCE(fee_amount,
              cpay_calculate_fee(merchant_id, type::text, detected_operator, amount, payment_method::text)) ELSE fee_amount END,
            net_amount = CASE WHEN $1 = 'authorized' THEN COALESCE(net_amount,
              amount - COALESCE(fee_amount, cpay_calculate_fee(merchant_id, type::text, detected_operator, amount, payment_method::text))) ELSE net_amount END
      WHERE transaction_id = $5 AND status = 'pending'
      RETURNING transaction_id`,
    [outcome, authCode ? String(authCode).slice(0, 64) : null, gatewayRef ? String(gatewayRef).slice(0, 128) : null,
     String(message).slice(0, 500), txn.transaction_id]
  );
  if (!upd.rowCount) return { applied: false, status: 'already_processed' };

  await recordTransactionEvent({
    transactionId: txn.transaction_id, merchantId: txn.merchant_id,
    eventType: `${String(provider).toUpperCase()}_${source === 'reconcile' ? 'RECONCILE' : 'CALLBACK'}`,
    payload: { outcome, authCode: authCode || null, gatewayRef: gatewayRef || null, ...eventPayload },
  });

  if (outcome === 'authorized') {
    if (SETTLEABLE_TYPES.has(txn.type)) {
      try {
        await settlementQueue.enqueue({ txnId: txn.transaction_id, merchantId: txn.merchant_id, amount: Number(txn.amount), currency: txn.currency });
      } catch (err) {
        logger.error('finalize: settlement enqueue failed', { provider, txnId: txn.transaction_id, err: err.message });
      }
    }
    if (txn.pay_link_id) {
      await query(
        `UPDATE pay_links SET status='paid', paid_at=NOW(), paid_amount=$1 WHERE pay_link_id=$2 AND status='pending'`,
        [Number(txn.amount), txn.pay_link_id]
      ).catch((err) => logger.warn('finalize: pay_link update failed', { payLinkId: txn.pay_link_id, err: err.message }));
    }
  }
  logger.info('transaction finalisée', { provider, source, txnId: txn.transaction_id, outcome });
  return { applied: true, status: outcome };
};

module.exports = { finalizeTransaction, recordTransactionEvent, SETTLEABLE_TYPES };
