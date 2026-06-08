/**
 * Settlement Engine — Calculus Plus
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

const { query, withTransaction } = require('../../config/database');
const logger = require('../../config/logger');

// ─── Taux de commission par méthode et niveau ─────────────────────

const COMMISSION_RATES = {
  mobile_money: {
    default: 0.015,   // 1.5%
    level1:  0.012,   // 1.2% si KYB validé
    level2:  0.010,   // 1.0% si contrat
  },
  card_nfc: {
    default: 0.025,   // 2.5%
    level1:  0.020,
    level2:  0.018,
  },
  qr: {
    default: 0.015,
    level1:  0.012,
    level2:  0.010,
  },
};

// ─── Queue de settlement ──────────────────────────────────────────

const enqueue = async ({ txnId, merchantId, amount, currency }) => {
  try {
    await query(
      `INSERT INTO settlement_queue (transaction_id, merchant_id, amount, currency, queued_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (transaction_id) DO NOTHING`,
      [txnId, merchantId, amount, currency]
    );
    logger.debug('Settlement: enqueued', { txnId });
  } catch (err) {
    logger.warn('Settlement enqueue failed', { txnId, error: err.message });
  }
};

// ─── Job de settlement (à lancer chaque nuit à 23h) ───────────────

/**
 * Traiter tous les settlements de la journée.
 * Groupe par marchand, calcule les commissions, crée les batches.
 */
const runSettlement = async (batchDate = null) => {
  const date = batchDate || new Date().toISOString().slice(0, 10);
  logger.info(`Settlement: running for ${date}`);

  // Récupérer tous les items non settled de la journée
  const pending = await query(
    `SELECT sq.*, t.payment_method, t.merchant_id, m.settlement_type,
            m.settlement_account, m.settlement_provider, m.kyb_level
     FROM settlement_queue sq
     JOIN transactions t  ON sq.transaction_id = t.transaction_id
     JOIN merchants m     ON sq.merchant_id     = m.merchant_id
     WHERE sq.settled = FALSE
       AND DATE(sq.queued_at) = $1
     ORDER BY sq.merchant_id`,
    [date]
  );

  if (!pending.rows.length) {
    logger.info('Settlement: nothing to process');
    return { settled: 0, errors: 0 };
  }

  // Grouper par marchand
  const byMerchant = {};
  for (const row of pending.rows) {
    if (!byMerchant[row.merchant_id]) byMerchant[row.merchant_id] = [];
    byMerchant[row.merchant_id].push(row);
  }

  let settled = 0, errors = 0;

  for (const [merchantId, items] of Object.entries(byMerchant)) {
    try {
      await settleForMerchant(merchantId, items, date);
      settled += items.length;
    } catch (err) {
      errors++;
      logger.error('Settlement: merchant failed', { merchantId, error: err.message });
    }
  }

  logger.info(`Settlement complete: ${settled} settled, ${errors} errors`);
  return { settled, errors, date };
};

const settleForMerchant = async (merchantId, items, date) => {
  const merchant = items[0]; // header info du premier item
  const kybLevel = merchant.kyb_level || 0;

  // Calculer les totaux et commissions
  let totalGross = 0;
  let totalFees  = 0;

  for (const item of items) {
    const rate = getCommissionRate(item.payment_method, kybLevel);
    const fee  = parseFloat((item.amount * rate).toFixed(2));
    item._fee  = fee;
    item._net  = parseFloat((item.amount - fee).toFixed(2));
    totalGross += parseFloat(item.amount);
    totalFees  += fee;
  }

  const totalNet = parseFloat((totalGross - totalFees).toFixed(2));

  await withTransaction(async (client) => {
    // Créer le batch de settlement
    const batchResult = await client.query(
      `INSERT INTO settlement_batches
         (merchant_id, batch_date, total_gross, total_fees, total_net,
          currency, txn_count, settlement_type, settlement_account,
          settlement_provider, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending')
       RETURNING batch_id`,
      [
        merchantId, date, totalGross, totalFees, totalNet,
        merchant.currency,
        items.length,
        merchant.settlement_type,
        merchant.settlement_account,
        merchant.settlement_provider,
      ]
    );

    const batchId = batchResult.rows[0].batch_id;

    // Marquer les transactions comme settled
    for (const item of items) {
      await client.query(
        `UPDATE settlement_queue SET settled = TRUE, batch_id = $1, settled_at = NOW(),
         fee_amount = $2, net_amount = $3
         WHERE transaction_id = $4`,
        [batchId, item._fee, item._net, item.transaction_id]
      );
    }

    // Déclencher le virement selon le type de compte
    if (merchant.settlement_type === 'bank') {
      await initiateBankTransfer({ batchId, merchantId, amount: totalNet, currency: merchant.currency, account: merchant.settlement_account });
    } else if (merchant.settlement_type === 'mobile_money') {
      await initiateMobileMoneyTransfer({ batchId, merchantId, amount: totalNet, currency: merchant.currency, phone: merchant.settlement_account, provider: merchant.settlement_provider });
    }

    // Mettre à jour le statut du batch
    await client.query(
      `UPDATE settlement_batches SET status = 'submitted', submitted_at = NOW()
       WHERE batch_id = $1`,
      [batchId]
    );
  });

  logger.info('Settlement: merchant settled', {
    merchantId, items: items.length, totalGross, totalFees, totalNet,
  });
};

// ─── Virements ────────────────────────────────────────────────────

const initiateBankTransfer = async ({ batchId, merchantId, amount, currency, account }) => {
  logger.info('Settlement: initiating bank transfer', { batchId, amount, currency });
  // TODO: intégrer l'API bancaire (GIMAC interbank, SWIFT, etc.)
  // En attendant, marquer comme "pending_manual"
};

const initiateMobileMoneyTransfer = async ({ batchId, merchantId, amount, currency, phone, provider }) => {
  logger.info('Settlement: initiating MM payout', { batchId, amount, provider });
  const mmRouter = require('../mobilemoney/mobilemoney.router');
  const detectionEngine = require('../detection/detection.engine');

  const detection = detectionEngine.detectFromPhone(phone);
  if (!detection.success) {
    logger.error('Settlement: phone detection failed for payout', { phone });
    return;
  }

  await mmRouter.sendPayout({
    txnId:    `SETTLE-${batchId}`,
    amount, currency, phone,
    operator: detection.operator,
    gateway:  detection.gateway,
    country:  detection.country,
  });
};

// ─── Helpers ──────────────────────────────────────────────────────

const getCommissionRate = (paymentMethod, kybLevel) => {
  const rates = COMMISSION_RATES[paymentMethod] || COMMISSION_RATES.mobile_money;
  if (kybLevel >= 2) return rates.level2;
  if (kybLevel >= 1) return rates.level1;
  return rates.default;
};

module.exports = { enqueue, runSettlement, COMMISSION_RATES };
