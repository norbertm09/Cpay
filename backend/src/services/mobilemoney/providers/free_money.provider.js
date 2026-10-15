/**
 * Free Money Provider — Sénégal
 * API : Free Sénégal Business API (Free Money)
 * Auth : OAuth2 client_credentials
 */
'use strict';
const https  = require('https');
const logger = require('../../../config/logger');
const DEFAULT_BASE = 'https://api.free.sn';
// WAVE-2 : URL de callback secrète (/api/v1/webhooks/<WEBHOOK_PATH_SECRET>/<provider>)
const { webhookUrl } = require('../mobilemoney.router');

const getToken = async (config) => {
  const creds = Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString('base64');
  const r = await req('POST', config.baseUrl || 'https://api.free.sn',
    '/oauth/token', 'grant_type=client_credentials',
    { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' }
  );
  return r.body?.access_token;
};

const collectPayment = async ({ txnId, amount, currency, phone, description, config }) => {
  logger.info('Free Money collectPayment', { txnId, amount, currency });
  if (!config.apiKey) throw new Error('Free Money API key not configured');

  const token = await getToken(config);
  const r = await req('POST', config.baseUrl || 'https://api.free.sn',
    '/v1/payment/request',
    {
      merchantId:  config.merchantId || config.apiKey,
      msisdn:      phone.replace('+221', '').replace('+', ''),
      amount:      String(amount),
      currency:    currency || 'XOF',
      orderId:     txnId,
      description: description || 'C-Pay',
      callbackUrl: webhookUrl('free_money', `/${txnId}`),
    },
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  );

  return {
    success:       r.body?.code === '200' || r.body?.status === 'SUCCESS',
    pending:       r.body?.status === 'PENDING',
    transactionId: r.body?.transactionId || r.body?.id,
    errorMessage:  r.body?.message || null,
  };
};

const sendPayout = async ({ txnId, amount, currency, phone, config }) => {
  logger.info('Free Money sendPayout', { txnId, amount });
  const token = await getToken(config);
  const r = await req('POST', config.baseUrl || 'https://api.free.sn',
    '/v1/payment/disburse',
    { merchantId: config.merchantId || config.apiKey, msisdn: phone.replace('+221', '').replace('+', ''),
      amount: String(amount), currency: currency || 'XOF', orderId: txnId },
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  );
  return { success: r.body?.code === '200' || r.body?.status === 'SUCCESS', transactionId: r.body?.transactionId };
};

const req = (method, base, path, body, headers) => new Promise((resolve, reject) => {
  const u = new URL(base + path);
  const p = body === null || body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname + (u.search || ''), method,
    headers: { ...headers, ...(p !== null ? { 'Content-Length': Buffer.byteLength(p) } : {}) }, timeout: 20000 },
    (res) => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => {
      try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: {} }); }
    }); });
  r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('Free Money timeout')); });
  if (p !== null) r.write(p); r.end();
});

// ─── Statut réel (WAVE-2) ─────────────────────────────────────────
// Endpoint non documenté publiquement : à renseigner dans extra_params.statusPath
// (ex. "/v1/payment/status/{ref}" — {ref} = référence C-Pay, {gatewayRef} = id opérateur).
// Sans statusPath, la re-interrogation est indisponible ({ available:false }).
const getStatus = async ({ txnId, gatewayRef, config }) => {
  if (!config || !config.statusPath) return { available: false };
  const path = String(config.statusPath)
    .replace('{ref}', encodeURIComponent(txnId || ''))
    .replace('{gatewayRef}', encodeURIComponent(gatewayRef || ''));
  const headers = { 'Authorization': `Bearer ${await getToken(config)}` };
  const r = await req('GET', config.baseUrl || DEFAULT_BASE, path, null, headers);
  if (r.status >= 400 || !r.body || typeof r.body !== 'object') {
    const err = new Error(`free_money status query failed: HTTP ${r.status}`);
    err.statusCode = r.status;
    throw err;
  }
  const b = r.body;
  const st = String(b.status || b.transaction_status || b.state || '').toUpperCase();
  return {
    available: true,
    status:   ['SUCCESS', 'SUCCESSFUL', 'CONFIRMED', 'COMPLETED', 'SUCCEEDED'].includes(st) ? 'SUCCESSFUL'
            : ['FAILED', 'FAILURE', 'ERROR', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(st) ? 'FAILED' : 'PENDING',
    amount:   b.amount != null ? Number(b.amount) : null,
    currency: b.currency || null,
    gatewayRef: b.transaction_id || b.transactionId || b.id || null,
    reason:   b.message || b.reason || null,
  };
};

module.exports = { collectPayment, sendPayout, getStatus };
