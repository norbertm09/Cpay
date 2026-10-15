/**
 * Airtel Money Provider — RDC, Congo Brazzaville
 * API : Airtel Africa Open API
 */
'use strict';
const https  = require('https');
const crypto = require('crypto');
const logger = require('../../../config/logger');

// Airtel Congo attend un msisdn local 0XXXXXXXX (sans indicatif)
const toLocalMsisdn = (ph) => {
  let n = String(ph || '').replace(/[^0-9]/g, '');
  if (n.startsWith('242')) n = n.slice(3);
  if (n[0] !== '0') n = '0' + n;
  return n;
};
// Reference/id purement numerique apres prefixe (Airtel sandbox rejette les lettres hex)

// Airtel v3 disbursement : PIN chiffre en RSA/ECB/OAEPWithSHA-256AndMGF1Padding (cle 2048), resultat base64
const encryptPin = (pin, pubKeyB64) => {
  const key = crypto.createPublicKey({ key: Buffer.from(pubKeyB64, 'base64'), format: 'der', type: 'spki' });
  return crypto.publicEncrypt(
    { key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', mgf1Hash: 'sha256' },
    Buffer.from(String(pin))
  ).toString('base64');
};

const genRef = () => 'CPAY' + Date.now() + Math.floor(Math.random() * 1000);

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
  const ref = genRef();
  const cc = currency === 'CDF' ? 'CD' : 'CG';
  const r = await httpRequest('POST', config.baseUrl || 'https://openapi.airtel.africa',
    '/merchant/v1/payments/',
    {
      reference:   ref,
      subscriber:  { country: cc, currency, msisdn: toLocalMsisdn(phone) },
      transaction: { amount, id: ref, country: cc, currency },
    },
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Country': cc, 'X-Currency': currency }
  );
  logger.info('AIRTEL RAW collectPayment', { txnId, rawBody: JSON.stringify(r.body || {}) });
  const txStatus = String(r.body?.data?.transaction?.status || '').toUpperCase();
  const apiOk = r.body?.status?.success === true || String(r.body?.status?.code) === '200';
  // Acceptation de la requete (push envoye, statut TIP ou absent) != paiement confirme.
  // success:true UNIQUEMENT sur un statut final TS ; sinon pending:true (webhook / reconciliation
  // finalisent) ; TF/TE ou refus API = echec.
  const failed  = !apiOk || txStatus === 'TF' || txStatus === 'TE';
  const success = apiOk && txStatus === 'TS';
  const pending = apiOk && !success && !failed;
  return {
    success,
    pending,
    transactionId: r.body?.data?.transaction?.id || ref,
    airtelMoneyId: r.body?.data?.transaction?.airtel_money_id || null,
    rawStatus:     txStatus || null,
    errorMessage:  failed ? (r.body?.status?.message || 'Airtel payment failed') : null,
    retryable:     false,
  };
};

const sendPayout = async ({ txnId, amount, currency, phone, config, txType }) => {
  const token = await getToken(config);
  const ref = genRef();
  const cc = currency === 'CDF' ? 'CD' : 'CG';
  const encPin = (config.pin && config.rsaPubKey) ? encryptPin(config.pin, config.rsaPubKey) : (config.encryptedPin || config.pin || '');
  const r = await httpRequest('POST', config.baseUrl || 'https://openapi.airtel.africa',
    '/standard/v3/disbursements',
    {
      payee:       { msisdn: toLocalMsisdn(phone), wallet_type: 'NORMAL' },
      reference:   ref,
      pin:         encPin,
      transaction: { amount, id: ref, type: txType === 'B2B' ? 'B2B' : 'B2C' },
    },
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Country': cc, 'X-Currency': currency }
  );
  logger.info('AIRTEL RAW sendPayout', { txnId, rawBody: JSON.stringify(r.body || {}) });
  const txStatus = String(r.body?.data?.transaction?.status || '').toUpperCase();
  const apiOk = r.body?.status?.success === true || String(r.body?.status?.code) === '200'
             || String(r.body?.status?.response_code || '').toUpperCase() === 'DP00900001001';
  const success = txStatus === 'TS';
  const failed  = !success && (!apiOk || txStatus === 'TF' || txStatus === 'TE');
  const pending = !success && !failed;   // TIP / TA / statut absent apres acceptation
  return {
    success,
    pending,
    transactionId: r.body?.data?.transaction?.id || ref,
    airtelMoneyId: r.body?.data?.transaction?.reference_id || r.body?.data?.transaction?.airtel_money_id || null,
    rawStatus:     txStatus || null,
    rawResponse: JSON.stringify(r.body || {}),
    errorMessage:  failed ? (r.body?.status_message || r.body?.status?.message || 'Airtel payout failed') : null,
    retryable:     false,
  };
};

