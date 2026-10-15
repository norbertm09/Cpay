'use strict';

const { v4: uuidv4 } = require('uuid');
const { query } = require('../../config/database');
const gtp   = require('../rails/gtp-card.service');
const mtn   = require('../rails/mtn-momo.client');
const email = require('../notifications/email.service');
const logger = require('../../config/logger');

const REF = () => 'TRF-' + Date.now().toString(36).toUpperCase();

// Statut terminal "a compenser" : une jambe a deplace des fonds et une jambe
// suivante a echoue → un operateur doit annuler/rembourser. Jamais 'completed'.
const NEEDS_REVERSAL = 'needs_reversal';

// ─── Etat d'un transfert ─────────────────────────────────────────
const setStatus = async (id, status, extra = {}) => {
  const fields = ['status=$2'];
  const vals = [id, status];
  let n = 2;

  if (extra.steps)          { fields.push(`steps=$${++n}`);              vals.push(JSON.stringify(extra.steps)); }
  if (extra.momoReference)  { fields.push(`momo_reference=$${++n}`);     vals.push(extra.momoReference); }
  if (extra.gtpTxnId)       { fields.push(`gtp_transaction_id=$${++n}`); vals.push(extra.gtpTxnId); }
  if (extra.error)          { fields.push(`error_message=$${++n}`);      vals.push(extra.error); }
  if (status === 'completed' || status === 'failed' || status === NEEDS_REVERSAL) fields.push('completed_at=NOW()');

  await query(
    `UPDATE bank_transfers SET ${fields.join(', ')} WHERE transfer_id=$1`, vals);
};

// ─── Attente confirmation MoMo (polling) ─────────────────────────
const waitMomo = async (referenceId, timeoutMs = 90000) => {
  const start = Date.now();
  const interval = 3000;

  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, interval));
    try {
      const s = await mtn.getCollectionStatus(referenceId);
      if (s.status === 'SUCCESSFUL') return { ok: true, ...s };
      if (s.status === 'FAILED')     return { ok: false, reason: s.reason || 'Paiement refuse' };
    } catch (e) { /* on continue a poller */ }
  }
  return { ok: false, reason: 'TIMEOUT', timeout: true };
};

