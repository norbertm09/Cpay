/**
 * MTN Mobile Money Provider
 * Couvre : Cameroun (CM), Côte d'Ivoire (CI), Congo Brazzaville (CG)
 * API : MTN MoMo API (momodeveloper.mtn.com)
 */
'use strict';
const https  = require('https');
const crypto = require('crypto');
const logger = require('../../../config/logger');

const getAccessToken = async (config) => {
  const creds = Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString('base64');
  const result = await httpRequest('POST', config.baseUrl, '/collection/token/',
    null, {
      'Authorization': `Basic ${creds}`,
      'Ocp-Apim-Subscription-Key': config.subscriptionKey || config.apiKey,
    });
  return result.body?.access_token;
};

const collectPayment = async ({ txnId, amount, currency, phone, description, config }) => {
  logger.info('MTN collectPayment', { txnId, amount, currency });
  const token = await getAccessToken(config);
  const ref   = txnId;

  const result = await httpRequest('POST', config.baseUrl,
    '/collection/v1_0/requesttopay',
    {
      amount:      String(amount),
      currency,
      externalId:  ref,
      payer: { partyIdType: 'MSISDN', partyId: phone.replace('+', '') },
      payerMessage: description || 'Calculus Plus',
      payeeNote:    description || 'Calculus Plus',
    },
    {
      'Authorization':              `Bearer ${token}`,
      'X-Reference-Id':             ref,
      'X-Target-Environment':       process.env.MTN_ENV || 'sandbox',
      'Ocp-Apim-Subscription-Key':  config.subscriptionKey || config.apiKey,
      'Content-Type':               'application/json',
    }
  );

  // MTN retourne 202 Accepted pour les paiements asynchrones
  const pending = result.statusCode === 202;
  if (pending) {
    // Polling du statut (jusqu'à 30 secondes)
    return pollStatus(config, ref, token);
  }

  return { success: false, responseCode: String(result.statusCode), errorMessage: 'Erreur MTN' };
};

const sendPayout = async ({ txnId, amount, currency, phone, config }) => {
  const token = await getAccessToken(config);
  const ref   = txnId;

  const result = await httpRequest('POST', config.baseUrl,
    '/disbursement/v1_0/transfer',
    {
      amount: String(amount), currency,
      externalId: ref,
      payee: { partyIdType: 'MSISDN', partyId: phone.replace('+', '') },
      payerMessage: 'Calculus Plus retrait',
      payeeNote:    'Calculus Plus retrait',
    },
    {
      'Authorization':             `Bearer ${token}`,
      'X-Reference-Id':            ref,
      'X-Target-Environment':      process.env.MTN_ENV || 'sandbox',
      'Ocp-Apim-Subscription-Key': config.subscriptionKey || config.apiKey,
      'Content-Type':              'application/json',
    }
  );

  if (result.statusCode === 202) return pollDisbursementStatus(config, ref, token);
  return { success: false, responseCode: String(result.statusCode) };
};

const pollStatus = async (config, ref, token, maxWaitMs = 30000) => {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await sleep(3000);
    const r = await httpRequest('GET', config.baseUrl,
      `/collection/v1_0/requesttopay/${ref}`,
      null,
      {
        'Authorization':             `Bearer ${token}`,
        'X-Target-Environment':      process.env.MTN_ENV || 'sandbox',
        'Ocp-Apim-Subscription-Key': config.subscriptionKey || config.apiKey,
      }
    );
    const status = r.body?.status;
    if (status === 'SUCCESSFUL') {
      return { success: true, financialTransactionId: r.body.financialTransactionId, externalId: ref };
    }
    if (status === 'FAILED') {
      return { success: false, reason: r.body.reason || 'FAILED', errorMessage: 'Paiement refusé', retryable: false };
    }
  }
  return { success: false, reason: 'TIMEOUT', errorMessage: 'Délai dépassé', retryable: true };
};

const pollDisbursementStatus = async (config, ref, token) => {
  await sleep(5000);
  const r = await httpRequest('GET', config.baseUrl,
    `/disbursement/v1_0/transfer/${ref}`,
    null,
    { 'Authorization': `Bearer ${token}`, 'X-Target-Environment': process.env.MTN_ENV || 'sandbox', 'Ocp-Apim-Subscription-Key': config.subscriptionKey || config.apiKey }
  );
  return { success: r.body?.status === 'SUCCESSFUL', financialTransactionId: r.body?.financialTransactionId };
};

const httpRequest = (method, baseUrl, path, body, headers) => new Promise((resolve, reject) => {
  const u = new URL(baseUrl + path);
  const payload = body ? JSON.stringify(body) : null;
  const req = https.request({
    hostname: u.hostname, port: 443, path: u.pathname,
    method, headers: { ...headers, ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
    timeout: 15000,
  }, res => {
    let data = '';
    res.on('data', c => { data += c; });
    res.on('end', () => {
      try { resolve({ statusCode: res.statusCode, body: JSON.parse(data) }); }
      catch { resolve({ statusCode: res.statusCode, body: {} }); }
    });
  });
  req.on('error', reject);
  req.on('timeout', () => { req.destroy(); reject(new Error('MTN timeout')); });
  if (payload) req.write(payload);
  req.end();
});

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = { collectPayment, sendPayout };
