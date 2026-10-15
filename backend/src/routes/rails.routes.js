'use strict';

const express = require('express');
const router = express.Router();
const { requireRole } = require('../middleware/auth');
const visa = require('../services/rails/visa-direct.service');
const mastercardDevelopers = require('../services/rails/mastercard-developers.service');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ─── Visa Direct — WAVE-2 (audit prod 2.6.0, 01-§2.3 / 02-§4) ─────
// * réservé aux admins ops/super (plus de merchantAuth : un marchand ne déclenche
//   jamais de push/pull funds) ;
// * jamais de PAN brut : tout champ /PrimaryAccountNumber|cardNumber|pan$|cvv|expiry/i
//   est refusé (422 RAW_PAN_NOT_ALLOWED) — seuls les tokens réseau sont admis ;
// * la réponse Visa n'est jamais renvoyée telle quelle : liste blanche de champs.
const visaAdmin = requireRole('super_admin', 'ops_admin');

const RAW_PAN_FIELD_RE = /PrimaryAccountNumber|cardNumber|pan$|cvv|expiry/i;

/** Parcours récursif du body : renvoie le chemin du premier champ interdit, sinon null. */
const findRawPanField = (value, path = '', depth = 0) => {
  if (!value || typeof value !== 'object' || depth > 8) return null;
  for (const [k, v] of Object.entries(value)) {
    const here = path ? `${path}.${k}` : k;
    if (RAW_PAN_FIELD_RE.test(k)) return here;
    const nested = findRawPanField(v, here, depth + 1);
    if (nested) return nested;
  }
  return null;
};

const rejectRawPan = (req, res, next) => {
  const hit = findRawPanField(req.body) || findRawPanField(req.query);
  if (hit) {
    return res.status(422).json({
      error: 'Données carte brutes interdites : utilisez un token réseau',
      code: 'RAW_PAN_NOT_ALLOWED',
      field: hit,
    });
  }
  next();
};

const VISA_FUNDS_FIELDS = ['transactionIdentifier', 'actionCode', 'approvalCode', 'responseCode', 'transmissionDateTime',
  'retrievalReferenceNumber', 'systemsTraceAuditNumber', 'statusIdentifier', 'feeProgramIndicator', 'settlementFlags',
  'transactionStatus', 'merchantVerificationValue', 'cardTypeCode', 'transactionCurrencyCode', 'amount', 'surchargeAmount'];
const VISA_PAYOUT_FIELDS = ['payoutId', 'clientReferenceId', 'status', 'statusCode', 'statusReason', 'statusDetails', 'payoutStatusList',
  'payoutMethod', 'transactionDetail', 'amount', 'currencyCode', 'recipientCurrencyCode', 'createdDate', 'lastUpdatedDate',
  'estimatedSettlementDate', 'validationStatus', 'validationErrors', 'validationDetails'];
const VISA_BALANCE_FIELDS = ['initiatingPartyId', 'currencyCode', 'balance', 'availableBalance', 'ledgerBalance', 'balanceAmount',
  'lastUpdatedDate', 'accountBalances'];
const VISA_QUERY_FIELDS = ['transactionIdentifier', 'actionCode', 'approvalCode', 'responseCode', 'transactionStatus', 'statusIdentifier',
  'retrievalReferenceNumber', 'systemsTraceAuditNumber', 'transmissionDateTime', 'amount', 'transactionCurrencyCode', 'transactionType'];

/** Liste blanche : seuls les champs connus (et jamais de PAN) remontent au client. */
const pickVisa = (raw, fields) => {
  if (!raw || typeof raw !== 'object') return {};
  const out = {};
  for (const f of fields) {
    if (raw[f] === undefined) continue;
    const v = raw[f];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sub = {};
      for (const [k, sv] of Object.entries(v)) if (!RAW_PAN_FIELD_RE.test(k) && (sv === null || typeof sv !== 'object')) sub[k] = sv;
      out[f] = sub;
    } else if (Array.isArray(v)) {
      out[f] = v.map(item => (item && typeof item === 'object')
        ? Object.fromEntries(Object.entries(item).filter(([k, sv]) => !RAW_PAN_FIELD_RE.test(k) && (sv === null || typeof sv !== 'object')))
        : item);
    } else {
      out[f] = v;
    }
  }
  return out;
};

