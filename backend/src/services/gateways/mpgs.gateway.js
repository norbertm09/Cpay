/**
 * Mastercard Payment Gateway Services (MPGS) — CPlus 2.6.0
 *
 * Doc     : https://ap-gateway.mastercard.com/api/documentation/
 * Auth    : Basic  →  merchant.{merchantId}:{apiPassword}
 * Base    : /api/rest/version/{version}/merchant/{merchantId}/
 *
 * Hôtes :
 *   Test       : mtf.gateway.mastercard.com
 *   Prod AP/AF : ap-gateway.mastercard.com
 *   Prod EU    : eu-gateway.mastercard.com
 *   Prod NA    : na-gateway.mastercard.com
 *
 * Opérations :
 *   processPayment  →  AUTHORIZE (alias card.router)
 *   authorizeCard   →  PUT order/{orderId}/transaction/{txnId}  apiOperation:AUTHORIZE
 *   capture         →  PUT order/{orderId}/transaction/{capId}  apiOperation:CAPTURE
 *   refund          →  PUT order/{orderId}/transaction/{refId}  apiOperation:REFUND
 *   voidAuth        →  PUT order/{orderId}/transaction/{vId}    apiOperation:VOID
 *   getOrder        →  GET order/{orderId}
 *   ping            →  GET merchant/{merchantId}
 */
'use strict';

const https  = require('https');
const crypto = require('crypto');
const logger = require('../../config/logger');

// ─── Config dynamique ─────────────────────────────────────────────
const cfg = () => {
  const host       = process.env.MPGS_HOST     || 'mtf.gateway.mastercard.com';
  const merchantId = process.env.MPGS_MERCHANT_ID;
  const apiPass    = process.env.MPGS_API_PASSWORD;
  const version    = process.env.MPGS_API_VERSION || '61';

  return {
    host, merchantId, version,
    basePath:   `/api/rest/version/${version}/merchant/${merchantId}`,
    authHeader: 'Basic ' + Buffer.from(`merchant.${merchantId}:${apiPass}`).toString('base64'),
    timeoutMs:  parseInt(process.env.MPGS_TIMEOUT_MS || '20000'),
  };
};

// ─── HTTP client avec retry ───────────────────────────────────────
const mpgsRequest = async (method, resource, body, retries = 2) => {
  const c       = cfg();
  const path    = `${c.basePath}/${resource}`;
  const payload = body ? JSON.stringify(body) : null;

  const headers = {
    'Authorization':  c.authHeader,   // recalculé à chaque appel (rotation support)
    'Content-Type':   'application/json;charset=utf-8',
    'Accept':         'application/json',
    'X-Correlation-ID': crypto.randomUUID(),
    ...(payload ? { 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
  };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await new Promise((resolve, reject) => {
        const req = https.request(
          { hostname: c.host, port: 443, path, method, headers, timeout: c.timeoutMs },
          (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
              try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
              catch { resolve({ status: res.statusCode, body: { _raw: data } }); }
            });
          }
        );
        req.on('timeout', () => { req.destroy(); reject(new Error(`MPGS timeout (${c.timeoutMs}ms)`)); });
        req.on('error',   reject);
        if (payload) req.write(payload);
        req.end();
      });

      if (result.status >= 500 && attempt < retries) {
        logger.warn(`MPGS ${result.status} → retry ${attempt + 1}/${retries}`);
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      return result;

    } catch (err) {
      if (attempt < retries) {
        logger.warn(`MPGS network error → retry ${attempt + 1}/${retries}`, { err: err.message });
        await sleep(500 * Math.pow(2, attempt));
        continue;
      }
      throw err;
    }
  }
};

