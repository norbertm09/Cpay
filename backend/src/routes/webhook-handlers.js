// backend/src/routes/webhook-handlers.js
// Handlers webhook Mobile Money — montés directement dans server.js
'use strict';

const crypto = require('crypto');
const { query } = require('../config/database');
const { auditLog } = require('../middleware/pci.middleware');

// ─── MTN MoMo Webhook ─────────────────────────────────────────────
const handleMtnWebhook = async (req, res) => {
  try {
    const { referenceId, status, financialTransactionId, reason } = req.body;
    if (!referenceId) return res.status(400).json({ error: 'referenceId requis' });

    await auditLog({
      eventType: `MTN_WEBHOOK_${status}`,
      actorType: 'system',
      details:   req.body,
      ipAddress: req.ip,
      success:   status === 'SUCCESSFUL',
    });

    if (status === 'SUCCESSFUL') {
      const txnRes = await query(
        `SELECT * FROM card_transactions WHERE mm_reference=$1 AND status='pending'`,
        [referenceId]
      );
      if (txnRes.rows.length) {
        const txn = txnRes.rows[0];
        if (txn.type === 'topup') {
          await query(
            `UPDATE virtual_cards SET balance=balance+$1, updated_at=NOW() WHERE card_id=$2`,
            [txn.net_amount, txn.card_id]
          );
        }
        await query(
          `UPDATE card_transactions SET status='completed', completed_at=NOW(), auth_code=$1 WHERE mm_reference=$2`,
          [financialTransactionId || referenceId, referenceId]
        );
      }
    }

    if (status === 'FAILED') {
      const txnRes = await query(
        `SELECT * FROM card_transactions WHERE mm_reference=$1 AND status='pending'`,
        [referenceId]
      );
      if (txnRes.rows.length && txnRes.rows[0].type === 'unload') {
        const txn = txnRes.rows[0];
        await query(
          `UPDATE virtual_cards SET balance=balance+$1, updated_at=NOW() WHERE card_id=$2`,
          [parseFloat(txn.amount) + parseFloat(txn.fee), txn.card_id]
        );
      }
      await query(
        `UPDATE card_transactions SET status='failed', failure_reason=$1 WHERE mm_reference=$2`,
        [reason || 'MTN FAILED', referenceId]
      );
    }

    res.status(200).json({ success: true, referenceId, status });
  } catch (err) {
    console.error('[MTN-WEBHOOK-ERROR]', err.message);
    res.status(200).json({ received: true });
  }
};

// ─── Airtel Money Webhook ─────────────────────────────────────────
const handleAirtelWebhook = async (req, res) => {
  // Vérification signature
  const signature = req.headers['x-airtel-signature'];
  const secret    = process.env.AIRTEL_WEBHOOK_SECRET;
  if (secret && signature) {
    const expected = crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify(req.body))
      .digest('hex');
    if (signature !== expected) {
      await auditLog({ eventType: 'AIRTEL_WEBHOOK_INVALID_SIGNATURE', actorType: 'system', ipAddress: req.ip, success: false });
      return res.status(401).json({ error: 'Signature invalide' });
    }
  }

  try {
    const { transaction, data } = req.body;
    const txnData     = transaction || data?.transaction || {};
    const referenceId = txnData.id || req.body.reference;
    const status      = txnData.status || req.body.status;
    const airtelRef   = txnData.airtel_money_id;
    const message     = txnData.message || req.body.message;

    if (!referenceId) return res.status(400).json({ error: 'transaction.id requis' });

    const isSuccess = ['TS', 'SUCCESS', 'SUCCESSFUL', 'COMPLETE'].includes(status?.toUpperCase());
    const isFailed  = ['TF', 'FAILED', 'EXPIRED'].includes(status?.toUpperCase());

    console.log(`[AIRTEL-WEBHOOK] ref=${referenceId} status=${status} airtelRef=${airtelRef}`);

    await auditLog({
      eventType: `AIRTEL_WEBHOOK_${status}`,
      actorType: 'system',
      details:   { referenceId, status, airtelRef, message },
      ipAddress: req.ip,
      success:   isSuccess,
    });

    const cardTxnRes = await query(
      `SELECT * FROM card_transactions WHERE mm_reference=$1 AND status='pending' LIMIT 1`,
      [referenceId]
    );

    if (isSuccess && cardTxnRes.rows.length) {
      const txn = cardTxnRes.rows[0];
      if (txn.type === 'topup') {
        await query(
          `UPDATE virtual_cards SET balance=balance+$1, updated_at=NOW() WHERE card_id=$2`,
          [parseFloat(txn.net_amount), txn.card_id]
        );
      }
      await query(
        `UPDATE card_transactions SET status='completed', completed_at=NOW(), auth_code=$1,
         metadata=metadata||$2 WHERE mm_reference=$3`,
        [airtelRef || referenceId, JSON.stringify({ airtelRef, webhook: 'airtel' }), referenceId]
      );
    }

    if (isFailed && cardTxnRes.rows.length) {
      const txn = cardTxnRes.rows[0];
      if (txn.type === 'unload') {
        await query(
          `UPDATE virtual_cards SET balance=balance+$1, updated_at=NOW() WHERE card_id=$2`,
          [parseFloat(txn.amount) + parseFloat(txn.fee), txn.card_id]
        );
      }
      await query(
        `UPDATE card_transactions SET status='failed', failure_reason=$1 WHERE mm_reference=$2`,
        [message || `Airtel ${status}`, referenceId]
      );
    }

    res.status(200).json({ success: true, referenceId, status });
  } catch (err) {
    console.error('[AIRTEL-WEBHOOK-ERROR]', err.message);
    res.status(200).json({ received: true });
  }
};

