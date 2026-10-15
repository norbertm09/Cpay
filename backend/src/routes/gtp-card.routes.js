// backend/src/routes/gtp-card.routes.js
// ================================================================
// CPlus 2.6 — Routes GTP (SOAP Partner API v1.7)
// Montees sous /api/v1/cardholder/gtp
// ================================================================
'use strict';

const express = require('express');
const router  = express.Router();
const gtp     = require('../services/rails/gtp-card.service');
const gtpClient = require('../services/rails/gtp.client');
const { query } = require('../config/database');

// ─── Auth ────────────────────────────────────────────────────────
// WAVE-2 : auth unique (audit §1.1). cardholderAuth n'accepte qu'un JWT de
// type cardholder (audit §2.5) et pose req.chId (= sub) + req.cardholder.
const { cardholderAuth: cardAuth } = require('../middleware/auth');

// ─── HOTFIX IDOR : :gtpCardId doit appartenir au porteur ─────────
const ownCard = async (req, res, next) => {
  try {
    const id = parseInt(req.params.gtpCardId, 10);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Carte introuvable' });
    const r = await query(
      `SELECT gtp_card_id, last4, status FROM gtp_cards WHERE gtp_card_id=$1 AND cardholder_id=$2`,
      [id, req.chId]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Carte introuvable' });
    req.gtpCard = r.rows[0];
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
};

// ─── Gestion d'erreurs GTP ───────────────────────────────────────
const handleErr = (err, res) => {
  console.error('[GTP]', err.code || '-', err.message);
  if (err.code === 'GTP_CARD_NOT_OWNED') return res.status(404).json({ error: 'Carte introuvable' });
  const m = {
    GTP_NOT_CONFIGURED: [503, 'Service GTP non configure (token manquant)'],
    GTP_TIMEOUT:        [504, 'GTP ne repond pas'],
    GTP_NETWORK_ERROR:  [502, 'Erreur reseau GTP'],
    GTP_SOAP_FAULT:     [502, err.message],
    GTP_HTTP_ERROR:     [502, err.message],
  };
  if (m[err.code]) {
    const [s, msg] = m[err.code];
    return res.status(s).json({ error: msg, code: err.code });
  }
  if (err.code === 'GTP_ERROR') {
    const n = err.gtpErrorNumber;
    const s = (n === 7003 || n === 7004 || n === 7002) ? 403
            : (n === 7102 || n === 7302 || n === 7402) ? 404 : 422;
    return res.status(s).json({ error: err.message, gtpError: n });
  }
  if (err.gtpCardId) return res.status(422).json({ error: err.message, gtp_card_id: err.gtpCardId });
  res.status(500).json({ error: err.message });
};

// ─── Helper: recuperer la carte GTP du porteur ───────────────────
const getCard = async (chId) => {
  const r = await query(
    `SELECT gtp_card_id, last4, status FROM gtp_cards
     WHERE cardholder_id=$1 AND status != 'cancelled' LIMIT 1`, [chId]);
  return r.rows[0] || null;
};

const getPhone = async (chId) => {
  const r = await query(`SELECT phone FROM cardholders WHERE cardholder_id=$1`, [chId]);
  return r.rows[0]?.phone || null;
};

// ═══════════════════════════════════════════════════════════════════
// STATUS — l'app verifie si GTP est actif avant d'afficher les cartes
// ═══════════════════════════════════════════════════════════════════
router.get('/status', cardAuth, async (req, res) => {
  const configured = gtpClient.isConfigured();
  let hasCard = false;
  try {
    const c = await getCard(req.chId);
    hasCard = Boolean(c);
  } catch (e) { /* ignore */ }
  res.json({
    configured,
    hasCard,
    message: configured
      ? 'Service cartes actif'
      : 'Service cartes en cours d\'activation',
  });
});

// ═══════════════════════════════════════════════════════════════════
// PING
// ═══════════════════════════════════════════════════════════════════
router.get('/ping', cardAuth, async (req, res) => {
  try { res.json(await gtp.ping()); }
  catch (e) { handleErr(e, res); }
});

// ═══════════════════════════════════════════════════════════════════
// CARTES
// ═══════════════════════════════════════════════════════════════════
router.get('/cards', cardAuth, async (req, res) => {
  try {
    const cards = await gtp.listCards(req.chId);
    res.json({ data: cards, total: cards.length });
  } catch (e) { handleErr(e, res); }
});

router.get('/cards/:gtpCardId', cardAuth, ownCard, async (req, res) => {
  try { res.json(await gtp.getCardDetails(req.params.gtpCardId, req.chId)); }
  catch (e) { handleErr(e, res); }
});

router.post('/issue', cardAuth, async (req, res) => {
  try {
    const r = await gtp.issueCard(req.chId, req.body);
    res.json({ success: true, ...r });
  } catch (e) { handleErr(e, res); }
});

router.get('/cards/:gtpCardId/transactions', cardAuth, ownCard, async (req, res) => {
  try {
    const txns = await gtp.getTransactions(req.params.gtpCardId, {
      startDate: req.query.startDate,
      endDate:   req.query.endDate,
      limit:     Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 100)),
    }, req.chId);
    res.json({ data: txns, total: txns.length });
  } catch (e) { handleErr(e, res); }
});

