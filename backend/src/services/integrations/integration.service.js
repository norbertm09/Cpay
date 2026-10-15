'use strict';

const net = require('net');
const dns = require('dns').promises;
const { query } = require('../../config/database');
const logger = require('../../config/logger');

// Delai maximal d'un appel sortant (webhook / integration) : 10 s
const OUTBOUND_TIMEOUT_MS = 10000;

// ─── CSV sur : quoting, echappement des guillemets, anti-injection de formule ──
// Toute cellule est entouree de guillemets, les guillemets internes sont doubles
// et une cellule commencant par = + - @ (ou tab / CR) est prefixee d'une apostrophe
// pour qu'Excel / LibreOffice ne l'interprete pas comme une formule.
const csvCell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
const csvRow = (values) => values.map(csvCell).join(',');

// ─── Garde SSRF pour les URLs de webhook sortantes ────────────────
// Refuse tout ce qui n'est pas https:// et toute cible loopback / privee /
// link-local / multicast / reserved, en IPv4 comme en IPv6 (y compris IPv4-mapped).
const ipv4ToInt = (ip) => ip.split('.').reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
const IPV4_BLOCKED = [
  ['0.0.0.0', 8],        // "this" network
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // CGNAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (metadonnees cloud incluses)
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved + broadcast
].map(([base, bits]) => [ipv4ToInt(base), bits]);

const isBlockedIPv4 = (ip) => {
  const n = ipv4ToInt(ip);
  return IPV4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) >>> 0 === (base & mask) >>> 0;
  });
};

const isBlockedIPv6 = (raw) => {
  const ip = raw.toLowerCase().replace(/^\[|\]$/g, '');
  if (ip === '::' || ip === '::1') return true;
  // IPv4-mapped (::ffff:a.b.c.d) ou IPv4-compatible
  const mapped = ip.match(/^(?:0*:)*ffff:(\d+\.\d+\.\d+\.\d+)$/) || ip.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return net.isIPv4(mapped[1]) ? isBlockedIPv4(mapped[1]) : true;
  // ::ffff:XXXX:XXXX forme hexadecimale
  const mappedHex = ip.match(/^(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16), lo = parseInt(mappedHex[2], 16);
    return isBlockedIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = ip.split(':')[0].padStart(4, '0');
  if (/^f[cd]/.test(first)) return true;    // fc00::/7  ULA (prive)
  if (/^fe[89ab]/.test(first)) return true; // fe80::/10 link-local
  if (/^ff/.test(first)) return true;       // ff00::/8  multicast
  return false;
};

const isBlockedAddress = (ip) => {
  if (net.isIPv4(ip)) return isBlockedIPv4(ip);
  if (net.isIPv6(ip)) return isBlockedIPv6(ip);
  return true;
};

const isBlockedHostname = (host) => {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localdomain') || h.endsWith('.home.arpa')) return true;
  if (h === 'metadata.google.internal' || h === 'metadata') return true;
  return false;
};

/**
 * Verification synchrone (syntaxique) d'une URL de webhook :
 *  - https:// obligatoire, pas d'identifiants dans l'URL
 *  - pas d'IP litterale privee / loopback / link-local, pas de localhost
 * Retourne { ok:true, url } ou { ok:false, reason }.
 */
const isSafeWebhookUrl = (input) => {
  let url;
  try { url = new URL(String(input || '')); } catch (e) { return { ok: false, reason: 'URL invalide' }; }
  if (url.protocol !== 'https:') return { ok: false, reason: 'Seules les URLs https:// sont acceptees' };
  if (url.username || url.password) return { ok: false, reason: 'Identifiants interdits dans l\'URL' };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedHostname(host)) return { ok: false, reason: 'Hote non autorise' };
  if (net.isIP(host) && isBlockedAddress(host)) return { ok: false, reason: 'Adresse IP privee ou reservee interdite' };
  return { ok: true, url: url.toString() };
};