// ─── AUTHORIZE ────────────────────────────────────────────────────
const authorizeCard = async ({
  txnId, amount, currency, terminalId, sdkPayload, merchantName,
}) => {
  const orderId  = `ORD-${txnId}`;
  const mpgsTxnId = `TXN-${txnId}`;
  logger.info('MPGS AUTHORIZE', { txnId, orderId, amount, currency });

  try {
    const { status, body } = await mpgsRequest(
      'PUT', `order/${orderId}/transaction/${mpgsTxnId}`,
      {
        apiOperation: 'AUTHORIZE',
        order: {
          amount:    amount.toFixed(2),
          currency,
          reference: txnId,
          ...(merchantName ? { merchantCategoryCode: '5999' } : {}),
        },
        transaction: { reference: txnId },
        sourceOfFunds: { type: 'CARD' },
        device: {
          type: 'POS',
          terminal: {
            id:          terminalId || 'CPLUS001',
            capability:  'CHIP_AND_CONTACTLESS',
            inputMethod: 'CONTACTLESS_EMV',
          },
        },
        pos: {
          lane: { id: terminalId || 'CPLUS001' },
          emv: { applicationData: sdkPayload },
        },
        authentication: { authenticationType: 'NOT_AUTHENTICATED' },
      }
    );

    logger.debug('MPGS AUTHORIZE response', { txnId, status, result: body.result });
    return { ...mapResponse(body, status), mpgsOrderId: orderId, mpgsTxnId };

  } catch (err) {
    logger.error('MPGS AUTHORIZE failed', { txnId, err: err.message });
    return networkError();
  }
};

// ─── CAPTURE ──────────────────────────────────────────────────────
const capture = async ({ txnId, mpgsOrderId, amount, currency }) => {
  if (!mpgsOrderId) return { approved: false, responseCode: '05', message: 'mpgsOrderId requis' };
  const captureId = `CAP-${Date.now()}`;
  logger.info('MPGS CAPTURE', { txnId, mpgsOrderId, amount });
  try {
    const { body } = await mpgsRequest(
      'PUT', `order/${mpgsOrderId}/transaction/${captureId}`,
      { apiOperation: 'CAPTURE', transaction: { amount: amount.toFixed(2), currency } }
    );
    const ok = body.result === 'SUCCESS';
    return { approved: ok, responseCode: body.response?.gatewayCode || (ok ? '00' : '05'),
             gatewayRef: body.transaction?.id, message: body.result };
  } catch (err) { return networkError(); }
};

// ─── REFUND ───────────────────────────────────────────────────────
const refund = async ({ txnId, mpgsOrderId, amount, currency }) => {
  if (!mpgsOrderId) return { approved: false, responseCode: '05', message: 'mpgsOrderId requis' };
  const refundId = `REF-${Date.now()}`;
  logger.info('MPGS REFUND', { txnId, mpgsOrderId, amount });
  try {
    const { body } = await mpgsRequest(
      'PUT', `order/${mpgsOrderId}/transaction/${refundId}`,
      { apiOperation: 'REFUND', transaction: { amount: amount.toFixed(2), currency } }
    );
    const ok = body.result === 'SUCCESS';
    return { approved: ok, responseCode: body.response?.gatewayCode || (ok ? '00' : '05'),
             gatewayRef: body.transaction?.id };
  } catch (err) { return networkError(); }
};

// ─── VOID ─────────────────────────────────────────────────────────
const voidAuth = async ({ txnId, mpgsOrderId, mpgsTxnId }) => {
  if (!mpgsOrderId || !mpgsTxnId) return { approved: false, responseCode: '05', message: 'mpgsOrderId + mpgsTxnId requis' };
  const voidId = `VOID-${Date.now()}`;
  logger.info('MPGS VOID', { txnId, mpgsOrderId, mpgsTxnId });
  try {
    const { body } = await mpgsRequest(
      'PUT', `order/${mpgsOrderId}/transaction/${voidId}`,
      { apiOperation: 'VOID', transaction: { targetTransactionId: mpgsTxnId } }
    );
    const ok = body.result === 'SUCCESS';
    return { approved: ok, responseCode: body.response?.gatewayCode || (ok ? '00' : '05') };
  } catch (err) { return networkError(); }
};

// ─── GET ORDER ────────────────────────────────────────────────────
const getOrder = async (mpgsOrderId) => {
  try {
    const { status, body } = await mpgsRequest('GET', `order/${mpgsOrderId}`);
    return { found: status === 200, status: body.status, result: body.result, amount: body.amount, currency: body.currency };
  } catch (err) { return { found: false }; }
};

// ─── HOSTED CHECKOUT — MPGS Hosted Checkout, mode redirection (WAVE-4 caisse) ──
// INITIATE_CHECKOUT crée une session ; le client est redirigé vers la page de paiement
// hébergée par Mastercard (/checkout/pay/{session.id}). Au retour, resultIndicator ===
// successIndicator indique un succès, confirmé côté serveur par getOrder(orderId).
const hostedConfigured = () => !!(process.env.MPGS_MERCHANT_ID && process.env.MPGS_API_PASSWORD);

