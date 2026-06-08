/**
 * Express Union Provider — Cameroun
 * API : Express Union Financial Services API
 * Auth : API Key dans les headers
 */
'use strict';
const https  = require('https');
const logger = require('../../../config/logger');

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
      description:   description || 'CPlus 2.0',
      callback_url:  `${process.env.API_BASE_URL}/webhooks/express_union/${txnId}`,
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
  const p = JSON.stringify(body);
  const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname, method,
    headers: { ...headers, 'Content-Length': Buffer.byteLength(p) }, timeout: 20000 },
    (res) => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => {
      try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: {} }); }
    }); });
  r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('Express Union timeout')); });
  r.write(p); r.end();
});

module.exports = { collectPayment, sendPayout };