// ═══════════════════════════════════════════════════════════════════
// TRANSFERT — orchestration
// ═══════════════════════════════════════════════════════════════════
const initiate = async ({ cardholderId, direction, sourceType, sourceId, accountId, amount, description }) => {
  const amt = parseFloat(amount);
  const ref = REF();

  // Compte bancaire
  const acc = await query(
    `SELECT ba.*, fi.name AS inst_name, fi.code AS inst_code, fi.type AS inst_type, fi.country
     FROM bank_accounts ba
     LEFT JOIN financial_institutions fi ON fi.institution_id = ba.institution_id
     WHERE ba.account_id=$1 AND ba.owner_id=$2 AND ba.status='verified'`,
    [accountId, cardholderId]);
  if (!acc.rows[0]) throw Object.assign(new Error('Compte bancaire introuvable'), { code: 'NO_ACCOUNT' });
  const bank = acc.rows[0];

  // Carte GTP (obligatoire — pivot de tous les transferts)
  const cardRes = await query(
    `SELECT gtp_card_id, last4 FROM gtp_cards
     WHERE cardholder_id=$1 AND status='active' LIMIT 1`, [cardholderId]);
  if (!cardRes.rows[0]) throw Object.assign(new Error('Aucune carte GTP active'), { code: 'NO_GTP_CARD' });
  const gtpCard = cardRes.rows[0];

  // Porteur
  const chRes = await query(
    `SELECT email, phone, first_name FROM cardholders WHERE cardholder_id=$1`, [cardholderId]);
  const ch = chRes.rows[0] || {};

  // Source/destination MoMo
  let wallet = null;
  if (sourceType === 'wallet') {
    const w = await query(
      `SELECT * FROM cardholder_wallets
       WHERE wallet_id=$1 AND cardholder_id=$2 AND status='active'`,
      [sourceId, cardholderId]);
    if (!w.rows[0]) throw Object.assign(new Error('Wallet introuvable'), { code: 'NO_WALLET' });
    wallet = w.rows[0];
  }

  // Trace
  const t = await query(
    `INSERT INTO bank_transfers (cardholder_id, direction, source_type, source_id,
      dest_type, dest_id, bank_account_id, amount, currency, status, reference, steps)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'XAF','pending',$9,'[]')
     RETURNING transfer_id`,
    [cardholderId, direction,
     direction === 'to_bank' ? sourceType : 'bank',
     direction === 'to_bank' ? String(sourceId || gtpCard.gtp_card_id) : accountId,
     direction === 'to_bank' ? 'bank' : sourceType,
     direction === 'to_bank' ? accountId : String(sourceId || gtpCard.gtp_card_id),
     accountId, amt, ref]);
  const transferId = t.rows[0].transfer_id;

  const bankRef = `${bank.inst_code}|${bank.account_number}|${description || ''}`.slice(0, 100);
  const steps = [];

  // ═══ Execution asynchrone ═══
  (async () => {
    try {
      // ─── VERS LA BANQUE ───
      if (direction === 'to_bank') {

        // Etape MoMo : debit du wallet
        if (sourceType === 'wallet') {
          await setStatus(transferId, 'awaiting_momo_confirmation');

          const rtp = await mtn.requestToPay({
            amount: amt,
            phone: wallet.phone,
            description: `C-Pay - Virement ${bank.inst_name}`,
            externalId: ref,
          });
          steps.push({ step: 'momo_request', status: 'pending', ref: rtp.referenceId, at: new Date() });
          await setStatus(transferId, 'awaiting_momo_confirmation',
            { steps, momoReference: rtp.referenceId });

          const conf = await waitMomo(rtp.referenceId);
          if (!conf.ok) {
            steps.push({ step: 'momo_request', status: 'failed', reason: conf.reason });
            await setStatus(transferId, 'failed', { steps, error: conf.reason });
            return;
          }
          steps[steps.length - 1].status = 'success';
          await setStatus(transferId, 'processing', { steps });

          // Crediter la carte GTP
          const w2c = await gtp.topUp({
            gtpCardId: gtpCard.gtp_card_id,
            cardholderId,
            amount: amt,
            operator: wallet.operator,
            mmPhone: wallet.phone,
          });
          steps.push({ step: 'wallet_to_card', status: 'success', txnId: w2c.transactionId });
          await setStatus(transferId, 'processing', { steps });
        }

        // Carte -> Banque
        await setStatus(transferId, 'processing');
        const c2b = await gtp.cardToBank({
          gtpCardId: gtpCard.gtp_card_id,
          cardholderId,
          amount: amt,
          bankRef,
          mobilePhone: ch.phone,
        });
        steps.push({ step: 'card_to_bank', status: 'success', txnId: c2b.transactionId });
        await setStatus(transferId, 'completed', { steps, gtpTxnId: c2b.transactionId });

        if (ch.email) {
          email.sendTransferNotice({
            to: ch.email, direction: 'to_bank', amount: amt,
            institution: bank.inst_name,
            accountNumber: bank.account_number.replace(/.(?=.{4})/g, '*'),
            accountName: bank.account_name,
            transactionId: c2b.transactionId,
            newBalance: c2b.newBalance,
          }).catch(() => {});
        }

      // ─── DEPUIS LA BANQUE ───
      } else {
        await setStatus(transferId, 'processing');

        const b2c = await gtp.bankToCard({
          gtpCardId: gtpCard.gtp_card_id,
          cardholderId,
          amount: amt,
          bankRef,
          mobilePhone: ch.phone,
        });
        steps.push({ step: 'bank_to_card', status: 'success', txnId: b2c.transactionId });
        await setStatus(transferId, 'processing', { steps, gtpTxnId: b2c.transactionId });

        // Vers un wallet : decharger la carte
        if (sourceType === 'wallet') {
          const c2w = await gtp.unload({
            gtpCardId: gtpCard.gtp_card_id,
            cardholderId,
            amount: amt,
            operator: wallet.operator,
            mmPhone: wallet.phone,
          });
          steps.push({ step: 'card_to_wallet', status: 'success', txnId: c2w.transactionId });

          // Crediter le wallet via MTN Disbursement
          if (wallet.operator === 'mtn') {
            try {
              const disb = await mtn.transfer({
                amount: amt,
                phone: wallet.phone,
                description: `C-Pay - Reception ${bank.inst_name}`,
                externalId: ref + '-D',
              });
              steps.push({ step: 'momo_disburse', status: 'pending', ref: disb.referenceId, at: new Date() });
            } catch (e) {
              // Carte dechargee mais wallet NON credite : jamais 'completed'.
              steps.push({ step: 'momo_disburse', status: 'failed', reason: e.message, at: new Date() });
              logger.error('[transfer] from_bank: MoMo disbursement failed after card unload — needs reversal', {
                transferId, reference: ref, cardholderId, amount: amt, gtpTxnId: b2c.transactionId, unloadTxnId: c2w.transactionId, err: e.message,
              });
              await setStatus(transferId, NEEDS_REVERSAL, {
                steps, gtpTxnId: b2c.transactionId,
                error: `Jambe MoMo echouee apres dechargement carte (${c2w.transactionId}) : ${e.message}`,
              });
              return;
            }
          }
        }

        // Aucune etape en echec → completed (sinon on est deja sorti plus haut)
        if (steps.some(s => s.status === 'failed')) {
          logger.error('[transfer] from_bank: step failed — not marking completed', { transferId, steps });
          await setStatus(transferId, NEEDS_REVERSAL, { steps, error: 'Une etape a echoue' });
          return;
        }
        await setStatus(transferId, 'completed', { steps });

        if (ch.email) {
          email.sendTransferNotice({
            to: ch.email, direction: 'from_bank', amount: amt,
            institution: bank.inst_name,
            accountNumber: bank.account_number.replace(/.(?=.{4})/g, '*'),
            accountName: bank.account_name,
            transactionId: b2c.transactionId,
            newBalance: b2c.newBalance,
          }).catch(() => {});
        }
      }
    } catch (e) {
      steps.push({ step: 'error', status: 'failed', reason: e.message, at: new Date() });
      // Si une jambe a deja deplace des fonds (topUp, bankToCard, unload…), l'echec
      // d'une jambe suivante exige une compensation : needs_reversal, pas failed.
      const moved = steps.some(s => s.status === 'success' || s.step === 'momo_disburse');
      const finalStatus = moved ? NEEDS_REVERSAL : 'failed';
      logger.error('[transfer] execution failed', { transferId, reference: ref, direction, status: finalStatus, err: e.message, steps });
      await setStatus(transferId, finalStatus, {
        steps,
        error: moved ? `Compensation requise — ${e.message}` : e.message,
      }).catch((dbErr) => logger.error('[transfer] setStatus failed', { transferId, err: dbErr.message }));
    }
  })();

  // Reponse immediate
  return {
    transferId,
    reference: ref,
    status: sourceType === 'wallet' && direction === 'to_bank'
            ? 'awaiting_momo_confirmation' : 'processing',
    amount: amt,
    currency: 'XAF',
    requiresConfirmation: sourceType === 'wallet' && direction === 'to_bank',
    destination: direction === 'to_bank' ? {
      institution: bank.inst_name,
      type: bank.inst_type,
      accountNumber: bank.account_number.replace(/.(?=.{4})/g, '*'),
    } : null,
    source: direction === 'from_bank' ? {
      institution: bank.inst_name,
      accountNumber: bank.account_number.replace(/.(?=.{4})/g, '*'),
    } : null,
  };
};

