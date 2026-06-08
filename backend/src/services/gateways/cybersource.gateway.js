/**
 * CyberSource REST API Gateway — CPlus 2.0
 *
 * Doc officielle : https://developer.cybersource.com/api-reference-assets/index.html
 * Auth           : HTTP Signature v1 (HMAC-SHA256) — draft-cavage-http-signatures
 * Host sandbox   : apitest.cybersource.com
 * Host prod      : api.cybersource.com
 *
 * Opérations couvertes :
 *   authorizeCard   →  POST /pts/v2/payments
 *   capture         →  POST /pts/v2/payments/{id}/captures
 *   refund          →  POST /pts/v2/payments/{id}/refunds
 *   voidAuth        →  POST /pts/v2/payments/{id}/reversals
 *   processPayment  →  authorize + capture (alias pour card.router)
 *   ping            →  GET  /tss/v2/transactions?count=1
 */
'use strict';

const https  = require('https');
const crypto = require('crypto');
const logger = require('../../config/logger');

// ─── Config dynamique (supporte rotation Vault) ───────────────────
const cfg = () => ({
  host:       process.env.CS_HOST        || 'apitest.cybersource.com',
  merchantId: process.env.CS_MERCHANT_ID,
  apiKeyId:   process.env.CS_API_KEY_ID,
  secretKey:  process.env.CS_SECRET_KEY,   // base64-encoded shared secret
  timeoutMs:  parseInt(process.env.CS_TIMEOUT_MS || '20000'),
});

// ─── HTTP Signature HMAC-SHA256 ──────────────────────────────────
//
// String-to-sign :  LF (\n) entre chaque ligne — jamais \r\n
// Headers signés (POST/PUT)  : host date request-target digest v-c-merchant-id
// Headers signés (GET)       : host date request-target
//
const buildSignatureHeader = (method, path, bodyStr, date) => {
  const c       = cfg();
  const isWrite = ['POST','PUT','PATCH'].includes(method.toUpperCase());

  const digest = isWrite
    ? 'SHA-256=' + crypto.createHash('sha256').update(bodyStr || '', 'utf8').digest('base64')
    : null;

  const signedHeaders = isWrite
    ? 'host date request-target digest v-c-merchant-id'
    : 'host date request-target';

  const lines = [
    `host: ${c.host}`,
    `date: ${date}`,
    `request-target: ${method.toLowerCase()} ${path}`,
    ...(isWrite ? [`digest: ${digest}`, `v-c-merchant-id: ${c.merchantId}`] : []),
  ];

  const sig = crypto
    .createHmac('sha256', Buffer.from(c.secretKey, 'base64'))
    .update(lines.join('\n'), 'utf8')
    .digest('base64');

  return {
    signatureHeader: `keyid="${c.apiKeyId}", algorithm="HmacSHA256", headers="${signedHeaders}", signature="${sig}"`,
    digest,
  };
};

// ─── HTTP client avec retry exponentiel ──────────────────────────
const csRequest = async (method, path, body, retries = 2) => {
  const c       = cfg();
  const date    = new Date().toUTCString();
  const payload = body ? JSON.stringify(body) : null;
  const { signatureHeader, digest } = buildSignatureHeader(method, path, payload, date);

  const headers = {
    'Host':            c.host,
    'Date':            date,
    'Signature':       signatureHeader,
    'Accept':          'application/hal+json;charset=utf-8',
    'Content-Type':    'application/json;charset=utf-8',
    'v-c-merchant-id': c.merchantId,
    'v-c-correlation-id': crypto.randomUUID(),
    ...(digest  ? { 'Digest':         digest }                                : {}),
    ...(payload ? { 'Content-Length': String(Buffer.byteLength(payload)) }    : {}),
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const req = https.request(
          { hostname: c.host, port: 443, path, method, headers, timeout: c.timeoutMs },
          (res) => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
              try   { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
              catch { resolve({ status: res.statusCode, headers: res.headers, body: { _raw: data } }); }
            });
          }
        );
        req.on('timeout', () => { req.destroy(); reject(new Error(`CyberSource timeout (${c.timeoutMs}ms)`)); });
        req.on('error',   reject);
        if (payload) req.write(payload);
        req.end();
      });

      if (result.status >= 500 && attempt < retries) {
        logger.warn(`CyberSource ${result.status} → retry ${attempt + 1}/${retries}`);
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      return result;

    } catch (err) {
      if (attempt < retries) {
        logger.warn(`CyberSource network error → retry ${attempt + 1}/${retries}`, { err: err.message });
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }
};

