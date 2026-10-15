'use strict';

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');

const readIfPath = (value) => {
  if (!value) return null;
  if (value.includes('BEGIN ')) return value;
  if (fs.existsSync(value)) return fs.readFileSync(value);
  return value;
};

const buildXPayToken = ({ apiKey, sharedSecret, resourcePath, queryString = '', body = '' }) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const preHash = `${timestamp}${resourcePath}${queryString}${body}`;
  const hash = crypto.createHmac('sha256', sharedSecret).update(preHash).digest('hex');
  return `xv2:${timestamp}:${hash}`;
};

const buildAuthHeaders = ({ method, resourcePath, queryString, payload }) => {
  const authType = (process.env.VISA_AUTH_TYPE || 'basic').toLowerCase();
  const userId = process.env.VISA_USER_ID || process.env.VISA_API_KEY;
  const password = process.env.VISA_PASSWORD || process.env.VISA_SHARED_SECRET;
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };

  if (authType === 'bearer') {
    headers.Authorization = `Bearer ${process.env.VISA_ACCESS_TOKEN}`;
  } else if (authType === 'xpay') {
    headers['x-pay-token'] = buildXPayToken({
      apiKey: userId,
      sharedSecret: password,
      resourcePath,
      queryString,
      body: payload || '',
    });
      headers.apikey = userId;
  } else {
    headers.Authorization = 'Basic ' + Buffer.from(`${userId}:${password}`).toString('base64');
  }

  return headers;
};

const request = ({ method = 'GET', path, query = {}, body = null, headers = {} }) => new Promise((resolve, reject) => {
  const baseUrl = process.env.VISA_BASE_URL || 'https://sandbox.api.visa.com';
  const url = new URL(path, baseUrl);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
  });
  const payload = body ? JSON.stringify(body) : '';
  const cert = readIfPath(process.env.VISA_CERT_PATH || process.env.VISA_CERT);
  const key = readIfPath(process.env.VISA_KEY_PATH || process.env.VISA_KEY);
  const ca = readIfPath(process.env.VISA_CA_PATH || process.env.VISA_CA);
  const pfx = readIfPath(process.env.VISA_PFX_PATH);

  const req = https.request({
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method,
    cert,
    key,
    ca,
    pfx,
    passphrase: process.env.VISA_KEY_PASSPHRASE || process.env.VISA_PFX_PASSPHRASE,
    headers: {
      ...buildAuthHeaders({ method, resourcePath: url.pathname, queryString: url.search.slice(1), payload }),
      ...headers,
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
    },
    timeout: parseInt(process.env.VISA_TIMEOUT_MS || '20000', 10),
  }, (res) => {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', c => { raw += c; });
    res.on('end', () => {
      let parsed = {};
      try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = { raw }; }
      resolve({ statusCode: res.statusCode, headers: res.headers, body: parsed });
    });
  });
  req.on('error', reject);
  req.on('timeout', () => req.destroy(new Error('Visa API timeout')));
  if (payload) req.write(payload);
  req.end();
});

module.exports = { request, buildXPayToken };
