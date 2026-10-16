/**
 * Payment Orchestration Hub
 *
 * Point d'entrée unique pour TOUTES les transactions CPlus 2.6.0.
 * Le marchand envoie uniquement : montant + phone OU montant + emvPayload.
 * Le hub décide de tout le reste.
 *
 * Flux :
 *   1. Validation entrée
 *   2. Détection automatique (pays, opérateur, réseau)
 *   3. Contrôle de plafond (niveau KYB)
 *   4. Routage vers le bon gateway
 *   5. Journalisation
 *   6. Réponse normalisée
 */

'use strict';

const { v4: uuidv4 }    = require('uuid');
const detectionEngine   = require('../detection/detection.engine');
const mobileMoneyRouter = require('../mobilemoney/mobilemoney.router');
const cardRouter        = require('../gateways/card.router');
const settlementQueue   = require('../settlement/settlement.queue');
const logger            = require('../../config/logger');
const { deliverEvent }  = require('../integrations/integration.service');
const pilotControl      = require('../pilot/pilot-control.service');
let fraudEngine; try { fraudEngine = require('../fraud/fraud.engine'); } catch { /* fraud engine optionnel */ }

// ─── Types de transaction ─────────────────────────────────────────

const TRANSACTION_TYPES = {
  COLLECT:    'collect',    // Encaissement
  PAYOUT:     'payout',     // Retrait
  QR_PAYMENT: 'qr_payment',
  PAY_LINK:   'pay_link',
};

const PAYMENT_METHODS = {
  MOBILE_MONEY: 'mobile_money',
  CARD_NFC:     'card_nfc',
  QR:           'qr',
  PAY_LINK:     'pay_link',
};

// Types reversés au marchand (encaissements). Les payouts n'entrent JAMAIS en settlement_queue.
const SETTLEABLE_TYPES = new Set([
  TRANSACTION_TYPES.COLLECT,
  TRANSACTION_TYPES.QR_PAYMENT,
  TRANSACTION_TYPES.PAY_LINK,
]);

// ─── Point d'entrée ───────────────────────────────────────────────

/**
 * Traiter une transaction — le marchand ne choisit rien.
 *
 * @param {object} params
 * @param {string}  params.merchantId        ID marchand
 * @param {string}  params.type              'collect' | 'payout'
 * @param {number}  params.amount            Montant (ex: 5000)
 * @param {string}  [params.customerPhone]   Numéro client Mobile Money
 * @param {string}  [params.emvPayload]      Données EMV NFC (carte)
 * @param {string}  [params.aidDetected]     AID NFC détecté par l'app
 * @param {string}  [params.description]     Description optionnelle
 * @param {string}  [params.deviceId]        ID terminal
 * @param {string}  [params.operatorOverride] WAVE-4 : wallet au choix du client (WAVE, EXPRESS_UNION) — caisse
 *
 * @returns {OrchestratorResult}
 */
