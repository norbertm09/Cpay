// backend/src/routes/mtn-momo.routes.js
// ================================================================
// CPlus 2.6 — MTN MoMo Routes
// POST /api/v1/momo/topup       — Collections (client paye)
// POST /api/v1/momo/payout      — Disbursements (CPlus envoie)
// GET  /api/v1/momo/status/:ref — Statut transaction
// POST /api/v1/momo/webhooks/mtn    — Callback MTN    (délégué à webhook-handlers)
// POST /api/v1/momo/webhooks/airtel — Callback Airtel (délégué à webhook-handlers)
// GET  /api/v1/momo/balance     — Soldes comptes (admin / marchand)
// Lot 2 (2026-11-09) : /payout, /accountbalance, /requesttopay → 410 (voir audit 2026-11-02 P1-3)
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
  const { phone, cardId } = req.body;
  // Lot 2 (audit 2026-11-02 P1-3) : montant typé (un "1000" en chaîne faussait les additions)
  const amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount < 500) return res.status(422).json({ error: 'Montant entier minimum 500 XAF' });
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
// Lot 2 (audit 2026-11-02 P1-3) : retiré. L'ancien handler appelait MTN DANS la transaction SQL (un échec réseau
// après acceptation MTN annulait le débit carte et la ligne pending : argent parti sans trace), avec un montant non
// typé. Aucun client ne l'utilise ; le déchargement carte passe par POST /api/v1/cardholder/unload.
const GONE = (res, replacement) => res.status(410).json({
  error: 'Endpoint retiré (audit 2026-11-02, lot 2)', code: 'FEATURE_DISABLED', ...(replacement ? { replacement } : {}),
});
router.post('/payout', cardAuth, (req, res) => GONE(res, 'POST /api/v1/cardholder/unload'));

// ─── STATUT transaction ───────────────────────────────────────────
// GET /api/v1/momo/status/:referenceId?product=collections|disbursements
// Le statut réel vient de MTN ; l'application en base passe par le même
// helper que le webhook (claim pending → crédit), donc rejouable sans double crédit.
router.get('/status/:referenceId', cardAuth, async (req, res) => {
  const { referenceId } = req.params;
  const product = req.query.product || 'collections';

  try {
    // Lot 2 (P1-3) : la référence doit désigner une transaction du porteur authentifié — jamais de relais brut
    // du statut MTN pour une référence inconnue ou appartenant à un autre porteur.
    const txn = await webhooks.findCardTxnByReference(referenceId);
    const ownerId = String(req.actor?.sub || req.actor?.cardholderId || '');
    if (!txn || req.actor?.type !== 'cardholder' || !ownerId || String(txn.cardholder_id || '') !== ownerId) {
      return res.status(404).json({ error: 'Transaction introuvable', code: 'NOT_FOUND' });
    }
    const status = product === 'collections'
      ? await mtn.getCollectionStatus(referenceId)
      : await mtn.getDisbursementStatus(referenceId);

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
router.put('/webhooks/mtn', webhooks.handleMtnWebhook); // MTN notifie en PUT sur X-Callback-Url

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

// ─── BALANCE numéro MTN / REQUEST TO PAY direct ──────────────────
// Lot 2 (audit 2026-11-02 P1-3) : retirés. /accountbalance renvoyait le solde du compte Collections de la
// plateforme à tout porteur ; /requesttopay permettait un push USSD MTN vers n'importe quel numéro sans ligne
// en base ni idempotence. Les encaissements passent par la caisse (POST /api/v1/merchant/cash/collect).
router.get('/accountbalance', cardAuth, (req, res) => GONE(res, 'GET /api/v1/momo/balance (admin)'));
router.post('/requesttopay', cardAuth, (req, res) => GONE(res, 'POST /api/v1/merchant/cash/collect'));

module.exports = router;