// ─── TopUp / Unload ──────────────────────────────────────────────
router.post('/cards/:gtpCardId/topup', cardAuth, ownCard, async (req, res) => {
  const { amount, operator, mmPhone } = req.body;
  if (!amount || parseFloat(amount) <= 0)
    return res.status(422).json({ error: 'Montant invalide' });
  try {
    const r = await gtp.topUp({
      gtpCardId: req.params.gtpCardId,
      cardholderId: req.chId,
      amount, operator,
      mmPhone: mmPhone || await getPhone(req.chId),
    });
    res.json({ success: true, ...r });
  } catch (e) { handleErr(e, res); }
});

router.post('/cards/:gtpCardId/unload', cardAuth, ownCard, async (req, res) => {
  const { amount, operator, mmPhone } = req.body;
  if (!amount || parseFloat(amount) <= 0)
    return res.status(422).json({ error: 'Montant invalide' });
  try {
    const r = await gtp.unload({
      gtpCardId: req.params.gtpCardId,
      cardholderId: req.chId,
      amount, operator,
      mmPhone: mmPhone || await getPhone(req.chId),
    });
    res.json({ success: true, ...r });
  } catch (e) { handleErr(e, res); }
});

// ─── Paiement ────────────────────────────────────────────────────
router.post('/cards/:gtpCardId/payment', cardAuth, ownCard, async (req, res) => {
  const { toCustomerId, toLast4, amount, description } = req.body;
  if (!toCustomerId) return res.status(422).json({ error: 'toCustomerId requis' });
  if (!amount || parseFloat(amount) <= 0)
    return res.status(422).json({ error: 'Montant invalide' });
  try {
    const r = await gtp.payment({
      gtpCardId: req.params.gtpCardId,
      cardholderId: req.chId,
      toCustomerId, toLast4, amount, description,
    });
    res.json({ success: true, ...r });
  } catch (e) { handleErr(e, res); }
});

router.post('/payment/token', cardAuth, async (req, res) => {
  const { toCustomerId, toLast4, amount, description } = req.body;
  try {
    const card = await getCard(req.chId);
    if (!card) return res.status(404).json({ error: 'Aucune carte GTP', code: 'NO_GTP_CARD' });
    const r = await gtp.paymentToken({
      gtpCardId: card.gtp_card_id,
      cardholderId: req.chId,
      toCustomerId, toLast4, amount, description,
    });
    res.json({ success: true, ...r });
  } catch (e) { handleErr(e, res); }
});

// ─── Gel / Reactivation ──────────────────────────────────────────
router.patch('/cards/:gtpCardId/freeze', cardAuth, ownCard, async (req, res) => {
  try {
    const phone = await getPhone(req.chId);
    res.json(await gtp.freezeCard(req.params.gtpCardId, phone, req.chId));
  } catch (e) { handleErr(e, res); }
});

router.patch('/cards/:gtpCardId/unfreeze', cardAuth, ownCard, async (req, res) => {
  try {
    const phone = await getPhone(req.chId);
    res.json(await gtp.unfreezeCard(req.params.gtpCardId, phone, req.chId));
  } catch (e) { handleErr(e, res); }
});

router.delete('/cards/:gtpCardId', cardAuth, ownCard, async (req, res) => {
  try {
    const phone = await getPhone(req.chId);
    res.json(await gtp.cancelCard(req.params.gtpCardId, phone, req.chId));
  } catch (e) { handleErr(e, res); }
});

// ─── PIN ─────────────────────────────────────────────────────────
router.post('/cards/:gtpCardId/pin', cardAuth, ownCard, async (req, res) => {
  const { pin } = req.body;
  if (!pin || !/^[0-9]{4}$/.test(pin))
    return res.status(422).json({ error: 'PIN 4 chiffres requis' });
  try { res.json(await gtp.changePin(req.params.gtpCardId, pin, req.chId)); }
  catch (e) { handleErr(e, res); }
});

// ═══════════════════════════════════════════════════════════════════
// ITEMS 13/14 — TRANSFERTS BANCAIRES
// ═══════════════════════════════════════════════════════════════════