module.exports = { handleMtnWebhook, handleAirtelWebhook };

// ─── CYBERSOURCE WEBHOOK ──────────────────────────────────────────
const handleCyberSourceWebhook = async (req, res) => {
  try {
    const crypto = require('crypto');
    // Vérifier signature CyberSource (HMAC-SHA256)
    const payload   = JSON.stringify(req.body);
    const signature = req.headers['v-c-signature'] || req.headers['x-signature'];
    const secret    = process.env.CYBERSOURCE_SHARED_SECRET;

    if (secret && signature) {
      const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64');
      if (signature !== expected) {
        console.warn('CyberSource webhook: signature invalide');
        return res.status(401).json({error:'Signature invalide'});
      }
    }

    const { id, type, data } = req.body;
    const orderId   = data?.object?.clientReferenceInformation?.code || data?.object?.id;
    const txnStatus = data?.object?.applicationInformation?.reasonCode;
    const authCode  = data?.object?.processorInformation?.approvalCode;
    const amount    = data?.object?.orderInformation?.amountDetails?.totalAmount;

    console.log(`CyberSource webhook: ${type} | order: ${orderId} | status: ${txnStatus}`);

    if (type === 'payments.payments.updated' || type === 'payments.payments.completed') {
      const isAuthorized = ['100'].includes(String(txnStatus));

      // Update transaction
      await require('../config/database').query(
        `UPDATE transactions SET
           status=$1, auth_code=COALESCE($2, auth_code),
           response_code=$3, completed_at=CASE WHEN $1='authorized' THEN NOW() ELSE completed_at END,
           updated_at=NOW()
         WHERE (gateway_payment_id=$4 OR gateway_order_id=$4) AND status='pending'`,
        [isAuthorized ? 'authorized' : 'failed', authCode||null, String(txnStatus), orderId]
      );

      // Update pay_link si lié
      if (isAuthorized) {
        await require('../config/database').query(
          `UPDATE pay_links SET status='paid', paid_at=NOW(), paid_amount=$1
           WHERE (short_id=$2 OR pay_link_id::text=$2) AND status='pending'`,
          [parseFloat(amount||0), orderId]
        ).catch(()=>{});
      }

      // Déclencher webhook sortant merchant
      await triggerMerchantWebhook(orderId, isAuthorized ? 'payment.completed' : 'payment.failed');
    }

    res.json({received: true});
  } catch(err) {
    console.error('CyberSource webhook error:', err.message);
    res.status(500).json({error:err.message});
  }
};

