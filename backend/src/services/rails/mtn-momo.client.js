'use strict';
// Nettoyer les messages pour MTN (ASCII, max 160 car, pas de caracteres speciaux)
const sanitizeMsg = (s) => String(s || 'Paiement C-Pay')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // retirer accents
  .replace(/[^a-zA-Z0-9 .,-]/g, ' ')                    // garder ASCII simple
  .replace(/\s+/g, ' ').trim().slice(0, 160) || 'Paiement C-Pay';


const https  = require('https');
const { v4: uuidv4 } = require('uuid');

// Environnement MTN (sandbox | production) resolu une seule fois pour tout le backend : config/mtn-env.js
const { resolveMtnEnv, warnOnce } = require('../../config/mtn-env');
const MTN_ENV = resolveMtnEnv({ country: process.env.MTN_CG_COUNTRY || 'CG' });
warnOnce(MTN_ENV);
const MTN_HOST = MTN_ENV.host;
const TARGET_ENV = MTN_ENV.targetEnvironment;

const CONFIG = {
  baseUrl:  MTN_ENV.baseUrl,
  sandbox:  MTN_ENV.isSandbox,
  targetEnvironment: TARGET_ENV,
  currency: process.env.MTN_CG_CURRENCY || 'XAF',
  country:  process.env.MTN_CG_COUNTRY || 'CG',
  callbackUrl: process.env.MTN_CG_CALLBACK_URL || 'https://api.c-pay.global/api/v1/momo/webhooks/mtn',
  timeout:  parseInt(process.env.MTN_CG_TIMEOUT_MS || '30000'),
  collections: {
    apiUser:    process.env.MTN_CG_COLL_API_USER || '',
    apiKey:     process.env.MTN_CG_COLL_API_KEY || '',
    primaryKey: process.env.MTN_CG_COLL_SUB_KEY_PRIMARY || '',
  },
  disbursements: {
    apiUser:    process.env.MTN_CG_DISB_API_USER || '',
    apiKey:     process.env.MTN_CG_DISB_API_KEY || '',
    primaryKey: process.env.MTN_CG_DISB_SUB_KEY_PRIMARY || '',
  },
};

const tokenCache = {};

// TLS : verification du certificat TOUJOURS active. Desactivable uniquement de
// facon explicite pour un bac a sable (MTN_TLS_INSECURE=true), jamais par defaut.
const TLS_INSECURE = String(process.env.MTN_TLS_INSECURE || '').toLowerCase() === 'true';
if (TLS_INSECURE) {
  console.error('[MTN-MOMO] MTN_TLS_INSECURE=true : verification TLS desactivee (sandbox uniquement)');
}

// Raw HTTPS request
const rawRequest = (opts, body) => new Promise((resolve, reject) => {
  const finalOpts = {
    hostname: opts.hostname,
    port:     443,
    path:     opts.path,
    method:   opts.method || 'GET',
    headers:  opts.headers || {},
    timeout:  opts.timeout || CONFIG.timeout || 30000,
  };
  if (TLS_INSECURE) finalOpts.rejectUnauthorized = false;
  const req = https.request(finalOpts, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      let parsed = null;
      try { parsed = d ? JSON.parse(d) : null; } catch { parsed = d; }
      resolve({ status: res.statusCode, data: parsed, raw: d });
    });
  });
  req.on('error', reject);
  req.on('timeout', () => {
    req.destroy(new Error(`MTN timeout after ${finalOpts.timeout}ms`));
  });
  if (body) req.write(body);
  req.end();
});

