/**
 * Webhooks Mobile Money (Orange, Wave, Africell, Express Union, Free Money, Moov) — WAVE-2
 * (audit prod 2.6.0, 02-§4 : « créer les routes Wave (signature), Orange, Africell… »).
 *
 * Montage (server.js) :
 *   - POST /api/v1/webhooks/<WEBHOOK_PATH_SECRET>/:provider   (secretRouter — segment secret, temps constant)
 *   - chemins publics historiques donnés aux opérateurs       (legacyRouter, monté sur /webhooks) :
 *       POST /webhooks/orange                       (notif_url Orange Web Payment)
 *       POST /webhooks/wave[/:kind/:txnId]          (webhook Wave signé)
 *       GET  /webhooks/wave/:kind/:txnId            (redirection navigateur success/error — aucun changement d'état)
 *       POST /webhooks/africell/:txnId, /webhooks/express_union/:txnId, /webhooks/free_money/:txnId, /webhooks/moov[/:txnId]
 *
 * Règles (mêmes principes que hotfix-v1 webhook-handlers.js) :
 *   * fail-closed : Wave → HMAC Wave-Signature obligatoire ; Orange → notif_token = gateway_payment_id
 *     stocké à l'initiation ; providers sans signature → en-tête X-Webhook-Token (<PROVIDER>_WEBHOOK_TOKEN
 *     ou extra_params.webhookToken) obligatoire sur les chemins legacy, secret d'URL suffisant sur le
 *     chemin secret ; si le provider expose getStatus() et qu'un statusPath est configuré, le statut
 *     opérateur re-interrogé prime (injoignable → 202, transaction laissée pending) ;
 *   * lookup par transaction_id ou gateway_payment_id, claim atomique `AND status='pending'` ;
 *   * montant / devise du callback comparés à la transaction (409 AMOUNT_MISMATCH, aucun changement) ;
 *   * rejeu idempotent (transaction déjà finalisée → 200 already_processed) ;
 *   * journal : webhook_events (007) + transaction_events ; authorized → settlement_queue
 *     (encaissements uniquement) + pay_links.status='paid' si transactions.pay_link_id (008_wave2).
 */
'use strict';

const express = require('express');
const crypto  = require('crypto');
const { query } = require('../config/database');
const logger  = require('../config/logger');
const settlementQueue = require('../services/settlement/settlement.queue');
const mmRouter = require('../services/mobilemoney/mobilemoney.router');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ─── Helpers ──────────────────────────────────────────────────────

const _loggedOnce = new Set();
const logOnce = (key, message, meta) => {
  if (_loggedOnce.has(key)) return;
  _loggedOnce.add(key);
  logger.error(message, meta || {});
};

const timingSafeEqualStr = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8'); const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
};

/** Corps brut signé : req.rawBody (express.json verify dans server.js), sinon re-sérialisation. */
const signedPayload = (req) => {
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
  return JSON.stringify(req.body || {});
};

const checkAmountCurrency = ({ expectedAmount, expectedCurrency, amount, currency }) => {
  if (amount !== undefined && amount !== null && amount !== '') {
    const a = Number(amount); const e = Number(expectedAmount);
    if (Number.isFinite(a) && Number.isFinite(e) && a > 0 && Math.abs(a - e) > 0.009) {
      return { field: 'amount', expected: e, received: a };
    }
  }
  if (currency && expectedCurrency && String(currency).toUpperCase() !== String(expectedCurrency).trim().toUpperCase()) {
    return { field: 'currency', expected: expectedCurrency, received: currency };
  }
  return null;
};

