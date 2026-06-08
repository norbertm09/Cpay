/**
 * Orange Money Provider
 * Couvre : Sénégal, Côte d'Ivoire, Cameroun, Congo Brazzaville, RDC
 * API : Orange Money Web Payment API
 */
'use strict';
const https  = require('https');
const logger = require('../../../config/logger');

const collectPayment = async ({ txnId, amount, currency, phone, description, config }) => {
  logger.info('Orange collectPayment', { txnId, amount, currency });

  const result = await httpRequest('POST', config.baseUrl, '/webpayment',
    {
      merchant_key: config.apiKey,
      currency,
      order_id:    txnId,
      amount:      String(amount),
      return_url:  process.env.PAY_LINK_BASE_URL + `/callback/orange/${txnId}`,
      cancel_url:  process.env.PAY_LINK_BASE_URL + `/cancel/orange/${txnId}`,
      notif_url:   process.env.API_BASE_URL      + `/webhooks/orange`,
      lang:        'fr',
      reference:   description || 'Calculus Plus',
    }
  );

  if (result.body?.payment_url) {
    // Orange retourne une URL de paiement → flow asynchrone via webhook
    return {
      success:      null,  // en attente
      pending:      true,
      paymentUrl:   result.body.payment_url,
      payToken:     result.body.pay_token,
      notifToken:   result.body.notif_token,
      externalId:   txnId,
      errorMessage: null,
    };
  }

  return { success: false, errorMessage: result.body?.message || 'Erreur Orange Money' };
};

const sendPayout = async ({ txnId, amount, currency, phone, config }) => {
  // Orange Money payout via API propriétaire
  const result = await httpRequest('POST', config.baseUrl, '/transfer',
    { merchant_key: config.apiKey, recipient_msisdn: phone, amount: String(amount), currency, reference: txnId }
  );
  return { success: result.statusCode === 200, transactionId: result.body?.txnid };
};

const httpRequest = (method, baseUrl, path, body) => new Promise((resolve, reject) => {
  const u = new URL((baseUrl || 'https://api.orange.com') + path);
  const payload = JSON.stringify(body);
  const req = https.request({
    hostname: u.hostname, port: 443, path: u.pathname,
    method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
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
  req.on('timeout', () => { req.destroy(); reject(new Error('Orange timeout')); });
  req.write(payload);
  req.end();
});

module.exports = { collectPayment, sendPayout };