const processTransaction = async (params) => {
  const txnId    = uuidv4();
  const { merchantId, type, amount, customerPhone, emvPayload, aidDetected, description, deviceId, payLinkId, operatorOverride } = params;

  logger.info('Orchestrator: new transaction', { txnId, merchantId, type, amount });

  // ── 1. Validation ──────────────────────────────────────────────
  const validation = validateInput(params);
  if (!validation.valid) {
    return { success: false, error: validation.error, txnId };
  }

  // ── 1b. Un retrait (payout) ne peut pas passer par une carte ────
  // Sans ce garde, POST /api/v1/payout avec emvPayload/aidDetected DÉBITAIT la
  // carte du client (card.router → authorizeCard). Refus avant tout appel gateway.
  if (type === TRANSACTION_TYPES.PAYOUT && !customerPhone && (emvPayload || aidDetected)) {
    logger.warn('Orchestrator: card payout refused', { txnId, merchantId, amount });
    return {
      success:    false,
      code:       'PAYOUT_CARD_UNSUPPORTED',
      statusCode: 422,
      error:      'Le retrait (payout) n\'est pas supporté par carte : utilisez un numéro Mobile Money',
      message:    'Retrait par carte non supporté',
      txnId,
      amount,
    };
  }

  const featureKey = customerPhone ? 'payment_mobile_money' : 'tap_to_phone';
  if (featureKey === 'tap_to_phone') {
    const gate = await pilotControl.evaluateFeature({
      merchantId,
      flagKey: featureKey,
      context: { txnId, type, amount, deviceId, aidDetected: !!aidDetected, emvPayload: !!emvPayload },
    });
    if (!gate.allowed) {
      return { success: false, error: gate.reason || 'Fonction non activee pour ce pilote', code: 'FEATURE_NOT_ENABLED', txnId, gate };
    }
  }

  // ── 2. Détection automatique ────────────────────────────────────
  let detection;
  if (customerPhone) {
    detection = operatorOverride
      ? detectionEngine.detectFromPhone(customerPhone, { operatorOverride })
      : detectionEngine.detectFromPhone(customerPhone);
  } else if (aidDetected) {
    detection = detectionEngine.detectFromAid(aidDetected);
  } else if (emvPayload) {
    // BIN sera extrait du payload par le SDK (mode passthrough)
    detection = { success: true, paymentMethod: PAYMENT_METHODS.CARD_NFC, network: 'UNKNOWN' };
  }

  if (!detection?.success) {
    logger.warn('Orchestrator: detection failed', { txnId, error: detection?.error });
    return { success: false, error: detection?.error || 'Détection du moyen de paiement échouée', txnId };
  }

  logger.info('Orchestrator: detection OK', {
    txnId,
    method: customerPhone ? 'mobile_money' : 'card',
    operator: detection.operator,
    network:  detection.network,
    country:  detection.country,
    currency: detection.currency,
  });

  // ── 3. Charger le marchand + vérifier plafond ──────────────────
  const merchantCheck = await checkMerchantLimits(merchantId, amount, detection.currency);
  if (!merchantCheck.allowed) {
    return {
      success: false,
      error:   merchantCheck.reason,
      txnId,
      limitInfo: merchantCheck,
    };
  }

  // ── 4. Créer la transaction en DB ──────────────────────────────
  await createTransactionRecord({
    txnId, merchantId, type, amount,
    currency:       detection.currency || merchantCheck.merchantCurrency,
    paymentMethod:  customerPhone ? PAYMENT_METHODS.MOBILE_MONEY : PAYMENT_METHODS.CARD_NFC,
    detectedInfo:   detection,
    description,
    deviceId,
    payLinkId:      payLinkId || null,
    status:         'pending',
  });

  // ── 4b. Fraud Engine ────────────────────────────────────────────
  if (fraudEngine) {
    const fraudResult = await fraudEngine.evaluate({
      txnId, merchantId, amount, currency: detection.currency || merchantCheck.merchantCurrency,
      paymentMethod: customerPhone ? 'mobile_money' : 'card_nfc',
      deviceId, ip: null,
    }).catch(() => ({ action: 'allow', score: 0 }));

    if (fraudResult.action === 'block') {
      logger.warn('Fraud: transaction blocked', { txnId, score: fraudResult.score });
      await updateTransactionStatus(txnId, 'failed', { error: fraudResult.blockReason });
      return { success: false, txnId, error: 'Transaction bloquée par le système de sécurité', message: 'Transaction bloquée', amount, currency: detection.currency || merchantCheck.merchantCurrency };
    }
  }

  // ── 5. Router vers la bonne passerelle ─────────────────────────
  let gatewayResult;

  try {
    if (customerPhone) {
      // Mobile Money
      const mmAction = type === TRANSACTION_TYPES.PAYOUT
        ? mobileMoneyRouter.sendPayout
        : mobileMoneyRouter.processPayment;
      gatewayResult = await mmAction({
        txnId, amount,
        currency:    detection.currency,
        phone:       detection.phone,
        operator:    detection.operator,
        gateway:     detection.gateway,
        country:     detection.country,
        type,
        description,
      });
    } else {
      // Carte NFC
      gatewayResult = await cardRouter.processCard({
        txnId, amount,
        currency:    merchantCheck.merchantCurrency,
        emvPayload,
        aid:         aidDetected,
        network:     detection.network,
        acquirer:    detection.acquirer,
        type,
        deviceId,
      });
    }
  } catch (err) {
    logger.error('Orchestrator: gateway error', { txnId, error: err.message });
    await updateTransactionStatus(txnId, 'failed', { error: err.message });
    return { success: false, error: 'Erreur de traitement du paiement', txnId };
  }

  // ── 6. Mettre à jour et répondre ───────────────────────────────
  // Un résultat provider "pending" (push accepté, PIN non encore saisi, timeout de
  // polling…) reste `pending` : jamais `failed` — la réconciliation / le webhook finalisent.
  const isPending   = gatewayResult.pending === true;
  const finalStatus = isPending ? 'pending' : (gatewayResult.approved === true ? 'authorized' : 'failed');
  await updateTransactionStatus(txnId, finalStatus, gatewayResult);
  await addTransactionEvent({
    txnId,
    merchantId,
    eventType: finalStatus === 'authorized' ? 'GATEWAY_APPROVED' : (finalStatus === 'pending' ? 'GATEWAY_PENDING' : 'GATEWAY_DECLINED'),
    payload: { responseCode: gatewayResult.responseCode, gateway: gatewayResult._gateway || gatewayResult._operator, retryable: gatewayResult.retryable || false },
  });

  // Règlement J+1 : uniquement les ENCAISSEMENTS autorisés (jamais les payouts,
  // qui étaient additionnés dans le net reversé au marchand).
  if (finalStatus === 'authorized' && SETTLEABLE_TYPES.has(type)) {
    await settlementQueue.enqueue({ txnId, merchantId, amount, currency: detection.currency || merchantCheck.merchantCurrency });
    logger.info('Orchestrator: transaction approved', { txnId, amount });
  } else if (finalStatus === 'authorized') {
    logger.info('Orchestrator: payout approved (not settled to merchant)', { txnId, amount, type });
  }

  deliverEvent({
    merchantId,
    eventType: `transaction.${finalStatus}`,
    payload: { txnId, type, amount, currency: detection.currency || merchantCheck.merchantCurrency, paymentMethod: customerPhone ? 'mobile_money' : 'card', status: finalStatus },
  }).catch((err) => logger.warn('Integration event delivery skipped', { txnId, err: err.message }));

  return {
    success:         gatewayResult.approved === true && !isPending,
    pending:         isPending,
    txnId,
    status:          finalStatus,
    amount,
    currency:        detection.currency || merchantCheck.merchantCurrency,
    paymentMethod:   customerPhone ? 'mobile_money' : 'card',
    // Infos détectées — jamais montrées au marchand mais disponibles en back office
    _detectedBrand:  detection.brand || detection.name,
    _detectedCountry: detection.country,
    authCode:        gatewayResult.authCode || null,
    message:         finalStatus === 'authorized'
      ? 'Paiement accepté'
      : (finalStatus === 'pending'
        ? 'Paiement en attente de confirmation'
        : (gatewayResult.declineReason || 'Paiement refusé')),
  };
};

