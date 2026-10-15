// backend/src/routes/webhook-handlers.js
// Handlers webhook Mobile Money / PSP — montés dans server.js et délégués
// depuis mtn-momo.routes.js (/api/v1/momo/webhooks/*).
//
// HOTFIX WAVE-1 (audit prod 2.6.0 §2.3 / §2.18 / 02-§4) — principes :
//   * fail-closed : signature/jeton obligatoires, sinon 401 sans changement d'état ;
//   * MTN : on ne crédite JAMAIS sur le seul callback — le statut est re-interrogé
//     auprès de MTN (GET requesttopay/{ref} ou transfer/{ref}) et seul le statut
//     renvoyé par MTN est appliqué ; provider injoignable → 202 et la transaction
//     reste `pending` ;
//   * chaque UPDATE est gardé par `AND status='pending'` (claim atomique) et le
//     crédit de solde n'est appliqué que si le claim a réussi (rejeu idempotent) ;
//   * montant/devise du callback (ou du provider) comparés à la transaction
//     stockée : divergence → log + 409 sans changement ;
//   * chaque callback est journalisé (pci_audit_logs + webhook_events +
//     transaction_events pour les transactions marchands).
'use strict';

const crypto = require('crypto');
const { query } = require('../config/database');
const { auditLog } = require('../middleware/pci.middleware');
const logger = require('../config/logger');

// ─── Helpers ──────────────────────────────────────────────────────

const _loggedOnce = new Set();
const logOnce = (key, message, meta) => {
  if (_loggedOnce.has(key)) return;
  _loggedOnce.add(key);
  logger.error(message, meta || {});
};

/** Comparaison en temps constant de deux chaînes (longueurs différentes → false). */
const timingSafeEqualStr = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
};

/** Corps brut signé : rawBody si le body-parser l'a conservé, sinon re-sérialisation. */
const signedPayload = (req) => {
  if (typeof req.rawBody === 'string') return req.rawBody;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.toString('utf8');
  return JSON.stringify(req.body || {});
};

const ZERO_DECIMAL = new Set(['XAF', 'XOF', 'GNF', 'RWF', 'UGX', 'BIF', 'DJF', 'KMF', 'VUV', 'XPF', 'CLP', 'JPY', 'KRW', 'PYG', 'VND']);
/** Montant en unité mineure (PSP carte) → unité majeure selon la devise. */
const minorToMajor = (raw, currency) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return ZERO_DECIMAL.has(String(currency || '').toUpperCase()) ? n : n / 100;
};

/**
 * Vérifie montant/devise annoncés contre la transaction stockée.
 * Les valeurs absentes/nulles ne sont pas comparées (le callback ne les porte pas toujours).
 * @returns {null|{field:string, expected:any, received:any}}
 */
const checkAmountCurrency = ({ expectedAmount, expectedCurrency, amount, currency }) => {
  if (amount !== undefined && amount !== null && amount !== '') {
    const a = Number(amount);
    const e = Number(expectedAmount);
    if (Number.isFinite(a) && Number.isFinite(e) && a > 0 && Math.abs(a - e) > 0.009) {
      return { field: 'amount', expected: e, received: a };
    }
  }
  if (currency && expectedCurrency) {
    if (String(currency).toUpperCase() !== String(expectedCurrency).toUpperCase()) {
      return { field: 'currency', expected: expectedCurrency, received: currency };
    }
  }
  return null;
};

