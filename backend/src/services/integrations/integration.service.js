'use strict';

const crypto = require('crypto');
const { query } = require('../../config/database');
const logger = require('../../config/logger');

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

const signPayload = (secret, payload) =>
  crypto.createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex');

const deliverEvent = async ({ merchantId, eventType, payload }) => {
  const integrations = await query(
    `SELECT * FROM merchant_integrations
     WHERE merchant_id=$1 AND status='active' AND $2 = ANY(event_types) AND endpoint_url IS NOT NULL`,
    [merchantId, eventType]
  );

  await Promise.allSettled(integrations.rows.map(async (integration) => {
    const body = { eventType, merchantId, payload, sentAt: new Date().toISOString() };
    try {
      const res = await fetch(integration.endpoint_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CPlus-Event': eventType,
          'X-CPlus-Signature': signPayload(integration.signing_secret, body),
        },
        body: JSON.stringify(body),
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
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return { contentType: 'text/csv', body: [cols.join(','), ...result.rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n') };
};

module.exports = { listIntegrations, upsertIntegration, deliverEvent, exportTransactions };
