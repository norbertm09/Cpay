'use strict';

const crypto = require('crypto');
const { query } = require('../config/database');
const logger = require('../config/logger');

const hashBody = (body) => crypto.createHash('sha256')
  .update(JSON.stringify(body || {}))
  .digest('hex');

const idempotency = async (req, res, next) => {
  const key = req.headers['idempotency-key'];
  if (!key) return next();
  if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
    return res.status(400).json({ error: 'Idempotency-Key invalide', code: 'INVALID_IDEMPOTENCY_KEY' });
  }

  const merchantId = req.user?.merchantId || req.user?.sub || 'anonymous';
  const endpoint = `${req.method} ${req.originalUrl.split('?')[0]}`;
  const requestHash = hashBody(req.body);

  try {
    const existing = await query(
      `SELECT status_code, response_body, request_hash
       FROM idempotency_keys
       WHERE merchant_id = $1 AND endpoint = $2 AND key = $3`,
      [merchantId, endpoint, key]
    );

    if (existing.rows.length) {
      const row = existing.rows[0];
      if (row.request_hash !== requestHash) {
        return res.status(409).json({ error: 'Idempotency-Key deja utilisee avec une requete differente', code: 'IDEMPOTENCY_CONFLICT' });
      }
      return res.status(row.status_code).json(row.response_body);
    }

    await query(
      `INSERT INTO idempotency_keys (merchant_id, endpoint, key, request_hash)
       VALUES ($1, $2, $3, $4)`,
      [merchantId, endpoint, key, requestHash]
    );
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Requete identique en cours de traitement', code: 'IDEMPOTENCY_IN_PROGRESS' });
    }
    logger.error('Idempotency setup failed', { err: err.message });
    return res.status(503).json({ error: 'Controle idempotence indisponible', code: 'IDEMPOTENCY_UNAVAILABLE' });
  }

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    query(
      `UPDATE idempotency_keys
       SET status_code = $1, response_body = $2, completed_at = NOW()
       WHERE merchant_id = $3 AND endpoint = $4 AND key = $5`,
      [res.statusCode, body, merchantId, endpoint, key]
    ).catch((err) => logger.error('Idempotency save failed', { err: err.message }));
    return originalJson(body);
  };

  next();
};

module.exports = { idempotency };
