/**
 * Africell Money Provider — RDC
 * API : Africell Business API
 * Auth : API Key + Secret dans les headers
 */
'use strict';
const https  = require('https');
const logger = require('../../../config/logger');

const collectPayment = async ({ txnId, amount, currency, phone, description, config }) => {
  logger.info('Africell collectPayment', { txnId, amount, currency });
  if (!config.apiKey) throw new Error('Africell API key not configured');

  const r = await req('POST', config.baseUrl || 'https://api.africellmoney.cd',
    '/v1/payment/request',
    {
      merchant_id:     config.merchantId || config.apiKey,
      phone_number:    phone.replace('+', ''),
      amount:          String(amount),
      currency:        currency || 'CDF',
      reference:       txnId,
      description:     description || 'CPlus 2.6.0',
      callback_url:    `${process.env.API_BASE_URL}/webhooks/africell/${txnId}`,
    },
    { 'X-API-Key': config.apiKey, 'X-API-Secret': config.apiSecret || '', 'Content-Type': 'application/json' }
  );

  const ok = r.status === 200 && ['SUCCESS', 'PENDING'].includes(r.body?.status);
  return {
    success:       r.body?.status === 'SUCCESS',
    pending:       r.body?.status === 'PENDING',
    transactionId: r.body?.transaction_id || r.body?.id,
    errorMessage:  ok ? null : (r.body?.message || 'Africell payment failed'),
  };
};

const sendPayout = async ({ txnId, amount, currency, phone, config }) => {
  logger.info('Africell sendPayout', { txnId, amount });
  const r = await req('POST', config.baseUrl || 'https://api.africellmoney.cd',
    '/v1/payout/transfer',
    { merchant_id: config.merchantId || config.apiKey, phone_number: phone.replace('+', ''),
      amount: String(amount), currency: currency || 'CDF', reference: txnId },
    { 'X-API-Key': config.apiKey, 'X-API-Secret': config.apiSecret || '', 'Content-Type': 'application/json' }
  );
  return { success: r.body?.status === 'SUCCESS', transactionId: r.body?.transaction_id };
};

const req = (method, base, path, body, headers) => new Promise((resolve, reject) => {
  const u = new URL(base + path);
  const p = JSON.stringify(body);
  const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname, method,
    headers: { ...headers, 'Content-Length': Buffer.byteLength(p) }, timeout: 20000 },
    (res) => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => {
      try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: {} }); }
    }); });
  r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('Africell timeout')); });
  r.write(p); r.end();
});

module.exports = { collectPayment, sendPayout };
