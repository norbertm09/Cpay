/**
 * Stripe Gateway — CPlus 2.6.0
 *
 * Doc  : https://stripe.com/docs/api
 * Auth : Bearer sk_live_... / sk_test_...
 *
 * Deux modes selon le payload reçu :
 *   Mode 1 — Terminal (carte présente / NFC)  :  PaymentIntents + payment_method_data EMV
 *   Mode 2 — Pay Link / QR                   :  PaymentIntents avec redirect
 *
 * Opérations :
 *   processPayment  →  createPaymentIntent (alias card.router)
 *   createIntent    →  POST /v1/payment_intents
 *   confirmIntent   →  POST /v1/payment_intents/{id}/confirm
 *   captureIntent   →  POST /v1/payment_intents/{id}/capture
 *   cancelIntent    →  POST /v1/payment_intents/{id}/cancel
 *   refundCharge    →  POST /v1/refunds
 *   ping            →  GET  /v1/balance
 */
'use strict';

const https  = require('https');
const crypto = require('crypto');
const logger = require('../../config/logger');

// ─── Config dynamique ─────────────────────────────────────────────
const cfg = () => ({
  secretKey:  process.env.STRIPE_SECRET_KEY,
  timeoutMs:  parseInt(process.env.STRIPE_TIMEOUT_MS || '20000'),
  host:       'api.stripe.com',
});