/**
 * Générer un QR Code de paiement mixte (Mobile Money + Carte).
 */
const generateQRPayload = async ({ merchantId, amount, currency, description }) => {
  const gate = await pilotControl.evaluateFeature({
    merchantId,
    flagKey: 'qr_code',
    context: { amount, currency, description },
  });
  if (!gate.allowed) {
    return { success: false, error: gate.reason || 'QR Code non active pour ce pilote', code: 'FEATURE_NOT_ENABLED', gate };
  }

  const qrId = uuidv4();
  const url  = `${process.env.PAY_LINK_BASE_URL || 'https://pay.c-pay.global'}/q/${qrId}`;

  await savePaymentLink({
    id: qrId, merchantId, amount, currency, description,
    type: 'qr', url, expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  });

  return {
    success:     true,
    qrId,
    url,
    // Le QR encode l'URL — le client choisit son moyen de paiement en ouvrant le lien
    qrContent:   url,
    deepLinks: {
      orangeMoney: `om://pay?ref=${qrId}`,
      wave:        `wave://pay?ref=${qrId}`,
      mtnMomo:     `momo://pay?ref=${qrId}`,
    },
  };
};

/**
 * Générer un lien de paiement partageable.
 */
const generatePayLink = async ({ merchantId, amount, currency, description }) => {
  const gate = await pilotControl.evaluateFeature({
    merchantId,
    flagKey: 'pay_by_link',
    context: { amount, currency, description },
  });
  if (!gate.allowed) {
    return { success: false, error: gate.reason || 'Pay by Link non active pour ce pilote', code: 'FEATURE_NOT_ENABLED', gate };
  }

  const linkId = uuidv4();
  const shortId = linkId.split('-')[0];
  const url  = `${process.env.PAY_LINK_BASE_URL || 'https://pay.c-pay.global'}/p/${shortId}`;

  await savePaymentLink({
    id: linkId, shortId, merchantId, amount, currency, description,
    type: 'paylink', expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  });

  return {
    success:   true,
    linkId,
    shortId,
    url,
    shareText: `Payer ${amount} ${currency} via C-Pay : ${url}`,
    channels: {
      whatsapp: `https://wa.me/?text=${encodeURIComponent(`Payer ${amount} ${currency} : ${url}`)}`,
      sms:      `sms:?body=${encodeURIComponent(`Payer ${amount} ${currency} : ${url}`)}`,
    },
  };
};

