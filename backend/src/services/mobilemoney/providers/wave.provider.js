/**
 * Wave Provider — Sénégal, Côte d'Ivoire
 * API : Wave Business API (wave.com/en/business)
 * Auth : Bearer API Key
 * Note : Wave utilise un modèle de paiement par checkout URL ou API directe
 */
'use strict';
const https  = require('https');
const logger = require('../../../config/logger');
// WAVE-2 : success_url / error_url sont des redirections NAVIGATEUR (client final) — jamais le
// chemin secret. Le vrai webhook Wave (signé Wave-Signature) est configuré côté portail Wave
// Business sur /api/v1/webhooks/<WEBHOOK_PATH_SECRET>/wave (voir routes/webhooks-mm.routes.js).

const collectPayment = async ({ txnId, amount, currency, phone, description, config }) => {
  logger.info('Wave collectPayment', { txnId, amount, currency });
  if (!config.apiKey) throw new Error('Wave API key not configured');

  // Wave Business API — initier un paiement
  const r = await req('POST', config.baseUrl || 'https://api.wave.com', '/v1/checkout/sessions',
    {
      currency,
      amount:      String(amount),
      error_url:   `${process.env.API_BASE_URL}/webhooks/wave/error/${txnId}`,
      success_url: `${process.env.API_BASE_URL}/webhooks/wave/success/${txnId}`,
      client_reference: txnId,
      ...(phone ? { receive_amount: String(amount), send_amount: String(amount), customer_mobile_number: phone.replace('+', '') } : {}),
    },
    { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }
  );

  if (r.status === 200 && r.body?.id) {
    // Wave crée une session — le paiement est confirmé via webhook
    return {
      success:     null,   // asynchrone
      pending:     true,
      sessionId:   r.body.id,
      checkoutUrl: r.body.wave_launch_url,
      externalId:  txnId,
    };
  }
  return { success: false, errorMessage: r.body?.message || 'Wave payment failed' };
};

const sendPayout = async ({ txnId, amount, currency, phone, config }) => {
  logger.info('Wave sendPayout', { txnId, amount });
  if (!config.apiKey) throw new Error('Wave API key not configured');

  // Wave P2B transfer (Business to customer)
  const r = await req('POST', config.baseUrl || 'https://api.wave.com', '/v1/business2client/transfer',
    {
      currency, amount: String(amount),
      receive_amount:  String(amount),
      mobile:          phone.replace('+', ''),
      client_reference: txnId,
      description:     'CPlus 2.6.0 retrait',
    },
    { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' }
  );
  const ok = r.status === 200 && r.body?.status === 'succeeded';
  return { success: ok, transactionId: r.body?.id, errorMessage: ok ? null : (r.body?.message || 'Wave payout failed') };
};

const req = (method, base, path, body, headers) => new Promise((resolve, reject) => {
  const u = new URL(base + path);
  const p = body ? JSON.stringify(body) : null;
  const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname, method,
    headers: { ...headers, ...(p ? { 'Content-Length': Buffer.byteLength(p) } : {}) }, timeout: 20000 },
    (res) => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => {
      try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: {} }); }
    }); });
  r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('Wave timeout')); });
  if (p) r.write(p); r.end();
});

module.exports = { collectPayment, sendPayout };
