// backend/src/routes/mtn-momo.routes.js
// ================================================================
// CPlus 2.6 — MTN MoMo Routes
// POST /api/v1/momo/topup       — Collections (client paye)
// POST /api/v1/momo/payout      — Disbursements (CPlus envoie)
// GET  /api/v1/momo/status/:ref — Statut transaction
// POST /api/v1/webhooks/mtn     — Callback MTN
// GET  /api/v1/momo/balance     — Soldes comptes
// GET  /api/v1/momo/validate/:phone — Valider numéro MTN
// ================================================================

'use strict';

const express = require('express');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();
const mtn     = require('../services/rails/mtn-momo.client');
const { query, withTransaction } = require('../config/database');
const { auditLog } = require('../middleware/pci.middleware');

// ─── Auth middleware ──────────────────────────────────────────────
const cardAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requis' });
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (!['cardholder', 'merchant'].includes(decoded.type)) return res.status(403).json({ error: 'Accès refusé' });
    req.actor = decoded;
    next();
  } catch { res.status(401).json({ error: 'Token invalide' }); }
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
    if (card.status === 'cancelled') return res.status(422).json({ error: 'Carte annulée' });

    // Frais 1%
    const fee     = Math.round(amount * 0.01);
    const credited = amount - fee;
    const externalId = uuidv4();

    // Enregistrer la transaction en PENDING
    const txnRes = await query(
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
      description: `CPlus Top-up ${amount} XAF`,
      externalId,
    });

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

  try {
    await withTransaction(async client => {
      const cardRes = await client.query(
        `SELECT * FROM virtual_cards WHERE card_id=$1 FOR UPDATE`,
        [resolvedCardId]
      );
      const card = cardRes.rows[0];
      if (!card) throw Object.assign(new Error('Carte introuvable'), { statusCode: 404 });
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
        description: `CPlus Payout ${amount} XAF`,
        externalId,
      });

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
    res.status(err.statusCode || 500).json({ error: err.message, code: 'MTN_ERROR' });
  }
});

