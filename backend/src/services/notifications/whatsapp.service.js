'use strict';

const https = require('https');

const requestJson = ({ host, path, method = 'POST', headers = {}, body }) => new Promise((resolve, reject) => {
  const payload = body ? JSON.stringify(body) : null;
  const req = https.request({
    host,
    path,
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      ...headers,
    },
    timeout: parseInt(process.env.WHATSAPP_TIMEOUT_MS || '20000', 10),
  }, (res) => {
    let raw = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { raw += chunk; });
    res.on('end', () => {
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { raw }; }
      if (res.statusCode >= 200 && res.statusCode < 300) return resolve(data);
      const err = new Error(data.error?.message || `WhatsApp API HTTP ${res.statusCode}`);
      err.response = data;
      reject(err);
    });
  });
  req.on('timeout', () => req.destroy(new Error('WhatsApp API timeout')));
  req.on('error', reject);
  if (payload) req.write(payload);
  req.end();
});

const sendWhatsAppText = async ({ to, text }) => {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    const err = new Error('Configuration WhatsApp manquante');
    err.code = 'WHATSAPP_NOT_CONFIGURED';
    throw err;
  }

  return requestJson({
    host: 'graph.facebook.com',
    path: `/v19.0/${phoneNumberId}/messages`,
    headers: { Authorization: `Bearer ${accessToken}` },
    body: {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { preview_url: true, body: text },
    },
  });
};

module.exports = { sendWhatsAppText };
