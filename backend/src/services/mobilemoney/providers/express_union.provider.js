/**
 * Express Union Provider — Cameroun
 * API : Express Union Financial Services API
 * Auth : API Key dans les headers
 */
'use strict';
const https  = require('https');
const logger = require('../../../config/logger');
const DEFAULT_BASE = 'https://api.expressunion.cm';
// WAVE-2 : URL de callback secrète (/api/v1/webhooks/<WEBHOOK_PATH_SECRET>/<provider>)
const { webhookUrl } = require('../mobilemoney.router');

const collectPayment = async ({ txnId, amount, currency, phone, description, config }) => {
  logger.info('Express Union collectPayment', { txnId, amount, currency });
  if (!config.apiKey) throw new Error('Express Union API key not configured');

  const r = await req('POST', config.baseUrl || 'https://api.expressunion.cm',
    '/api/v1/payment/cashin',
    {
      api_key:       config.apiKey,
      amount:        String(amount),
      currency:      currency || 'XAF',
      phone:         phone.replace('+', ''),
      reference:     txnId,
      description:   description || 'CPlus 2.6.0',
      callback_url:  webhookUrl('express_union', `/${txnId}`),
    },
    { 'Authorization': `ApiKey ${config.apiKey}`, 'Content-Type': 'application/json' }
  );

  const ok = r.status === 200 && r.body?.success;
  return {
    success:       ok && r.body?.status === 'CONFIRMED',
    pending:       ok && r.body?.status === 'PENDING',
    transactionId: r.body?.transaction_id,
    errorMessage:  ok ? null : (r.body?.message || 'Express Union failed'),
  };
};

const sendPayout = async ({ txnId, amount, currency, phone, config }) => {
  logger.info('Express Union sendPayout', { txnId, amount });
  const r = await req('POST', config.baseUrl || 'https://api.expressunion.cm',
    '/api/v1/payment/cashout',
    { api_key: config.apiKey, amount: String(amount), currency: currency || 'XAF',
      phone: phone.replace('+', ''), reference: txnId },
    { 'Authorization': `ApiKey ${config.apiKey}`, 'Content-Type': 'application/json' }
  );
  return { success: r.body?.success && r.body?.status === 'CONFIRMED', transactionId: r.body?.transaction_id };
};

const req = (method, base, path, body, headers) => new Promise((resolve, reject) => {
  const u = new URL(base + path);
  const p = body === null || body === undefined ? null : JSON.stringify(body);
  const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname + (u.search || ''), method,
    headers: { ...headers, ...(p !== null ? { 'Content-Length': Buffer.byteLength(p) } : {}) }, timeout: 20000 },
    (res) => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => {
      try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: {} }); }
    }); });
  r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('Express Union timeout')); });
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
  const headers = { 'Authorization': `ApiKey ${config.apiKey}` };
  const r = await req('GET', config.baseUrl || DEFAULT_BASE, path, null, headers);
  if (r.status >= 400 || !r.body || typeof r.body !== 'object') {
    const err = new Error(`express_union status query failed: HTTP ${r.status}`);
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