/**
 * Verification complete : syntaxe + resolution DNS. Toutes les adresses
 * resolues doivent etre publiques (anti DNS-rebinding partiel).
 * Leve une erreur (statusCode 422) si l'URL est refusee.
 */
const assertSafeWebhookUrl = async (input) => {
  const check = isSafeWebhookUrl(input);
  if (!check.ok) {
    const err = new Error(`Webhook URL refusee : ${check.reason}`);
    err.statusCode = 422; err.code = 'UNSAFE_WEBHOOK_URL';
    throw err;
  }
  const host = new URL(check.url).hostname.replace(/^\[|\]$/g, '');
  if (!net.isIP(host)) {
    let addrs;
    try { addrs = await dns.lookup(host, { all: true, verbatim: true }); }
    catch (e) {
      const err = new Error('Webhook URL refusee : hote introuvable (DNS)');
      err.statusCode = 422; err.code = 'UNSAFE_WEBHOOK_URL';
      throw err;
    }
    if (!addrs.length || addrs.some(a => isBlockedAddress(a.address))) {
      const err = new Error('Webhook URL refusee : resolution vers une adresse privee ou reservee');
      err.statusCode = 422; err.code = 'UNSAFE_WEBHOOK_URL';
      throw err;
    }
  }
  return check.url;
};

// fetch avec delai maximal (AbortController)
const fetchWithTimeout = async (url, options = {}, timeoutMs = OUTBOUND_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
};

const ALLOWED_TYPES = ['accounting', 'crm', 'erp', 'webhook'];
const DEFAULT_EVENTS = ['transaction.authorized', 'transaction.failed', 'settlement.completed'];

const maskAuth = (row) => ({
  ...row,
  auth_config: row.auth_config && Object.keys(row.auth_config).length ? { configured: true } : {},
  signing_secret: row.signing_secret ? `${row.signing_secret.slice(0, 8)}...` : null,
});

const listIntegrations = async (merchantId) => {
  const result = await query(
    `SELECT * FROM merchant_integrations WHERE merchant_id = $1 ORDER BY created_at DESC`,
    [merchantId]
  );
  return result.rows.map(maskAuth);
};

const upsertIntegration = async ({ merchantId, integrationId, integrationType, provider, displayName, endpointUrl, authType = 'none', authConfig = {}, eventTypes = DEFAULT_EVENTS, status = 'inactive' }) => {
  if (!ALLOWED_TYPES.includes(integrationType)) {
    const err = new Error('Type integration invalide');
    err.statusCode = 422;
    throw err;
  }
  if (!provider || !displayName) {
    const err = new Error('provider et displayName requis');
    err.statusCode = 422;
    throw err;
  }

  const result = integrationId
    ? await query(
      `UPDATE merchant_integrations SET
         integration_type=$1, provider=$2, display_name=$3, endpoint_url=$4,
         auth_type=$5, auth_config=$6::jsonb, event_types=$7, status=$8::integration_status, updated_at=NOW()
       WHERE integration_id=$9 AND merchant_id=$10 RETURNING *`,
      [integrationType, provider, displayName, endpointUrl || null, authType, JSON.stringify(authConfig || {}), eventTypes, status, integrationId, merchantId]
    )
    : await query(
      `INSERT INTO merchant_integrations
        (merchant_id, integration_type, provider, display_name, endpoint_url, auth_type, auth_config, event_types, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::integration_status) RETURNING *`,
      [merchantId, integrationType, provider, displayName, endpointUrl || null, authType, JSON.stringify(authConfig || {}), eventTypes, status]
    );

  if (!result.rows.length) return null;
  return maskAuth(result.rows[0]);
};

// WAVE-3 : signature/en-têtes partagés (X-CPay-* + X-CPlus-* de transition) — services/webhooks/outgoing.js
const outgoing = require('../webhooks/outgoing');
// Conservé pour compatibilité (hex nu, format historique des intégrations)
const signPayload = (secret, payload) => outgoing.computeHmac(secret, JSON.stringify(payload));