const createHostedCheckout = async ({ orderId, amount, currency, description, returnUrl, cancelUrl, merchantName }) => {
  if (!hostedConfigured()) return { ok: false, reason: 'not_configured' };
  const c = cfg();
  try {
    const { status, body } = await mpgsRequest('POST', 'session', {
      apiOperation: 'INITIATE_CHECKOUT',
      checkoutMode: 'PAYMENT_LINK',
      interaction: {
        operation: 'PURCHASE',
        returnUrl, cancelUrl: cancelUrl || returnUrl,
        merchant: { name: String(merchantName || 'C-Pay').slice(0, 40) },
        displayControl: { billingAddress: 'HIDE' },
      },
      order: { id: orderId, amount: String(amount), currency, description: String(description || orderId).slice(0, 127) },
    });
    const sessionId = body?.session?.id;
    if (status >= 300 || !sessionId || body?.result !== 'SUCCESS') {
      logger.warn('MPGS INITIATE_CHECKOUT failed', { orderId, status, result: body?.result, error: body?.error });
      return { ok: false, reason: body?.error?.explanation || body?.error?.cause || `HTTP ${status}` };
    }
    return {
      ok: true, sessionId, successIndicator: body.successIndicator || null,
      redirectUrl: `https://${c.host}/checkout/pay/${encodeURIComponent(sessionId)}?checkoutVersion=1.0.0`, orderId,
    };
  } catch (err) {
    logger.error('MPGS INITIATE_CHECKOUT error', { orderId, err: err.message });
    return { ok: false, reason: err.message };
  }
};

// ─── PING ─────────────────────────────────────────────────────────
const ping = async () => {
  if (!cfg().merchantId) return { ok: false, reason: 'not_configured' };
  try {
    const { status, body } = await mpgsRequest('GET', '');
    return { ok: status < 400, status, merchantStatus: body.merchant?.status };
  } catch (err) { return { ok: false, reason: err.message }; }
};

// ─── Alias card.router ────────────────────────────────────────────
const processPayment = async ({ txnId, amount, currency, emvPayload, network, type, deviceId }) =>
  authorizeCard({ txnId, amount, currency, terminalId: deviceId, sdkPayload: emvPayload });

// ─── Response mapper ──────────────────────────────────────────────
const mapResponse = (body, httpStatus) => {
  const approved  = body.result === 'SUCCESS';
  const gwCode    = body.response?.gatewayCode  || '';
  const acqCode   = body.response?.acquirerCode || '';
  const respCode  = acqCode || gwCode || (approved ? '00' : '05');
  const card      = body.sourceOfFunds?.provided?.card || {};

  return {
    approved,
    responseCode:    respCode,
    message:         body.response?.acquirerMessage || gwCode || body.result || 'UNKNOWN',
    authCode:        body.transaction?.authorizationCode || null,
    rrn:             body.transaction?.id                || null,
    maskedPan:       card.number                         || null,
    cardScheme:      card.brand                          || null,
    gatewayRef:      body.transaction?.id                || null,
    declineCategory: approved ? null : mapDeclineCode(respCode),
    retryable:       ['96', 'SYSTEM_ERROR'].includes(respCode),
    balanceCheck:    respCode === '51' || gwCode === 'DECLINED' ? 'insufficient' : 'not_checked',
  };
};

const mapDeclineCode = (code) => ({
  '51': 'insufficient_funds', '54': 'card_expired',
  '05': 'do_not_honor', 'DECLINED': 'do_not_honor',
  '96': 'network_error', 'SYSTEM_ERROR': 'network_error',
}[code] || 'unknown');

const networkError = () => ({
  approved: false, responseCode: '96', message: 'MPGS unavailable',
  authCode: null, maskedPan: null, mpgsOrderId: null, mpgsTxnId: null,
  declineCategory: 'network_error', retryable: true, balanceCheck: 'check_failed',
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { processPayment, authorizeCard, capture, refund, voidAuth, getOrder, ping, createHostedCheckout, hostedConfigured };