// ─── MIGS WEBHOOK ────────────────────────────────────────────────
const handleMigsWebhook = async (req, res) => {
  try {
    const { vpc_TxnResponseCode, vpc_TransactionNo, vpc_MerchTxnRef,
            vpc_AuthorizeId, vpc_Amount, vpc_SecureHash } = req.body;

    // Vérifier signature MIGS
    const secret = process.env.MIGS_SECURE_HASH;
    if (secret && vpc_SecureHash) {
      const params = Object.keys(req.body)
        .filter(k => k !== 'vpc_SecureHash' && k.startsWith('vpc_'))
        .sort()
        .map(k => `${k}=${req.body[k]}`)
        .join('&');
      const expected = require('crypto').createHmac('sha256', Buffer.from(secret,'hex')).update(params).digest('hex').toUpperCase();
      if (expected !== vpc_SecureHash.toUpperCase()) {
        return res.status(401).json({error:'Signature MIGS invalide'});
      }
    }

    const isAuthorized = vpc_TxnResponseCode === '0';
    const orderId      = vpc_MerchTxnRef;
    const authCode     = vpc_AuthorizeId;
    const amount       = parseFloat(vpc_Amount||0) / 100; // MIGS envoie en centimes

    console.log(`MIGS webhook: order=${orderId} | code=${vpc_TxnResponseCode} | auth=${authCode}`);

    await require('../config/database').query(
      `UPDATE transactions SET
         status=$1, auth_code=COALESCE($2, auth_code),
         response_code=$3, completed_at=CASE WHEN $1='authorized' THEN NOW() ELSE completed_at END
       WHERE (gateway_payment_id=$4 OR gateway_order_id=$4 OR reference=$4) AND status='pending'`,
      [isAuthorized ? 'authorized' : 'failed', authCode||null, vpc_TxnResponseCode, orderId]
    );

    if (isAuthorized) {
      await require('../config/database').query(
        `UPDATE pay_links SET status='paid', paid_at=NOW(), paid_amount=$1
         WHERE (short_id=$2 OR pay_link_id::text=$2) AND status='pending'`,
        [amount, orderId]
      ).catch(()=>{});
    }

    await triggerMerchantWebhook(orderId, isAuthorized ? 'payment.completed' : 'payment.failed');

    // MIGS attend une réponse spécifique
    res.send('OK');
  } catch(err) {
    console.error('MIGS webhook error:', err.message);
    res.status(500).send('ERROR');
  }
};

// ─── WEBHOOKS SORTANTS MERCHANT ───────────────────────────────────
const triggerMerchantWebhook = async (referenceOrId, event) => {
  try {
    const { query } = require('../config/database');

    // Trouver la transaction et le merchant
    const txnRes = await query(
      `SELECT t.*, m.webhook_url, m.webhook_secret
       FROM transactions t
       JOIN merchants m ON m.merchant_id=t.merchant_id
       WHERE t.gateway_order_id=$1 OR t.reference=$1 OR t.transaction_id::text=$1
       LIMIT 1`,
      [referenceOrId]
    );
    if (!txnRes.rows.length) return;

    const txn = txnRes.rows[0];
    if (!txn.webhook_url) return;

    const crypto  = require('crypto');
    const payload = JSON.stringify({
      event,
      txnId:     txn.transaction_id,
      reference: txn.reference,
      amount:    parseFloat(txn.amount),
      currency:  txn.currency,
      status:    txn.status,
      method:    txn.payment_method,
      authCode:  txn.auth_code,
      timestamp: new Date().toISOString()
    });

    const signature = 'sha256=' + crypto
      .createHmac('sha256', txn.webhook_secret || 'cplus-default-secret')
      .update(payload)
      .digest('hex');

    // Envoyer le webhook (avec retry)
    const url = new URL(txn.webhook_url);
    const lib = url.protocol === 'https:' ? require('https') : require('http');

    const sendWebhook = (attempt = 1) => {
      const req = lib.request({
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname,
        method:   'POST',
        headers:  {
          'Content-Type':       'application/json',
          'Content-Length':     Buffer.byteLength(payload),
          'X-CPlus-Signature':  signature,
          'X-CPlus-Event':      event,
          'User-Agent':         'CPlus-Webhook/2.6.0',
        },
        timeout: 10000,
      }, (res) => {
        console.log(`Webhook merchant ${event}: HTTP ${res.statusCode} (tentative ${attempt})`);
        if (res.statusCode >= 500 && attempt < 3) {
          setTimeout(() => sendWebhook(attempt + 1), attempt * 5000);
        }
      });
      req.on('error', (e) => {
        console.error(`Webhook merchant error (tentative ${attempt}):`, e.message);
        if (attempt < 3) setTimeout(() => sendWebhook(attempt + 1), attempt * 5000);
      });
      req.write(payload);
      req.end();
    };

    sendWebhook();
  } catch(err) {
    console.error('triggerMerchantWebhook error:', err.message);
  }
};

module.exports = {
  ...module.exports,
  handleCyberSourceWebhook,
  handleMigsWebhook,
  triggerMerchantWebhook
};