const deliverEvent = async ({ merchantId, eventType, payload }) => {
  const integrations = await query(
    `SELECT * FROM merchant_integrations
     WHERE merchant_id=$1 AND status='active' AND $2 = ANY(event_types) AND endpoint_url IS NOT NULL`,
    [merchantId, eventType]
  );

  await Promise.allSettled(integrations.rows.map(async (integration) => {
    const body = { eventType, merchantId, payload, sentAt: new Date().toISOString() };
    try {
      // Garde SSRF + delai 10 s sur tout appel sortant
      const safeUrl = await assertSafeWebhookUrl(integration.endpoint_url);
      const rawBody = JSON.stringify(body);
      const res = await fetchWithTimeout(safeUrl, {
        method: 'POST',
        // legacyPrefixed:false — les intégrations recevaient un hex nu dans X-CPlus-Signature
        headers: outgoing.buildHeaders({ secret: integration.signing_secret, rawBody, event: eventType, legacyPrefixed: false }),
        body: rawBody,
      });
      const text = await res.text().catch(() => '');
      await query(
        `INSERT INTO integration_delivery_logs (integration_id, merchant_id, event_type, payload, status_code, success, response_body)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [integration.integration_id, merchantId, eventType, JSON.stringify(body), res.status, res.ok, text.slice(0, 2000)]
      );
      await query(
        `UPDATE merchant_integrations SET last_sync_at=NOW(), last_error=$1, status=CASE WHEN $2 THEN status ELSE 'error'::integration_status END WHERE integration_id=$3`,
        [res.ok ? null : text.slice(0, 500), res.ok, integration.integration_id]
      );
    } catch (err) {
      logger.warn('Integration delivery failed', { merchantId, eventType, err: err.message });
      await query(
        `INSERT INTO integration_delivery_logs (integration_id, merchant_id, event_type, payload, success, error_message)
         VALUES ($1,$2,$3,$4,false,$5)`,
        [integration.integration_id, merchantId, eventType, JSON.stringify(body), err.message]
      );
      await query('UPDATE merchant_integrations SET status=$1, last_error=$2 WHERE integration_id=$3', ['error', err.message, integration.integration_id]);
    }
  }));
};

const exportTransactions = async ({ merchantId, dateFrom, dateTo, format = 'json' }) => {
  const params = [merchantId];
  let where = 'WHERE t.merchant_id=$1';
  if (dateFrom) { params.push(dateFrom); where += ` AND t.initiated_at >= $${params.length}`; }
  if (dateTo) { params.push(dateTo); where += ` AND t.initiated_at <= $${params.length}`; }
  const result = await query(
    `SELECT t.transaction_id, t.type, t.amount, t.currency, t.payment_method, t.status,
            t.gateway_name, t.auth_code, t.fee_amount, t.net_amount, t.description,
            t.initiated_at, t.completed_at, m.business_name, m.email
     FROM transactions t JOIN merchants m ON m.merchant_id=t.merchant_id
     ${where}
     ORDER BY t.initiated_at DESC LIMIT 5000`,
    params
  );

  if (format !== 'csv') return { contentType: 'application/json', body: JSON.stringify({ data: result.rows }, null, 2) };
  const cols = ['transaction_id','type','amount','currency','payment_method','status','gateway_name','auth_code','fee_amount','net_amount','description','initiated_at','completed_at'];
  return { contentType: 'text/csv', body: [csvRow(cols), ...result.rows.map(r => csvRow(cols.map(c => r[c])))].join('\n') };
};

module.exports = {
  listIntegrations, upsertIntegration, deliverEvent, exportTransactions,
  csvCell, csvRow,
  isSafeWebhookUrl, assertSafeWebhookUrl, isBlockedAddress, fetchWithTimeout,
  OUTBOUND_TIMEOUT_MS,
};