router.get('/institutions', cardAuth, async (req, res) => {
  try {
    const p = [];
    let sql = `SELECT institution_id, code, name, type, country, swift
               FROM financial_institutions WHERE status='active'`;
    if (req.query.country) { p.push(req.query.country.toUpperCase()); sql += ` AND country=$${p.length}`; }
    if (req.query.type)    { p.push(req.query.type); sql += ` AND type=$${p.length}`; }
    sql += ` ORDER BY country, type, name`;

    const r = await query(sql, p);
    res.json({
      data: r.rows.map(i => ({
        institutionId: i.institution_id,
        code: i.code, name: i.name, type: i.type,
        country: i.country, swift: i.swift,
      })),
      total: r.rows.length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/bank-accounts', cardAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT ba.account_id, ba.account_number, ba.account_name, ba.iban,
              ba.status, ba.is_default, fi.name AS inst_name, fi.code AS inst_code,
              fi.type AS inst_type, fi.country
       FROM bank_accounts ba
       LEFT JOIN financial_institutions fi ON fi.institution_id = ba.institution_id
       WHERE ba.owner_type='cardholder' AND ba.owner_id=$1 AND ba.status != 'removed'
       ORDER BY ba.is_default DESC, ba.created_at ASC`, [req.chId]);

    res.json({
      data: r.rows.map(a => ({
        accountId: a.account_id,
        accountNumber: a.account_number.replace(/.(?=.{4})/g, '*'),
        accountName: a.account_name,
        iban: a.iban,
        status: a.status,
        isDefault: a.is_default,
        institution: { name: a.inst_name, code: a.inst_code, type: a.inst_type, country: a.country },
      })),
      total: r.rows.length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/bank-accounts', cardAuth, async (req, res) => {
  const { institutionId, accountNumber, accountName, iban } = req.body;
  if (!institutionId || !accountNumber || !accountName)
    return res.status(422).json({ error: 'institutionId, accountNumber, accountName requis' });
  try {
    const ex = await query(
      `SELECT COUNT(*)::int AS n FROM bank_accounts
       WHERE owner_type='cardholder' AND owner_id=$1 AND status != 'removed'`, [req.chId]);

    const r = await query(
      `INSERT INTO bank_accounts (owner_type, owner_id, institution_id, account_number,
        account_name, iban, status, is_default)
       VALUES ('cardholder',$1,$2,$3,$4,$5,'verified',$6)
       RETURNING account_id, account_number, account_name, status, is_default`,
      [req.chId, institutionId, accountNumber, accountName.toUpperCase(),
       iban || null, ex.rows[0].n === 0]);

    const a = r.rows[0];
    res.json({
      accountId: a.account_id,
      accountNumber: a.account_number.replace(/.(?=.{4})/g, '*'),
      accountName: a.account_name,
      status: a.status,
      isDefault: a.is_default,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/bank-accounts/:accountId', cardAuth, async (req, res) => {
  try {
    await query(
      `UPDATE bank_accounts SET status='removed', updated_at=NOW()
       WHERE account_id=$1 AND owner_id=$2`, [req.params.accountId, req.chId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// TRANSFERTS — 4 SENS
//   source: 'card' | 'momo'      destination: 'bank'
//   source: 'bank'               destination: 'card' | 'momo'
// ═══════════════════════════════════════════════════════════════════
const email = require('../services/notifications/email.service');

const getAccount = async (accountId, chId) => {
  const r = await query(
    `SELECT ba.*, fi.name AS inst_name, fi.code AS inst_code, fi.type AS inst_type
     FROM bank_accounts ba
     LEFT JOIN financial_institutions fi ON fi.institution_id = ba.institution_id
     WHERE ba.account_id=$1 AND ba.owner_id=$2 AND ba.status='verified'`,
    [accountId, chId]);
  return r.rows[0] || null;
};

const getChInfo = async (chId) => {
  const r = await query(
    `SELECT email, phone, first_name FROM cardholders WHERE cardholder_id=$1`, [chId]);
  return r.rows[0] || {};
};

// ─── VERS LA BANQUE (depuis carte ou MoMo) ───────────────────────
router.post('/transfer/:transactionId/reverse', cardAuth, async (req, res) => {
  try {
    const card = await getCard(req.chId);
    if (!card) return res.status(404).json({ error: 'Aucune carte GTP' });
    const r = await gtp.reverseTransaction(
      card.gtp_card_id, req.params.transactionId, req.body.reason, req.chId);
    res.json({ success: true, ...r });
  } catch (e) { handleErr(e, res); }
});

// ═══════════════════════════════════════════════════════════════════
// WALLETS MOBILE MONEY
// ═══════════════════════════════════════════════════════════════════
const transferSvc = require('../services/transfer/transfer.service');

router.get('/wallets', cardAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT wallet_id, operator, phone, label, country, is_default, status
       FROM cardholder_wallets
       WHERE cardholder_id=$1 AND status='active'
       ORDER BY is_default DESC, created_at ASC`, [req.chId]);

    res.json({
      data: r.rows.map(w => ({
        walletId: w.wallet_id,
        operator: w.operator,
        phone: w.phone,
        label: w.label || w.operator.toUpperCase(),
        country: w.country,
        isDefault: w.is_default,
      })),
      total: r.rows.length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/wallets', cardAuth, async (req, res) => {
  const { operator, phone, label, country } = req.body;
  if (!operator || !phone)
    return res.status(422).json({ error: 'operator et phone requis' });
  if (!['mtn', 'airtel', 'orange'].includes(operator))
    return res.status(422).json({ error: 'operator: mtn | airtel | orange' });

  const cleanPhone = String(phone).replace(/\D/g, '');
  if (cleanPhone.length < 9)
    return res.status(422).json({ error: 'Numero invalide' });

  try {
    // Verifier chez l'operateur
    let active = null;
    if (operator === 'mtn') {
      try {
        const mtn = require('../services/rails/mtn-momo.client');
        const v = await mtn.validateAccount(cleanPhone);
        active = v.active;
      } catch (e) { /* validation indisponible */ }
    }

    const ex = await query(
      `SELECT COUNT(*)::int AS n FROM cardholder_wallets
       WHERE cardholder_id=$1 AND status='active'`, [req.chId]);

    const r = await query(
      `INSERT INTO cardholder_wallets (cardholder_id, operator, phone, label, country,
        is_default, status, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,'active',$7)
       ON CONFLICT (cardholder_id, operator, phone)
       DO UPDATE SET status='active', updated_at=NOW()
       RETURNING wallet_id, operator, phone, label, country, is_default`,
      [req.chId, operator, cleanPhone,
       label || operator.toUpperCase(),
       country || 'CG',
       ex.rows[0].n === 0,
       active === true ? new Date() : null]);

    const w = r.rows[0];
    res.json({
      walletId: w.wallet_id,
      operator: w.operator,
      phone: w.phone,
      label: w.label,
      country: w.country,
      isDefault: w.is_default,
      verified: active,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/wallets/:walletId', cardAuth, async (req, res) => {
  try {
    await query(
      `UPDATE cardholder_wallets SET status='removed', updated_at=NOW()
       WHERE wallet_id=$1 AND cardholder_id=$2`, [req.params.walletId, req.chId]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
// TRANSFERTS BANCAIRES
// ═══════════════════════════════════════════════════════════════════
router.post('/transfer/initiate', cardAuth, async (req, res) => {
  const { direction, sourceType, sourceId, accountId, amount, description } = req.body;

  if (!['to_bank', 'from_bank'].includes(direction))
    return res.status(422).json({ error: "direction: 'to_bank' | 'from_bank'" });
  if (!['card', 'wallet'].includes(sourceType))
    return res.status(422).json({ error: "sourceType: 'card' | 'wallet'" });
  if (!accountId) return res.status(422).json({ error: 'accountId requis' });
  if (!amount || parseFloat(amount) < 500)
    return res.status(422).json({ error: 'Montant minimum 500 XAF' });
  if (sourceType === 'wallet' && !sourceId)
    return res.status(422).json({ error: 'sourceId (walletId) requis' });

  try {
    const r = await transferSvc.initiate({
      cardholderId: req.chId,
      direction, sourceType, sourceId, accountId,
      amount, description,
    });
    res.json({ success: true, ...r });
  } catch (e) {
    if (e.code === 'NO_GTP_CARD')
      return res.status(404).json({ error: 'Aucune carte GTP active', code: e.code });
    if (e.code === 'NO_ACCOUNT' || e.code === 'NO_WALLET')
      return res.status(404).json({ error: e.message, code: e.code });
    handleErr(e, res);
  }
});

router.get('/transfer/:transferId/status', cardAuth, async (req, res) => {
  try {
    res.json(await transferSvc.getStatus(req.params.transferId, req.chId));
  } catch (e) {
    if (e.code === 'NOT_FOUND') return res.status(404).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

router.get('/transfers', cardAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT bt.transfer_id, bt.reference, bt.direction, bt.source_type,
              bt.amount, bt.currency, bt.status, bt.created_at, bt.completed_at,
              fi.name AS inst_name
       FROM bank_transfers bt
       LEFT JOIN bank_accounts ba ON ba.account_id = bt.bank_account_id
       LEFT JOIN financial_institutions fi ON fi.institution_id = ba.institution_id
       WHERE bt.cardholder_id=$1
       ORDER BY bt.created_at DESC LIMIT 50`, [req.chId]);

    res.json({
      data: r.rows.map(t => ({
        transferId: t.transfer_id,
        reference: t.reference,
        direction: t.direction,
        sourceType: t.source_type,
        amount: parseFloat(t.amount),
        currency: t.currency,
        status: t.status,
        institution: t.inst_name,
        createdAt: t.created_at,
        completedAt: t.completed_at,
      })),
      total: r.rows.length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
