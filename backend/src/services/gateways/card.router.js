/**
 * Card Router — CPlus 2.6.0
 *
 * Routing automatique basé sur le réseau carte + priorité acquéreur.
 *
 * Priorités par réseau :
 *   VISA       → CyberSource (primaire) → MIGS (fallback)
 *   MASTERCARD → MPGS        (primaire) → CyberSource (fallback)
 *   MAESTRO    → MPGS
 *   GIMAC      → GIMAC Gateway (CEMAC local)
 *   VERVE      → Interswitch
 *   UNIONPAY   → CyberSource
 *   AMEX       → CyberSource
 *   DISCOVER   → CyberSource
 *   UNKNOWN    → essai séquentiel des gateways configurés
 *
 * paymentSolution CyberSource :
 *   006 = Visa TTP (Consumer-facing Payment on COTS)
 *   014 = Mastercard Tap-to-Pay
 *
 * Failover automatique : si le gateway primaire échoue (code 96/réseau),
 * le routeur essaie automatiquement le gateway de secours.
 */
'use strict';

const logger = require('../../config/logger');

// ─── Table de routing ─────────────────────────────────────────────
//
// Chaque entrée : { primary, fallback, paymentSolution }
// paymentSolution : champ CyberSource (null pour les autres gateways)

const ROUTING_TABLE = {
  VISA:       { primary: 'cybersource', fallback: 'migs',        paymentSolution: '006' },
  MASTERCARD: { primary: 'mpgs',        fallback: 'cybersource',  paymentSolution: '014' },
  MAESTRO:    { primary: 'mpgs',        fallback: null,           paymentSolution: '014' },
  GIMAC:      { primary: 'gimac',       fallback: 'mpgs',         paymentSolution: null  },
  VERVE:      { primary: 'interswitch', fallback: 'cybersource',  paymentSolution: null  },
  UNIONPAY:   { primary: 'cybersource', fallback: null,           paymentSolution: null  },
  AMEX:       { primary: 'cybersource', fallback: 'stripe',       paymentSolution: null  },
  DISCOVER:   { primary: 'cybersource', fallback: 'stripe',       paymentSolution: null  },
  UNKNOWN:    { primary: 'cybersource', fallback: 'mpgs',         paymentSolution: null  },
};

// ─── Registry des gateways (lazy-loaded) ─────────────────────────
const GW = {
  cybersource: () => require('./cybersource.gateway'),
  mpgs:        () => require('./mpgs.gateway'),
  stripe:      () => require('./stripe.gateway'),
  migs:        () => require('./migs.gateway'),
  gimac:       () => require('./gimac.gateway'),
  interswitch: () => require('./interswitch.gateway'),
};

const isConfigured = (gwName) => ({
  cybersource: () => !!(process.env.CS_MERCHANT_ID        && process.env.CS_API_KEY_ID),
  mpgs:        () => !!(process.env.MPGS_MERCHANT_ID      && process.env.MPGS_API_PASSWORD),
  stripe:      () => !!process.env.STRIPE_SECRET_KEY,
  migs:        () => !!(process.env.MIGS_MERCHANT_ID      && process.env.MIGS_ACCESS_CODE),
  gimac:       () => !!process.env.GIMAC_MERCHANT_ID,
  interswitch: () => !!process.env.INTERSWITCH_MERCHANT_ID,
}[gwName]?.() ?? false);

// ─── Traitement d'un paiement carte ──────────────────────────────
const processCard = async ({
  txnId, amount, currency,
  emvPayload, aid, network, acquirer,
  type, deviceId, description,
  forcedGateway,           // override manuel (test, debug)
}) => {
  // Résoudre le réseau depuis l'acquéreur si network absent
  const cardNetwork = network?.toUpperCase() || resolveNetworkFromAcquirer(acquirer);
  const route       = ROUTING_TABLE[cardNetwork] || ROUTING_TABLE.UNKNOWN;

  // Override si gateway forcé
  const gwName  = forcedGateway || route.primary;
  const gwFallback = route.fallback;

  logger.info('CardRouter: route resolved', {
    txnId, cardNetwork, primary: gwName, fallback: gwFallback,
    paymentSolution: route.paymentSolution,
  });

  // ── Essai primaire ────────────────────────────────────────────
  const primaryResult = await tryGateway(gwName, {
    txnId, amount, currency, emvPayload, network: cardNetwork,
    type, deviceId, description,
    paymentSolution: route.paymentSolution,
  });

  if (primaryResult.approved) return { ...primaryResult, _gateway: gwName };

  // ── Failover si erreur réseau sur le primaire ─────────────────
  const isNetworkError = primaryResult.declineCategory === 'network_error' ||
                         primaryResult.responseCode === '96';

  if (isNetworkError && gwFallback && isConfigured(gwFallback)) {
    logger.warn('CardRouter: primary network error → failover', {
      txnId, from: gwName, to: gwFallback,
    });

    const fallbackResult = await tryGateway(gwFallback, {
      txnId, amount, currency, emvPayload, network: cardNetwork,
      type, deviceId, description,
      paymentSolution: gwFallback === 'cybersource' ? route.paymentSolution : null,
    });

    return {
      ...fallbackResult,
      _gateway:     gwFallback,
      _wasFallback: true,
      _primaryError: primaryResult.message,
    };
  }

  return { ...primaryResult, _gateway: gwName };
};

