/**
 * Airtel Money Provider — RDC, Congo Brazzaville
 * API : Airtel Africa Open API
 */
'use strict';
const https  = require('https');
const logger = require('../../../config/logger');

const getToken = async (config) => {
  const r = await httpRequest('POST', config.baseUrl || 'https://openapi.airtel.africa',
    '/auth/oauth2/token',
    `client_id=${config.apiKey}&client_secret=${config.apiSecret}&grant_type=client_credentials`,
    { 'Content-Type': 'application/x-www-form-urlencoded' }
  );
  return r.body?.access_token;
};

const collectPayment = async ({ txnId, amount, currency, phone, config }) => {
  logger.info('Airtel collectPayment', { txnId, amount });
  const token = await getToken(config);

  const r = await httpRequest('POST', config.baseUrl || 'https://openapi.airtel.africa',
    '/merchant/v1/payments/',
    {
      reference:   txnId,
      subscriber:  { country: currency === 'CDF' ? 'CD' : 'CG', currency, msisdn: phone.replace('+', '') },
      transaction: { amount, id: txnId, country: currency === 'CDF' ? 'CD' : 'CG', currency },
    },
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Country': currency === 'CDF' ? 'CD' : 'CG', 'X-Currency': currency }
  );

  const success = r.body?.data?.transaction?.status === 'TS';
  return {
    success,
    transactionId:  r.body?.data?.transaction?.id,
    errorMessage:   success ? null : (r.body?.status?.message || 'Airtel payment failed'),
  };
};

const sendPayout = async ({ txnId, amount, currency, phone, config }) => {
  const token = await getToken(config);
  const r = await httpRequest('POST', config.baseUrl || 'https://openapi.airtel.africa',
    '/standard/v1/disbursements/',
    {
      payee:       { msisdn: phone.replace('+', '') },
      reference:   txnId,
      pin:         config.encryptedPin || '',
      transaction: { amount, id: txnId },
    },
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  );
  return { success: r.statusCode === 200, transactionId: r.body?.data?.transaction?.id };
};

const httpRequest = (method, baseUrl, path, body, headers) => new Promise((resolve, reject) => {
  const u = new URL(baseUrl + path);
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const req = https.request({
    hostname: u.hostname, port: 443, path: u.pathname,
    method, headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
    timeout: 15000,
  }, res => {
    let data = '';
    res.on('data', c => { data += c; });
    res.on('end', () => { try { resolve({ statusCode: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ statusCode: res.statusCode, body: {} }); } });
  });
  req.on('error', reject);
  req.on('timeout', () => { req.destroy(); reject(new Error('Airtel timeout')); });
  req.write(payload);
  req.end();
});

module.exports = { collectPayment, sendPayout };
