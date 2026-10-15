'use strict';
// ================================================================
// CPlus 2.6 — MIGS (MasterCard Internet Gateway Service) Client
// Cartes Mastercard (BIN 5xxxxx)
// API MIGS v1 (ANZ/ABA)
// ================================================================

const https  = require('https');
const crypto = require('crypto');
const qs     = require('querystring');

const CONFIG = {
  merchantId:   process.env.MIGS_MERCHANT_ID   || '',
  accessCode:   process.env.MIGS_ACCESS_CODE   || '',
  secureHash:   process.env.MIGS_SECURE_HASH   || '',
  sandbox:      process.env.MIGS_SANDBOX !== 'false',
  get baseUrl() {
    return this.sandbox
      ? 'migs.mastercard.com.au'
      : 'migs.mastercard.com.au';
  },
  path: '/vpcdps',
};

// ─── Signature MIGS (HMAC-SHA256) ────────────────────────────────
const buildHash = (params) => {
  // Trier les paramètres vpc_ par ordre alphabétique
  const sorted = Object.keys(params)
    .filter(k => k.startsWith('vpc_'))
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');

  return crypto
    .createHmac('sha256', Buffer.from(CONFIG.secureHash, 'hex'))
    .update(sorted)
    .digest('hex')
    .toUpperCase();
};

// ─── HTTP Request MIGS ───────────────────────────────────────────
const request = (params) => new Promise((resolve, reject) => {
  const body = qs.stringify(params);

  const req = https.request({
    hostname: CONFIG.baseUrl,
    path:     CONFIG.path,
    method:   'POST',
    headers: {
      'Content-Type':   'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
    rejectUnauthorized: !CONFIG.sandbox,
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      // MIGS retourne query string
      const parsed = qs.parse(d);
      if (res.statusCode >= 400) {
        const err = new Error(`MIGS HTTP ${res.statusCode}`);
        err.statusCode = res.statusCode;
        err.migsResponse = parsed;
        return reject(err);
      }
      resolve({ status: res.statusCode, data: parsed });
    });
  });
  req.on('error', reject);
  req.write(body);
  req.end();
});

// ─── Paiement Direct (Sale) ───────────────────────────────────────
/**
 * Débiter une carte Mastercard via MIGS
 */
const processPayment = async ({ amount, currency = '950', tokenId, cardMasked, network, orderId, cardholder = {} }) => {
  // Currency XAF = ISO 4217 code 950
  const currencyCode = currency === 'XAF' ? '950' : currency;
  const amountCents  = String(Math.round(amount * 100)); // MIGS en centimes

  const params = {
    vpc_Version:        '1',
    vpc_Command:        'pay',
    vpc_AccessCode:     CONFIG.accessCode,
    vpc_MerchTxnRef:    orderId,
    vpc_Merchant:       CONFIG.merchantId,
    vpc_OrderInfo:      `CPlus-${orderId}`,
    vpc_Amount:         amountCents,
    vpc_Currency:       currencyCode,
    vpc_ReturnURL:      'https://api.c-pay.global/api/v1/webhooks/migs',
    vpc_card:           tokenId,
    vpc_CardNum:        tokenId,  // Token ou PAN selon config
    vpc_CardExp:        '',       // Géré par token
    vpc_CardSecurityCode: '',
    vpc_Locale:         'fr_FR',
    vpc_gateway:        'ssl',
  };

  // Ajouter signature
  params.vpc_SecureHash     = buildHash(params);
  params.vpc_SecureHashType = 'SHA256';

  const { data } = await request(params);

  const responseCode = data.vpc_TxnResponseCode;
  const success      = responseCode === '0';

  if (!success) {
    const err = new Error(data.vpc_Message || `MIGS declined: ${responseCode}`);
    err.statusCode  = 402;
    err.migsCode    = responseCode;
    throw err;
  }

  return {
    success:       true,
    transactionId: data.vpc_TransactionNo,
    authCode:      data.vpc_AuthorizeId,
    status:        'AUTHORIZED',
    cardMasked,
    network,
    amount,
    currency:      'XAF',
    pspRef:        data.vpc_TransactionNo,
    psp:           'migs',
    raw:           data,
  };
};

// ─── Remboursement ────────────────────────────────────────────────
const refund = async ({ transactionId, amount, orderId }) => {
  const params = {
    vpc_Version:     '1',
    vpc_Command:     'refund',
    vpc_AccessCode:  CONFIG.accessCode,
    vpc_Merchant:    CONFIG.merchantId,
    vpc_MerchTxnRef: orderId + '_refund',
    vpc_TransactionNo: transactionId,
    vpc_Amount:      String(Math.round(amount * 100)),
    vpc_User:        CONFIG.merchantId,
    vpc_Password:    CONFIG.secureHash,
  };

  params.vpc_SecureHash     = buildHash(params);
  params.vpc_SecureHashType = 'SHA256';

  const { data } = await request(params);

  return {
    success:  data.vpc_TxnResponseCode === '0',
    refundId: data.vpc_TransactionNo,
    status:   data.vpc_TxnResponseCode === '0' ? 'REFUNDED' : 'FAILED',
    psp:      'migs',
  };
};

module.exports = { processPayment, refund, CONFIG };
