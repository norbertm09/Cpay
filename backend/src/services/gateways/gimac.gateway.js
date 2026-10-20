'use strict';
/**
 * Passerelle GIMAC / GIMACPAY — NON ACTIVÉE (vague 6, lot 2).
 *
 * Aucune connexion GIMAC opérationnelle n'existe dans ce dépôt (docs/LAUNCH-CEMAC-RDC.md). Toute tentative
 * lève GatewayNotActivatedError (code GATEWAY_NOT_ACTIVATED, HTTP 503) au lieu d'une erreur générique ;
 * le registre de capacités (services/capabilities/registry.js) expose GIMAC en `planned` avec les prérequis :
 * contrat de participation, spécifications techniques, tests partenaires (encaissement, retrait, transfert,
 * rapprochement), puis GIMAC_MERCHANT_ID / GIMAC_AID_PREFIXES.
 */
const logger = require('../../config/logger');

class GatewayNotActivatedError extends Error {
  constructor(gateway = 'gimac', message = 'Passerelle GIMAC non activée : intégration en cours (contrat, spécifications et tests partenaires requis)') {
    super(message);
    this.name = 'GatewayNotActivatedError';
    this.code = 'GATEWAY_NOT_ACTIVATED';
    this.statusCode = 503;
    this.gateway = gateway;
    this.retryable = false;
  }
  toJSON() { return { error: this.message, code: this.code, gateway: this.gateway, status: 'planned' }; }
}

const REQUIRES = Object.freeze(['contrat de participation GIMAC', 'spécifications techniques GIMAC / GIMACPAY', 'tests partenaires (encaissement, retrait, transfert, rapprochement)', 'GIMAC_MERCHANT_ID', 'GIMAC_AID_PREFIXES']);

const isActivated = () => false;

const processPayment = async ({ txnId, amount, network } = {}) => {
  logger.warn('gimac processPayment refused: gateway not activated', { txnId, amount, network });
  throw new GatewayNotActivatedError('gimac');
};

module.exports = { processPayment, isActivated, GatewayNotActivatedError, REQUIRES };