// Get OAuth2 token
const getToken = async (product) => {
  const cfg = CONFIG[product];
  const cached = tokenCache[product];
  if (cached && cached.expiresAt > Date.now() + 60000) {
    return cached.token;
  }
  const cred = Buffer.from(cfg.apiUser + ':' + cfg.apiKey).toString('base64');
  const r = await rawRequest({
    hostname: MTN_HOST,
    path: `/${product === 'collections' ? 'collection' : 'disbursement'}/token/`,
    method: 'POST',
    headers: {
      'Authorization': `Basic ${cred}`,
      'Ocp-Apim-Subscription-Key': cfg.primaryKey,
      'Content-Length': '0',
      'Host': MTN_HOST,
    },
  }, null);

  if (r.status !== 200 || !r.data || !r.data.access_token) {
    throw new Error(`MTN token failed: ${r.status} ${r.raw}`);
  }
  tokenCache[product] = {
    token: r.data.access_token,
    expiresAt: Date.now() + (r.data.expires_in || 3600) * 1000,
  };
  return r.data.access_token;
};

// Collections - Request to Pay
// Congo: le marchand saisit un numero local (0XXXXXXXX). MTN attend le format international 242XXXXXXXXX.
const toMtnMsisdn = (ph) => {
  let n = String(ph || '').replace(/[^0-9]/g, '');
  if (n.startsWith('242')) return n;
  // MTN Congo attend le 0 conserve apres l'indicatif : 242 + 0XXXXXXXX
  if (!n.startsWith('0')) n = '0' + n;
  return '242' + n;
};

const requestToPay = async ({ amount, phone, description, externalId }) => {
  const token = await getToken('collections');
  const refId = uuidv4();  // X-Reference-Id : toujours un UUID
  const body  = JSON.stringify({
    amount:      String(Math.round(amount)),
    currency:    CONFIG.currency,
    externalId:  (externalId ? externalId + '-' : '') + Date.now() + '-' + Math.random().toString(36).slice(2,6),
    payer:       { partyIdType: 'MSISDN', partyId: toMtnMsisdn(phone) },
    payerMessage: sanitizeMsg(description) || 'C-Pay Payment',
    payeeNote:    'C-Pay',
  });
  const r = await rawRequest({
    hostname: MTN_HOST,
    path:     '/collection/v1_0/requesttopay',
    method:   'POST',
    headers: {
      'Authorization':             `Bearer ${token}`,
      'X-Reference-Id':            refId,
      'X-Target-Environment':      TARGET_ENV,
      'Ocp-Apim-Subscription-Key': CONFIG.collections.primaryKey,
      'Content-Type':              'application/json',
      'Content-Length':            Buffer.byteLength(body),
    },
  }, body);

  if (r.status !== 202) throw Object.assign(new Error(`MTN requestToPay failed: ${r.status} ${r.raw}`), { statusCode: r.status });
  return { referenceId: refId, status: 'PENDING' };
};

// Collections - Get status
const getCollectionStatus = async (referenceId) => {
  const token = await getToken('collections');
  const r = await rawRequest({
    hostname: MTN_HOST,
    path:     `/collection/v1_0/requesttopay/${referenceId}`,
    method:   'GET',
    headers: {
      'Authorization':             `Bearer ${token}`,
      'X-Target-Environment':      TARGET_ENV,
      'Ocp-Apim-Subscription-Key': CONFIG.collections.primaryKey,
    },
  }, null);
  const d = r.data || {};
  return { referenceId, status: d.status, reason: d.reason, financialTxnId: d.financialTransactionId, amount: parseFloat(d.amount || 0), currency: d.currency };
};

// Collections - Balance
const getCollectionBalance = async () => {
  const token = await getToken('collections');
  const r = await rawRequest({
    hostname: MTN_HOST,
    path:     '/collection/v1_0/account/balance',
    method:   'GET',
    headers: {
      'Authorization':             `Bearer ${token}`,
      'X-Target-Environment':      TARGET_ENV,
      'Ocp-Apim-Subscription-Key': CONFIG.collections.primaryKey,
    },
  }, null);
  return { balance: parseFloat(r.data?.availableBalance || 0), currency: r.data?.currency };
};

