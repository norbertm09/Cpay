// backend/src/routes/mtn-momo.routes.js
// ================================================================
// CPlus 2.6 — MTN MoMo Routes
// POST /api/v1/momo/topup       — Collections (client paye)
// POST /api/v1/momo/payout      — Disbursements (CPlus envoie)
// GET  /api/v1/momo/status/:ref — Statut transaction
// POST /api/v1/momo/webhooks/mtn    — Callback MTN    (délégué à webhook-handlers)
// POST /api/v1/momo/webhooks/airtel — Callback Airtel (délégué à webhook-handlers)
// GET  /api/v1/momo/balance     — Soldes comptes (admin / marchand)
// GET  /api/v1/momo/validate/:phone — Valider numéro MTN
// ================================================================
//
// HOTFIX WAVE-1 :
//   * webhooks MTN/Airtel : plus de doublon, délégation aux handlers fail-closed ;
//   * /balance : authentification admin ou marchand obligatoire ;
//   * cardId (body) : la carte doit appartenir au porteur authentifié (403 sinon) ;
//   * /status/:ref : claim `status='pending'` avant tout crédit (rejeu idempotent).

'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();
const mtn     = require('../services/rails/mtn-momo.client');
const { query, withTransaction } = require('../config/database');
const webhooks = require('./webhook-handlers');

// ─── Auth middleware ──────────────────────────────────────────────
// WAVE-2 : auth unique (audit §1.1). requireType verifie signature + iss/aud +
// type ; aliasUser('actor') conserve req.actor pour les handlers existants.
const { requireType, aliasUser } = require('../middleware/auth');
const cardAuth       = [requireType(['cardholder', 'merchant']), aliasUser('actor')];
const privilegedAuth = [requireType(['admin', 'merchant']), aliasUser('actor')];

// ─── Propriété de la carte ────────────────────────────────────────
// Un cardId venant du body n'est jamais pris pour argent comptant :
// la carte doit appartenir au porteur authentifié (virtual_cards.cardholder_id).
const ownsCard = (card, actor) => {
  if (!card || !actor || actor.type !== 'cardholder') return false;
  const chId = actor.sub || actor.cardholderId || actor.chId;
  if (!chId || !card.cardholder_id) return false;
  return String(card.cardholder_id) === String(chId);
};