const httpRequest = (method, baseUrl, path, body, headers) => new Promise((resolve, reject) => {
  const u = new URL(baseUrl + path);
  const hasBody = body !== null && body !== undefined && method !== 'GET';
  const payload = hasBody ? (typeof body === 'string' ? body : JSON.stringify(body)) : '';
  const req = https.request({
    hostname: u.hostname, port: 443, path: u.pathname,
    method, headers: hasBody ? { ...headers, 'Content-Length': Buffer.byteLength(payload) } : { ...headers },
    timeout: 15000,
  }, res => {
    let data = '';
    res.on('data', c => { data += c; });
    res.on('end', () => { try { resolve({ statusCode: res.statusCode, body: JSON.parse(data) }); } catch { resolve({ statusCode: res.statusCode, body: {} }); } });
  });
  req.on('error', reject);
  req.on('timeout', () => { req.destroy(); reject(new Error('Airtel timeout')); });
  if (payload) req.write(payload);
  req.end();
});

const queryTransaction = async ({ txId, currency, config }) => {
  const token = await getToken(config);
  const cc = currency === 'CDF' ? 'CD' : 'CG';
  const r = await httpRequest('GET', config.baseUrl || 'https://openapi.airtel.africa',
    '/standard/v1/payments/' + txId, null,
    { 'Authorization': `Bearer ${token}`, 'Accept': '*/*', 'X-Country': cc, 'X-Currency': currency }
  );
  logger.info('AIRTEL RAW queryTransaction', { txId, rawBody: JSON.stringify(r.body || {}) });
  const t = (r.body && r.body.data && r.body.data.transaction) || {};
  return {
    rawStatus: t.status,
    success:   t.status === 'TS',
    failed:    t.status === 'TF' || t.status === 'TE',
    pending:   t.status === 'TIP' || t.status === 'TA' || t.status === 'Success.',
    airtelMoneyId: t.airtel_money_id || null,
    message:   t.message || null,
    rawResponse: JSON.stringify(r.body || {}),
  };
};

const queryDisbursement = async ({ txId, currency, config }) => {
  const token = await getToken(config);
  const cc = currency === 'CDF' ? 'CD' : 'CG';
  const r = await httpRequest('GET', config.baseUrl || 'https://openapi.airtel.africa',
    '/standard/v3/disbursements/' + txId, null,
    { 'Authorization': `Bearer ${token}`, 'Accept': '*/*', 'X-Country': cc, 'X-Currency': currency }
  );
  logger.info('AIRTEL RAW queryTransaction', { txId, rawBody: JSON.stringify(r.body || {}) });
  const t = (r.body && r.body.data && r.body.data.transaction) || {};
  return {
    rawStatus: t.status,
    success:   t.status === 'TS',
    failed:    t.status === 'TF' || t.status === 'TE',
    pending:   t.status === 'TIP' || t.status === 'TA',
    airtelMoneyId: t.reference_id || t.airtel_money_id || null,
    message:   t.message || null,
    rawResponse: JSON.stringify(r.body || {}),
  };
};

module.exports = { collectPayment, sendPayout, queryTransaction, queryDisbursement };