// ─── Validation ───────────────────────────────────────────────────

const validateInput = ({ merchantId, type, amount, customerPhone, emvPayload, aidDetected }) => {
  if (!merchantId)            return { valid: false, error: 'merchantId requis' };
  if (!type)                  return { valid: false, error: 'Type de transaction requis' };
  if (!amount || amount <= 0) return { valid: false, error: 'Montant invalide' };
  if (!customerPhone && !emvPayload && !aidDetected) {
    return { valid: false, error: 'Numéro client ou données carte requis' };
  }
  if (!Object.values(TRANSACTION_TYPES).includes(type)) {
    return { valid: false, error: `Type invalide : ${type}` };
  }
  return { valid: true };
};

// ─── Limites marchands (KYB levels) ───────────────────────────────

const MERCHANT_LIMITS = {
  0: { daily: 500_000,      label: 'Compte créé'     },
  1: { daily: 5_000_000,    label: 'KYB validé'      },
  2: { daily: Infinity,     label: 'Contrat validé'   },
};

const checkMerchantLimits = async (merchantId, amount, currency) => {
  const { query } = require('../../config/database');
  const merchantResult = await query(
    `SELECT merchant_id, currency, kyb_level, merchant_status
     FROM merchants WHERE merchant_id = $1`,
    [merchantId]
  );
  if (!merchantResult.rows.length) {
    return { allowed: false, reason: 'Marchand introuvable', merchantCurrency: currency || 'XOF' };
  }
  const merchant = merchantResult.rows[0];
  if (merchant.merchant_status !== 'active') {
    return { allowed: false, reason: 'Compte marchand inactif', merchantCurrency: merchant.currency };
  }

  if (currency && String(currency).toUpperCase() !== String(merchant.currency).toUpperCase()) {
    return { allowed: false, reason: 'Devise du paiement différente de celle du marchand', merchantCurrency: merchant.currency };
  }

  const volumeResult = await query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS daily_volume
     FROM transactions
     WHERE merchant_id = $1
       AND currency = $2
       AND DATE(initiated_at) = CURRENT_DATE
       AND status IN ('pending', 'authorized')`,
    [merchantId, currency || merchant.currency]
  );

  const kybLevel = Number(merchant.kyb_level || 0);
  const limit    = MERCHANT_LIMITS[kybLevel] || MERCHANT_LIMITS[0];
  const dailyVolume = Number(volumeResult.rows[0].daily_volume || 0);
  const newDaily = dailyVolume + amount;

  if (newDaily > limit.daily) {
    return {
      allowed:          false,
      reason:           `Plafond journalier atteint (${limit.daily.toLocaleString()} ${merchant.currency})`,
      currentVolume:    dailyVolume,
      limit:            limit.daily,
      merchantCurrency: merchant.currency,
    };
  }

  return { allowed: true, merchantCurrency: merchant.currency, kybLevel, currentVolume: dailyVolume, limit: limit.daily };
};

// ─── DB helpers (stubs — brancher sur le vrai pool) ───────────────

const createTransactionRecord = async (data) => {
  const { query } = require('../../config/database');
  try {
    await query(
      `INSERT INTO transactions
         (transaction_id, merchant_id, type, amount, currency,
          payment_method, detected_operator, detected_network,
          detected_country, description, device_id, status, pay_link_id, fee_amount, net_amount, initiated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
         cpay_calculate_fee($2::uuid,$3::text,$7::text,$4::numeric,$6::text),
         $4::numeric-cpay_calculate_fee($2::uuid,$3::text,$7::text,$4::numeric,$6::text),NOW())`,
      [
        data.txnId, data.merchantId, data.type, data.amount, data.currency,
        data.paymentMethod,
        data.detectedInfo.operator || null,
        data.detectedInfo.network  || null,
        data.detectedInfo.country  || null,
        data.description || null,
        data.deviceId    || null,
        data.status,
        data.payLinkId   || null,
      ]
    );
  } catch (err) {
    logger.error('createTransactionRecord failed', { txnId: data.txnId, error: err.message });
    if (err.code === '23505' && err.constraint === 'idx_pay_link_one_active_attempt') {
      err.statusCode = 409; err.code = 'PAYMENT_IN_PROGRESS'; err.message = 'Un paiement existe déjà pour ce lien';
    }
    throw err;
  }
};

const updateTransactionStatus = async (txnId, status, gatewayData) => {
  const { query } = require('../../config/database');
  try {
    await query(
      `UPDATE transactions SET
         status = $1, auth_code = $2,
         response_code = $3, response_message = $4,
         gateway_payment_id = $5,
         gateway_name = $6,
         fee_amount = CASE WHEN $1 = 'authorized' THEN COALESCE(fee_amount,
           cpay_calculate_fee(merchant_id, type::text, detected_operator, amount, payment_method::text)) ELSE fee_amount END,
         net_amount = CASE WHEN $1 = 'authorized' THEN COALESCE(net_amount,
           amount - COALESCE(fee_amount, cpay_calculate_fee(merchant_id, type::text, detected_operator, amount, payment_method::text))) ELSE net_amount END,
         completed_at = CASE WHEN $1 = 'authorized' THEN NOW() ELSE NULL END
       WHERE transaction_id = $7`,
      [
        status,
        gatewayData.authCode     || null,
        gatewayData.responseCode || null,
        gatewayData.declineReason || gatewayData.message || null,
        gatewayData.gatewayRef   || null,
        gatewayData._gateway || gatewayData._operator || null,
        txnId,
      ]
    );
  } catch (err) {
    logger.error('updateTransactionStatus failed', { txnId, error: err.message });
    throw err;
  }
};

const savePaymentLink = async (data) => {
  const { query } = require('../../config/database');
  try {
    await query(
      `INSERT INTO pay_links (pay_link_id, merchant_id, short_id, amount, currency, description, type, short_url, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [data.id, data.merchantId, data.shortId || null, data.amount, data.currency,
       data.description, data.type, data.url || null, data.expiresAt]
    );
  } catch (err) {
    logger.error('savePaymentLink failed', { error: err.message });
    throw err;
  }
};

const addTransactionEvent = async ({ txnId, merchantId, eventType, payload }) => {
  const { query } = require('../../config/database');
  await query(
    `INSERT INTO transaction_events (transaction_id, merchant_id, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [txnId, merchantId, eventType, payload || {}]
  );
};

module.exports = {
  processTransaction,
  generateQRPayload,
  generatePayLink,
  // WAVE-4 : checkout carte hébergé (même enregistrement de transaction que l'orchestrateur)
  createTransactionRecord,
  addTransactionEvent,
  TRANSACTION_TYPES,
  PAYMENT_METHODS,
};
