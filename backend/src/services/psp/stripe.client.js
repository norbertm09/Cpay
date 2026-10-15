'use strict';
// ================================================================
// CPlus 2.6 — Stripe Payment Client
// Fallback toutes cartes / cartes non-Visa/MC
// ================================================================

const https = require('https');

const CONFIG = {
  secretKey: process.env.STRIPE_SECRET_KEY || '',
  sandbox:   process.env.STRIPE_SANDBOX !== 'false',
  baseUrl:   'api.stripe.com',
};

// ─── HTTP Request Stripe ──────────────────────────────────────────
const request = (method, path, body) => new Promise((resolve, reject) => {
  const payload = body
    ? Object.entries(body).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')
    : null;

  const headers = {
    'Authorization': `Bearer ${CONFIG.secretKey}`,
    'Content-Type':  'application/x-www-form-urlencoded',
    'Stripe-Version': '2023-10-16',
  };
  if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

  const req = https.request({
    hostname: CONFIG.baseUrl,
    path:     `/v1${path}`,
    method,
    headers,
    rejectUnauthorized: true,
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(d); } catch { parsed = d; }
      if (res.statusCode >= 400) {
        const err = new Error(parsed?.error?.message || `Stripe HTTP ${res.statusCode}`);
        err.statusCode    = res.statusCode;
        err.stripeCode    = parsed?.error?.code;
        err.stripeResponse = parsed;
        return reject(err);
      }
      resolve({ status: res.statusCode, data: parsed });
    });
  });
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
});

// ─── Paiement via Payment Intent ─────────────────────────────────
/**
 * Débiter une carte via Stripe
 * Le token Stripe (pm_xxx) est créé côté frontend avec Stripe.js
 */
const processPayment = async ({ amount, currency = 'xaf', tokenId, cardMasked, network, orderId, cardholder = {} }) => {
  // XAF = devise sans centimes (zero-decimal currency)
  const stripeAmount = Math.round(amount); // XAF pas de centimes
  const stripeCurrency = currency.toLowerCase();

  // 1. Créer Payment Intent
  const { data: pi } = await request('POST', '/payment_intents', {
    amount:               stripeAmount,
    currency:             stripeCurrency,
    payment_method:       tokenId,   // pm_xxx créé par Stripe.js
    confirm:              'true',
    return_url:           'https://app.c-pay.global/payment/complete',
    metadata_order_id:    orderId,
    'metadata[cplus_txn]': orderId,
    description:          `C-Pay Payment ${orderId}`,
    receipt_email:        cardholder.email || undefined,
  });

  const success = ['succeeded', 'processing'].includes(pi.status);

  if (!success && pi.status !== 'requires_action') {
    const err = new Error(`Stripe payment failed: ${pi.status}`);
    err.statusCode = 402;
    throw err;
  }

  return {
    success:       pi.status === 'succeeded',
    transactionId: pi.id,
    authCode:      pi.latest_charge,
    status:        pi.status === 'succeeded' ? 'AUTHORIZED' : 'PENDING_3DS',
    clientSecret:  pi.client_secret,     // Pour 3DS si nécessaire
    requiresAction: pi.status === 'requires_action',
    nextAction:    pi.next_action,
    cardMasked,
    network,
    amount,
    currency:      'XAF',
    pspRef:        pi.id,
    psp:           'stripe',
    raw:           pi,
  };
};

// ─── Remboursement ────────────────────────────────────────────────
const refund = async ({ transactionId, amount, orderId }) => {
  const { data } = await request('POST', '/refunds', {
    payment_intent: transactionId,
    amount:         String(Math.round(amount)),
    reason:         'requested_by_customer',
    metadata_order_id: orderId,
  });

  return {
    success:  data.status === 'succeeded',
    refundId: data.id,
    status:   data.status === 'succeeded' ? 'REFUNDED' : 'PENDING',
    psp:      'stripe',
  };
};

// ─── Créer Customer + enregistrer carte ──────────────────────────
const createCustomer = async ({ email, name, metadata = {} }) => {
  const { data } = await request('POST', '/customers', { email, name, ...metadata });
  return { customerId: data.id };
};

// ─── Attacher Payment Method à Customer ──────────────────────────
const attachPaymentMethod = async (paymentMethodId, customerId) => {
  const { data } = await request('POST', `/payment_methods/${paymentMethodId}/attach`, {
    customer: customerId,
  });
  return data;
};

module.exports = { processPayment, refund, createCustomer, attachPaymentMethod, CONFIG };