// ─── Statut d'un transfert ───────────────────────────────────────
const getStatus = async (transferId, cardholderId) => {
  const r = await query(
    `SELECT bt.*, fi.name AS inst_name
     FROM bank_transfers bt
     LEFT JOIN bank_accounts ba ON ba.account_id = bt.bank_account_id
     LEFT JOIN financial_institutions fi ON fi.institution_id = ba.institution_id
     WHERE bt.transfer_id=$1 AND bt.cardholder_id=$2`,
    [transferId, cardholderId]);
  if (!r.rows[0]) throw Object.assign(new Error('Transfert introuvable'), { code: 'NOT_FOUND' });
  const t = r.rows[0];

  const labels = {
    pending:                    'Initialisation',
    awaiting_momo_confirmation: 'Confirmez sur votre telephone',
    processing:                 'Traitement en cours',
    completed:                  'Transfert effectue',
    failed:                     'Transfert echoue',
    needs_reversal:             'Incident en cours de traitement',
  };

  return {
    transferId: t.transfer_id,
    reference: t.reference,
    status: t.status,
    label: labels[t.status] || t.status,
    direction: t.direction,
    amount: parseFloat(t.amount),
    currency: t.currency,
    institution: t.inst_name,
    steps: t.steps || [],
    error: t.error_message,
    createdAt: t.created_at,
    completedAt: t.completed_at,
  };
};

module.exports = { initiate, getStatus, waitMomo, NEEDS_REVERSAL };
