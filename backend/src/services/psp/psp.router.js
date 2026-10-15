'use strict';
// ================================================================
// CPlus 2.6 — PSP Router
// Sélection automatique du PSP selon le BIN de la carte
// BIN 4xxxxx → CyberSource (Visa)
// BIN 5xxxxx → MIGS (Mastercard)
// Autres     → Stripe (fallback)
// ================================================================

const cybersource = require('./cybersource.client');
const migs        = require('./migs.client');
const stripe      = require('./stripe.client');

// ─── Config frais par défaut ─────────────────────────────────────
const DEFAULT_FEES = {
  card2momo: { rate: 0.04, bearer: process.env.FEE_BEARER_CARD2MOMO || 'client' },
  momo2card: { rate: 0.01, bearer: process.env.FEE_BEARER_MOMO2CARD || 'client' },
  card2card: { rate: 0.00, bearer: process.env.FEE_BEARER_CARD2CARD || 'cplus'  },
  momo2momo: { rate: 0.01, bearer: process.env.FEE_BEARER_MOMO2MOMO || 'client' },
  payment:   { rate: 0.005,bearer: process.env.FEE_BEARER_PAYMENT   || 'client' },
};

// ─── Détection réseau par BIN ─────────────────────────────────────
const detectNetwork = (pan) => {
  if (!pan) return 'unknown';
  const clean = pan.replace(/[\s-]/g, '');
  const first = clean.charAt(0);
  if (first === '4') return 'visa';
  if (first === '5') return 'mastercard';
  if (first === '3') return 'amex';
  if (first === '6') return 'verve';
  return 'unknown';
};

// ─── Sélection PSP selon réseau ──────────────────────────────────
const selectPSP = (network) => {
  switch (network) {
    case 'visa':       return { psp: 'cybersource', client: cybersource };
    case 'mastercard': return { psp: 'migs',        client: migs        };
    default:           return { psp: 'stripe',      client: stripe      };
  }
};

// ─── Calcul frais ────────────────────────────────────────────────
/**
 * Calculer les montants selon qui paie les frais
 * @param {number} amount    - Montant demandé
 * @param {string} flowType  - card2momo | momo2card | card2card | momo2momo | payment
 * @param {string} [override] - 'client' | 'cplus' (override admin)
 */
const calculateFees = (amount, flowType, override = null) => {
  const config  = DEFAULT_FEES[flowType] || { rate: 0.04, bearer: 'client' };
  const rate    = config.rate;
  const bearer  = override || config.bearer;
  const fee     = Math.round(amount * rate);

  if (bearer === 'client') {
    // Client paie le montant + les frais
    return {
      debitAmount:  amount + fee,   // Ce qui est débité de la carte
      creditAmount: amount,          // Ce qui est crédité côté destination
      fee,
      feeRate:      rate,
      feeBearer:    'client',
    };
  } else {
    // CPlus absorbe les frais
    return {
      debitAmount:  amount,          // Carte débitée du montant exact
      creditAmount: amount - fee,    // Destination reçoit montant - frais
      fee,
      feeRate:      rate,
      feeBearer:    'cplus',
    };
  }
};

// ─── Processeur principal ─────────────────────────────────────────
/**
 * Débiter une carte via le PSP approprié
 */
const chargeCard = async ({ amount, currency = 'XAF', tokenId, cardMasked, network, orderId, cardholder, flowType = 'payment', feeBearer = null }) => {
  const { debitAmount, creditAmount, fee, feeRate, feeBearer: actualBearer } = calculateFees(amount, flowType, feeBearer);

  // Détecter réseau si pas fourni
  const resolvedNetwork = network || detectNetwork(cardMasked || tokenId);
  const { psp, client }  = selectPSP(resolvedNetwork);

  console.log(`[PSP-ROUTER] ${resolvedNetwork} → ${psp} | debit=${debitAmount} credit=${creditAmount} fee=${fee} bearer=${actualBearer}`);

  const result = await client.processPayment({
    amount:     debitAmount,
    currency,
    tokenId,
    cardMasked,
    network:    resolvedNetwork,
    orderId,
    cardholder,
  });

  return {
    ...result,
    psp,
    debitAmount,
    creditAmount,
    fee,
    feeRate,
    feeBearer: actualBearer,
    flowType,
  };
};

// ─── Remboursement via PSP ────────────────────────────────────────
const refundCard = async ({ psp, transactionId, amount, orderId }) => {
  const clients = { cybersource, migs, stripe };
  const client  = clients[psp];
  if (!client) throw new Error(`PSP inconnu: ${psp}`);
  return client.refund({ transactionId, amount, orderId });
};

module.exports = {
  chargeCard,
  refundCard,
  detectNetwork,
  selectPSP,
  calculateFees,
  DEFAULT_FEES,
};
