/**
 * WAVE-3 — finalisation d'une transaction Mobile Money `pending`.
 *
 * UNIQUE machine d'état partagée par :
 *   - les webhooks opérateurs (routes/webhooks-mm.routes.js) ;
 *   - la réconciliation (services/reconcile.service.js, POST /admin/reconcile,
 *     scripts/reconcile-pending.js).
 *
 * Règles :
 *   - claim atomique `WHERE status='pending'` : un rejeu / une course ne change rien ;
 *   - `authorized` : response_code '00', règlement enfilé pour les encaissements,
 *     lien de paiement marqué `paid` ;
 *   - `failed` : response_code conservé ou '05', message = raison opérateur ;
 *   - un événement `transaction_events` est journalisé à chaque application.
 *
 * WAVE-6 (audit 17/10/2026 §2) : les trois écritures (statut, settlement_queue, pay_link) et
 * l'événement sont exécutés dans UNE transaction PostgreSQL (withTransaction). Si l'une échoue,
 * tout est annulé : la transaction reste `pending` et le webhook / la réconciliation peuvent
 * être rejoués. Plus aucune erreur « seulement journalisée ».
 */
'use strict';

const { query, withTransaction } = require('../../config/database');
const logger = require('../../config/logger');
const settlementQueue = require('../settlement/settlement.queue');

const SETTLEABLE_TYPES = new Set(['collect', 'qr_payment', 'pay_link']);

/**
 * Journalise un événement. Hors transaction (défaut) : erreur avalée (journal best effort).
 * Avec `exec` (client d'une transaction) : l'erreur remonte pour annuler la transaction.
 */
const recordTransactionEvent = async ({ transactionId, merchantId, eventType, payload, exec = null }) => {
  const sql = `INSERT INTO transaction_events (transaction_id, merchant_id, event_type, payload) VALUES ($1,$2,$3,$4)`;
  const params = [transactionId, merchantId || null, eventType, JSON.stringify(payload || {})];
  if (exec) { await exec(sql, params); return; }
  try { await query(sql, params); }
  catch (err) { logger.warn('transaction_events insert failed', { transactionId, eventType, err: err.message }); }
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
 * @returns {Promise<{applied:boolean, status:string}>}  — lève si une écriture échoue (tout est annulé)
 */
const finalizeTransaction = async ({ txn, provider, outcome, authCode, gatewayRef, reason, source = 'webhook', eventPayload = {} }) => {
  if (outcome !== 'authorized' && outcome !== 'failed') throw new Error(`finalizeTransaction: outcome invalide (${outcome})`);
  const label = source === 'reconcile' ? `${provider}, reconcile` : provider;
  const message = outcome === 'authorized' ? `Paiement confirmé (${label})` : (reason || `Paiement refusé (${label})`);

  const result = await withTransaction(async (client) => {
    const exec = (text, params) => client.query(text, params);
    // 1) claim atomique
    const upd = await exec(
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

    // 2) événement (même transaction : une erreur annule le claim)
    await recordTransactionEvent({
      transactionId: txn.transaction_id, merchantId: txn.merchant_id,
      eventType: `${String(provider).toUpperCase()}_${source === 'reconcile' ? 'RECONCILE' : 'CALLBACK'}`,
      payload: { outcome, authCode: authCode || null, gatewayRef: gatewayRef || null, ...eventPayload },
      exec,
    });

    if (outcome === 'authorized') {
      // 3) règlement J+1 (encaissements uniquement) — même transaction
      if (SETTLEABLE_TYPES.has(txn.type)) {
        await settlementQueue.enqueue({ txnId: txn.transaction_id, merchantId: txn.merchant_id, amount: Number(txn.amount), currency: txn.currency }, client);
      }
      // 4) clôture du lien de paiement — même transaction
      if (txn.pay_link_id) {
        await exec(
          `UPDATE pay_links SET status='paid', paid_at=NOW(), paid_amount=$1 WHERE pay_link_id=$2 AND status='pending'`,
          [Number(txn.amount), txn.pay_link_id]
        );
      }
    }
    return { applied: true, status: outcome };
  });

  if (result.applied) logger.info('transaction finalisée', { provider, source, txnId: txn.transaction_id, outcome });
  return result;
};

module.exports = { finalizeTransaction, recordTransactionEvent, SETTLEABLE_TYPES };