// ─── HTTP client Stripe ───────────────────────────────────────────
// Stripe utilise application/x-www-form-urlencoded (pas JSON)
const stripeRequest = async (method, path, params, retries = 2) => {
  const c = cfg();

  const toFormData = (obj, prefix = '') => {
    const parts = [];
    for (const [k, v] of Object.entries(obj || {})) {
      const key = prefix ? `${prefix}[${k}]` : k;
      if (v !== null && v !== undefined) {
        if (typeof v === 'object' && !Array.isArray(v)) {
          parts.push(...toFormData(v, key));
        } else if (Array.isArray(v)) {
          v.forEach((item, i) => {
            if (typeof item === 'object') parts.push(...toFormData(item, `${key}[${i}]`));
            else parts.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`);
          });
        } else {
          parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
        }
      }
    }
    return parts;
  };

  const payload = params ? toFormData(params).join('&') : null;

  const headers = {
    'Authorization': `Bearer ${c.secretKey}`,
    'Content-Type':  'application/x-www-form-urlencoded',
    'Stripe-Version': '2023-10-16',
    'Idempotency-Key': crypto.randomUUID(),
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
              catch { resolve({ status: res.statusCode, body: {} }); }
            });
          }
        );
        req.on('timeout', () => { req.destroy(); reject(new Error(`Stripe timeout (${c.timeoutMs}ms)`)); });
        req.on('error',   reject);
        if (payload) req.write(payload);
        req.end();
      });

      // 429 = rate limit, 5xx = server error → retry
      if ((result.status === 429 || result.status >= 500) && attempt < retries) {
        const waitMs = result.status === 429 ? 2000 : 500 * Math.pow(2, attempt);
        logger.warn(`Stripe ${result.status} → retry ${attempt + 1}/${retries} in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }
      return result;

    } catch (err) {
      if (attempt < retries) { await sleep(500 * Math.pow(2, attempt)); continue; }
      throw err;
    }
  }
};

// ─── CREATE PAYMENT INTENT ────────────────────────────────────────
const createIntent = async ({
  txnId, amount, currency,
  paymentMethodTypes = ['card'],
  captureMethod = 'automatic',
  description,
  metadata = {},
}) => {
  logger.info('Stripe createIntent', { txnId, amount, currency });

  try {
    const { status, body } = await stripeRequest('POST', '/v1/payment_intents', {
      amount:              Math.round(amount * 100),  // Stripe en centimes
      currency:            currency.toLowerCase(),
      payment_method_types: paymentMethodTypes,
      capture_method:      captureMethod,
      description:         description || 'CPlus 2.6.0',
      metadata:            { internal_txn_id: txnId, ...metadata },
    });

    if ([200, 201].includes(status)) {
      return {
        success:         true,
        intentId:        body.id,
        clientSecret:    body.client_secret,
        status:          body.status,
        amount:          body.amount / 100,
        currency:        body.currency?.toUpperCase(),
      };
    }
    return { success: false, error: body.error?.message || 'Stripe intent failed' };
  } catch (err) { return { success: false, error: err.message }; }
};

// ─── CONFIRM INTENT (carte présente NFC) ─────────────────────────
const confirmIntent = async ({ intentId, txnId, emvPayload, deviceId }) => {
  logger.info('Stripe confirmIntent', { txnId, intentId });

  try {
    const { status, body } = await stripeRequest(
      'POST', `/v1/payment_intents/${intentId}/confirm`,
      {
        payment_method_data: {
          type:   'card_present',
          card_present: {
            emv_auth_data: emvPayload,  // données EMV du lecteur NFC
          },
        },
      }
    );

    return mapIntentResponse(body, status, txnId);
  } catch (err) {
    logger.error('Stripe confirmIntent failed', { txnId, err: err.message });
    return networkError();
  }
};

// ─── CAPTURE (si capture_method = manual) ────────────────────────
const captureIntent = async ({ intentId, txnId, amountToCapture }) => {
  logger.info('Stripe captureIntent', { txnId, intentId });
  try {
    const params = amountToCapture ? { amount_to_capture: Math.round(amountToCapture * 100) } : {};
    const { status, body } = await stripeRequest('POST', `/v1/payment_intents/${intentId}/capture`, params);
    const ok = body.status === 'succeeded';
    return { approved: ok, responseCode: ok ? '00' : '05', gatewayRef: body.id, chargeId: body.latest_charge };
  } catch (err) { return networkError(); }
};

// ─── CANCEL / VOID ────────────────────────────────────────────────
const cancelIntent = async ({ intentId, txnId }) => {
  logger.info('Stripe cancelIntent', { txnId, intentId });
  try {
    const { body } = await stripeRequest('POST', `/v1/payment_intents/${intentId}/cancel`, {});
    const ok = body.status === 'canceled';
    return { approved: ok, responseCode: ok ? '00' : '05' };
  } catch (err) { return networkError(); }
};

// ─── REFUND ───────────────────────────────────────────────────────
const refundCharge = async ({ txnId, stripePaymentIntentId, amount, currency }) => {
  if (!stripePaymentIntentId) return { approved: false, responseCode: '05', message: 'stripePaymentIntentId requis' };
  logger.info('Stripe REFUND', { txnId, stripePaymentIntentId, amount });
  try {
    const { status, body } = await stripeRequest('POST', '/v1/refunds', {
      payment_intent:      stripePaymentIntentId,
      ...(amount ? { amount: Math.round(amount * 100) } : {}),
      metadata: { internal_txn_id: txnId },
    });
    const ok = [200, 201].includes(status) && body.status === 'succeeded';
    return { approved: ok, responseCode: ok ? '00' : '05', gatewayRef: body.id };
  } catch (err) { return networkError(); }
};

// ─── PING ─────────────────────────────────────────────────────────
const ping = async () => {
  if (!cfg().secretKey) return { ok: false, reason: 'not_configured' };
  try {
    const { status, body } = await stripeRequest('GET', '/v1/balance', null);
    return { ok: status === 200, mode: body.livemode ? 'live' : 'test', status };
  } catch (err) { return { ok: false, reason: err.message }; }
};

// ─── Alias card.router ────────────────────────────────────────────
const processPayment = async ({ txnId, amount, currency, emvPayload, network, type, deviceId, description }) => {
  // Créer l'intent puis confirmer avec le payload EMV
  const intent = await createIntent({ txnId, amount, currency, description });
  if (!intent.success) return { approved: false, responseCode: '05', message: intent.error };
  return confirmIntent({ intentId: intent.intentId, txnId, emvPayload, deviceId });
};

// ─── Response mapper ──────────────────────────────────────────────
const mapIntentResponse = (body, httpStatus, txnId) => {
  const approved  = body.status === 'succeeded' || body.status === 'requires_capture';
  const charge    = body.charges?.data?.[0] || {};
  const outcome   = charge.outcome || {};
  const respCode  = approved ? '00' : STRIPE_DECLINE_MAP[charge.failure_code] || '05';

  return {
    approved,
    responseCode:    respCode,
    message:         outcome.seller_message || body.status || 'UNKNOWN',
    authCode:        charge.authorization_code || null,
    maskedPan:       charge.payment_method_details?.card?.last4
                       ? `**** **** **** ${charge.payment_method_details.card.last4}` : null,
    cardScheme:      charge.payment_method_details?.card?.brand?.toUpperCase() || null,
    gatewayRef:      body.id || null,
    stripePaymentIntentId: body.id || null,
    declineCategory: approved ? null : (charge.failure_code ? STRIPE_CATEGORY_MAP[charge.failure_code] : 'unknown'),
    retryable:       !approved && ['do_not_honor', 'insufficient_funds'].includes(charge.failure_code),
    balanceCheck:    charge.failure_code === 'insufficient_funds' ? 'insufficient' : 'not_checked',
  };
};

const STRIPE_DECLINE_MAP = {
  insufficient_funds:     '51',
  card_declined:          '05',
  expired_card:           '54',
  incorrect_cvc:          '82',
  lost_card:              '41',
  stolen_card:            '43',
  do_not_honor:           '05',
  processing_error:       '96',
};

const STRIPE_CATEGORY_MAP = {
  insufficient_funds: 'insufficient_funds',
  expired_card:       'card_expired',
  lost_card:          'card_blocked',
  stolen_card:        'card_blocked',
  processing_error:   'network_error',
};

const networkError = () => ({
  approved: false, responseCode: '96', message: 'Stripe unavailable',
  authCode: null, maskedPan: null, stripePaymentIntentId: null,
  declineCategory: 'network_error', retryable: true, balanceCheck: 'check_failed',
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { processPayment, createIntent, confirmIntent, captureIntent, cancelIntent, refundCharge, ping };
