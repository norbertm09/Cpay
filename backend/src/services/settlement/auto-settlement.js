'use strict';
/**
 * Règlement automatique J+1 — DÉSACTIVÉ (hotfix v1).
 *
 * L'ancienne implémentation marquait les batches 'completed' sans aucun mouvement de fonds
 * (« Simuler le virement ») et entrait en concurrence avec settlement.engine.js et
 * settlement.service.js (double règlement possible, audit production §6).
 * Le règlement J+1 passe désormais exclusivement par settlement.engine.runSettlement
 * (POST /internal/settlement/run, verrou global, virement réel vérifié).
 */
const logger = require('../../config/logger');

const runAutoSettlement = async () => {
  logger.warn('runAutoSettlement désactivé : utiliser settlement.engine.runSettlement');
  return { disabled: true, reason: 'AUTO_SETTLEMENT_DISABLED', use: 'POST /internal/settlement/run' };
};

module.exports = { runAutoSettlement };
