/**
 * Moov Money Provider — Côte d'Ivoire, Cameroun
 * API : Moov Africa Open API
 * Auth : Bearer Token (OAuth2 client_credentials)
 */
'use strict';
const https  = require('https');
const logger = require('../../../config/logger');
const DEFAULT_BASE = 'https://openapi.moov.africa';

const getToken = async (config) => {
  const r = await req('POST', config.baseUrl || 'https://openapi.moov.africa',
    '/oauth2/token',
    `client_id=${config.apiKey}&client_secret=${config.apiSecret}&grant_type=client_credentials`,
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );
  return r.body?.access_token;
};

const collectPayment = async ({ txnId, amount, currency, phone, description, config }) => {
  logger.info('Moov collectPayment', { txnId, amount, currency });
  if (!config.apiKey) throw new Error('Moov API key not configured');

  const token = await getToken(config);
  const country = currency === 'XAF' ? 'CM' : 'CI';

  const r = await req('POST', config.baseUrl || 'https://openapi.moov.africa',
    '/v1/payment/cash-in',
    {
      partner_id:    config.partnerId || config.apiKey,
      amount:        String(amount),
      currency,
      customer_msisdn: phone.replace('+', ''),
      external_transaction_id: txnId,
      description:   description || 'C-Pay',
      country_code:  country,
    },
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  );

  const ok = r.status === 200 && ['SUCCESS', 'PENDING'].includes(r.body?.status);
  if (r.body?.status === 'PENDING') {
    return { success: null, pending: true, transactionId: r.body?.transaction_id, externalId: txnId };
  }
  return {
    success:       r.body?.status === 'SUCCESS',
    transactionId: r.body?.transaction_id,
    errorMessage:  ok ? null : (r.body?.message || 'Moov payment failed'),
  };
};

const sendPayout = async ({ txnId, amount, currency, phone, config }) => {
  logger.info('Moov sendPayout', { txnId, amount });
  const token = await getToken(config);
  const r = await req('POST', config.baseUrl || 'https://openapi.moov.africa',
    '/v1/payment/cash-out',
    { partner_id: config.partnerId || config.apiKey, amount: String(amount), currency,
      customer_msisdn: phone.replace('+', ''), external_transaction_id: txnId },
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  );
  return { success: r.body?.status === 'SUCCESS', transactionId: r.body?.transaction_id };
};

const req = (method, base, path, body, headers) => new Promise((resolve, reject) => {
  const u = new URL(base + path);
  const p = body === null || body === undefined ? null : (typeof body === 'string' ? body : JSON.stringify(body));
  const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname + (u.search || ''), method,
    headers: { ...headers, ...(p !== null ? { 'Content-Length': Buffer.byteLength(p) } : {}) }, timeout: 20000 },
    (res) => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => {
      try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: {} }); }
    }); });
  r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('Moov timeout')); });
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
    const err = new Error(`moov status query failed: HTTP ${r.status}`);
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
