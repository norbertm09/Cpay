/**
 * Vodacom M-Pesa Provider — RDC
 * API : Vodacom Business API (M-Pesa Open API)
 * Auth : OAuth2 Bearer Token
 */
'use strict';
const https  = require('https');
const logger = require('../../../config/logger');

const getToken = async (config) => {
  const creds = Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString('base64');
  const r = await req('GET', config.baseUrl || 'https://openapi.vodacom.cd',
    '/v1/oauth2/token?grant_type=client_credentials', null,
    { 'Authorization': `Basic ${creds}` }
  );
  return r.body?.access_token;
};

const collectPayment = async ({ txnId, amount, currency, phone, description, config }) => {
  logger.info('Vodacom M-Pesa collectPayment', { txnId, amount, currency });
  if (!config.apiKey) throw new Error('Vodacom API key not configured');

  const token = await getToken(config);
  // M-Pesa Customer to Business (C2B)
  const r = await req('POST', config.baseUrl || 'https://openapi.vodacom.cd',
    '/v1/c2b/initiate',
    {
      input_TransactionReference:  txnId,
      input_CustomerMSISDN:        phone.replace('+', ''),
      input_Amount:                String(amount),
      input_Currency:              currency || 'CDF',
      input_ServiceProviderCode:   config.serviceCode || config.apiKey,
      input_ThirdPartyConversationID: txnId,
      input_PurchasedItemsDesc:    description || 'CPlus 2.6.0',
    },
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
      'Origin':        config.origin || 'https://api.c-pay.global' }
  );

  // INS-0 a l'initiate = requete ACCEPTEE par M-Pesa (push envoye), pas un debit confirme.
  // success:true uniquement si la reponse indique explicitement une completion ;
  // sinon pending:true (callback / reconciliation finalisent).
  const accepted  = r.body?.output_ResponseCode === 'INS-0';
  const completed = accepted && isFinalSuccess(r.body);
  return {
    success:              completed,
    pending:              accepted && !completed,
    transactionId:        r.body?.output_TransactionID,
    conversationId:       r.body?.output_ConversationID,
    errorMessage:         accepted ? null : (r.body?.output_ResponseDesc || 'M-Pesa failed'),
    retryable:            ['INS-1', 'INS-9', 'INS-10'].includes(r.body?.output_ResponseCode),
  };
};

// Indicateur explicite de completion dans la reponse M-Pesa (statut de transaction final).
const isFinalSuccess = (body) => {
  const st = String(body?.output_TransactionStatus || body?.output_Status || body?.transactionStatus || '').toUpperCase();
  return ['COMPLETED', 'COMPLETE', 'SUCCESS', 'SUCCESSFUL', 'TS'].includes(st);
};

const sendPayout = async ({ txnId, amount, currency, phone, config }) => {
  logger.info('Vodacom M-Pesa sendPayout', { txnId, amount });
  const token = await getToken(config);
  // B2C — Business to Customer
  const r = await req('POST', config.baseUrl || 'https://openapi.vodacom.cd',
    '/v1/b2c/initiate',
    {
      input_TransactionReference:  txnId,
      input_CustomerMSISDN:        phone.replace('+', ''),
      input_Amount:                String(amount),
      input_Currency:              currency || 'CDF',
      input_ServiceProviderCode:   config.serviceCode || config.apiKey,
      input_ThirdPartyConversationID: txnId,
      input_PaymentItemsDesc:      'CPlus 2.6.0 retrait',
    },
    { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
      'Origin': config.origin || 'https://api.c-pay.global' }
  );
  const accepted  = r.body?.output_ResponseCode === 'INS-0';
  const completed = accepted && isFinalSuccess(r.body);
  return {
    success:       completed,
    pending:       accepted && !completed,
    transactionId: r.body?.output_TransactionID,
    errorMessage:  accepted ? null : (r.body?.output_ResponseDesc || 'M-Pesa payout failed'),
  };
};

const req = (method, base, path, body, headers) => new Promise((resolve, reject) => {
  const u = new URL(base + path);
  const p = body ? JSON.stringify(body) : null;
  const r = https.request({ hostname: u.hostname, port: 443, path: u.pathname + (u.search || ''), method,
    headers: { ...headers, ...(p ? { 'Content-Length': Buffer.byteLength(p) } : {}) }, timeout: 20000 },
    (res) => { let d = ''; res.on('data', c => { d += c; }); res.on('end', () => {
      try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: {} }); }
    }); });
  r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('Vodacom timeout')); });
  if (p) r.write(p); r.end();
});

module.exports = { collectPayment, sendPayout };
