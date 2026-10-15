/**
 * Interswitch Wallet Payments API (DRC)
 * OAuth2 client_credentials + mobile-wallet/initialize.
 */
'use strict';

const https = require('https');
const logger = require('../../../config/logger');

const tokenCache = new Map();

const walletProviderFromConfig = (config) => {
  if (config.walletProvider) return config.walletProvider;
  const key = config.providerKey || '';
  if (key.includes('airtel')) return 'AIRTELMONEY';
  if (key.includes('orange')) return 'ORANGE';
  if (key.includes('africell') || key.includes('afri')) return 'AFRIMONEY';
  return 'MPESA';
};

const numericCurrency = (currency) => {
  if (currency === 'USD') return '840';
  return '976';
};

const getToken = async (config) => {
  const cacheKey = config.apiKey;
  const cached = tokenCache.get(cacheKey);
  if (cached?.token && Date.now() < cached.expiresAt) return cached.token;
  if (!config.apiKey || !config.apiSecret) throw new Error('Interswitch client credentials not configured');

  const authBase = config.authBaseUrl || process.env.INTERSWITCH_AUTH_BASE_URL || 'https://passport-sandbox.interswitchng.com';
  const basic = Buffer.from(`${config.apiKey}:${config.apiSecret}`).toString('base64');
  const response = await request({
    method: 'POST',
    baseUrl: authBase,
    path: '/passport/oauth/token?grant_type=client_credentials',
    body: 'grant_type=client_credentials',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  const token = response.body?.access_token;
  if (!token) throw new Error(response.body?.error_description || 'Interswitch token missing');
  const expiresIn = Number(response.body?.expires_in || 3600);
  tokenCache.set(cacheKey, { token, expiresAt: Date.now() + Math.max(expiresIn - 60, 60) * 1000 });
  return token;
};

const collectPayment = async ({ txnId, amount, currency, phone, config }) => {
  logger.info('Interswitch Wallet collectPayment', { txnId, amount, currency, provider: config.providerKey });
  const merchantCode = config.merchantCode || config.merchantId;
  if (!merchantCode || !config.payItemId) throw new Error('Interswitch merchantCode/payItemId not configured');

  const token = await getToken(config);
  const baseUrl = config.baseUrl || process.env.INTERSWITCH_WALLET_BASE_URL || 'https://ipg-v2.k8.isw.la';
  const response = await request({
    method: 'POST',
    baseUrl,
    path: '/collections/api/v2/mobile-wallet/initialize',
    body: {
      order_id: txnId,
      order_currency: currency || 'CDF',
      customer_mobile_number: phone.replace('+', ''),
      mobile_wallet_provider: walletProviderFromConfig(config),
      pay_item_id: config.payItemId,
      merchant_code: merchantCode,
      txn_ref: txnId,
      currency: numericCurrency(currency || 'CDF'),
      order_amount: String(amount),
      merchant_country: config.merchantCountry || 'CD',
    },
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  const ok = response.statusCode >= 200 && response.statusCode < 300;
  return {
    success: ok,
    pending: ok,
    transactionId: response.body?.transactionRef || response.body?.txn_ref || response.body?.paymentId || txnId,
    externalId: response.body?.order_id || txnId,
    responseCode: ok ? '00' : String(response.body?.code || response.statusCode || '05'),
    errorMessage: ok ? null : (response.body?.message || 'Interswitch wallet payment failed'),
    retryable: response.statusCode >= 500,
  };
};

const sendPayout = async () => {
  throw new Error('Interswitch Wallet Payments API DRC supports collect initialization only');
};

const request = ({ method, baseUrl, path, body, headers }) => new Promise((resolve, reject) => {
  const url = new URL(path, baseUrl);
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const req = https.request({
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method,
    headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
    timeout: parseInt(process.env.INTERSWITCH_TIMEOUT_MS || '20000', 10),
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
  req.on('timeout', () => req.destroy(new Error('Interswitch timeout')));
  req.write(payload);
  req.end();
});

module.exports = { collectPayment, sendPayout };
