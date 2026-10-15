'use strict';
const https = require('https');
const { URL } = require('url');

const NS = 'http://gtplimited.com/';
const SOAP_ACTION = 'http://gtplimited.com/IBaseAction/Submit';

// ─── Echappement XML ──────────────────────────────────────────────
const esc = (v) => {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
};

// ─── Construction du corps XML depuis un objet plat ───────────────
const buildFields = (data) => {
  return Object.entries(data)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `        <${k}>${esc(v)}</${k}>`)
    .join('\n');
};

// ─── Enveloppe SOAP ───────────────────────────────────────────────
const buildEnvelope = (requestType, data, requestId) => {
  const token = process.env.GTP_SECURITY_TOKEN;
  return `<?xml version="1.0" encoding="utf-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:gtp="${NS}">
  <soapenv:Header>
    <gtp:RequestHeader>
      <gtp:SecurityToken>${esc(token)}</gtp:SecurityToken>
      <gtp:RequestID>${esc(requestId)}</gtp:RequestID>
    </gtp:RequestHeader>
  </soapenv:Header>
  <soapenv:Body xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <gtp:BaseRequest>
      <gtp:RequestData xsi:type="${requestType}" xmlns="${NS}">
${buildFields(data)}
      </gtp:RequestData>
    </gtp:BaseRequest>
  </soapenv:Body>
</soapenv:Envelope>`;
};

// ─── Parsing XML minimaliste (sans dependance) ────────────────────
const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i'));
  return m ? m[1].trim() : null;
};

const tagAll = (xml, name) => {
  const re = new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
};

const unesc = (s) => {
  if (!s) return s;
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
          .replace(/&amp;/g, '&');
};

// Extrait tous les champs simples d'un bloc XML
const parseFlat = (xml) => {
  const out = {};
  const re = /<(\w+)(?:\s[^>]*)?>([^<]*)<\/\1>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    out[m[1]] = unesc(m[2].trim());
  }
  return out;
};

// ─── Appel HTTP SOAP ──────────────────────────────────────────────
const callSoap = (requestType, data) => new Promise((resolve, reject) => {
  const endpoint = process.env.GTP_ENDPOINT;
  const token = process.env.GTP_SECURITY_TOKEN;

  if (!endpoint) {
    const e = new Error('GTP_ENDPOINT non configure');
    e.code = 'GTP_NOT_CONFIGURED';
    return reject(e);
  }
  if (!token) {
    const e = new Error('GTP_SECURITY_TOKEN non configure');
    e.code = 'GTP_NOT_CONFIGURED';
    return reject(e);
  }

  const requestId = Date.now().toString() + Math.floor(Math.random() * 1000);
  const body = buildEnvelope(requestType, data, requestId);
  const url = new URL(endpoint);
  const timeout = parseInt(process.env.GTP_TIMEOUT_MS || '30000', 10);

  const opts = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'SOAPAction': `"${SOAP_ACTION}"`,
    },
    timeout,
  };

  const req = https.request(opts, (res) => {
    let raw = '';
    res.on('data', (c) => { raw += c; });
    res.on('end', () => {
      // Fault SOAP
      const fault = tag(raw, 'faultstring');
      if (fault) {
        const e = new Error(`GTP SOAP Fault: ${unesc(fault)}`);
        e.code = 'GTP_SOAP_FAULT';
        e.httpStatus = res.statusCode;
        return reject(e);
      }

      const statusCode  = tag(raw, 'StatusCode');
      const statusMsg   = tag(raw, 'StatusMessage');
      const responseId  = tag(raw, 'ResponseID');

      // Erreur metier GTP
      const errNum = tag(raw, 'ErrorNumber');
      if (errNum || (statusCode && statusCode !== '0')) {
        const e = new Error(unesc(tag(raw, 'ErrorMessage')) || statusMsg || 'Erreur GTP');
        e.code = 'GTP_ERROR';
        e.gtpErrorNumber = parseInt(errNum || statusCode, 10);
        e.requestId = requestId;
        return reject(e);
      }

      if (res.statusCode >= 400) {
        const e = new Error(`GTP HTTP ${res.statusCode}`);
        e.code = 'GTP_HTTP_ERROR';
        e.httpStatus = res.statusCode;
        e.raw = raw.slice(0, 500);
        return reject(e);
      }

      const dataBlock = tag(raw, 'ResponseData') || raw;
      resolve({
        requestId,
        responseId,
        statusCode: parseInt(statusCode || '0', 10),
        raw,
        data: dataBlock,
        parsed: parseFlat(dataBlock),
      });
    });
  });

  req.on('timeout', () => {
    req.destroy();
    const e = new Error('GTP timeout');
    e.code = 'GTP_TIMEOUT';
    reject(e);
  });

  req.on('error', (err) => {
    err.code = err.code || 'GTP_NETWORK_ERROR';
    reject(err);
  });

  req.write(body);
  req.end();
});

// ─── Detection de configuration ───────────────────────────────────
const isConfigured = () => {
  return Boolean(
    process.env.GTP_ENDPOINT &&
    process.env.GTP_SECURITY_TOKEN &&
    process.env.GTP_SUB_COMPANY
  );
};

module.exports = { callSoap, tag, tagAll, parseFlat, unesc, buildEnvelope, isConfigured };
