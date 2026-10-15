'use strict';

/**
 * Idempotence API (en-tête Idempotency-Key) — table idempotency_keys.
 *
 * WAVE-2 (audit prod 2.6.0, 01-§3.7) :
 *   - seules les réponses 2xx/4xx sont persistées et rejouées ; une réponse 5xx supprime la clé
 *     pour que le client puisse réessayer ;
 *   - si le handler lève avant de répondre, la clé « en cours » est supprimée (plus de clé éternelle) ;
 *   - purge paresseuse des clés plus vieilles que IDEMPOTENCY_TTL_HOURS (défaut 24 h), au plus
 *     une fois toutes les 10 minutes par instance ;
 *   - 409 conservés : même clé + corps différent → IDEMPOTENCY_CONFLICT ; même clé en cours →
 *     IDEMPOTENCY_IN_PROGRESS.
 */

const crypto = require('crypto');
const { query } = require('../config/database');
const logger = require('../config/logger');

const PURGE_INTERVAL_MS = 10 * 60 * 1000;
let _lastPurge = 0;

const ttlHours = () => {
  const n = parseInt(process.env.IDEMPOTENCY_TTL_HOURS, 10);
  return Number.isFinite(n) && n > 0 ? n : 24;
};

/** Purge paresseuse (jamais bloquante, au plus toutes les 10 min). */
const maybePurge = () => {
  const now = Date.now();
  if (now - _lastPurge < PURGE_INTERVAL_MS) return;
  _lastPurge = now;
  query(
    `DELETE FROM idempotency_keys WHERE created_at < NOW() - ($1 || ' hours')::interval`,
    [String(ttlHours())]
  ).catch((err) => logger.warn('Idempotency purge failed', { err: err.message }));
};
/** Tests / ops : force la prochaine purge. */
const _resetPurgeClock = () => { _lastPurge = 0; };

const hashBody = (body) => crypto.createHash('sha256')
  .update(JSON.stringify(body || {}))
  .digest('hex');

const deleteKey = (merchantId, endpoint, key) => query(
  `DELETE FROM idempotency_keys WHERE merchant_id = $1 AND endpoint = $2 AND key = $3`,
  [merchantId, endpoint, key]
).catch((err) => logger.error('Idempotency cleanup failed', { err: err.message }));

const idempotency = async (req, res, next) => {
  const key = req.headers['idempotency-key'];
  if (!key) return next();
  if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
    return res.status(400).json({ error: 'Idempotency-Key invalide', code: 'INVALID_IDEMPOTENCY_KEY' });
  }

  const merchantId = req.user?.merchantId || req.user?.sub || 'anonymous';
  const endpoint = `${req.method} ${req.originalUrl.split('?')[0]}`;
  const requestHash = hashBody(req.body);

  maybePurge();

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
      if (row.status_code === null || row.status_code === undefined) {
        // Ligne réservée, réponse pas encore persistée : requête concurrente en cours
        return res.status(409).json({ error: 'Requete identique en cours de traitement', code: 'IDEMPOTENCY_IN_PROGRESS' });
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

  let settled = false;
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (!settled) {
      settled = true;
      const status = res.statusCode;
      if (status >= 500) {
        // 5xx : ne jamais rejouer une erreur serveur — on libère la clé pour un retry client
        deleteKey(merchantId, endpoint, key);
      } else {
        query(
          `UPDATE idempotency_keys
           SET status_code = $1, response_body = $2, completed_at = NOW()
           WHERE merchant_id = $3 AND endpoint = $4 AND key = $5`,
          [status, body, merchantId, endpoint, key]
        ).catch((err) => logger.error('Idempotency save failed', { err: err.message }));
      }
    }
    return originalJson(body);
  };

  // Handler terminé sans res.json (exception avant réponse, res.send/end, connexion coupée…) :
  // la clé réservée est libérée pour ne pas bloquer définitivement le client.
  res.on('finish', () => { if (!settled) { settled = true; deleteKey(merchantId, endpoint, key); } });
  res.on('close',  () => { if (!settled) { settled = true; deleteKey(merchantId, endpoint, key); } });

  next();
};

module.exports = { idempotency, _resetPurgeClock, _ttlHours: ttlHours };
