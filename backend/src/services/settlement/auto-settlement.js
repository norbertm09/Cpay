'use strict';

const { query, withTransaction } = require('../../config/database');

/**
 * Règlement automatique J+1
 * - Récupère toutes les transactions authorized de la veille non encore réglées
 * - Crée un batch de règlement par merchant
 * - Déclenché chaque jour à 00:30
 */
const runAutoSettlement = async () => {
  console.log('[Settlement] Démarrage règlement J+1 —', new Date().toISOString());
  try {
    // Merchants avec transactions authorized non réglées de la veille
    const merchants = await query(`
      SELECT DISTINCT t.merchant_id,
             m.settlement_account, m.settlement_type, m.currency
      FROM transactions t
      JOIN merchants m ON m.merchant_id = t.merchant_id
      WHERE t.status = 'authorized'
        AND t.initiated_at::date = CURRENT_DATE - INTERVAL '1 day'
        AND t.settlement_batch_id IS NULL
        AND m.merchant_status = 'active'
    `);

    console.log(`[Settlement] ${merchants.rows.length} merchant(s) à régler`);

    for (const merchant of merchants.rows) {
      await withTransaction(async client => {
        // Récupérer les transactions éligibles
        const txns = await client.query(`
          SELECT transaction_id, amount, fee_amount, net_amount, currency
          FROM transactions
          WHERE merchant_id = $1
            AND status = 'authorized'
            AND initiated_at::date = CURRENT_DATE - INTERVAL '1 day'
            AND settlement_batch_id IS NULL
          FOR UPDATE
        `, [merchant.merchant_id]);

        if (!txns.rows.length) return;

        const totalGross = txns.rows.reduce((s, t) => s + parseFloat(t.amount || 0), 0);
        const totalFees  = txns.rows.reduce((s, t) => s + parseFloat(t.fee_amount || 0), 0);
        const totalNet   = txns.rows.reduce((s, t) => s + parseFloat(t.net_amount || totalGross - totalFees), 0);

        // Créer le batch
        const batch = await client.query(`
          INSERT INTO settlement_batches
            (merchant_id, batch_date, total_gross, total_fees, total_net,
             currency, txn_count, settlement_type, settlement_account, status, submitted_at)
          VALUES ($1, CURRENT_DATE - INTERVAL '1 day', $2, $3, $4, $5, $6, $7, $8, 'submitted', NOW())
          RETURNING batch_id
        `, [
          merchant.merchant_id,
          totalGross.toFixed(2), totalFees.toFixed(2), totalNet.toFixed(2),
          merchant.currency || 'XAF',
          txns.rows.length,
          merchant.settlement_type || 'mobile_money',
          merchant.settlement_account
        ]);

        const batchId = batch.rows[0].batch_id;

        // Ajouter la colonne settlement_batch_id si elle n'existe pas
        await client.query(`
          ALTER TABLE transactions
          ADD COLUMN IF NOT EXISTS settlement_batch_id UUID REFERENCES settlement_batches(batch_id)
        `).catch(() => {});

        // Lier les transactions au batch
        await client.query(`
          UPDATE transactions
          SET settlement_batch_id = $1, status = 'authorized'
          WHERE transaction_id = ANY($2::uuid[])
        `, [batchId, txns.rows.map(t => t.transaction_id)]);

        // Simuler le virement (en prod : appel API MoMo/Banque)
        // Pour l'instant on marque completed directement
        await client.query(`
          UPDATE settlement_batches
          SET status = 'completed', completed_at = NOW()
          WHERE batch_id = $1
        `, [batchId]);

        console.log(`[Settlement] Merchant ${merchant.merchant_id}: batch ${batchId} — ${txns.rows.length} txns — ${totalNet.toFixed(2)} XAF`);
      });
    }
    console.log('[Settlement] Règlement J+1 terminé ✅');
  } catch (err) {
    console.error('[Settlement] Erreur:', err.message);
  }
};

module.exports = { runAutoSettlement };
