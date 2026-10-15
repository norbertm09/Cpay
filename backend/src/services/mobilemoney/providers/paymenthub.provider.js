/**
 * PaymentHub API v1.1
 * Bearer personal access token + payment instruction payouts.
 */
'use strict';

const https = require('https');
const logger = require('../../../config/logger');

const itemCodeFromConfig = (config) => {
  if (config.paymentItemCode) return config.paymentItemCode;
  const key = config.providerKey || '';
  if (key.includes('airtel')) return 'AM';
  if (key.includes('orange')) return 'OM';
  if (key.includes('africell') || key.includes('afri')) return 'AFM';
  return 'MPESA';
};

const collectPayment = async () => {
  throw new Error('PaymentHub API v1.1 supports payouts, not customer collect');
};

const sendPayout = async ({ txnId, amount, currency, phone, config }) => {
  logger.info('PaymentHub sendPayout', { txnId, amount, currency, provider: config.providerKey });
  const token = config.apiKey || config.token;
  if (!token || !config.companyCode || !config.debitAccountNo) {
    throw new Error('PaymentHub token/companyCode/debitAccountNo not configured');
  }

  const response = await request({
    method: 'POST',
    baseUrl: config.baseUrl || process.env.PAYMENTHUB_BASE_URL || 'https://paymenthub.example.com',
    path: '/api/v1/payments',
    body: {
      company_code: config.companyCode,
      reference: txnId,
      narration: config.narration || 'CPlus payout',
      debit_account_no: config.debitAccountNo,
      debit_type: 'single',
      callback_url: config.callbackUrl || process.env.PAYMENTHUB_CALLBACK_URL,
      operations: [{
        beneficiary_account_no: phone.replace('+', ''),
        payment_item_code: itemCodeFromConfig(config),
        amount: Number(amount),
        currency: currency || 'CDF',
        reference: txnId,
        narration: config.operationNarration || 'CPlus payout',
      }],
    },
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  const ok = response.body?.code === '00' || response.body?.status === 'accepted';
  return {
    success: ok,
    pending: ok,
    transactionId: response.body?.id || txnId,
    externalId: response.body?.id,
    responseCode: response.body?.code || (ok ? '00' : String(response.statusCode || '05')),
    errorMessage: ok ? null : (response.body?.message || 'PaymentHub payout failed'),
    retryable: response.statusCode >= 500,
  };
};

const getBalance = async ({ config }) => {
  const token = config.apiKey || config.token;
  const qs = new URLSearchParams({ company_code: config.companyCode, account_no: config.debitAccountNo });
  return request({
    method: 'GET',
    baseUrl: config.baseUrl || process.env.PAYMENTHUB_BASE_URL || 'https://paymenthub.example.com',
    path: `/api/v1/accounts/balance?${qs.toString()}`,
    headers: { Authorization: `Bearer ${token}` },
  });
};

const getStatus = async ({ reference, id, config }) => {
  const token = config.apiKey || config.token;
  const qs = new URLSearchParams({ company_code: config.companyCode });
  if (id) qs.set('id', id);
  else qs.set('reference', reference);
  return request({
    method: 'GET',
    baseUrl: config.baseUrl || process.env.PAYMENTHUB_BASE_URL || 'https://paymenthub.example.com',
    path: `/api/v1/payments/status?${qs.toString()}`,
    headers: { Authorization: `Bearer ${token}` },
  });
};

const request = ({ method, baseUrl, path, body, headers }) => new Promise((resolve, reject) => {
  const url = new URL(path, baseUrl);
  const payload = body ? JSON.stringify(body) : null;
  const req = https.request({
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method,
    headers: { ...headers, ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
    timeout: parseInt(process.env.PAYMENTHUB_TIMEOUT_MS || '20000', 10),
  }, (res) => {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', c => { raw += c; });
    res.on('end', () => {
      try { resolve({ statusCode: res.statusCode, body: raw ? JSON.parse(raw) : {} }); }
      catch { resolve({ statusCode: res.statusCode, body: { raw } }); }
    });
  });
  req.on('error', reject);
  req.on('timeout', () => req.destroy(new Error('PaymentHub timeout')));
  if (payload) req.write(payload);
  req.end();
});

module.exports = { collectPayment, sendPayout, getBalance, getStatus };
