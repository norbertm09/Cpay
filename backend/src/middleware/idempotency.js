'use strict';

/**
 * Idempotence API (en-tête Idempotency-Key) — table idempotency_keys.
 *
 * WAVE-2 (audit prod 2.6.0, 01-§3.7) :
 *   - les réponses 2xx/4xx sont persistées et rejouées ;
 *   - purge paresseuse des clés plus vieilles que IDEMPOTENCY_TTL_HOURS (défaut 24 h), au plus
 *     une fois toutes les 10 minutes par instance ;
 *   - 409 : même clé + corps différent → IDEMPOTENCY_CONFLICT ; même clé en cours →
 *     IDEMPOTENCY_IN_PROGRESS.
 *
 * WAVE-6 (audit 17/10/2026 §1) — endpoints monétaires (MONEY_ENDPOINTS : /cash/withdraw,
 * /cash/transfers, /cash/collect, /transfer/payout, /disburse, /collect) :
 *   - une réponse 5xx ou un handler interrompu avant réponse NE SUPPRIME PLUS la clé : elle est
 *     conservée avec status_code=NULL, in_progress=false, last_error, et la ressource créée
 *     (resource_type/resource_id, posée par `attachResource(req, { type, id })` dès que
 *     l'ordre existe, AVANT l'appel opérateur) ;
 *   - un rejeu (même clé, même corps) renvoie alors l'ORDRE D'ORIGINE (200, IDEMPOTENCY_REPLAY)
 *     s'il existe, sinon 409 IDEMPOTENCY_RETRY_AFTER_ERROR : un retry ne crée jamais un
 *     second ordre.
 * DURABLE : les clés monétaires sont obligatoires et exclues de la purge TTL.
 * Leur empreinte trie les objets et exclut seulement confirm ; un challenge 428
 * sans ressource peut être repris atomiquement sous la même clé et le même corps métier.
 * Les anciennes empreintes brutes restent rejouables à corps strictement identique.
 *   Les autres endpoints conservent le comportement vague 2 (5xx → clé libérée).
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

// Endpoints qui créent un mouvement de fonds (chemin, sans préfixe de montage ni query string)
const MONEY_ENDPOINTS = ['/cash/withdraw', '/cash/transfers', '/cash/collect', '/transfer/payout', '/disburse', '/collect', '/payout'];
const isMoneyEndpoint = (req) => {
  if (String(req.method).toUpperCase() !== 'POST') return false;
  const path = String(req.originalUrl || req.url || '').split('?')[0].replace(/\/+$/, '');
  return MONEY_ENDPOINTS.some((p) => path === p || path.endsWith(p));
};

/** Purge paresseuse (jamais bloquante, au plus toutes les 10 min). */
const maybePurge = () => {
  const now = Date.now();
  if (now - _lastPurge < PURGE_INTERVAL_MS) return;
  _lastPurge = now;
  query(
    `DELETE FROM idempotency_keys WHERE created_at < NOW() - ($1 || ' hours')::interval
       AND status_code IS NOT NULL AND in_progress = FALSE
       AND NOT EXISTS (
         SELECT 1 FROM unnest($2::text[]) AS money(suffix)
         WHERE endpoint LIKE 'POST %' AND right(rtrim(endpoint, '/'), length(suffix)) = suffix
       )`,
    [String(ttlHours()), MONEY_ENDPOINTS]
  ).catch((err) => logger.warn('Idempotency purge failed', { err: err.message }));
};
/** Tests / ops : force la prochaine purge. */
const _resetPurgeClock = () => { _lastPurge = 0; };

const hashBody = (body) => crypto.createHash('sha256')
  .update(JSON.stringify(body || {}))
  .digest('hex');

// Authentication is renewable; only business data defines a monetary intention.
// Keep the old raw hash as a read-only compatibility check for pre-existing keys.
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])])
  );
  return value;
};
const moneyHash = (body) => {
  const business = { ...(body || {}) };
  delete business.confirm;
  return hashBody(canonical(business));
};

const deleteKey = (merchantId, endpoint, key) => query(
  `DELETE FROM idempotency_keys WHERE merchant_id = $1 AND endpoint = $2 AND key = $3`,
  [merchantId, endpoint, key]
).catch((err) => logger.error('Idempotency cleanup failed', { err: err.message }));