// ─── Health check de tous les gateways configurés ────────────────
const healthCheck = async () => {
  const results = {};
  await Promise.allSettled(
    Object.keys(GW)
      .filter(isConfigured)
      .map(async (name) => {
        try {
          const gw = GW[name]();
          results[name] = typeof gw.ping === 'function'
            ? await gw.ping()
            : { ok: true, reason: 'no_ping_method' };
        } catch (err) {
          results[name] = { ok: false, reason: err.message };
        }
      })
  );
  return results;
};

// ─── Refund ───────────────────────────────────────────────────────
const refund = async ({ txnId, gatewayName, gatewayPaymentId, gatewayOrderId, gatewayTxnId, amount, currency }) => {
  const gw = GW[gatewayName]?.();
  if (!gw) return { approved: false, responseCode: '05', message: `Gateway ${gatewayName} inconnu` };

  logger.info('CardRouter: refund', { txnId, gatewayName, amount });

  if (gatewayName === 'cybersource') return gw.refund({ txnId, csPaymentId: gatewayPaymentId, amount, currency });
  if (gatewayName === 'mpgs')        return gw.refund({ txnId, mpgsOrderId: gatewayOrderId,   amount, currency });
  if (gatewayName === 'stripe')      return gw.refundCharge({ txnId, stripePaymentIntentId: gatewayPaymentId, amount, currency });
  if (gatewayName === 'migs')        return gw.refund({ txnId, migsTransactionNo: gatewayTxnId, amount, currency });

  return { approved: false, responseCode: '05', message: 'Refund non supporté pour ce gateway' };
};

// ─── Void ────────────────────────────────────────────────────────
const voidTransaction = async ({ txnId, gatewayName, gatewayPaymentId, gatewayOrderId, gatewayTxnId, amount, currency }) => {
  const gw = GW[gatewayName]?.();
  if (!gw) return { approved: false, responseCode: '05', message: `Gateway ${gatewayName} inconnu` };

  logger.info('CardRouter: void', { txnId, gatewayName });

  if (gatewayName === 'cybersource') return gw.voidAuth({ txnId, csPaymentId: gatewayPaymentId, amount, currency });
  if (gatewayName === 'mpgs')        return gw.voidAuth({ txnId, mpgsOrderId: gatewayOrderId, mpgsTxnId: gatewayTxnId });
  if (gatewayName === 'stripe')      return gw.cancelIntent({ intentId: gatewayPaymentId, txnId });
  if (gatewayName === 'migs')        return gw.voidAuth({ txnId, migsTransactionNo: gatewayTxnId });

  return { approved: false, responseCode: '05', message: 'Void non supporté' };
};

// ─── Helpers privés ───────────────────────────────────────────────

const tryGateway = async (gwName, params) => {
  const factory = GW[gwName];
  if (!factory) {
    return { approved: false, responseCode: '05', message: `Gateway ${gwName} non enregistré`, declineCategory: 'configuration_error', retryable: false };
  }
  if (!isConfigured(gwName)) {
    return { approved: false, responseCode: '05', message: `Gateway ${gwName} non configuré`, declineCategory: 'configuration_error', retryable: false };
  }
  try {
    const gw = factory();
    return await gw.processPayment(params);
  } catch (err) {
    logger.error(`CardRouter: gateway ${gwName} threw`, { txnId: params.txnId, err: err.message });
    return { approved: false, responseCode: '96', message: err.message, declineCategory: 'network_error', retryable: true };
  }
};

const resolveNetworkFromAcquirer = (acquirer) => {
  const MAP = { cybersource: 'VISA', mpgs: 'MASTERCARD', migs: 'VISA', stripe: 'VISA', gimac: 'GIMAC' };
  return MAP[acquirer] || 'UNKNOWN';
};

module.exports = { processCard, healthCheck, refund, voidTransaction, ROUTING_TABLE, isConfigured };