// Disbursements - Transfer
const transfer = async ({ amount, phone, description, externalId }) => {
  const token = await getToken('disbursements');
  const refId = uuidv4();  // X-Reference-Id : toujours un UUID
  const body  = JSON.stringify({
    amount:      String(Math.round(amount)),
    currency:    CONFIG.currency,
    externalId:  (externalId ? externalId + '-' : '') + Date.now() + '-' + Math.random().toString(36).slice(2,6),
    payee:       { partyIdType: 'MSISDN', partyId: toMtnMsisdn(phone) },
    payerMessage: sanitizeMsg(description) || 'C-Pay Payout',
    payeeNote:    'C-Pay',
  });
  const r = await rawRequest({
    hostname: MTN_HOST,
    path:     '/disbursement/v1_0/transfer',
    method:   'POST',
    headers: {
      'Authorization':             `Bearer ${token}`,
      'X-Reference-Id':            refId,
      'X-Target-Environment':      TARGET_ENV,
      'Ocp-Apim-Subscription-Key': CONFIG.disbursements.primaryKey,
      'Content-Type':              'application/json',
      'Content-Length':            Buffer.byteLength(body),
    },
  }, body);

  if (r.status !== 202) throw Object.assign(new Error(`MTN transfer failed: ${r.status} ${r.raw}`), { statusCode: r.status });
  return { referenceId: refId, status: 'PENDING' };
};

// Disbursements - Get status
const getDisbursementStatus = async (referenceId) => {
  const token = await getToken('disbursements');
  const r = await rawRequest({
    hostname: MTN_HOST,
    path:     `/disbursement/v1_0/transfer/${referenceId}`,
    method:   'GET',
    headers: {
      'Authorization':             `Bearer ${token}`,
      'X-Target-Environment':      TARGET_ENV,
      'Ocp-Apim-Subscription-Key': CONFIG.disbursements.primaryKey,
    },
  }, null);
  const d = r.data || {};
  return { referenceId, status: d.status, reason: d.reason, financialTxnId: d.financialTransactionId, amount: parseFloat(d.amount || 0) };
};

// Disbursements - Balance
const getDisbursementBalance = async () => {
  const token = await getToken('disbursements');
  const r = await rawRequest({
    hostname: MTN_HOST,
    path:     '/disbursement/v1_0/account/balance',
    method:   'GET',
    headers: {
      'Authorization':             `Bearer ${token}`,
      'X-Target-Environment':      TARGET_ENV,
      'Ocp-Apim-Subscription-Key': CONFIG.disbursements.primaryKey,
    },
  }, null);
  return { balance: parseFloat(r.data?.availableBalance || 0), currency: r.data?.currency };
};

const validateAccount = async (phone, product = 'collections') => {
  const token = await getToken(product);
  const cfg   = CONFIG[product];
  const msisdn = toMtnMsisdn(phone);
  const r = await rawRequest({
    hostname: MTN_HOST,
    path:     `/${product}/v1_0/accountholder/msisdn/${msisdn}/active`,
    method:   'GET',
    headers: {
      'Authorization':             `Bearer ${token}`,
      'X-Target-Environment':      TARGET_ENV,
      'Ocp-Apim-Subscription-Key': cfg.primaryKey,
    },
  }, null);
  return { active: r.data === true || r.data?.result === true, phone: msisdn };
};

const pollStatus = async (referenceId, product, { maxAttempts = 10, intervalMs = 3000 } = {}) => {
  const getFn = product === 'collections' ? getCollectionStatus : getDisbursementStatus;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, intervalMs));
    const s = await getFn(referenceId);
    if (s.status === 'SUCCESSFUL' || s.status === 'FAILED') return s;
  }
  return { referenceId, status: 'TIMEOUT' };
};

module.exports = {
  requestToPay, getCollectionStatus, getCollectionBalance,
  transfer, getDisbursementStatus, getDisbursementBalance,
  validateAccount, pollStatus, getToken, CONFIG,
};
