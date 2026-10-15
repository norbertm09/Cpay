'use strict';
const logger = require('../../config/logger');
const processPayment = async ({ txnId, amount, currency, emvPayload, network }) => {
  logger.info('interswitch processPayment', { txnId, amount, network });
  // TODO: intégrer la vraie API interswitch
  // Voir backend SoftPOS pour l'implémentation complète CyberSource / MPGS
  throw new Error('Gateway interswitch — voir implementation dans softpos-platform/backend-api/src/services/gateways/');
};
module.exports = { processPayment };
