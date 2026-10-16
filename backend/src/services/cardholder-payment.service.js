'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { withTransaction } = require('../config/database');
const fail = (statusCode, message, code) => Object.assign(new Error(message), { statusCode, code });
const ZERO_DECIMAL = new Set(['XOF','XAF','CDF','GNF','RWF','UGX']);
async function pay({ cardholderId, cardId, merchantId, amount, pin, description, key, ip, feeRate = 0.005 }) {
  if (typeof key !== 'string' || key.length < 8 || key.length > 128) throw fail(400, 'Idempotency-Key requis (8 à 128 caractères)', 'INVALID_IDEMPOTENCY_KEY');
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 1e12) throw fail(422, 'Montant numérique invalide', 'VALIDATION_ERROR');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(merchantId || ''))) throw fail(422, 'Marchand invalide', 'VALIDATION_ERROR');
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) throw fail(422, 'PIN à 4 chiffres requis', 'VALIDATION_ERROR');
  if (description !== undefined && (typeof description !== 'string' || description.length > 500)) throw fail(422, 'Description invalide', 'VALIDATION_ERROR');
  const requestHash = crypto.createHash('sha256').update(JSON.stringify({ cardId, merchantId, amount, description: description || null, feeRate })).digest('hex');
  return withTransaction(async client => {
    const inserted = await client.query(`INSERT INTO cardholder_payment_requests (cardholder_id,request_key,request_hash)
      VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING request_key`, [cardholderId,key,requestHash]);
    if (!inserted.rowCount) {
      const previous = await client.query('SELECT request_hash,response_body FROM cardholder_payment_requests WHERE cardholder_id=$1 AND request_key=$2 FOR UPDATE', [cardholderId,key]);
      const old = previous.rows[0];
      if (!old || old.request_hash !== requestHash) throw fail(409, 'Clé déjà utilisée avec un autre paiement', 'IDEMPOTENCY_CONFLICT');
      if (!old.response_body) throw fail(409, 'Paiement en cours', 'IDEMPOTENCY_IN_PROGRESS');
      return old.response_body;
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(merchantId)]);
    const merchant = (await client.query('SELECT business_name,currency,merchant_status FROM merchants WHERE merchant_id=$1 FOR SHARE', [merchantId])).rows[0];
    if (!merchant || merchant.merchant_status !== 'active') throw fail(422, 'Marchand introuvable ou inactif', 'MERCHANT_INACTIVE');
    const card = (await client.query('SELECT * FROM virtual_cards WHERE card_id=$1 AND cardholder_id=$2 FOR UPDATE', [cardId,cardholderId])).rows[0];
    if (!card) throw fail(404, 'Carte introuvable', 'CARD_NOT_FOUND');
    if (card.status !== 'active') throw fail(422, 'Carte inactive', 'CARD_INACTIVE');
    if (card.currency !== merchant.currency) throw fail(422, 'Devises incompatibles', 'CURRENCY_MISMATCH');
    const factor = ZERO_DECIMAL.has(card.currency) ? 1 : 100;
    if (Math.abs(amount*factor - Math.round(amount*factor)) > 1e-6) throw fail(422, 'Précision du montant invalide pour cette devise', 'VALIDATION_ERROR');
    const pinOk = card.pin_hash && await bcrypt.compare(pin,card.pin_hash);
    if (!pinOk) throw fail(422, 'PIN incorrect', 'INVALID_PIN');
    const fee = Math.round(amount*feeRate*factor)/factor;
    const total = Math.round((amount+fee)*factor)/factor;
    const balBefore = Number(card.balance);
    if (!Number.isFinite(balBefore) || balBefore < total) throw fail(422, 'Solde insuffisant (frais inclus)', 'INSUFFICIENT_BALANCE');
    // Respect both the daily and monthly card ceilings while holding the card row lock.
    const used = (await client.query(`SELECT
      COALESCE(SUM(amount+COALESCE(fee,0)) FILTER (WHERE initiated_at >= date_trunc('day',NOW())),0) AS daily,
      COALESCE(SUM(amount+COALESCE(fee,0)),0) AS monthly
      FROM card_transactions WHERE card_id=$1 AND type='payment' AND status='completed'
        AND initiated_at >= date_trunc('month',NOW())`, [cardId])).rows[0] || {};
    if ((Number(card.daily_limit)>0 && Number(used.daily || 0)+total>Number(card.daily_limit)) ||
        (Number(card.monthly_limit)>0 && Number(used.monthly || 0)+total>Number(card.monthly_limit))) throw fail(422, 'Plafond carte atteint', 'LIMIT_EXCEEDED');
    const id = crypto.randomUUID();
    const merchantTxnId = crypto.randomUUID();
    const authCode = crypto.randomBytes(6).toString('hex').toUpperCase();
    const balAfter = Math.round((balBefore-total)*factor)/factor;
    await client.query('UPDATE virtual_cards SET balance=$1,updated_at=NOW() WHERE card_id=$2 AND cardholder_id=$3', [balAfter,cardId,cardholderId]);
    await client.query('INSERT INTO pin_attempts (card_id,ip_address,success) VALUES ($1,$2,TRUE)', [cardId,ip]);
    const txn = (await client.query(`INSERT INTO card_transactions
      (txn_id,card_id,cardholder_id,type,amount,fee,net_amount,balance_before,balance_after,currency,status,description,merchant_name,merchant_id,auth_code,initiated_at,completed_at)
      VALUES ($1,$2,$3,'payment',$4,$5,$4,$6,$7,$8,'completed',$9,$10,$11,$12,NOW(),NOW()) RETURNING *`,
      [id,cardId,cardholderId,amount,fee,balBefore,balAfter,card.currency,description || null,merchant.business_name,merchantId,authCode])).rows[0];
    // Counter-entry: the merchant receives the principal; payer fees are separate.
    await client.query(`INSERT INTO transactions
      (transaction_id,merchant_id,type,amount,currency,payment_method,status,fee_amount,net_amount,gateway_name,gateway_payment_id,auth_code,description,initiated_at,completed_at)
      VALUES ($1,$2,'collect',$3,$4,'qr','authorized',0,$3,'cpay_wallet',$5,$6,$7,NOW(),NOW())`,
      [merchantTxnId,merchantId,amount,card.currency,id,authCode,description || 'Paiement portefeuille C-Pay']);
    await client.query(`INSERT INTO settlement_queue (transaction_id,merchant_id,amount,currency,queued_at)
      VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (transaction_id) DO NOTHING`, [merchantTxnId,merchantId,amount,card.currency]);
    const response = { success: true, txn, txnId: id, reference: 'PAY-' + id, status: 'completed', amount, fee, newBalance: balAfter, authCode, merchantTxnId };
    await client.query('UPDATE cardholder_payment_requests SET response_body=$1 WHERE cardholder_id=$2 AND request_key=$3', [response,cardholderId,key]);
    return response;
  });
}
module.exports = { pay };