/** Journal brut des callbacks (table webhook_events — voir 007b_hotfix_webhooks.sql). Jamais bloquant. */
const recordWebhookEvent = async ({ provider, referenceId, status, outcome, payload, ip }) => {
  try {
    await query(
      `INSERT INTO webhook_events (provider, reference_id, provider_status, outcome, payload, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [provider, referenceId ? String(referenceId).slice(0, 128) : null, status ? String(status).slice(0, 32) : null,
       outcome ? String(outcome).slice(0, 32) : null, JSON.stringify(payload || {}), ip || null]
    );
  } catch (_) { /* table absente ou DB indisponible : ne bloque jamais le webhook */ }
};

/** Événement sur une transaction marchand (même usage que server.js /webhooks/paymenthub). */
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

// ─── Application d'un statut MTN/Airtel sur une card_transaction ──
//
// Partagé par le webhook MTN, le webhook Airtel et GET /momo/status/:ref.
// Le claim `status='pending'` est fait AVANT tout mouvement de solde :
// un rejeu ne peut donc jamais créditer deux fois.

const FINAL_OK     = 'SUCCESSFUL';
const FINAL_FAILED = 'FAILED';

/** Montant que le provider doit annoncer pour cette card_transaction. */
const expectedProviderAmount = (txn) => {
  // card2momo : la jambe MoMo porte le net (débit carte − frais)
  if (txn.type === 'card2momo') return Number(txn.net_amount);
  return Number(txn.amount);
};

/**
 * @param {object} txn  ligne card_transactions (status attendu : pending)
 * @param {object} p    { status:'SUCCESSFUL'|'FAILED'|other, financialTransactionId, reason, amount, currency, provider }
 * @returns {{applied:boolean, newStatus?:string, reason?:string, mismatch?:object}}
 */
const applyCardTxnProviderStatus = async (txn, p) => {
  const providerName = p.provider || 'mtn';
  const status = String(p.status || '').toUpperCase();

  if (txn.status !== 'pending') {
    return { applied: false, reason: 'not_pending', currentStatus: txn.status };
  }

  if (status !== FINAL_OK && status !== FINAL_FAILED) {
    return { applied: false, reason: 'still_pending' };
  }

  if (status === FINAL_OK) {
    const mismatch = checkAmountCurrency({
      expectedAmount:   expectedProviderAmount(txn),
      expectedCurrency: txn.currency,
      amount:           p.amount,
      currency:         p.currency,
    });
    if (mismatch) {
      logger.error('Webhook: amount/currency mismatch — no state change', {
        provider: providerName, txnId: txn.txn_id, reference: txn.mm_reference, ...mismatch,
      });
      await auditLog({
        eventType: `${providerName.toUpperCase()}_WEBHOOK_AMOUNT_MISMATCH`, actorType: 'system',
        details: { txnId: txn.txn_id, ...mismatch }, success: false,
      });
      return { applied: false, reason: 'mismatch', mismatch };
    }

    // Claim atomique
    const upd = await query(
      `UPDATE card_transactions
         SET status='completed', completed_at=NOW(), auth_code=$1,
             metadata = COALESCE(metadata,'{}'::jsonb) || $2::jsonb
       WHERE txn_id=$3 AND status='pending'
       RETURNING txn_id, card_id, type, net_amount`,
      [String(p.financialTransactionId || p.airtelRef || txn.mm_reference || '').slice(0, 64) || null,
       JSON.stringify({ webhook: providerName, providerStatus: status, providerRef: p.financialTransactionId || p.airtelRef || null, confirmedAt: new Date().toISOString() }),
       txn.txn_id]
    );
    if (!upd.rowCount) return { applied: false, reason: 'already_processed' };

    if (txn.type === 'topup') {
      await query(
        `UPDATE virtual_cards SET balance=balance+$1, updated_at=NOW() WHERE card_id=$2`,
        [parseFloat(txn.net_amount), txn.card_id]
      );
    }
    return { applied: true, newStatus: 'completed' };
  }

  // FINAL_FAILED
  // card2momo : la carte a déjà été débitée (jambe 1) → remboursement à opérer, pas un simple 'failed'
  const failedStatus = txn.type === 'card2momo' ? 'needs_refund' : 'failed';
  const upd = await query(
    `UPDATE card_transactions
       SET status=$1, failure_reason=$2,
           metadata = COALESCE(metadata,'{}'::jsonb) || $3::jsonb
     WHERE txn_id=$4 AND status='pending'
     RETURNING txn_id`,
    [failedStatus, String(p.reason || `${providerName.toUpperCase()} FAILED`).slice(0, 255),
     JSON.stringify({ webhook: providerName, providerStatus: status, failedAt: new Date().toISOString() }),
     txn.txn_id]
  );
  if (!upd.rowCount) return { applied: false, reason: 'already_processed' };

  if (txn.type === 'unload') {
    // Déchargement échoué → recréditer la carte (montant + frais débités à l'initiation)
    await query(
      `UPDATE virtual_cards SET balance=balance+$1, updated_at=NOW() WHERE card_id=$2`,
      [parseFloat(txn.amount) + parseFloat(txn.fee || 0), txn.card_id]
    );
  }
  if (failedStatus === 'needs_refund') {
    logger.error('card2momo: MoMo leg FAILED after card debit — manual refund required', {
      txnId: txn.txn_id, cardId: txn.card_id, amount: txn.amount, reference: txn.mm_reference,
    });
  }
  return { applied: true, newStatus: failedStatus };
};

/** Charge la card_transaction liée à une référence MoMo (mm_reference ou leg2.mtnRef). */
const findCardTxnByReference = async (referenceId) => {
  const r = await query(
    `SELECT * FROM card_transactions
      WHERE mm_reference=$1
         OR metadata->'leg2'->>'mtnRef'=$1
      ORDER BY (status='pending') DESC, initiated_at DESC
      LIMIT 1`,
    [referenceId]
  );
  return r.rows[0] || null;
};

// ─── MTN MoMo Webhook ─────────────────────────────────────────────
//
// Le callback n'est qu'un signal : la source de vérité est GET requesttopay/{ref}
// (collections) ou GET transfer/{ref} (disbursements) côté MTN.

const getMtnClient = () => require('../services/rails/mtn-momo.client');

const handleMtnWebhook = async (req, res) => {
  // 0. Jeton partagé (si configuré) — comparaison en temps constant
  const token = process.env.MTN_WEBHOOK_TOKEN;
  if (token) {
    const provided = req.headers['x-webhook-token'];
    if (!timingSafeEqualStr(String(provided || ''), token)) {
      await auditLog({ eventType: 'MTN_WEBHOOK_INVALID_TOKEN', actorType: 'system', ipAddress: req.ip, success: false });
      return res.status(401).json({ error: 'Jeton webhook invalide', code: 'INVALID_WEBHOOK_TOKEN' });
    }
  }

  const body = req.body || {};
  const { referenceId, status: callbackStatus, amount: cbAmount, currency: cbCurrency } = body;
  if (!referenceId) return res.status(400).json({ error: 'referenceId requis' });

  try {
    await auditLog({
      eventType: `MTN_WEBHOOK_${String(callbackStatus || 'UNKNOWN').slice(0, 20)}`,
      actorType: 'system',
      details:   body,
      ipAddress: req.ip,
      success:   callbackStatus === 'SUCCESSFUL',
    });

    const txn = await findCardTxnByReference(referenceId);
    if (!txn) {
      await recordWebhookEvent({ provider: 'mtn', referenceId, status: callbackStatus, outcome: 'unknown_reference', payload: body, ip: req.ip });
      return res.status(200).json({ received: true, referenceId, outcome: 'unknown_reference' });
    }
    if (txn.status !== 'pending') {
      // Rejeu : rien à faire (idempotent), aucune régression possible
      await recordWebhookEvent({ provider: 'mtn', referenceId, status: callbackStatus, outcome: 'replay_ignored', payload: body, ip: req.ip });
      return res.status(200).json({ received: true, referenceId, outcome: 'already_processed', status: txn.status });
    }

    // 1. Contrôle montant/devise du callback lui-même (s'il les porte)
    const cbMismatch = checkAmountCurrency({
      expectedAmount: expectedProviderAmount(txn), expectedCurrency: txn.currency,
      amount: cbAmount, currency: cbCurrency,
    });
    if (cbMismatch) {
      logger.error('MTN webhook: callback amount/currency mismatch — ignored', { referenceId, ...cbMismatch });
      await recordWebhookEvent({ provider: 'mtn', referenceId, status: callbackStatus, outcome: 'mismatch', payload: body, ip: req.ip });
      return res.status(409).json({ error: 'Montant ou devise incohérent', code: 'AMOUNT_MISMATCH' });
    }

    // 2. Re-interroger MTN — seule source de vérité
    const isDisbursement = txn.type === 'unload' || txn.type === 'card2momo' || txn.metadata?.product === 'disbursements';
    let providerStatus;
    try {
      const mtn = getMtnClient();
      providerStatus = isDisbursement
        ? await mtn.getDisbursementStatus(referenceId)
        : await mtn.getCollectionStatus(referenceId);
    } catch (err) {
      logger.warn('MTN webhook: provider status unavailable — leaving pending', { referenceId, err: err.message });
      await recordWebhookEvent({ provider: 'mtn', referenceId, status: callbackStatus, outcome: 'provider_unavailable', payload: body, ip: req.ip });
      return res.status(202).json({ received: true, referenceId, status: 'pending', code: 'PROVIDER_UNAVAILABLE' });
    }

    const pStatus = String(providerStatus?.status || '').toUpperCase();
    if (callbackStatus && pStatus && String(callbackStatus).toUpperCase() !== pStatus) {
      logger.warn('MTN webhook: callback status differs from provider — provider wins', { referenceId, callbackStatus, providerStatus: pStatus });
    }

    const result = await applyCardTxnProviderStatus(txn, {
      provider: 'mtn',
      status:   pStatus,
      financialTransactionId: providerStatus?.financialTxnId || providerStatus?.financialTransactionId || null,
      reason:   providerStatus?.reason || body.reason || null,
      amount:   providerStatus?.amount,
      currency: providerStatus?.currency,
    });

    if (result.reason === 'mismatch') {
      await recordWebhookEvent({ provider: 'mtn', referenceId, status: pStatus, outcome: 'mismatch', payload: body, ip: req.ip });
      return res.status(409).json({ error: 'Montant ou devise incohérent', code: 'AMOUNT_MISMATCH' });
    }
    if (result.reason === 'still_pending') {
      await recordWebhookEvent({ provider: 'mtn', referenceId, status: pStatus, outcome: 'still_pending', payload: body, ip: req.ip });
      return res.status(202).json({ received: true, referenceId, status: 'pending', providerStatus: pStatus || null });
    }

    await recordWebhookEvent({ provider: 'mtn', referenceId, status: pStatus, outcome: result.applied ? result.newStatus : result.reason, payload: body, ip: req.ip });
    return res.status(200).json({ success: true, referenceId, status: pStatus, applied: result.applied, newStatus: result.newStatus || txn.status });
  } catch (err) {
    logger.error('[MTN-WEBHOOK-ERROR]', { referenceId, err: err.message });
    // Erreur interne : ne jamais confirmer, laisser MTN/la réconciliation réessayer
    return res.status(202).json({ received: true, status: 'pending' });
  }
};

// ─── Airtel Money Webhook ─────────────────────────────────────────

const verifyAirtelSignature = async (req, res) => {
  const signature = req.headers['x-airtel-signature'];
  const secret    = process.env.AIRTEL_WEBHOOK_SECRET;
  if (!secret) {
    logOnce('airtel_secret', 'AIRTEL_WEBHOOK_SECRET non configuré — webhook Airtel refusé (fail-closed)');
    await auditLog({ eventType: 'AIRTEL_WEBHOOK_NO_SECRET', actorType: 'system', ipAddress: req.ip, success: false });
    res.status(401).json({ error: 'Webhook non configuré', code: 'WEBHOOK_NOT_CONFIGURED' });
    return false;
  }
  if (!signature) {
    await auditLog({ eventType: 'AIRTEL_WEBHOOK_MISSING_SIGNATURE', actorType: 'system', ipAddress: req.ip, success: false });
    res.status(401).json({ error: 'Signature requise', code: 'MISSING_SIGNATURE' });
    return false;
  }
  const expected = crypto.createHmac('sha256', secret).update(signedPayload(req)).digest('hex');
  const provided = String(signature).trim().toLowerCase();
  if (!timingSafeEqualStr(provided, expected)) {
    await auditLog({ eventType: 'AIRTEL_WEBHOOK_INVALID_SIGNATURE', actorType: 'system', ipAddress: req.ip, success: false });
    res.status(401).json({ error: 'Signature invalide', code: 'INVALID_SIGNATURE' });
    return false;
  }
  return true;
};

const handleAirtelWebhook = async (req, res) => {
  if (!(await verifyAirtelSignature(req, res))) return;

  const body = req.body || {};
  const { transaction, data } = body;
  const txnData     = transaction || data?.transaction || {};
  const referenceId = txnData.id || body.reference;
  const status      = txnData.status || body.status;
  const airtelRef   = txnData.airtel_money_id || txnData.reference_id;
  const message     = txnData.message || body.message;
  const cbAmount    = txnData.amount ?? body.amount;
  const cbCurrency  = txnData.currency ?? body.currency;

  if (!referenceId) return res.status(400).json({ error: 'transaction.id requis' });

  const up = String(status || '').toUpperCase();
  const isSuccess = ['TS', 'SUCCESS', 'SUCCESSFUL', 'COMPLETE', 'COMPLETED'].includes(up);
  const isFailed  = ['TF', 'TE', 'FAILED', 'EXPIRED', 'REJECTED', 'CANCELLED'].includes(up);

  try {
    logger.info('[AIRTEL-WEBHOOK]', { referenceId, status, airtelRef });
    await auditLog({
      eventType: `AIRTEL_WEBHOOK_${String(status || 'UNKNOWN').slice(0, 20)}`,
      actorType: 'system',
      details:   { referenceId, status, airtelRef, message },
      ipAddress: req.ip,
      success:   isSuccess,
    });

    // ── card_transactions (portail cardholder) ──
    const cardTxn = await findCardTxnByReference(referenceId);
    if (cardTxn) {
      if (cardTxn.status !== 'pending') {
        await recordWebhookEvent({ provider: 'airtel', referenceId, status, outcome: 'replay_ignored', payload: body, ip: req.ip });
        return res.status(200).json({ received: true, referenceId, outcome: 'already_processed', status: cardTxn.status });
      }
      if (!isSuccess && !isFailed) {
        // TIP / TA : en cours, attendre le prochain callback
        await recordWebhookEvent({ provider: 'airtel', referenceId, status, outcome: 'still_pending', payload: body, ip: req.ip });
        return res.status(202).json({ received: true, referenceId, status: 'pending' });
      }
      const result = await applyCardTxnProviderStatus(cardTxn, {
        provider: 'airtel',
        status:   isSuccess ? FINAL_OK : FINAL_FAILED,
        airtelRef,
        reason:   message || `Airtel ${status}`,
        amount:   cbAmount,
        currency: cbCurrency,
      });
      if (result.reason === 'mismatch') {
        await recordWebhookEvent({ provider: 'airtel', referenceId, status, outcome: 'mismatch', payload: body, ip: req.ip });
        return res.status(409).json({ error: 'Montant ou devise incohérent', code: 'AMOUNT_MISMATCH' });
      }
      await recordWebhookEvent({ provider: 'airtel', referenceId, status, outcome: result.applied ? result.newStatus : result.reason, payload: body, ip: req.ip });
      return res.status(200).json({ success: true, referenceId, status, applied: result.applied, newStatus: result.newStatus || cardTxn.status });
    }

    // ── transactions marchands (orchestrateur : gateway_payment_id = référence Airtel) ──
    const mainRes = await query(
      `SELECT transaction_id, merchant_id, amount, currency, status, type
         FROM transactions WHERE gateway_payment_id=$1 ORDER BY initiated_at DESC LIMIT 1`,
      [referenceId]
    );
    const main = mainRes.rows[0];
    if (!main) {
      await recordWebhookEvent({ provider: 'airtel', referenceId, status, outcome: 'unknown_reference', payload: body, ip: req.ip });
      return res.status(200).json({ received: true, referenceId, outcome: 'unknown_reference' });
    }
    if (main.status !== 'pending') {
      await recordWebhookEvent({ provider: 'airtel', referenceId, status, outcome: 'replay_ignored', payload: body, ip: req.ip });
      return res.status(200).json({ received: true, referenceId, outcome: 'already_processed', status: main.status });
    }
    if (!isSuccess && !isFailed) {
      await recordWebhookEvent({ provider: 'airtel', referenceId, status, outcome: 'still_pending', payload: body, ip: req.ip });
      return res.status(202).json({ received: true, referenceId, status: 'pending' });
    }
    const mismatch = checkAmountCurrency({ expectedAmount: main.amount, expectedCurrency: main.currency, amount: cbAmount, currency: cbCurrency });
    if (mismatch) {
      logger.error('Airtel webhook: amount/currency mismatch — no state change', { referenceId, transactionId: main.transaction_id, ...mismatch });
      await recordWebhookEvent({ provider: 'airtel', referenceId, status, outcome: 'mismatch', payload: body, ip: req.ip });
      return res.status(409).json({ error: 'Montant ou devise incohérent', code: 'AMOUNT_MISMATCH' });
    }
    const newStatus = isSuccess ? 'authorized' : 'failed';
    const upd = await query(
      `UPDATE transactions SET
         status=$1,
         auth_code=CASE WHEN $1='authorized' THEN COALESCE($2, auth_code) ELSE auth_code END,
         response_code=CASE WHEN $1='authorized' THEN '00' ELSE response_code END,
         response_message=$3,
         completed_at=CASE WHEN $1='authorized' THEN NOW() ELSE completed_at END
       WHERE transaction_id=$4 AND status='pending'
       RETURNING transaction_id, merchant_id`,
      [newStatus, airtelRef || null, String(message || `Airtel ${status}`).slice(0, 255), main.transaction_id]
    );
    if (upd.rowCount) {
      await recordTransactionEvent({
        transactionId: upd.rows[0].transaction_id, merchantId: upd.rows[0].merchant_id,
        eventType: 'AIRTEL_CALLBACK', payload: { status, airtelRef, message, newStatus },
      });
    }
    await recordWebhookEvent({ provider: 'airtel', referenceId, status, outcome: upd.rowCount ? newStatus : 'already_processed', payload: body, ip: req.ip });
    return res.status(200).json({ success: true, referenceId, status, applied: !!upd.rowCount, newStatus: upd.rowCount ? newStatus : main.status });
  } catch (err) {
    logger.error('[AIRTEL-WEBHOOK-ERROR]', { referenceId, err: err.message });
    return res.status(202).json({ received: true, status: 'pending' });
  }
};

// ─── Helpers transactions marchands (PSP carte) ───────────────────

const findMerchantTxn = async (orderId) => {
  const r = await query(
    `SELECT transaction_id, merchant_id, amount, currency, status, pay_link_id
       FROM transactions
      WHERE gateway_payment_id=$1 OR gateway_order_id=$1 OR transaction_id::text=$1
      ORDER BY initiated_at DESC LIMIT 1`,
    [String(orderId)]
  );
  return r.rows[0] || null;
};

/**
 * Applique un résultat PSP (authorized/failed) sur une transaction marchand pending,
 * avec contrôle montant/devise et claim atomique.
 * @returns {{code:number, body:object, applied:boolean, isAuthorized:boolean}}
 */
const applyMerchantPspResult = async ({ provider, orderId, isAuthorized, authCode, responseCode, amount, currency, rawPayload }) => {
  const txn = await findMerchantTxn(orderId);
  if (!txn) {
    return { code: 200, applied: false, isAuthorized, body: { received: true, outcome: 'unknown_reference' } };
  }
  if (txn.status !== 'pending') {
    // Jamais de régression d'une transaction déjà finalisée (authorized/failed/…)
    return { code: 200, applied: false, isAuthorized, body: { received: true, outcome: 'already_processed', status: txn.status } };
  }
  const mismatch = checkAmountCurrency({ expectedAmount: txn.amount, expectedCurrency: txn.currency, amount, currency });
  if (mismatch) {
    logger.error(`${provider} webhook: amount/currency mismatch — no state change`, { orderId, transactionId: txn.transaction_id, ...mismatch });
    await auditLog({ eventType: `${provider.toUpperCase()}_WEBHOOK_AMOUNT_MISMATCH`, actorType: 'system', details: { orderId, ...mismatch }, success: false });
    return { code: 409, applied: false, isAuthorized, body: { error: 'Montant ou devise incohérent', code: 'AMOUNT_MISMATCH' } };
  }
  const newStatus = isAuthorized ? 'authorized' : 'failed';
  const upd = await query(
    `UPDATE transactions SET
       status=$1, auth_code=COALESCE($2, auth_code),
       response_code=$3,
       completed_at=CASE WHEN $1='authorized' THEN NOW() ELSE completed_at END
     WHERE transaction_id=$4 AND status='pending'
     RETURNING transaction_id, merchant_id`,
    [newStatus, authCode || null, responseCode != null ? String(responseCode).slice(0, 8) : null, txn.transaction_id]
  );
  if (!upd.rowCount) {
    return { code: 200, applied: false, isAuthorized, body: { received: true, outcome: 'already_processed' } };
  }
  await recordTransactionEvent({
    transactionId: txn.transaction_id, merchantId: txn.merchant_id,
    eventType: `${provider.toUpperCase()}_CALLBACK`,
    payload: { orderId, newStatus, authCode: authCode || null, responseCode: responseCode || null, raw: rawPayload || null },
  });
  if (isAuthorized) {
    await query(
      `UPDATE pay_links SET status='paid', paid_at=NOW(), paid_amount=$1
       WHERE (short_id=$2 OR pay_link_id::text=$2 OR pay_link_id::text=$3) AND status='pending'`,
      [Number(amount) > 0 ? Number(amount) : Number(txn.amount), String(orderId), txn.pay_link_id ? String(txn.pay_link_id) : '']
    ).catch(() => {});
  }
  return { code: 200, applied: true, isAuthorized, body: { received: true, applied: true, status: newStatus } };
};

// ─── CYBERSOURCE WEBHOOK ──────────────────────────────────────────
const handleCyberSourceWebhook = async (req, res) => {
  try {
    const signature = req.headers['v-c-signature'] || req.headers['x-signature'];
    const secret    = process.env.CYBERSOURCE_SHARED_SECRET;
    if (!secret) {
      logOnce('cs_secret', 'CYBERSOURCE_SHARED_SECRET non configuré — webhook CyberSource refusé (fail-closed)');
      return res.status(401).json({ error: 'Webhook non configuré', code: 'WEBHOOK_NOT_CONFIGURED' });
    }
    if (!signature) {
      return res.status(401).json({ error: 'Signature requise', code: 'MISSING_SIGNATURE' });
    }
    const expected = crypto.createHmac('sha256', secret).update(signedPayload(req)).digest('base64');
    if (!timingSafeEqualStr(String(signature).trim(), expected)) {
      logger.warn('CyberSource webhook: signature invalide', { ip: req.ip });
      return res.status(401).json({ error: 'Signature invalide', code: 'INVALID_SIGNATURE' });
    }

    const { type, data } = req.body || {};
    const orderId   = data?.object?.clientReferenceInformation?.code || data?.object?.id;
    const txnStatus = data?.object?.applicationInformation?.reasonCode;
    const authCode  = data?.object?.processorInformation?.approvalCode;
    const amount    = data?.object?.orderInformation?.amountDetails?.totalAmount;
    const currency  = data?.object?.orderInformation?.amountDetails?.currency;

    logger.info('CyberSource webhook', { type, orderId, txnStatus });
    await recordWebhookEvent({ provider: 'cybersource', referenceId: orderId, status: txnStatus, outcome: 'received', payload: req.body, ip: req.ip });

    if (!orderId) return res.status(400).json({ error: 'order id requis' });

    if (type === 'payments.payments.updated' || type === 'payments.payments.completed') {
      const isAuthorized = String(txnStatus) === '100';
      const r = await applyMerchantPspResult({
        provider: 'cybersource', orderId, isAuthorized, authCode, responseCode: txnStatus,
        amount, currency, rawPayload: { type, id: req.body?.id },
      });
      if (r.applied) {
        await triggerMerchantWebhook(orderId, isAuthorized ? 'payment.completed' : 'payment.failed');
      }
      return res.status(r.code).json(r.body);
    }

    res.json({ received: true, ignored: true });
  } catch (err) {
    logger.error('CyberSource webhook error', { err: err.message });
    res.status(500).json({ error: 'Erreur interne' });
  }
};

// ─── MIGS WEBHOOK ────────────────────────────────────────────────
const handleMigsWebhook = async (req, res) => {
  try {
    const body = req.body || {};
    const { vpc_TxnResponseCode, vpc_MerchTxnRef, vpc_AuthorizeId, vpc_Amount, vpc_Currency, vpc_SecureHash } = body;

    const secret = process.env.MIGS_SECURE_HASH;
    if (!secret) {
      logOnce('migs_secret', 'MIGS_SECURE_HASH non configuré — webhook MIGS refusé (fail-closed)');
      return res.status(401).send('ERROR');
    }
    if (!vpc_SecureHash) {
      return res.status(401).send('ERROR');
    }
    const params = Object.keys(body)
      .filter(k => k !== 'vpc_SecureHash' && k.startsWith('vpc_'))
      .sort()
      .map(k => `${k}=${body[k]}`)
      .join('&');
    const expected = crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update(params).digest('hex').toUpperCase();
    if (!timingSafeEqualStr(String(vpc_SecureHash).toUpperCase(), expected)) {
      logger.warn('MIGS webhook: signature invalide', { ip: req.ip });
      return res.status(401).send('ERROR');
    }

    if (!vpc_MerchTxnRef) return res.status(400).send('ERROR');

    const isAuthorized = String(vpc_TxnResponseCode) === '0';
    const orderId      = vpc_MerchTxnRef;
    // MIGS envoie le montant en unité mineure (centimes) — pas de décimales pour XAF/XOF
    const txnForCurrency = vpc_Currency ? null : await findMerchantTxn(orderId);
    const currency = vpc_Currency || txnForCurrency?.currency;
    const amount   = vpc_Amount != null ? minorToMajor(vpc_Amount, currency) : null;

    logger.info('MIGS webhook', { orderId, code: vpc_TxnResponseCode, auth: vpc_AuthorizeId });
    await recordWebhookEvent({ provider: 'migs', referenceId: orderId, status: vpc_TxnResponseCode, outcome: 'received', payload: body, ip: req.ip });

    const r = await applyMerchantPspResult({
      provider: 'migs', orderId, isAuthorized, authCode: vpc_AuthorizeId, responseCode: vpc_TxnResponseCode,
      amount, currency: vpc_Currency || null, rawPayload: { vpc_TransactionNo: body.vpc_TransactionNo },
    });
    if (r.code === 409) return res.status(409).send('ERROR');
    if (r.applied) {
      await triggerMerchantWebhook(orderId, isAuthorized ? 'payment.completed' : 'payment.failed');
    }
    // MIGS attend une réponse spécifique
    res.send('OK');
  } catch (err) {
    logger.error('MIGS webhook error', { err: err.message });
    res.status(500).send('ERROR');
  }
};

// ─── WEBHOOKS SORTANTS MERCHANT ───────────────────────────────────
const triggerMerchantWebhook = async (referenceOrId, event) => {
  try {
    // Trouver la transaction et le merchant
    const txnRes = await query(
      `SELECT t.*, m.webhook_url, m.webhook_secret
       FROM transactions t
       JOIN merchants m ON m.merchant_id=t.merchant_id
       WHERE t.gateway_order_id=$1 OR t.gateway_payment_id=$1 OR t.transaction_id::text=$1
       LIMIT 1`,
      [String(referenceOrId)]
    );
    if (!txnRes.rows.length) return;

    const txn = txnRes.rows[0];
    if (!txn.webhook_url) return;

    const payload = JSON.stringify({
      event,
      txnId:     txn.transaction_id,
      reference: txn.reference,
      amount:    parseFloat(txn.amount),
      currency:  txn.currency,
      status:    txn.status,
      method:    txn.payment_method,
      authCode:  txn.auth_code,
      timestamp: new Date().toISOString()
    });

    // WAVE-3 : signature + en-têtes partagés (services/webhooks/outgoing.js)
    const headers = require('../services/webhooks/outgoing').buildHeaders({
      secret: txn.webhook_secret || 'cplus-default-secret', rawBody: payload, event,
    });

    // Envoyer le webhook (avec retry)
    const url = new URL(txn.webhook_url);
    const lib = url.protocol === 'https:' ? require('https') : require('http');

    const sendWebhook = (attempt = 1) => {
      const req = lib.request({
        hostname: url.hostname,
        port:     url.port || (url.protocol === 'https:' ? 443 : 80),
        path:     url.pathname,
        method:   'POST',
        headers:  { ...headers, 'Content-Length': Buffer.byteLength(payload) },
        timeout: 10000,
      }, (res) => {
        logger.info(`Webhook merchant ${event}: HTTP ${res.statusCode} (tentative ${attempt})`);
        if (res.statusCode >= 500 && attempt < 3) {
          setTimeout(() => sendWebhook(attempt + 1), attempt * 5000);
        }
      });
      req.on('error', (e) => {
        logger.error(`Webhook merchant error (tentative ${attempt})`, { err: e.message });
        if (attempt < 3) setTimeout(() => sendWebhook(attempt + 1), attempt * 5000);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.write(payload);
      req.end();
    };

    sendWebhook();
  } catch(err) {
    logger.error('triggerMerchantWebhook error', { err: err.message });
  }
};

module.exports = {
  handleMtnWebhook,
  handleAirtelWebhook,
  handleCyberSourceWebhook,
  handleMigsWebhook,
  triggerMerchantWebhook,
  // WAVE-4 : retour navigateur du checkout carte hébergé (services/cash/card-link.service)
  applyMerchantPspResult, findMerchantTxn, minorToMajor,
  // Helpers partagés (routes momo / card2momo / tests)
  applyCardTxnProviderStatus,
  findCardTxnByReference,
  applyMerchantPspResult,
  checkAmountCurrency,
  timingSafeEqualStr,
  signedPayload,
  minorToMajor,
  recordWebhookEvent,
  recordTransactionEvent,
};
