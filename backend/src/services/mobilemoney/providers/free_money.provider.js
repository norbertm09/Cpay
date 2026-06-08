/**
 * Free Money Provider — Sénégal
 * API : Free Sénégal Business API (Free Money)
 * Auth : OAuth2 client_credentials
 */
'use strict';
const https  = require('https');
const logger = require('../../../config/logger');

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
      description: description || 'CPlus 2.0',
      callbackUrl: `${process.env.API_BASE_URL}/webhooks/free_money/${txnId}`,
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
  const p = typeof body === 'string' ? body : JSON.stringify(body);
  const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname, method,
    headers: { ...headers, 'Content-Length': Buffer.byteLength(p) }, timeout: 20000 },
    (res) => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => {
      try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: {} }); }
    }); });
  r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('Free Money timeout')); });
  r.write(p); r.end();
});

module.exports = { collectPayment, sendPayout };
