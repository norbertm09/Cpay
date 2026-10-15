'use strict';
// ================================================================
// CPlus 2.6 — Card ↔ MoMo Orchestrator Routes
// POST /api/v1/card2momo   — Débit carte → Crédit MoMo
// POST /api/v1/momo2card   — Débit MoMo  → Crédit carte GTP
// POST /api/v1/card2card   — Carte → Carte (interne)
// POST /api/v1/momo2momo   — MoMo → MoMo
// GET  /api/v1/transfers/:txnId — Statut transfert
// ================================================================

'use strict';

const express  = require('express');
const { v4: uuidv4 } = require('uuid');
const router   = express.Router();
const psp      = require('../services/psp/psp.router');
const mtn      = require('../services/rails/mtn-momo.client');
const { query, withTransaction } = require('../config/database');
const webhooks = require('./webhook-handlers');

// ─── Auth middleware ──────────────────────────────────────────────
// WAVE-2 : auth unique (audit §1.1). L'ancien cardAuth acceptait n'importe quel
// JWT signe ; seuls les porteurs (type cardholder) peuvent lancer un card2momo
// (les handlers lisent req.actor.sub / req.actor.cardId = porteur).
const { cardholderAuth, aliasUser } = require('../middleware/auth');
const cardAuth = [cardholderAuth, aliasUser('actor')];

// ─── Helper : enregistrer transfert en DB ────────────────────────
const logTransfer = async (client, { txnId, cardId, cardholderId, type, amount, fee, feeBearer, currency, status, description, metadata }) => {
  await client.query(
    `INSERT INTO card_transactions
       (txn_id, card_id, cardholder_id, type, amount, fee, net_amount,
        balance_before, balance_after, currency, status, description, metadata, initiated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,$8,$9,$10,$11,NOW())`,
    [txnId, cardId, cardholderId, type, amount, fee, amount - fee,
     currency, status, description, JSON.stringify(metadata)]
  );
};