// ─── AUTHORIZE ────────────────────────────────────────────────────
const authorizeCard = async ({
  txnId, amount, currency, terminalId,
  sdkPayload,               // cryptogramme EMV chiffré par le SDK Visa TTP
  paymentSolution = '006',  // 006 = Visa TTP CPoC  |  014 = MC Tap-to-Pay
  merchantName,
}) => {
  logger.info('CyberSource AUTHORIZE', { txnId, amount, currency, paymentSolution });

  const body = {
    clientReferenceInformation: {
      code: txnId,
      partner: { solutionId: 'CPLUS_V2' },
    },
    processingInformation: {
      commerceIndicator: 'tap',
      paymentSolution,
      ...(process.env.NODE_ENV !== 'production' ? { actionList: ['DECISION_SKIP'] } : {}),
    },
    orderInformation: {
      amountDetails: { totalAmount: amount.toFixed(2), currency },
    },
    pointOfSaleInformation: {
      terminalId:           terminalId || 'CPLUS001',
      terminalModel:        'COTS',
      terminalCapability:   '4',
      terminalInputCapability: '5',
      entryMode:            'C',
      catLevel:             '1',
      emvApplicationData:   sdkPayload,
    },
    ...(merchantName ? {
      merchantInformation: {
        merchantDescriptor: { name: merchantName },
        categoryCode: '5999',
      },
    } : {}),
  };

  try {
    const { status, body: resp, headers } = await csRequest('POST', '/pts/v2/payments', body);
    logger.debug('CyberSource AUTHORIZE response', { txnId, status, csStatus: resp.status, csId: resp.id });
    return mapResponse(resp, status, txnId);
  } catch (err) {
    logger.error('CyberSource AUTHORIZE failed', { txnId, err: err.message });
    return networkError();
  }
};

// ─── CAPTURE ──────────────────────────────────────────────────────
const capture = async ({ txnId, csPaymentId, amount, currency }) => {
  if (!csPaymentId) return { approved: false, responseCode: '05', message: 'csPaymentId manquant' };
  logger.info('CyberSource CAPTURE', { txnId, csPaymentId, amount });
  try {
    const { status, body } = await csRequest(
      'POST', `/pts/v2/payments/${csPaymentId}/captures`,
      { clientReferenceInformation: { code: `CAP-${txnId}` },
        orderInformation: { amountDetails: { totalAmount: amount.toFixed(2), currency } } }
    );
    const ok = [200, 201].includes(status) && ['PENDING','SUCCEEDED'].includes(body.status);
    return { approved: ok, responseCode: body.processorInformation?.responseCode || (ok ? '00' : '05'),
             gatewayRef: body.id || csPaymentId, message: body.status };
  } catch (err) { return networkError(); }
};

// ─── REFUND ───────────────────────────────────────────────────────
const refund = async ({ txnId, csPaymentId, amount, currency }) => {
  if (!csPaymentId) return { approved: false, responseCode: '05', message: 'csPaymentId requis pour le remboursement' };
  logger.info('CyberSource REFUND', { txnId, csPaymentId, amount });
  try {
    const { status, body } = await csRequest(
      'POST', `/pts/v2/payments/${csPaymentId}/refunds`,
      { clientReferenceInformation: { code: `REF-${txnId}` },
        orderInformation: { amountDetails: { totalAmount: amount.toFixed(2), currency } } }
    );
    const ok = [200, 201].includes(status) && ['PENDING','SUCCEEDED'].includes(body.status);
    return { approved: ok, responseCode: body.processorInformation?.responseCode || (ok ? '00' : '05'),
             gatewayRef: body.id, message: body.status };
  } catch (err) { return networkError(); }
};

