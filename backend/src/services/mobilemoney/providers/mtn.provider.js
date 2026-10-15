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
      payerMessage: description || 'C-Pay',
      payeeNote:    description || 'C-Pay',
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
      payerMessage: 'C-Pay retrait',
      payeeNote:    'C-Pay retrait',
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

// Timeout de polling ≠ echec : le client peut encore valider son PIN. On rend
// pending:true ; le webhook / la reconciliation (getRequestStatus) finalisent.
const pollStatus = async (config, ref, token, maxWaitMs = 30000, sleepMs = 3000) => {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await sleep(sleepMs);
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
      return { success: false, reason: r.body.reason || 'FAILED', errorMessage: 'Paiement refusé', retryable: false, externalId: ref };
    }
  }
  return { success: false, pending: true, reason: 'TIMEOUT', errorMessage: 'En attente de confirmation client', retryable: false, externalId: ref };
};

const pollDisbursementStatus = async (config, ref, token, sleepMs = 5000) => {
  await sleep(sleepMs);
  const r = await httpRequest('GET', config.baseUrl,
    `/disbursement/v1_0/transfer/${ref}`,
    null,
    { 'Authorization': `Bearer ${token}`, 'X-Target-Environment': process.env.MTN_ENV || 'sandbox', 'Ocp-Apim-Subscription-Key': config.subscriptionKey || config.apiKey }
  );
  const status = r.body?.status;
  if (status === 'SUCCESSFUL') {
    return { success: true, financialTransactionId: r.body.financialTransactionId, externalId: ref };
  }
  if (status === 'FAILED') {
    return { success: false, reason: r.body?.reason || 'FAILED', errorMessage: 'Transfert refusé', retryable: false, externalId: ref };
  }
  // PENDING (ou statut inconnu) : le transfert peut encore aboutir → jamais failed
  return { success: false, pending: true, reason: status || 'PENDING', errorMessage: 'Transfert en cours', retryable: false, externalId: ref };
};

// ─── Statut reel (webhook / reconciliation) ───────────────────────
// Retourne le statut tel que renvoye par MTN : { status, amount, currency, financialTransactionId, reason }
const getStatusGeneric = async (config, product, ref) => {
  const token = await getAccessToken(config);
  const path  = product === 'disbursement'
    ? `/disbursement/v1_0/transfer/${ref}`
    : `/collection/v1_0/requesttopay/${ref}`;
  const r = await httpRequest('GET', config.baseUrl, path, null, {
    'Authorization':             `Bearer ${token}`,
    'X-Target-Environment':      process.env.MTN_ENV || 'sandbox',
    'Ocp-Apim-Subscription-Key': config.subscriptionKey || config.apiKey,
  });
  if (r.statusCode >= 400 || !r.body || typeof r.body !== 'object') {
    const err = new Error(`MTN status query failed: HTTP ${r.statusCode}`);
    err.statusCode = r.statusCode;
    throw err;
  }
  const b = r.body;
  return {
    referenceId: ref,
    status:      b.status || null,                     // PENDING | SUCCESSFUL | FAILED
    amount:      b.amount != null ? parseFloat(b.amount) : null,
    currency:    b.currency || null,
    financialTransactionId: b.financialTransactionId || null,
    financialTxnId:         b.financialTransactionId || null,
    reason:      b.reason ? (typeof b.reason === 'object' ? (b.reason.message || b.reason.code) : b.reason) : null,
    externalId:  b.externalId || null,
  };
};

const getRequestStatus  = (config, ref) => getStatusGeneric(config, 'collection', ref);
const getTransferStatus = (config, ref) => getStatusGeneric(config, 'disbursement', ref);

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

module.exports = { collectPayment, sendPayout, getRequestStatus, getTransferStatus, pollStatus, pollDisbursementStatus };