// ─── TOP-UP : Collections (MTN → Carte virtuelle) ─────────────────
// POST /api/v1/momo/topup
router.post('/topup', cardAuth, async (req, res) => {
  const { amount, phone, cardId } = req.body;

  if (!amount || amount < 500) return res.status(422).json({ error: 'Montant minimum 500 XAF' });
  if (!phone) return res.status(422).json({ error: 'Numéro MTN requis' });

  const resolvedCardId = cardId || req.actor.cardId;
  if (!resolvedCardId) return res.status(422).json({ error: 'cardId requis' });

  try {
    // Vérifier la carte
    const cardRes = await query(
      `SELECT * FROM virtual_cards WHERE card_id=$1`,
      [resolvedCardId]
    );
    if (!cardRes.rows.length) return res.status(404).json({ error: 'Carte introuvable' });
    const card = cardRes.rows[0];
    if (!ownsCard(card, req.actor)) {
      return res.status(403).json({ error: 'Cette carte ne vous appartient pas', code: 'CARD_NOT_OWNED' });
    }
    if (card.status === 'cancelled') return res.status(422).json({ error: 'Carte annulée' });

    // Frais 1%
    const fee     = Math.round(amount * 0.01);
    const credited = amount - fee;
    const externalId = uuidv4();

    // Enregistrer la transaction en PENDING
    await query(
      `INSERT INTO card_transactions
         (txn_id, card_id, cardholder_id, type, amount, fee, net_amount,
          balance_before, balance_after, currency, status, description,
          mobile_money_op, mobile_money_phone, mm_reference, initiated_at, metadata)
       VALUES ($1,$2,$3,'topup',$4,$5,$6,$7,$8,$9,'pending',$10,'mtn',$11,$12,NOW(),$13)
       RETURNING txn_id`,
      [
        externalId, resolvedCardId, req.actor.sub || req.actor.cardId,
        amount, fee, credited,
        parseFloat(card.balance), parseFloat(card.balance) + credited,
        card.currency,
        `Top-up MTN MoMo`,
        phone, externalId,
        JSON.stringify({ mtnReferenceId: externalId, product: 'collections' }),
      ]
    );

    // Initier la demande MTN
    const mtnResult = await mtn.requestToPay({
      amount,
      phone,
      description: `C-Pay Top-up ${amount} XAF`,
      externalId,
    });

    // La référence MTN (X-Reference-Id) est celle que le webhook/le polling recevront
    await query(
      `UPDATE card_transactions SET mm_reference=$1, metadata = COALESCE(metadata,'{}'::jsonb) || $2::jsonb
       WHERE txn_id=$3 AND status='pending'`,
      [mtnResult.referenceId, JSON.stringify({ mtnReferenceId: mtnResult.referenceId }), externalId]
    );

    res.json({
      success:     true,
      referenceId: mtnResult.referenceId,
      txnId:       externalId,
      amount,
      fee,
      credited,
      currency:    'XAF',
      status:      'PENDING',
      message:     `Une notification a été envoyée au ${phone}. Validez sur votre téléphone MTN.`,
      pollUrl:     `/api/v1/momo/status/${mtnResult.referenceId}`,
    });

  } catch (err) {
    console.error('[MTN-TOPUP]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message, code: 'MTN_ERROR' });
  }
});

// ─── PAYOUT : Disbursements (Carte → MTN) ─────────────────────────
// POST /api/v1/momo/payout
router.post('/payout', cardAuth, async (req, res) => {
  const { amount, phone, cardId, pin } = req.body;

  if (!amount || amount < 500) return res.status(422).json({ error: 'Montant minimum 500 XAF' });
  if (!phone)  return res.status(422).json({ error: 'Numéro MTN requis' });
  if (!pin)    return res.status(422).json({ error: 'PIN requis' });

  const resolvedCardId = cardId || req.actor.cardId;
  if (!resolvedCardId) return res.status(422).json({ error: 'cardId requis' });

  try {
    await withTransaction(async client => {
      const cardRes = await client.query(
        `SELECT * FROM virtual_cards WHERE card_id=$1 FOR UPDATE`,
        [resolvedCardId]
      );
      const card = cardRes.rows[0];
      if (!card) throw Object.assign(new Error('Carte introuvable'), { statusCode: 404 });
      if (!ownsCard(card, req.actor)) {
        throw Object.assign(new Error('Cette carte ne vous appartient pas'), { statusCode: 403, code: 'CARD_NOT_OWNED' });
      }
      if (card.status !== 'active') throw Object.assign(new Error('Carte non active'), { statusCode: 422 });

      // Vérifier PIN
      const bcrypt = require('bcryptjs');
      if (card.pin_hash) {
        const ok = await bcrypt.compare(pin, card.pin_hash);
        if (!ok) throw Object.assign(new Error('PIN incorrect'), { statusCode: 422 });
      }

      // Frais 1.5%
      const fee   = Math.round(amount * 0.015);
      const total = amount + fee;

      if (parseFloat(card.balance) < total) {
        throw Object.assign(new Error(`Solde insuffisant. Requis: ${total} XAF, Disponible: ${card.balance} XAF`), { statusCode: 422 });
      }

      const externalId  = uuidv4();
      const balBefore   = parseFloat(card.balance);
      const balAfter    = balBefore - total;

      // Débiter la carte immédiatement
      await client.query(
        `UPDATE virtual_cards SET balance=$1, updated_at=NOW() WHERE card_id=$2`,
        [balAfter, card.card_id]
      );

      // Enregistrer en pending
      await client.query(
        `INSERT INTO card_transactions
           (txn_id, card_id, cardholder_id, type, amount, fee, net_amount,
            balance_before, balance_after, currency, status, description,
            mobile_money_op, mobile_money_phone, mm_reference, initiated_at, metadata)
         VALUES ($1,$2,$3,'unload',$4,$5,$6,$7,$8,$9,'pending',$10,'mtn',$11,$12,NOW(),$13)`,
        [
          externalId, resolvedCardId, req.actor.sub || req.actor.cardId,
          amount, fee, amount - fee,
          balBefore, balAfter, card.currency,
          `Déchargement MTN MoMo vers ${phone}`,
          phone, externalId,
          JSON.stringify({ mtnReferenceId: externalId, product: 'disbursements' }),
        ]
      );

      // Envoyer via MTN
      const mtnResult = await mtn.transfer({
        amount,
        phone,
        description: `C-Pay Payout ${amount} XAF`,
        externalId,
      });

      await client.query(
        `UPDATE card_transactions SET mm_reference=$1, metadata = COALESCE(metadata,'{}'::jsonb) || $2::jsonb
         WHERE txn_id=$3 AND status='pending'`,
        [mtnResult.referenceId, JSON.stringify({ mtnReferenceId: mtnResult.referenceId }), externalId]
      );

      res.json({
        success:     true,
        referenceId: mtnResult.referenceId,
        txnId:       externalId,
        amount,
        fee,
        sent:        amount - fee,
        newBalance:  balAfter,
        currency:    'XAF',
        status:      'PENDING',
        message:     `Virement en cours vers ${phone}`,
        pollUrl:     `/api/v1/momo/status/${mtnResult.referenceId}?product=disbursements`,
      });
    });
  } catch (err) {
    console.error('[MTN-PAYOUT]', err.message);
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code || 'MTN_ERROR' });
  }
});