// ─── STATUT transaction ───────────────────────────────────────────
// GET /api/v1/momo/status/:referenceId?product=collections|disbursements
router.get('/status/:referenceId', cardAuth, async (req, res) => {
  const { referenceId } = req.params;
  const product = req.query.product || 'collections';

  try {
    const status = product === 'collections'
      ? await mtn.getCollectionStatus(referenceId)
      : await mtn.getDisbursementStatus(referenceId);

    // Si SUCCESSFUL — mettre à jour la transaction en DB
    if (status.status === 'SUCCESSFUL') {
      await query(
        `UPDATE card_transactions
         SET status='completed', completed_at=NOW(), auth_code=$1
         WHERE mm_reference=$2 AND status='pending'`,
        [status.financialTxnId || referenceId, referenceId]
      );

      // Si c'est un topup — créditer la carte
      if (product === 'collections') {
        const txnRes = await query(
          `SELECT * FROM card_transactions WHERE mm_reference=$1`,
          [referenceId]
        );
        if (txnRes.rows.length) {
          const txn = txnRes.rows[0];
          await query(
            `UPDATE virtual_cards SET balance=balance+$1, updated_at=NOW() WHERE card_id=$2`,
            [txn.net_amount, txn.card_id]
          );
        }
      }
    }

    // Si FAILED — rembourser si c'était un payout
    if (status.status === 'FAILED' && product === 'disbursements') {
      const txnRes = await query(
        `SELECT * FROM card_transactions WHERE mm_reference=$1 AND status='pending'`,
        [referenceId]
      );
      if (txnRes.rows.length) {
        const txn = txnRes.rows[0];
        // Rembourser : recréditer le total débité (amount + fee)
        const totalDebited = parseFloat(txn.amount) + parseFloat(txn.fee);
        await query(
          `UPDATE virtual_cards SET balance=balance+$1, updated_at=NOW() WHERE card_id=$2`,
          [totalDebited, txn.card_id]
        );
        await query(
          `UPDATE card_transactions SET status='failed', failure_reason=$1 WHERE mm_reference=$2`,
          [status.reason || 'MTN_FAILED', referenceId]
        );
      }
    }

    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WEBHOOK MTN callback ─────────────────────────────────────────
// POST /api/v1/webhooks/mtn
router.post('/webhooks/mtn', async (req, res) => {
  try {
    const { referenceId, status, financialTransactionId, reason } = req.body;
    if (!referenceId) return res.status(400).json({ error: 'referenceId requis' });

    // Logger le callback
    await auditLog({
      eventType: `MTN_WEBHOOK_${status}`,
      actorType: 'system',
      details:   req.body,
      ipAddress: req.ip,
      success:   status === 'SUCCESSFUL',
    });

    if (status === 'SUCCESSFUL') {
      // Topup — créditer la carte
      const txnRes = await query(
        `SELECT * FROM card_transactions WHERE mm_reference=$1 AND status='pending'`,
        [referenceId]
      );
      if (txnRes.rows.length) {
        const txn = txnRes.rows[0];
        if (txn.type === 'topup') {
          await query(
            `UPDATE virtual_cards SET balance=balance+$1, updated_at=NOW() WHERE card_id=$2`,
            [txn.net_amount, txn.card_id]
          );
        }
        await query(
          `UPDATE card_transactions SET status='completed', completed_at=NOW(), auth_code=$1 WHERE mm_reference=$2`,
          [financialTransactionId || referenceId, referenceId]
        );
      }
    }

    if (status === 'FAILED') {
      const txnRes = await query(
        `SELECT * FROM card_transactions WHERE mm_reference=$1 AND status='pending'`,
        [referenceId]
      );
      if (txnRes.rows.length && txnRes.rows[0].type === 'unload') {
        // Rembourser le payout échoué
        const txn = txnRes.rows[0];
        await query(
          `UPDATE virtual_cards SET balance=balance+$1, updated_at=NOW() WHERE card_id=$2`,
          [parseFloat(txn.amount) + parseFloat(txn.fee), txn.card_id]
        );
      }
      await query(
        `UPDATE card_transactions SET status='failed', failure_reason=$1 WHERE mm_reference=$2`,
        [reason || 'FAILED', referenceId]
      );
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[MTN-WEBHOOK]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── BALANCE ─────────────────────────────────────────────────────
// GET /api/v1/momo/balance (admin uniquement)
router.get('/balance', async (req, res) => {
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

// ─── WEBHOOK AIRTEL MONEY callback ────────────────────────────────
// POST /api/v1/webhooks/airtel
// Airtel Africa Open API envoie un callback asynchrone après chaque
// transaction (collection ou disbursement)
// Sécurité : vérification signature X-Airtel-Signature (HMAC-SHA256)
router.post('/webhooks/airtel', async (req, res) => {
  // 1. Vérification signature Airtel
  const signature = req.headers['x-airtel-signature'];
  const secret    = process.env.AIRTEL_WEBHOOK_SECRET;
  if (secret && signature) {
    const expected = require('crypto')
      .createHmac('sha256', secret)
      .update(JSON.stringify(req.body))
      .digest('hex');
    if (signature !== expected) {
      await auditLog({ eventType: 'AIRTEL_WEBHOOK_INVALID_SIGNATURE', actorType: 'system', ipAddress: req.ip, success: false });
      return res.status(401).json({ error: 'Signature invalide' });
    }
  }

  try {
    // Format Airtel Africa Open API callback
    const {
      transaction,   // { id, status, airtel_money_id, message }
      data,          // { transaction: { id, status, airtel_money_id } }
    } = req.body;

    // Normaliser selon la version Airtel API (v1 vs v2)
    const txnData    = transaction || data?.transaction || {};
    const referenceId = txnData.id || req.body.reference;
    const status      = txnData.status || req.body.status;  // TS=success, TF=failed, TIP=pending
    const airtelRef   = txnData.airtel_money_id || txnData.airtel_money_id;
    const message     = txnData.message || req.body.message;

    if (!referenceId) return res.status(400).json({ error: 'transaction.id requis' });

    const isSuccess = ['TS', 'SUCCESS', 'SUCCESSFUL', 'COMPLETE'].includes(status?.toUpperCase());
    const isFailed  = ['TF', 'FAILED', 'FAILED', 'EXPIRED'].includes(status?.toUpperCase());

    console.log(`[AIRTEL-WEBHOOK] ref=${referenceId} status=${status} airtelRef=${airtelRef}`);

    // 2. Audit log
    await auditLog({
      eventType: `AIRTEL_WEBHOOK_${status}`,
      actorType: 'system',
      details:   { referenceId, status, airtelRef, message },
      ipAddress: req.ip,
      success:   isSuccess,
    });

    // 3. Retrouver la transaction en attente
    // Chercher dans card_transactions (portail cardholder)
    const cardTxnRes = await query(
      `SELECT * FROM card_transactions WHERE mm_reference=$1 AND status='pending' LIMIT 1`,
      [referenceId]
    );

    // Chercher dans audit_logs / transactions principales
    const mainTxnRes = await query(
      `SELECT * FROM transactions WHERE reference_id=$1 AND status='pending' LIMIT 1`,
      [referenceId]
    ).catch(() => ({ rows: [] }));

    if (isSuccess) {
      // ── Traitement succès ──────────────────────────────────────
      if (cardTxnRes.rows.length) {
        const txn = cardTxnRes.rows[0];

        if (txn.type === 'topup') {
          // Créditer la carte virtuelle
          await query(
            `UPDATE virtual_cards SET balance=balance+$1, updated_at=NOW() WHERE card_id=$2`,
            [parseFloat(txn.net_amount), txn.card_id]
          );
          // Créditer aussi la carte GTP si liée
          await query(
            `UPDATE gtp_cards SET updated_at=NOW() WHERE cardholder_id=(SELECT cardholder_id FROM cardholders WHERE cardholder_id=$1)`,
            [txn.cardholder_id]
          ).catch(() => {});
        }
        // Marquer complété
        await query(
          `UPDATE card_transactions
           SET status='completed', completed_at=NOW(), auth_code=$1, metadata=metadata||$2
           WHERE mm_reference=$3`,
          [airtelRef || referenceId, JSON.stringify({ airtelRef, webhook: 'airtel' }), referenceId]
        );
      }

      if (mainTxnRes.rows.length) {
        await query(
          `UPDATE transactions SET status='completed', completed_at=NOW(), gateway_ref=$1 WHERE reference_id=$2`,
          [airtelRef, referenceId]
        ).catch(() => {});
      }

    } else if (isFailed) {
      // ── Traitement échec — remboursement si unload ─────────────
      if (cardTxnRes.rows.length) {
        const txn = cardTxnRes.rows[0];
        if (txn.type === 'unload') {
          // Rembourser le montant + frais sur la carte
          await query(
            `UPDATE virtual_cards SET balance=balance+$1, updated_at=NOW() WHERE card_id=$2`,
            [parseFloat(txn.amount) + parseFloat(txn.fee), txn.card_id]
          );
        }
        await query(
          `UPDATE card_transactions SET status='failed', failure_reason=$1 WHERE mm_reference=$2`,
          [message || `Airtel ${status}`, referenceId]
        );
      }

      if (mainTxnRes.rows.length) {
        await query(
          `UPDATE transactions SET status='failed', failure_reason=$1 WHERE reference_id=$2`,
          [message || `Airtel ${status}`, referenceId]
        ).catch(() => {});
      }
    }
    // TIP (Transaction In Progress) → ne rien faire, attendre le prochain callback

    // 4. Répondre 200 immédiatement (Airtel re-essaie si timeout)
    res.status(200).json({ success: true, referenceId, status });

  } catch (err) {
    console.error('[AIRTEL-WEBHOOK-ERROR]', err.message);
    // Toujours répondre 200 pour éviter les re-essais infinis d'Airtel
    res.status(200).json({ received: true });
  }
});