// Clé conservée après une erreur serveur : plus « en cours », ressource référencée si connue
const markFailed = (merchantId, endpoint, key, lastError, resource) => query(
  `UPDATE idempotency_keys
   SET status_code = NULL, response_body = NULL, in_progress = FALSE, failed_at = NOW(), last_error = $4,
       resource_type = COALESCE($5, resource_type), resource_id = COALESCE($6, resource_id)
   WHERE merchant_id = $1 AND endpoint = $2 AND key = $3`,
  [merchantId, endpoint, key, String(lastError || 'server_error').slice(0, 500), resource?.type || null, resource?.id ? String(resource.id) : null]
).catch((err) => logger.error('Idempotency mark-failed failed', { err: err.message }));

const keyContext = (req) => {
  const key = req.headers['idempotency-key'];
  if (!key) return null;
  return {
    key,
    merchantId: req.user?.merchantId || req.user?.sub || 'anonymous',
    endpoint: `${req.method} ${req.originalUrl.split('?')[0]}`,
  };
};

/**
 * WAVE-6 : référence la ressource créée par le handler (ordre de retrait, transaction) sur la clé
 * en cours — à appeler dès que la ligne existe, avant l'appel opérateur. Sans en-tête : no-op.
 * @param {object} req
 * @param {{ type: 'merchant_transfer'|'transaction', id: string }} resource
 */
const attachResource = async (req, resource) => {
  if (!req || !resource || !resource.id) return false;
  req.idempotencyResource = { type: resource.type || 'merchant_transfer', id: String(resource.id) };
  const ctx = keyContext(req);
  if (!ctx) return false;
  try {
    await query(
      `UPDATE idempotency_keys SET resource_type = $4, resource_id = $5
       WHERE merchant_id = $1 AND endpoint = $2 AND key = $3`,
      [ctx.merchantId, ctx.endpoint, ctx.key, req.idempotencyResource.type, req.idempotencyResource.id]);
    return true;
  } catch (err) {
    logger.error('Idempotency attachResource failed', { err: err.message, resource: req.idempotencyResource });
    return false;
  }
};

