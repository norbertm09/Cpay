/**
 * Fraud Engine — CPlus 2.6
 * Évaluation temps réel avant chaque transaction.
 * Actions : allow | review | block
 */
'use strict';

const logger = require('../../config/logger');
const USD_RATES = { USD:1, EUR:1.08, XAF:0.0016, XOF:0.0016, CDF:0.00035 };
const toUSD = (a, c) => a * (USD_RATES[(c||'').toUpperCase()] || 1);

const evaluate = async ({ txnId, merchantId, deviceId, terminalId, amount, currency, paymentMethod, ip }) => {
  const checks = await Promise.allSettled([
    checkVelocity({ merchantId, deviceId, terminalId }),
    checkAmount({ merchantId, amount, currency }),
    checkDevice({ merchantId, deviceId, terminalId }),
  ]);

  let maxScore = 0;
  let blockReason = null;
  const triggered = [];

  for (const c of checks) {
    if (c.status !== 'fulfilled') continue;
    const { score, reason, action, ruleName } = c.value;
    if (score > 0) triggered.push({ ruleName, score, reason, action });
    maxScore = Math.max(maxScore, score);
    if (action === 'block') blockReason = reason;
  }

  const action = blockReason || maxScore >= 80 ? 'block' : maxScore >= 40 ? 'review' : 'allow';

  if (action !== 'allow') {
    logger.warn('Fraud evaluation', { txnId, action, score: maxScore, triggered });
    try {
      const m = require('../../config/metrics');
      if (action === 'block') m.incFraudBlock({ method: paymentMethod });
      else m.incFraudFlag({ method: paymentMethod });
    } catch {}
  }

  return { action, score: maxScore, rulesTriggered: triggered, blockReason };
};

const checkVelocity = async ({ merchantId, deviceId, terminalId }) => {
  const { query } = require('../../config/database');
  try {
    if (terminalId) {
      const r = await query(
        `SELECT COUNT(*)::int as cnt FROM transactions
         WHERE terminal_id=$1 AND initiated_at > NOW()-INTERVAL '1 minute' AND status!='failed'`,
        [terminalId]);
      if (r.rows[0].cnt >= 5) return { ruleName:'velocity_terminal', score:100, action:'block', reason:`${r.rows[0].cnt} txn/min` };
    }
    const r2 = await query(
      `SELECT COUNT(*)::int as cnt FROM transactions
       WHERE merchant_id=$1 AND status='failed' AND initiated_at>NOW()-INTERVAL '10 minutes'`,
      [merchantId]);
    if (r2.rows[0].cnt >= 5) return { ruleName:'card_testing', score:100, action:'block', reason:`${r2.rows[0].cnt} échecs en 10min` };
  } catch {}
  return { ruleName:'velocity_ok', score:0, action:'allow', reason:null };
};

const checkAmount = async ({ merchantId, amount, currency }) => {
  const amUSD = toUSD(amount, currency);
  if (amUSD > 5000) return { ruleName:'amount_very_high', score:60, action:'review', reason:`Montant élevé $${amUSD.toFixed(0)}` };
  return { ruleName:'amount_ok', score:0, action:'allow', reason:null };
};

const checkDevice = async ({ merchantId, deviceId, terminalId }) => {
  if (!terminalId) return { ruleName:'device_no_terminal', score:15, action:'allow', reason:'Terminal non spécifié' };
  const { query } = require('../../config/database');
  try {
    const r = await query('SELECT status FROM terminals WHERE terminal_id=$1', [terminalId]);
    if (!r.rows.length) return { ruleName:'device_unregistered', score:80, action:'review', reason:'Terminal non enregistré' };
    if (r.rows[0].status === 'blocked') return { ruleName:'device_blocked', score:100, action:'block', reason:'Terminal bloqué' };
  } catch {}
  return { ruleName:'device_ok', score:0, action:'allow', reason:null };
};

module.exports = { evaluate };