// ─── VOID (reversal) ──────────────────────────────────────────────
const voidAuth = async ({ txnId, csPaymentId, amount, currency }) => {
  if (!csPaymentId) return { approved: false, responseCode: '05', message: 'csPaymentId requis' };
  logger.info('CyberSource VOID', { txnId, csPaymentId });
  try {
    const { status, body } = await csRequest(
      'POST', `/pts/v2/payments/${csPaymentId}/reversals`,
      { clientReferenceInformation: { code: `VOID-${txnId}` },
        orderInformation: { amountDetails: { totalAmount: amount.toFixed(2), currency } },
        reversalInformation: { amountDetails: { totalAmount: amount.toFixed(2), currency }, reason: 'VOID' } }
    );
    const ok = [200, 201].includes(status);
    return { approved: ok, responseCode: body.reversal?.processorInformation?.responseCode || (ok ? '00' : '05'),
             gatewayRef: body.id };
  } catch (err) { return networkError(); }
};

// ─── PING ─────────────────────────────────────────────────────────
const ping = async () => {
  if (!cfg().merchantId) return { ok: false, reason: 'not_configured' };
  try {
    const { status } = await csRequest('GET', '/tss/v2/transactions?count=1', null);
    return { ok: status < 400, status };
  } catch (err) { return { ok: false, reason: err.message }; }
};

// ─── Alias pour card.router ────────────────────────────────────────
const processPayment = async ({ txnId, amount, currency, emvPayload, network, type, deviceId }) => {
  const ps = network === 'MASTERCARD' ? '014' : '006';
  return authorizeCard({ txnId, amount, currency, terminalId: deviceId, sdkPayload: emvPayload, paymentSolution: ps });
};

// ─── Response mapper ──────────────────────────────────────────────
const mapResponse = (body, httpStatus, txnId) => {
  const approved   = body.status === 'AUTHORIZED';
  const proc       = body.processorInformation || {};
  const errInfo    = body.errorInformation     || {};
  const card       = body.paymentAccountInformation?.card || {};
  const respCode   = proc.responseCode || (approved ? '00' : errInfo.details?.[0]?.field?.includes('FUNDS') ? '51' : '05');
  const maskedPan  = card.prefix && card.suffix
    ? `${card.prefix}${'*'.repeat(Math.max(0, 16 - card.prefix.length - card.suffix.length))}${card.suffix}`
    : null;

  return {
    approved,
    responseCode:    respCode,
    message:         proc.responseCodeSource || body.status || 'UNKNOWN',
    authCode:        proc.approvalCode                   || null,
    rrn:             proc.retrievalReferenceNumber       || null,
    maskedPan,
    cardScheme:      card.type                           || null,
    gatewayRef:      body.id                             || null,
    csPaymentId:     body.id                             || null,
    declineCategory: approved ? null : mapDeclineCode(respCode),
    retryable:       ['96','91'].includes(respCode),
    balanceCheck:    respCode === '51' ? 'insufficient' : 'not_checked',
  };
};

const mapDeclineCode = (code) => ({
  '51': 'insufficient_funds', '54': 'card_expired',
  '05': 'do_not_honor', '41': 'lost_card', '43': 'stolen_card',
  '96': 'network_error', '91': 'network_error',
}[code] || 'unknown');

const networkError = () => ({
  approved: false, responseCode: '96', message: 'CyberSource unavailable',
  authCode: null, maskedPan: null, csPaymentId: null,
  declineCategory: 'network_error', retryable: true, balanceCheck: 'check_failed',
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { processPayment, authorizeCard, capture, refund, voidAuth, ping };