// Rejeu d'une clé en erreur : ressource d'origine si elle existe (jamais un nouvel ordre)
const loadResource = async (row, merchantId) => {
  if (!row.resource_id) return null;
  if (row.resource_type === 'transaction') {
    const r = await query(
      `SELECT transaction_id, merchant_id, type, amount, currency, fee_amount, net_amount, status, gateway_order_id, gateway_payment_id, response_message, initiated_at, completed_at
       FROM transactions WHERE transaction_id = $1`, [row.resource_id]);
    const t = r.rows[0];
    if (!t) return null;
    return {
      resourceType: 'transaction', txnId: t.transaction_id, status: t.status, amount: Number(t.amount), currency: t.currency,
      fee: Number(t.fee_amount || 0), net: Number(t.net_amount || 0), reference: t.gateway_order_id || null,
      gatewayReference: t.gateway_payment_id || null, message: t.response_message || null, createdAt: t.initiated_at, finalizedAt: t.completed_at || null,
    };
  }
  const cash = require('../services/cash/cash.service');
  const t = await cash.getTransfer(row.resource_id, UUID_RE.test(String(merchantId)) ? { merchantId } : {});
  if (!t) return null;
  return { resourceType: 'merchant_transfer', ...cash.serializeTransfer(t) };
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const idempotency = async (req, res, next) => {
  const key = req.headers['idempotency-key'];
  const money = isMoneyEndpoint(req);
  if (!key) {
    if (money) return res.status(400).json({ error: 'Idempotency-Key requis', code: 'IDEMPOTENCY_KEY_REQUIRED' });
    return next();
  }
  if (typeof key !== 'string' || key.length < 8 || key.length > 128) {
    return res.status(400).json({ error: 'Idempotency-Key invalide', code: 'INVALID_IDEMPOTENCY_KEY' });
  }

  const { merchantId, endpoint } = keyContext(req);
  const requestHash = money ? moneyHash(req.body) : hashBody(req.body);
  let reclaimed = false;

  maybePurge();

  try {
    const existing = await query(
      `SELECT status_code, response_body, request_hash, in_progress, last_error, resource_type, resource_id
       FROM idempotency_keys
       WHERE merchant_id = $1 AND endpoint = $2 AND key = $3`,
      [merchantId, endpoint, key]
    );

    if (existing.rows.length) {
      const row = existing.rows[0];
      if (row.request_hash !== requestHash && !(money && row.request_hash === hashBody(req.body))) {
        return res.status(409).json({ error: 'Idempotency-Key deja utilisee avec une requete differente', code: 'IDEMPOTENCY_CONFLICT' });
      }
      if (row.status_code === null || row.status_code === undefined) {
        if (row.in_progress === false) {
          // WAVE-6 : requête précédente terminée en erreur serveur → ressource d'origine ou 409, jamais un doublon
          const resource = await loadResource(row, merchantId).catch((err) => { logger.error('Idempotency replay lookup failed', { err: err.message }); return null; });
          if (resource) {
            return res.status(200).json({ ...resource, replayed: true, code: 'IDEMPOTENCY_REPLAY', lastError: row.last_error || null,
              message: 'Ordre d’origine renvoyé : la requête précédente avait échoué côté serveur après la création de l’ordre' });
          }
          return res.status(409).json({
            error: 'La requête précédente avec cette clé a échoué côté serveur : vérifiez vos opérations avant de réessayer avec une nouvelle clé',
            code: 'IDEMPOTENCY_RETRY_AFTER_ERROR', lastError: row.last_error || null,
            resourceType: row.resource_type || null, resourceId: row.resource_id || null,
          });
        }
        // Ligne réservée, réponse pas encore persistée : requête concurrente en cours
        return res.status(409).json({ error: 'Requete identique en cours de traitement', code: 'IDEMPOTENCY_IN_PROGRESS' });
      }
      // A challenge is issued before any order exists. Atomically reclaim it,
      // retaining the original business hash even while authentication is renewed.
      if (money && row.status_code === 428 && row.response_body?.code === 'STEP_UP_REQUIRED'
          && !row.resource_id && !row.resource_type) {
        const claimed = await query(
          `UPDATE idempotency_keys SET status_code = NULL, response_body = NULL, in_progress = TRUE
           WHERE merchant_id = $1 AND endpoint = $2 AND key = $3
             AND status_code = 428 AND response_body->>'code' = 'STEP_UP_REQUIRED'
             AND resource_id IS NULL AND resource_type IS NULL RETURNING key`,
          [merchantId, endpoint, key]);
        if (!claimed.rows.length) return res.status(409).json({ code: 'IDEMPOTENCY_IN_PROGRESS', error: 'Requete identique en cours de traitement' });
        reclaimed = true;
      } else {
        return res.status(row.status_code).json(row.response_body);
      }
    }

    if (!reclaimed) await query(
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
        if (money) {
          // WAVE-6 : erreur serveur sur un endpoint monétaire → clé conservée, ressource référencée
          const resource = req.idempotencyResource || (body && (body.transferId || body.txnId)
            ? { type: body.txnId && !body.transferId ? 'transaction' : 'merchant_transfer', id: body.transferId || body.txnId } : null);
          markFailed(merchantId, endpoint, key, (body && (body.code || body.error)) || `HTTP ${status}`, resource);
        } else {
          // 5xx : ne jamais rejouer une erreur serveur — on libère la clé pour un retry client
          deleteKey(merchantId, endpoint, key);
        }
      } else {
        const saved = query(
          `UPDATE idempotency_keys
           SET status_code = $1, response_body = $2, completed_at = NOW(), in_progress = FALSE
           WHERE merchant_id = $3 AND endpoint = $4 AND key = $5`,
          [status, body, merchantId, endpoint, key]
        );
        // Persist a renewable challenge before exposing it to an immediate retry.
        if (money && status === 428 && body?.code === 'STEP_UP_REQUIRED') {
          saved.then(() => originalJson(body)).catch((err) => {
            logger.error('Idempotency save failed', { err: err.message });
            res.status(503);
            originalJson({ error: 'Controle idempotence indisponible', code: 'IDEMPOTENCY_UNAVAILABLE' });
          });
          return res;
        }
        saved.catch((err) => logger.error('Idempotency save failed', { err: err.message }));
      }
    }
    return originalJson(body);
  };

  // Handler terminé sans res.json (exception avant réponse, res.send/end, connexion coupée…) :
  //   - endpoint monétaire (WAVE-6) : issue inconnue → clé conservée en erreur (rejeu = ordre d'origine ou 409) ;
  //   - autres : la clé réservée est libérée pour ne pas bloquer définitivement le client.
  const onAbort = (reason) => {
    if (settled) return;
    settled = true;
    if (money) markFailed(merchantId, endpoint, key, reason, req.idempotencyResource || null);
    else deleteKey(merchantId, endpoint, key);
  };
  res.on('finish', () => onAbort(`no_json_response (HTTP ${res.statusCode})`));
  res.on('close',  () => onAbort('connection_closed'));

  next();
};

module.exports = { idempotency, attachResource, isMoneyEndpoint, MONEY_ENDPOINTS, _resetPurgeClock, _ttlHours: ttlHours };