router.post('/visa-direct/push-funds', visaAdmin, rejectRawPan, asyncHandler(async (req, res) => {
  const result = await visa.pushFunds(req.body);
  res.json({ success: true, data: pickVisa(result, VISA_FUNDS_FIELDS) });
}));

router.post('/visa-direct/pull-funds', visaAdmin, rejectRawPan, asyncHandler(async (req, res) => {
  const result = await visa.pullFunds(req.body);
  res.json({ success: true, data: pickVisa(result, VISA_FUNDS_FIELDS) });
}));

router.get('/visa-direct/transaction-query', visaAdmin, rejectRawPan, asyncHandler(async (req, res) => {
  const result = await visa.queryTransaction(req.query);
  res.json({ success: true, data: pickVisa(result, VISA_QUERY_FIELDS) });
}));

router.post('/visa-payouts/v3/payouts', visaAdmin, rejectRawPan, asyncHandler(async (req, res) => {
  const result = await visa.accountWalletPayout(req.body);
  res.json({ success: true, data: pickVisa(result, VISA_PAYOUT_FIELDS) });
}));

router.post('/visa-payouts/v3/payouts/validate', visaAdmin, rejectRawPan, asyncHandler(async (req, res) => {
  const result = await visa.validateAccountWalletPayout(req.body);
  res.json({ success: true, data: pickVisa(result, VISA_PAYOUT_FIELDS) });
}));

router.get('/visa-payouts/v3/payouts', visaAdmin, rejectRawPan, asyncHandler(async (req, res) => {
  const result = await visa.queryPayout(req.query);
  res.json({ success: true, data: pickVisa(result, VISA_PAYOUT_FIELDS) });
}));

router.get('/visa-payouts/v3/account-balance', visaAdmin, rejectRawPan, asyncHandler(async (req, res) => {
  const result = await visa.getAccountBalance(req.query);
  res.json({ success: true, data: pickVisa(result, VISA_BALANCE_FIELDS) });
}));

router.get('/mastercard-developers/services', requireRole('super_admin', 'ops_admin'), asyncHandler(async (req, res) => {
  const result = await mastercardDevelopers.getServices(req.query);
  res.json({ success: true, data: result });
}));

router.get('/mastercard-developers/services/:id', requireRole('super_admin', 'ops_admin'), asyncHandler(async (req, res) => {
  const result = await mastercardDevelopers.getService(req.params.id);
  res.json({ success: true, data: result });
}));

router.get('/mastercard-developers/projects', requireRole('super_admin', 'ops_admin'), asyncHandler(async (req, res) => {
  const result = await mastercardDevelopers.getProjects(req.query);
  res.json({ success: true, data: result });
}));

router.post('/mastercard-developers/projects', requireRole('super_admin'), asyncHandler(async (req, res) => {
  const result = await mastercardDevelopers.createProject(req.body);
  res.status(201).json({ success: true, data: result });
}));

router.get('/mastercard-developers/projects/:id', requireRole('super_admin', 'ops_admin'), asyncHandler(async (req, res) => {
  const result = await mastercardDevelopers.getProject(req.params.id);
  res.json({ success: true, data: result });
}));

router.post('/mastercard-developers/projects/:id/services', requireRole('super_admin'), asyncHandler(async (req, res) => {
  const result = await mastercardDevelopers.addServiceToProject(req.params.id, req.body);
  res.status(201).json({ success: true, data: result });
}));

router.post('/mastercard-developers/projects/:id/credentials', requireRole('super_admin'), asyncHandler(async (req, res) => {
  const result = await mastercardDevelopers.addCredential(req.params.id, req.body);
  res.status(201).json({ success: true, data: result });
}));

module.exports = router;
module.exports._visa = { findRawPanField, pickVisa, RAW_PAN_FIELD_RE };