// ─── POST /card2momo ──────────────────────────────────────────────
// Leg 1 : Débit carte (PSP) → Leg 2 : Crédit MoMo (MTN Disbursements)
router.post('/card2momo', cardAuth, async (req, res) => {
  const { amount, tokenId, cardMasked, network, momoPhone, momoOperator = 'mtn', feeBearer, description } = req.body;

  if (!amount || amount < 1) return res.status(422).json({ error: "Montant requis" });
  if (!tokenId)                   return res.status(422).json({ error: 'Token carte requis' });
  if (!momoPhone)                 return res.status(422).json({ error: 'Numéro MoMo requis' });

  const txnId = uuidv4();

  try {
    // ─── LEG 1 : Débit carte via PSP ─────────────────────────────
    let leg1Result;
    try {
      leg1Result = await psp.chargeCard({
        amount,
        currency:   'XAF',
        tokenId,
        cardMasked,
        network,
        orderId:    txnId,
        cardholder: { email: req.actor.email },
        flowType:   'card2momo',
        feeBearer,
      });
    } catch (pspErr) {
      return res.status(402).json({
        error:  `Débit carte refusé: ${pspErr.message}`,
        code:   'PSP_DECLINED',
        leg:    1,
        psp:    pspErr.psp || 'unknown',
      });
    }

    // Enregistrer LEG 1
    await query(
      `INSERT INTO card_transactions
         (txn_id, card_id, cardholder_id, type, amount, fee, net_amount,
          balance_before, balance_after, currency, status, description, metadata, initiated_at)
       VALUES ($1,$2,$3,'card2momo_leg1',$4,$5,$6,0,0,'XAF','completed',$7,$8,NOW())`,
      [txnId, req.actor.cardId, req.actor.sub,
       leg1Result.debitAmount, leg1Result.fee, leg1Result.creditAmount,
       description || `Card2MoMo → ${momoPhone}`,
       JSON.stringify({ psp: leg1Result.psp, pspRef: leg1Result.pspRef, authCode: leg1Result.authCode, feeBearer: leg1Result.feeBearer })]
    );

    // ─── LEG 2 : Crédit MoMo via MTN Disbursements ───────────────
    const momoTxnId = uuidv4();
    let leg2Result;
    try {
      leg2Result = await mtn.transfer({
        amount:      leg1Result.creditAmount,
        phone:       momoPhone.replace(/\D/g, ''),
        description: `C-Pay Card2MoMo ${txnId}`,
        externalId:  momoTxnId,
      });
    } catch (momoErr) {
      // LEG 2 échoué → rembourser LEG 1
      try {
        await psp.refundCard({ psp: leg1Result.psp, transactionId: leg1Result.transactionId, amount: leg1Result.debitAmount, orderId: txnId });
        await query(`UPDATE card_transactions SET status='refunded', failure_reason=$1 WHERE txn_id=$2`,
          [`Leg2 MoMo failed: ${momoErr.message}`, txnId]);
      } catch (refundErr) {
        console.error('[CARD2MOMO] Refund failed:', refundErr.message);
      }
      return res.status(502).json({
        error: `Crédit MoMo échoué: ${momoErr.message}`,
        code:  'MOMO_FAILED',
        leg:   2,
        note:  'Remboursement initié',
      });
    }

    // Enregistrer LEG 2 — mm_reference = X-Reference-Id MTN : le webhook / la
    // réconciliation retrouvent la transaction et la passent à completed ou
    // needs_refund (carte déjà débitée) selon le statut réel du transfert.
    await query(
      `UPDATE card_transactions SET
         metadata = COALESCE(metadata,'{}'::jsonb) || $1::jsonb,
         status = 'pending',
         mm_reference = $3,
         mobile_money_op = $4,
         mobile_money_phone = $5
       WHERE txn_id = $2`,
      [JSON.stringify({ leg2: { mtnRef: leg2Result.referenceId, momoPhone, momoOperator, status: 'PENDING' } }), txnId,
       leg2Result.referenceId, momoOperator, momoPhone]
    );

    res.json({
      success:       true,
      txnId,
      leg1: {
        psp:           leg1Result.psp,
        status:        'COMPLETED',
        debitAmount:   leg1Result.debitAmount,
        authCode:      leg1Result.authCode,
        cardMasked:    leg1Result.cardMasked,
      },
      leg2: {
        operator:      momoOperator,
        phone:         momoPhone,
        creditAmount:  leg1Result.creditAmount,
        referenceId:   leg2Result.referenceId,
        status:        'PENDING',
        pollUrl:       `/api/v1/momo/status/${leg2Result.referenceId}?product=disbursements`,
      },
      fee:             leg1Result.fee,
      feeRate:         `${(leg1Result.feeRate * 100).toFixed(1)}%`,
      feeBearer:       leg1Result.feeBearer,
      currency:        'XAF',
    });

  } catch (err) {
    console.error('[CARD2MOMO]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /momo2card ──────────────────────────────────────────────
// Leg 1 : Débit MoMo (MTN Collections) → Leg 2 : Crédit carte GTP
router.post('/momo2card', cardAuth, async (req, res) => {
  const { amount, momoPhone, momoOperator = 'mtn', gtpCardId, feeBearer, description } = req.body;

  if (!amount || amount < 1) return res.status(422).json({ error: 'Montant requis' });
  if (!momoPhone)              return res.status(422).json({ error: 'Numéro MoMo requis' });

  const fees    = psp.calculateFees(amount, 'momo2card', feeBearer);
  const txnId   = uuidv4();
  const momoRef = uuidv4();

  try {
    // ─── LEG 1 : Débit MoMo ──────────────────────────────────────
    const leg1 = await mtn.requestToPay({
      amount:      fees.debitAmount,
      phone:       momoPhone.replace(/\D/g, ''),
      description: 'C-Pay MoMo2Card',
      externalId:  momoRef,
    });

    // Enregistrer en PENDING
    let cardId2 = req.actor.cardId;
    if (!cardId2) {
      const cardRes2 = await query('SELECT card_id FROM cardholders WHERE cardholder_id=$1', [req.actor.sub]);
      cardId2 = cardRes2.rows[0]?.card_id;
    }
    await query(
      `INSERT INTO card_transactions
         (txn_id, card_id, cardholder_id, type, amount, fee, net_amount,
          balance_before, balance_after, currency, status, description, metadata, initiated_at)
       VALUES ($1,$2,$3,'momo2card',$4,$5,$6,0,0,'XAF','pending',$7,$8,NOW())`,
      [txnId, cardId2, req.actor.sub,
       fees.debitAmount, fees.fee, fees.creditAmount,
       description || `MoMo2Card ← ${momoPhone}`,
       JSON.stringify({ mtnRef: momoRef, momoPhone, momoOperator, gtpCardId, feeBearer: fees.feeBearer })]
    );

    res.json({
      success:      true,
      txnId,
      leg1: {
        operator:    momoOperator,
        phone:       momoPhone,
        debitAmount: fees.debitAmount,
        referenceId: momoRef,
        status:      'PENDING',
        message:     `Validez le paiement de ${fees.debitAmount} XAF sur votre téléphone ${momoOperator.toUpperCase()}`,
        pollUrl:     `/api/v1/transfers/${txnId}/status`,
      },
      leg2: {
        creditAmount: fees.creditAmount,
        gtpCardId:    gtpCardId || 'default',
        status:       'WAITING_LEG1',
      },
      fee:       fees.fee,
      feeRate:   `${(fees.feeRate * 100).toFixed(1)}%`,
      feeBearer: fees.feeBearer,
      currency:  'XAF',
    });

  } catch (err) {
    console.error('[MOMO2CARD]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /momo2momo ──────────────────────────────────────────────
router.post('/momo2momo', cardAuth, async (req, res) => {
  const { amount, srcPhone, dstPhone, srcOperator = 'mtn', dstOperator = 'mtn', description } = req.body;

  if (!amount || amount < 1) return res.status(422).json({ error: 'Montant requis' });
  if (!srcPhone || !dstPhone)  return res.status(422).json({ error: 'Numéros source et destination requis' });

  const fees    = psp.calculateFees(amount, 'momo2momo');
  const txnId   = uuidv4();
  const leg1Ref = uuidv4();

  try {
    // Récupérer cardId si manquant dans le token
    let cardId = req.actor.cardId;
    if (!cardId) {
      const cardRes = await query('SELECT card_id FROM cardholders WHERE cardholder_id=$1', [req.actor.sub]);
      cardId = cardRes.rows[0]?.card_id;
    }

    // LEG 1 : Débit MoMo source
    const leg1 = await mtn.requestToPay({
      amount:      fees.debitAmount,
      phone:       srcPhone.replace(/\D/g, ''),
      description: `C-Pay MoMo2MoMo -> ${dstPhone}`,
      externalId:  leg1Ref,
    });

    await query(
      `INSERT INTO card_transactions
         (txn_id, card_id, cardholder_id, type, amount, fee, net_amount,
          balance_before, balance_after, currency, status, description, metadata, initiated_at)
       VALUES ($1,$2,$3,'momo2momo',$4,$5,$6,0,0,'XAF','pending',$7,$8,NOW())`,
      [txnId, cardId, req.actor.sub,
       fees.debitAmount, fees.fee, fees.creditAmount,
       description || `MoMo2MoMo ${srcPhone} → ${dstPhone}`,
       JSON.stringify({ leg1Ref, srcPhone, dstPhone, srcOperator, dstOperator })]
    );

    res.json({
      success:      true,
      txnId,
      leg1: { phone: srcPhone, debitAmount: fees.debitAmount, referenceId: leg1Ref, status: 'PENDING' },
      leg2: { phone: dstPhone, creditAmount: fees.creditAmount, status: 'WAITING_LEG1' },
      fee:       fees.fee,
      feeBearer: fees.feeBearer,
      currency:  'XAF',
    });
  } catch (err) {
    console.error('[MOMO2MOMO ERROR]', err.message, err.stack?.split('\n').slice(0,3).join(' | '));
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /transfers/:txnId/status ────────────────────────────────
router.get('/transfers/:txnId/status', cardAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM card_transactions WHERE txn_id=$1 AND cardholder_id=$2`,
      [req.params.txnId, req.actor.sub]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Transfert introuvable' });
    const txn  = r.rows[0];
    const meta = txn.metadata || {};

    // card2momo : jambe 2 (disbursement MTN) en attente — statut réel MTN
    // SUCCESSFUL → completed ; FAILED → needs_refund (carte déjà débitée, remboursement manuel)
    if (txn.status === 'pending' && txn.type === 'card2momo' && meta.leg2?.mtnRef) {
      const disb = await mtn.getDisbursementStatus(meta.leg2.mtnRef);
      if (disb.status === 'SUCCESSFUL' || disb.status === 'FAILED') {
        const r = await webhooks.applyCardTxnProviderStatus(txn, {
          provider: 'mtn', status: disb.status,
          financialTransactionId: disb.financialTxnId || null,
          reason: disb.reason || 'MTN_FAILED', amount: disb.amount, currency: disb.currency,
        });
        if (r.reason === 'mismatch') return res.status(409).json({ error: 'Montant ou devise incohérent', code: 'AMOUNT_MISMATCH' });
        const newStatus = r.newStatus || txn.status;
        return res.json({
          txnId: txn.txn_id, status: newStatus.toUpperCase(), leg1: 'COMPLETED', leg2: disb.status,
          reason: disb.status === 'FAILED' ? (disb.reason || 'MTN_FAILED') : undefined,
          note: newStatus === 'needs_refund' ? 'Crédit MoMo échoué après débit carte — remboursement en cours de traitement' : undefined,
        });
      }
    }

    // momo2card / momo2momo : jambe 1 (collection MTN) en attente — statut réel MTN
    if (txn.status === 'pending' && meta.mtnRef) {
      const momoStatus = await mtn.getCollectionStatus(meta.mtnRef);

      if (momoStatus.status === 'SUCCESSFUL') {
        const mismatch = webhooks.checkAmountCurrency({
          expectedAmount: txn.amount, expectedCurrency: txn.currency,
          amount: momoStatus.amount, currency: momoStatus.currency,
        });
        if (mismatch) {
          console.error('[TRANSFER-STATUS] amount/currency mismatch', { txnId: txn.txn_id, ...mismatch });
          return res.status(409).json({ error: 'Montant ou devise incohérent', code: 'AMOUNT_MISMATCH' });
        }
        if (txn.type === 'momo2card') {
          // LEG 2 : Créditer la carte GTP
          // TODO: appel GTP API /cards/{id}/load quand credentials disponibles
          const upd = await query(
            `UPDATE card_transactions SET status='completed', completed_at=NOW()
             WHERE txn_id=$1 AND status='pending' RETURNING txn_id`, [txn.txn_id]);
          return res.json({ txnId: txn.txn_id, status: 'COMPLETED', leg1: 'SUCCESSFUL', leg2: 'COMPLETED', applied: !!upd.rowCount });
        }
      }

      if (momoStatus.status === 'FAILED') {
        await query(
          `UPDATE card_transactions SET status='failed', failure_reason=$2
           WHERE txn_id=$1 AND status='pending'`, [txn.txn_id, String(momoStatus.reason || 'MTN_FAILED').slice(0, 255)]);
        return res.json({ txnId: txn.txn_id, status: 'FAILED', reason: momoStatus.reason });
      }
    }

    res.json({
      txnId:   txn.txn_id,
      status:  txn.status,
      type:    txn.type,
      amount:  parseFloat(txn.amount),
      fee:     parseFloat(txn.fee),
      metadata: txn.metadata,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Webhook PSP (CyberSource / MIGS / Stripe) ───────────────────
// Stripe : signature `Stripe-Signature` (t=…,v1=…) OBLIGATOIRE, HMAC-SHA256 de
// `${t}.${payload}` avec STRIPE_WEBHOOK_SECRET ; secret absent ou en-tête absent → 401.
// CyberSource / MIGS ont leurs propres routes (/api/v1/webhooks/*) : ici aucun changement d'état.
let _stripeSecretWarned = false;
const verifyStripeSignature = (req) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    if (!_stripeSecretWarned) { _stripeSecretWarned = true; console.error('[WEBHOOK-STRIPE] STRIPE_WEBHOOK_SECRET non configuré — webhook refusé (fail-closed)'); }
    return { ok: false, code: 'WEBHOOK_NOT_CONFIGURED' };
  }
  const header = req.headers['stripe-signature'];
  if (!header) return { ok: false, code: 'MISSING_SIGNATURE' };
  const parts = String(header).split(',').map(s => s.trim());
  const t  = parts.find(p => p.startsWith('t='))?.slice(2);
  const v1 = parts.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (!t || !v1.length) return { ok: false, code: 'INVALID_SIGNATURE' };
  const toleranceSec = parseInt(process.env.STRIPE_WEBHOOK_TOLERANCE_SEC || '300', 10);
  if (Number.isFinite(Number(t)) && Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) {
    return { ok: false, code: 'SIGNATURE_EXPIRED' };
  }
  const expected = require('crypto').createHmac('sha256', secret)
    .update(`${t}.${webhooks.signedPayload(req)}`).digest('hex');
  const ok = v1.some(sig => webhooks.timingSafeEqualStr(sig, expected));
  return ok ? { ok: true } : { ok: false, code: 'INVALID_SIGNATURE' };
};

router.post('/webhooks/psp/:psp', async (req, res) => {
  const { psp: pspName } = req.params;
  console.log(`[WEBHOOK-${pspName.toUpperCase()}]`, JSON.stringify(req.body || {}).slice(0, 200));

  try {
    // Stripe webhook
    if (pspName === 'stripe') {
      const sig = verifyStripeSignature(req);
      if (!sig.ok) {
        return res.status(401).json({ error: 'Signature webhook invalide', code: sig.code });
      }
      const { type, data } = req.body || {};
      const obj     = data?.object || {};
      const orderId = obj.metadata?.cplus_txn;
      if (!orderId) {
        return res.status(200).json({ received: true, ignored: true });
      }
      const isSuccess = type === 'payment_intent.succeeded';
      const isFailed  = type === 'payment_intent.payment_failed' || type === 'payment_intent.canceled';
      if (!isSuccess && !isFailed) {
        return res.status(200).json({ received: true, ignored: true });
      }

      const r = await query(`SELECT * FROM card_transactions WHERE txn_id=$1 LIMIT 1`, [orderId]);
      const txn = r.rows[0];
      if (!txn) return res.status(200).json({ received: true, outcome: 'unknown_reference' });
      if (txn.status !== 'pending') {
        // Rejeu / transaction déjà finalisée : aucune régression
        return res.status(200).json({ received: true, outcome: 'already_processed', status: txn.status });
      }

      const currency = obj.currency ? String(obj.currency).toUpperCase() : null;
      const amountMinor = obj.amount_received ?? obj.amount;
      const amount = amountMinor != null ? webhooks.minorToMajor(amountMinor, currency || txn.currency) : null;
      const mismatch = webhooks.checkAmountCurrency({ expectedAmount: txn.amount, expectedCurrency: txn.currency, amount, currency });
      if (mismatch) {
        console.error('[WEBHOOK-STRIPE] amount/currency mismatch — no state change', { orderId, ...mismatch });
        await webhooks.recordWebhookEvent({ provider: 'stripe', referenceId: orderId, status: type, outcome: 'mismatch', payload: req.body, ip: req.ip });
        return res.status(409).json({ error: 'Montant ou devise incohérent', code: 'AMOUNT_MISMATCH' });
      }

      const upd = isSuccess
        ? await query(
            `UPDATE card_transactions SET status='completed', completed_at=NOW(), auth_code=COALESCE($2, auth_code)
             WHERE txn_id=$1 AND status='pending' RETURNING txn_id`, [orderId, obj.id ? String(obj.id).slice(0, 64) : null])
        : await query(
            `UPDATE card_transactions SET status='failed', failure_reason=$2
             WHERE txn_id=$1 AND status='pending' RETURNING txn_id`,
            [orderId, String(obj.last_payment_error?.message || type).slice(0, 255)]);
      await webhooks.recordWebhookEvent({
        provider: 'stripe', referenceId: orderId, status: type,
        outcome: upd.rowCount ? (isSuccess ? 'completed' : 'failed') : 'already_processed', payload: req.body, ip: req.ip,
      });
      return res.status(200).json({ received: true, applied: !!upd.rowCount });
    }
    // CyberSource et MIGS — routes dédiées /api/v1/webhooks/cybersource|migs (aucun changement d'état ici)
    res.status(200).json({ received: true, ignored: true });
  } catch (err) {
    console.error('[WEBHOOK-PSP]', err.message);
    res.status(500).json({ error: 'Erreur interne' });
  }
});

module.exports = router;
