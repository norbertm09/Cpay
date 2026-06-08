'use strict';
const logger = require('../../config/logger');
const processPayment = async ({ txnId, amount, currency, emvPayload, network }) => {
  logger.info('gimac processPayment', { txnId, amount, network });
  // TODO: intégrer la vraie API gimac
  // Voir backend SoftPOS pour l'implémentation complète CyberSource / MPGS
  throw new Error('Gateway gimac — voir implementation dans softpos-platform/backend-api/src/services/gateways/');
};
module.exports = { processPayment };
