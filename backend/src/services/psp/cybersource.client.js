'use strict';
// ================================================================
// CPlus 2.6 — CyberSource Payment Client
// Cartes Visa (BIN 4xxxxx)
// API REST CyberSource v2
// ================================================================

const https  = require('https');
const crypto = require('crypto');

const CONFIG = {
  merchantId:   process.env.CYBERSOURCE_MERCHANT_ID    || '',
  apiKeyId:     process.env.CYBERSOURCE_API_KEY_ID     || '',
  sharedSecret: process.env.CYBERSOURCE_SHARED_SECRET  || '',
  sandbox:      process.env.CYBERSOURCE_SANDBOX !== 'false',
  get baseUrl() {
    return this.sandbox
      ? 'apitest.cybersource.com'
      : 'api.cybersource.com';
  },
};

// ─── Signature HTTP CyberSource ───────────────────────────────────
const buildSignature = (method, path, payload, date) => {
  const digest = payload
    ? 'SHA-256=' + crypto.createHash('sha256').update(payload).digest('base64')
    : '';

  const signTarget = [
    `host: ${CONFIG.baseUrl}`,
    `date: ${date}`,
    `(request-target): ${method.toLowerCase()} ${path}`,
    payload ? `digest: ${digest}` : '',
    `v-c-merchant-id: ${CONFIG.merchantId}`,
  ].filter(Boolean).join('\n');

  const headers = [
    'host', 'date', '(request-target)',
    payload ? 'digest' : null,
    'v-c-merchant-id',
  ].filter(Boolean).join(' ');

  const sig = crypto
    .createHmac('sha256', Buffer.from(CONFIG.sharedSecret, 'base64'))
    .update(signTarget)
    .digest('base64');

  return {
    signature: `keyid="${CONFIG.apiKeyId}", algorithm="HmacSHA256", headers="${headers}", signature="${sig}"`,
    digest,
    date,
  };
};

// ─── HTTP Request ─────────────────────────────────────────────────
const request = (method, path, body) => new Promise((resolve, reject) => {
  const date    = new Date().toUTCString();
  const payload = body ? JSON.stringify(body) : null;
  const { signature, digest } = buildSignature(method, path, payload, date);

  const headers = {
    'Host':             CONFIG.baseUrl,
    'Date':             date,
    'v-c-merchant-id':  CONFIG.merchantId,
    'Signature':        signature,
    'Content-Type':     'application/json;charset=utf-8',
    'Accept':           'application/hal+json;charset=utf-8',
  };
  if (digest) headers['Digest'] = digest;
  if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

  const req = https.request({
    hostname: CONFIG.baseUrl,
    path,
    method,
    headers,
    rejectUnauthorized: !CONFIG.sandbox,
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(d); } catch { parsed = d; }
      if (res.statusCode >= 400) {
        const err = new Error(parsed?.message || `CyberSource HTTP ${res.statusCode}`);
        err.statusCode = res.statusCode;
        err.csResponse = parsed;
        return reject(err);
      }
      resolve({ status: res.statusCode, data: parsed });
    });
  });
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
});

// ─── Autorisation + Capture (Sale) ───────────────────────────────
/**
 * Débiter une carte tokenisée via CyberSource
 * @param {object} params
 * @param {number}  params.amount      - Montant en XAF
 * @param {string}  params.currency    - Devise (XAF)
 * @param {string}  params.tokenId     - Token CPlus (transient token ou PAN tokenisé)
 * @param {string}  params.cardMasked  - PAN masqué (pour logs)
 * @param {string}  params.network     - visa | mastercard
 * @param {string}  params.orderId     - ID commande CPlus (txn_id)
 * @param {object}  params.cardholder  - { firstName, lastName, email }
 */
const processPayment = async ({ amount, currency = 'XAF', tokenId, cardMasked, network, orderId, cardholder = {} }) => {
  const body = {
    clientReferenceInformation: {
      code: orderId,
    },
    processingInformation: {
      capture: true,  // Sale = Auth + Capture en une seule requête
      commerceIndicator: 'internet',
    },
    orderInformation: {
      amountDetails: {
        totalAmount: String(Math.round(amount)),
        currency,
      },
      billTo: {
        firstName: cardholder.firstName || 'CPlus',
        lastName:  cardholder.lastName  || 'Client',
        email:     cardholder.email     || 'client@cplus.africa',
        address1:  'Brazzaville',
        country:   'CG',
        postalCode: '00000',
      },
    },
    paymentInformation: {
      customer: {
        customerId: tokenId,
      },
    },
  };

  const { data } = await request('POST', '/pts/v2/payments', body);

  return {
    success:      data.status === 'AUTHORIZED' || data.status === 'PENDING',
    transactionId: data.id,
    authCode:      data.processorInformation?.approvalCode,
    status:        data.status,
    cardMasked,
    network,
    amount,
    currency,
    pspRef:        data.id,
    psp:           'cybersource',
    raw:           data,
  };
};

// ─── Remboursement ────────────────────────────────────────────────
const refund = async ({ transactionId, amount, currency = 'XAF', orderId }) => {
  const body = {
    clientReferenceInformation: { code: orderId + '_refund' },
    orderInformation: {
      amountDetails: { totalAmount: String(Math.round(amount)), currency },
    },
  };
  const { data } = await request('POST', `/pts/v2/payments/${transactionId}/refunds`, body);
  return {
    success:       data.status === 'PENDING',
    refundId:      data.id,
    status:        data.status,
    psp:           'cybersource',
  };
};

// ─── Vérification transaction ─────────────────────────────────────
const getTransaction = async (transactionId) => {
  const { data } = await request('GET', `/tss/v2/transactions/${transactionId}`);
  return data;
};

module.exports = { processPayment, refund, getTransaction, CONFIG };