// ─── STATUT transaction ───────────────────────────────────────────
// GET /api/v1/momo/status/:referenceId?product=collections|disbursements
// Le statut réel vient de MTN ; l'application en base passe par le même
// helper que le webhook (claim pending → crédit), donc rejouable sans double crédit.
router.get('/status/:referenceId', cardAuth, async (req, res) => {
  const { referenceId } = req.params;
  const product = req.query.product || 'collections';

  try {
    const status = product === 'collections'
      ? await mtn.getCollectionStatus(referenceId)
      : await mtn.getDisbursementStatus(referenceId);

    const txn = await webhooks.findCardTxnByReference(referenceId);
    let applied = null;
    if (txn && txn.status === 'pending' && (status.status === 'SUCCESSFUL' || status.status === 'FAILED')) {
      applied = await webhooks.applyCardTxnProviderStatus(txn, {
        provider: 'mtn',
        status:   status.status,
        financialTransactionId: status.financialTxnId || status.financialTransactionId || null,
        reason:   status.reason || 'MTN_FAILED',
        amount:   status.amount,
        currency: status.currency,
      });
      if (applied.reason === 'mismatch') {
        return res.status(409).json({ ...status, error: 'Montant ou devise incohérent', code: 'AMOUNT_MISMATCH' });
      }
    }

    res.json({ ...status, txnStatus: applied?.newStatus || txn?.status || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WEBHOOK MTN callback ─────────────────────────────────────────
// POST /api/v1/momo/webhooks/mtn — même implémentation que /api/v1/webhooks/mtn
router.post('/webhooks/mtn', webhooks.handleMtnWebhook);

// ─── WEBHOOK AIRTEL MONEY callback ────────────────────────────────
// POST /api/v1/momo/webhooks/airtel — même implémentation que /api/v1/webhooks/airtel
router.post('/webhooks/airtel', webhooks.handleAirtelWebhook);

// ─── BALANCE ─────────────────────────────────────────────────────
// GET /api/v1/momo/balance (admin ou marchand authentifié)
router.get('/balance', privilegedAuth, async (req, res) => {
  try {
    const [collections, disbursements] = await Promise.all([
      mtn.getCollectionBalance(),
      mtn.getDisbursementBalance(),
    ]);
    res.json({ collections, disbursements });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── VALIDATE numéro (par opérateur) ────────────────────────────
// GET /api/v1/momo/validate/:phone?operator=mtn|airtel
router.get('/validate/:phone', cardAuth, async (req, res) => {
  try {
    const phone    = req.params.phone.replace(/\D/g, '');
    const operator = req.query.operator || 'collections';
    // MTN → collections, Airtel → disbursements (même sandbox)
    const product  = operator === 'airtel' ? 'disbursements' : 'collections';
    const result   = await mtn.validateAccount(phone, product);
    // Détection opérateur par préfixe Congo +242
    const isMtn    = /^242(06|07|05)/.test(phone);
    const isAirtel = /^242(04)/.test(phone);
    res.json({
      active:   result.active,
      phone:    phone,
      operator: isMtn ? 'mtn' : isAirtel ? 'airtel' : 'unknown',
      network:  operator,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── BALANCE numéro MTN (AccountBalance) ─────────────────────────
// GET /api/v1/momo/accountbalance?phone=242XXXXXXX
router.get('/accountbalance', cardAuth, async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.status(422).json({ error: 'phone requis' });
    // En sandbox — retourne le solde du compte Collections
    const balance = await mtn.getCollectionBalance();
    res.json({
      phone,
      availableBalance: balance.balance,
      currency: balance.currency || 'XAF',
      note: 'Sandbox: solde simulé',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REQUEST TO PAY direct ───────────────────────────────────────
// POST /api/v1/momo/requesttopay
router.post('/requesttopay', cardAuth, async (req, res) => {
  const { amount, phone, description, externalId } = req.body;
  if (!amount || !phone) return res.status(422).json({ error: 'amount et phone requis' });
  try {
    const result = await mtn.requestToPay({ amount, phone, description, externalId });
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

module.exports = router;