const recordWebhookEvent = async ({ provider, referenceId, status, outcome, payload, ip }) => {
  try {
    await query(
      `INSERT INTO webhook_events (provider, reference_id, provider_status, outcome, payload, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [provider, referenceId ? String(referenceId).slice(0, 128) : null, status ? String(status).slice(0, 32) : null,
       outcome ? String(outcome).slice(0, 32) : null, JSON.stringify(payload || {}), ip || null]
    );
  } catch (_) { /* jamais bloquant */ }
};

const recordTransactionEvent = async ({ transactionId, merchantId, eventType, payload }) => {
  try {
    await query(
      `INSERT INTO transaction_events (transaction_id, merchant_id, event_type, payload)
       VALUES ($1,$2,$3,$4)`,
      [transactionId, merchantId || null, eventType, JSON.stringify(payload || {})]
    );
  } catch (err) {
    logger.warn('transaction_events insert failed', { transactionId, eventType, err: err.message });
  }
};

const SETTLEABLE_TYPES = new Set(['collect', 'qr_payment', 'pay_link']);

/** Clés de gateway candidates pour charger la config d'un provider (webhookSecret / webhookToken / statusPath). */
const GATEWAY_KEYS = {
  orange: ['orange_sn', 'orange_ci', 'orange_cm', 'orange_cg', 'orange_cd'],
  wave: ['wave_sn', 'wave_ci'],
  africell: ['africell_cd'],
  express_union: ['express_union_cm'],
  free_money: ['free_money_sn'],
  moov: ['moov_ci', 'moov_cm'],
};

const gatewayKeyFor = (provider, txn) => {
  const keys = GATEWAY_KEYS[provider] || [];
  if (txn?.gateway_name && keys.includes(txn.gateway_name)) return txn.gateway_name;
  if (txn?.detected_country) {
    const byCountry = keys.find(k => k.endsWith(`_${String(txn.detected_country).toLowerCase()}`));
    if (byCountry) return byCountry;
  }
  return keys[0] || null;
};

/** Premier secret/jeton trouvé : env dédié, puis extra_params des configs du provider. */
const findProviderSetting = async (provider, field, envName) => {
  if (process.env[envName]) return process.env[envName];
  for (const key of GATEWAY_KEYS[provider] || []) {
    try {
      const cfg = await mmRouter.getConfig(key);
      if (cfg && cfg[field]) return cfg[field];
    } catch (_) { /* config indisponible */ }
  }
  return null;
};

const toOutcome = (status, okSet, koSet) => {
  const st = String(status || '').toUpperCase();
  if (okSet.includes(st)) return 'authorized';
  if (koSet.includes(st)) return 'failed';
  return null;
};
const OK_STATUSES = ['SUCCESS', 'SUCCESSFUL', 'SUCCEEDED', 'COMPLETED', 'CONFIRMED', 'OK'];
const KO_STATUSES = ['FAILED', 'FAILURE', 'ERROR', 'REJECTED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'DECLINED'];

// ─── Adaptateurs par provider ─────────────────────────────────────
//
// verify(req, raw, ctx) → { ok:boolean, code?:string, reason?:string }
// extract(body, ctx)    → { ref, gatewayRef, authCode, outcome, reason, amount, currency, notifToken? }

const ADAPTERS = {
  // Orange Money Web Payment — notif_url reçoit { status, notif_token, txnid } ; le notif_token
  // est comparé (temps constant) au token stocké dans gateway_payment_id à l'initiation.
  orange: {
    signed: true,
    verify: async () => ({ ok: true }), // vérification par notif_token dans apply()
    extract: (b) => ({
      ref:        b.order_id || b.reference || null,
      gatewayRef: b.notif_token || null,
      authCode:   b.txnid || b.transaction_id || null,
      notifToken: b.notif_token || null,
      outcome:    toOutcome(b.status, OK_STATUSES, KO_STATUSES),
      reason:     b.message || null,
      amount:     b.amount,
      currency:   b.currency,
    }),
  },

  // Wave — en-tête Wave-Signature "t=<ts>,v1=<hmac>[,v1=…]" sur "<ts><rawBody>" avec le webhook secret
  wave: {
    signed: true,
    verify: async (req, raw) => {
      const secret = await findProviderSetting('wave', 'webhookSecret', 'WAVE_WEBHOOK_SECRET');
      if (!secret) {
        logOnce('wave_secret', 'WAVE_WEBHOOK_SECRET non configuré — webhook Wave refusé (fail-closed)');
        return { ok: false, code: 'WEBHOOK_NOT_CONFIGURED' };
      }
      const header = String(req.headers['wave-signature'] || '');
      const ts = header.match(/t=([^,]+)/)?.[1];
      const sigs = [...header.matchAll(/v1=([a-fA-F0-9]+)/g)].map(m => m[1].toLowerCase());
      if (!ts || !sigs.length) return { ok: false, code: 'MISSING_SIGNATURE' };
      const expected = crypto.createHmac('sha256', secret).update(ts + raw).digest('hex');
      return sigs.some(s => timingSafeEqualStr(s, expected)) ? { ok: true } : { ok: false, code: 'INVALID_SIGNATURE' };
    },
    extract: (b, ctx) => {
      const d = b.data || b;
      const type = String(b.type || '');
      const pstatus = String(d.payment_status || d.status || '').toLowerCase();
      let outcome = null;
      if (type === 'checkout.session.completed' || pstatus === 'succeeded' || pstatus === 'success') outcome = 'authorized';
      else if (type === 'checkout.session.payment_failed' || type === 'checkout.session.failed' || pstatus === 'failed' || pstatus === 'cancelled'
               || String(d.checkout_status || '').toLowerCase() === 'expired') outcome = 'failed';
      return {
        ref:        d.client_reference || ctx.pathTxnId || null,
        gatewayRef: d.id || null,
        authCode:   d.transaction_id || d.id || null,
        outcome,
        reason:     d.last_payment_error?.message || d.error_message || null,
        amount:     d.amount,
        currency:   d.currency,
      };
    },
  },

  africell: {
    signed: false,
    extract: (b, ctx) => ({
      ref:        b.reference || ctx.pathTxnId || null,
      gatewayRef: b.transaction_id || b.id || null,
      authCode:   b.transaction_id || b.id || null,
      outcome:    toOutcome(b.status, OK_STATUSES, KO_STATUSES),
      reason:     b.message || null,
      amount:     b.amount, currency: b.currency,
    }),
  },
  express_union: {
    signed: false,
    extract: (b, ctx) => ({
      ref:        b.reference || ctx.pathTxnId || null,
      gatewayRef: b.transaction_id || null,
      authCode:   b.transaction_id || null,
      outcome:    toOutcome(b.status, OK_STATUSES, KO_STATUSES),
      reason:     b.message || null,
      amount:     b.amount, currency: b.currency,
    }),
  },
  free_money: {
    signed: false,
    extract: (b, ctx) => ({
      ref:        b.orderId || b.reference || ctx.pathTxnId || null,
      gatewayRef: b.transactionId || b.id || null,
      authCode:   b.transactionId || b.id || null,
      outcome:    toOutcome(b.status, OK_STATUSES, KO_STATUSES),
      reason:     b.message || null,
      amount:     b.amount, currency: b.currency,
    }),
  },
  moov: {
    signed: false,
    extract: (b, ctx) => ({
      ref:        b.external_transaction_id || b.reference || b.external_id || ctx.pathTxnId || null,
      gatewayRef: b.transaction_id || null,
      authCode:   b.transaction_id || null,
      outcome:    toOutcome(b.status, OK_STATUSES, KO_STATUSES),
      reason:     b.message || null,
      amount:     b.amount, currency: b.currency,
    }),
  },
};

const ENV_TOKEN_NAME = (provider) => `${provider.toUpperCase()}_WEBHOOK_TOKEN`;

/** Providers sans signature : jeton partagé obligatoire hors chemin secret. */
const verifySharedToken = async (provider, req, { viaSecretPath }) => {
  const token = await findProviderSetting(provider, 'webhookToken', ENV_TOKEN_NAME(provider));
  if (token) {
    const provided = req.headers['x-webhook-token'] || req.headers['x-callback-token'];
    return timingSafeEqualStr(String(provided || ''), String(token)) ? { ok: true } : { ok: false, code: 'INVALID_WEBHOOK_TOKEN' };
  }
  if (viaSecretPath) return { ok: true }; // le segment secret de l'URL authentifie l'appelant
  logOnce(`${provider}_token`, `${ENV_TOKEN_NAME(provider)} non configuré — callback legacy /webhooks/${provider} refusé (fail-closed) ; utilisez l'URL secrète`);
  return { ok: false, code: 'WEBHOOK_NOT_CONFIGURED' };
};

// ─── Traitement commun ────────────────────────────────────────────

const findTransaction = async (info) => {
  const r = await query(
    `SELECT transaction_id, merchant_id, type, amount, currency, status, gateway_name, gateway_payment_id,
            detected_operator, detected_country, pay_link_id
       FROM transactions
      WHERE ($1::text IS NOT NULL AND transaction_id::text = $1)
         OR ($2::text IS NOT NULL AND gateway_payment_id = $2)
      ORDER BY (status = 'pending') DESC, initiated_at DESC
      LIMIT 1`,
    [info.ref ? String(info.ref) : null, info.gatewayRef ? String(info.gatewayRef) : null]
  );
  return r.rows[0] || null;
};

/**
 * Re-interroge l'opérateur si le provider expose getStatus() et qu'un statusPath est configuré.
 * @returns {null | {status, amount, currency, gatewayRef, reason}}  null = indisponible / non configuré
 */
const requeryProvider = async (provider, txn, info) => {
  const key = gatewayKeyFor(provider, txn);
  const mod = key ? mmRouter.getProvider(key) : null;
  if (!mod || typeof mod.getStatus !== 'function') return null;
  const config = await mmRouter.getConfig(key);
  const s = await mod.getStatus({ txnId: txn.transaction_id, gatewayRef: info.gatewayRef || txn.gateway_payment_id, config });
  if (!s || s.available === false) return null;
  return s;
};

const processWebhook = async (provider, req, res, { viaSecretPath = false, pathTxnId = null } = {}) => {
  const adapter = ADAPTERS[provider];
  if (!adapter) return res.status(404).json({ error: 'Provider inconnu', code: 'UNKNOWN_PROVIDER' });

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const raw  = signedPayload(req);
  const ctx  = { viaSecretPath, pathTxnId };

  // 1. Authentification du callback
  let verdict;
  try {
    verdict = adapter.signed ? await adapter.verify(req, raw, ctx) : await verifySharedToken(provider, req, ctx);
  } catch (err) {
    logger.warn('webhook verify threw', { provider, err: err.message });
    verdict = { ok: false, code: 'VERIFY_ERROR' };
  }
  const info = adapter.extract(body, ctx) || {};
  if (!verdict.ok) {
    await recordWebhookEvent({ provider, referenceId: info.ref || info.gatewayRef, status: body.status, outcome: 'rejected', payload: body, ip: req.ip });
    const code = verdict.code || 'INVALID_SIGNATURE';
    return res.status(401).json({ error: code === 'WEBHOOK_NOT_CONFIGURED' ? 'Webhook non configuré' : 'Signature ou jeton invalide', code });
  }

  if (!info.ref && !info.gatewayRef) {
    await recordWebhookEvent({ provider, referenceId: null, status: body.status, outcome: 'unknown_reference', payload: body, ip: req.ip });
    return res.status(400).json({ error: 'Référence absente', code: 'REFERENCE_REQUIRED' });
  }

  // 2. Transaction
  const txn = await findTransaction(info);
  if (!txn) {
    await recordWebhookEvent({ provider, referenceId: info.ref || info.gatewayRef, status: body.status, outcome: 'unknown_reference', payload: body, ip: req.ip });
    return res.status(200).json({ received: true, outcome: 'unknown_reference' });
  }

  // 2b. Orange : notif_token = token stocké à l'initiation (fail-closed si absent)
  if (provider === 'orange') {
    if (!info.notifToken || !txn.gateway_payment_id || !timingSafeEqualStr(String(info.notifToken), String(txn.gateway_payment_id))) {
      logger.warn('Orange webhook: notif_token mismatch', { txnId: txn.transaction_id });
      await recordWebhookEvent({ provider, referenceId: info.ref || info.gatewayRef, status: body.status, outcome: 'rejected', payload: body, ip: req.ip });
      return res.status(401).json({ error: 'notif_token invalide', code: 'INVALID_NOTIF_TOKEN' });
    }
  }

  if (txn.status !== 'pending') {
    await recordWebhookEvent({ provider, referenceId: info.ref || info.gatewayRef, status: body.status, outcome: 'replay_ignored', payload: body, ip: req.ip });
    return res.status(200).json({ received: true, outcome: 'already_processed', status: txn.status });
  }

  // 3. Montant / devise annoncés par le callback
  const cbMismatch = checkAmountCurrency({ expectedAmount: txn.amount, expectedCurrency: txn.currency, amount: info.amount, currency: info.currency });
  if (cbMismatch) {
    logger.error('webhook: amount/currency mismatch — no state change', { provider, txnId: txn.transaction_id, ...cbMismatch });
    await recordWebhookEvent({ provider, referenceId: info.ref || info.gatewayRef, status: body.status, outcome: 'mismatch', payload: body, ip: req.ip });
    return res.status(409).json({ error: 'Montant ou devise incohérent', code: 'AMOUNT_MISMATCH' });
  }

  // 4. Re-interrogation opérateur (si disponible) : le statut opérateur prime
  let outcome  = info.outcome;
  let authCode = info.authCode;
  let reason   = info.reason;
  let providerStatus = null;
  try {
    providerStatus = await requeryProvider(provider, txn, info);
  } catch (err) {
    logger.warn('webhook: provider status unavailable — leaving pending', { provider, txnId: txn.transaction_id, err: err.message });
    await recordWebhookEvent({ provider, referenceId: info.ref || info.gatewayRef, status: body.status, outcome: 'provider_unavailable', payload: body, ip: req.ip });
    return res.status(202).json({ received: true, status: 'pending', code: 'PROVIDER_UNAVAILABLE' });
  }
  if (providerStatus) {
    const pMismatch = checkAmountCurrency({ expectedAmount: txn.amount, expectedCurrency: txn.currency, amount: providerStatus.amount, currency: providerStatus.currency });
    if (pMismatch) {
      logger.error('webhook: provider amount/currency mismatch — no state change', { provider, txnId: txn.transaction_id, ...pMismatch });
      await recordWebhookEvent({ provider, referenceId: info.ref || info.gatewayRef, status: providerStatus.status, outcome: 'mismatch', payload: body, ip: req.ip });
      return res.status(409).json({ error: 'Montant ou devise incohérent', code: 'AMOUNT_MISMATCH' });
    }
    outcome  = providerStatus.status === 'SUCCESSFUL' ? 'authorized' : providerStatus.status === 'FAILED' ? 'failed' : null;
    authCode = providerStatus.gatewayRef || authCode;
    reason   = providerStatus.reason || reason;
  }

  if (!outcome) {
    await recordWebhookEvent({ provider, referenceId: info.ref || info.gatewayRef, status: body.status, outcome: 'still_pending', payload: body, ip: req.ip });
    return res.status(202).json({ received: true, status: 'pending' });
  }

  // 5. Claim atomique
  const message = outcome === 'authorized' ? `Paiement confirmé (${provider})` : (reason || `Paiement refusé (${provider})`);
  const upd = await query(
    `UPDATE transactions
        SET status = $1, auth_code = COALESCE($2, auth_code),
            gateway_order_id = COALESCE($3, gateway_order_id),
            response_code = CASE WHEN $1 = 'authorized' THEN '00' ELSE COALESCE(response_code, '05') END,
            response_message = $4,
            completed_at = NOW()
      WHERE transaction_id = $5 AND status = 'pending'
      RETURNING transaction_id`,
    [outcome, authCode ? String(authCode).slice(0, 64) : null, info.gatewayRef ? String(info.gatewayRef).slice(0, 128) : null,
     String(message).slice(0, 500), txn.transaction_id]
  );
  if (!upd.rowCount) {
    await recordWebhookEvent({ provider, referenceId: info.ref || info.gatewayRef, status: body.status, outcome: 'replay_ignored', payload: body, ip: req.ip });
    return res.status(200).json({ received: true, outcome: 'already_processed' });
  }

  await recordTransactionEvent({
    transactionId: txn.transaction_id, merchantId: txn.merchant_id,
    eventType: `${provider.toUpperCase()}_CALLBACK`,
    payload: { outcome, authCode: authCode || null, gatewayRef: info.gatewayRef || null, providerStatus: providerStatus?.status || body.status || null, raw: body },
  });

  // 6. Effets de bord d'un encaissement confirmé
  if (outcome === 'authorized') {
    if (SETTLEABLE_TYPES.has(txn.type)) {
      try {
        await settlementQueue.enqueue({ txnId: txn.transaction_id, merchantId: txn.merchant_id, amount: Number(txn.amount), currency: txn.currency });
      } catch (err) {
        logger.error('webhook: settlement enqueue failed', { provider, txnId: txn.transaction_id, err: err.message });
      }
    }
    if (txn.pay_link_id) {
      await query(
        `UPDATE pay_links SET status='paid', paid_at=NOW(), paid_amount=$1 WHERE pay_link_id=$2 AND status='pending'`,
        [Number(txn.amount), txn.pay_link_id]
      ).catch((err) => logger.warn('webhook: pay_link update failed', { payLinkId: txn.pay_link_id, err: err.message }));
    }
  }

  await recordWebhookEvent({ provider, referenceId: info.ref || info.gatewayRef, status: providerStatus?.status || body.status, outcome, payload: body, ip: req.ip });
  logger.info('webhook: transaction mise à jour', { provider, txnId: txn.transaction_id, outcome });
  return res.status(200).json({ received: true, applied: true, status: outcome });
};

// ─── Routeur secret : /api/v1/webhooks/<WEBHOOK_PATH_SECRET>/:provider ───

const secretGuard = (req, res, next) => {
  const expected = process.env.WEBHOOK_PATH_SECRET;
  if (!expected) {
    logOnce('path_secret', 'WEBHOOK_PATH_SECRET non configuré — webhooks secrets refusés');
    return res.status(404).end();
  }
  if (!timingSafeEqualStr(String(req.params.secret || ''), String(expected))) return res.status(404).end();
  next();
};

const secretRouter = express.Router();
secretRouter.post('/:secret/:provider', secretGuard, asyncHandler((req, res) =>
  processWebhook(req.params.provider, req, res, { viaSecretPath: true })));
secretRouter.post('/:secret/:provider/:txnId', secretGuard, asyncHandler((req, res) =>
  processWebhook(req.params.provider, req, res, { viaSecretPath: true, pathTxnId: req.params.txnId })));

// ─── Routeur legacy : chemins publics historiques (/webhooks/…) ───

const legacyRouter = express.Router();
legacyRouter.post('/orange', asyncHandler((req, res) => processWebhook('orange', req, res)));
legacyRouter.post('/wave',   asyncHandler((req, res) => processWebhook('wave', req, res)));
legacyRouter.post('/wave/:kind/:txnId', asyncHandler((req, res) => processWebhook('wave', req, res, { pathTxnId: req.params.txnId })));
// Redirections navigateur Wave (success_url / error_url) : page neutre, aucun changement d'état
legacyRouter.get('/wave/:kind/:txnId', (req, res) => {
  const ok = req.params.kind === 'success';
  res.status(200).type('html').send(
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>C-Pay</title></head><body style="font-family:sans-serif;text-align:center;padding:40px">` +
    `<h2>${ok ? 'Paiement en cours de confirmation' : 'Paiement non abouti'}</h2>` +
    `<p>${ok ? 'Votre paiement Wave est en cours de validation. Vous pouvez fermer cette page.' : 'Le paiement Wave a été annulé ou a échoué. Vous pouvez réessayer.'}</p>` +
    `</body></html>`
  );
});
for (const p of ['africell', 'express_union', 'free_money', 'moov']) {
  legacyRouter.post(`/${p}`, asyncHandler((req, res) => processWebhook(p, req, res)));
  legacyRouter.post(`/${p}/:txnId`, asyncHandler((req, res) => processWebhook(p, req, res, { pathTxnId: req.params.txnId })));
}

module.exports = {
  secretRouter,
  legacyRouter,
  processWebhook,
  _adapters: ADAPTERS,
  _helpers: { checkAmountCurrency, timingSafeEqualStr, signedPayload, gatewayKeyFor },
};
