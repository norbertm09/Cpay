'use strict';
/**
 * Paiement par carte sur la page hébergée (pay.c-pay.global) — WAVE-4 caisse.
 *
 * Aucun PAN ne transite par C-Pay : le client est redirigé vers la page de paiement de la passerelle
 * (checkout hébergé), puis revient sur /pay/:shortId/return. La transaction est créée `pending`
 * (type collect, payment_method pay_link, pay_link_id) via le même enregistrement que l'orchestrateur,
 * et finalisée par la même machine d'état que les webhooks carte (webhook-handlers.applyMerchantPspResult).
 *
 * Passerelles avec checkout hébergé :
 *   - migs : VPC 3-Party (redirect + vpc_ReturnURL signé, webhook handleMigsWebhook) — env MIGS_MERCHANT_ID,
 *            MIGS_ACCESS_CODE, MIGS_SECURE_HASH ;
 *   - mpgs : Hosted Checkout (INITIATE_CHECKOUT → /checkout/pay/{session}, retour resultIndicator confirmé
 *            par getOrder) — env MPGS_MERCHANT_ID, MPGS_API_PASSWORD.
 *   CyberSource / Stripe / GIMAC / Interswitch : pas de checkout hébergé branché → carte indisponible (410).
 */

const crypto = require('crypto');
const { query } = require('../../config/database');
const logger = require('../../config/logger');

const HOSTED_GATEWAYS = {
  migs: () => require('../gateways/migs.gateway'),
  mpgs: () => require('../gateways/mpgs.gateway'),
};

const payBaseUrl = () => String(process.env.PAY_LINK_BASE_URL || 'https://pay.c-pay.global').replace(/\/+$/, '');
const returnUrlFor = (shortId) => `${payBaseUrl()}/pay/${encodeURIComponent(shortId)}/return`;

/** Passerelle carte hébergée réellement utilisable (module + configuration env), ou null. */
const hostedGatewayConfigured = (gw) => {
  const factory = HOSTED_GATEWAYS[String(gw || '').toLowerCase()];
  if (!factory) return false;
  try { return !!factory().hostedConfigured(); } catch (e) { return false; }
};

/** Passerelle carte hébergée pour le pays du marchand (country_payment_defaults.default_card_gateway). */
async function hostedCardGatewayFor(country) {
  if (!country) return null;
  let gw = null;
  try {
    const { getCountryDefaults } = require('../config/country-defaults');
    const d = await getCountryDefaults(country);
    gw = d && d.default_card_gateway ? String(d.default_card_gateway).toLowerCase() : null;
  } catch (e) { logger.warn('card-link: country defaults unavailable', { err: e.message }); }
  if (!gw) return null;
  return hostedGatewayConfigured(gw) ? gw : null;
}

const CURRENT_TXN_SQL = `
  SELECT transaction_id, merchant_id, amount, currency, status, gateway_name, gateway_order_id, gateway_payment_id,
         auth_code, response_code, response_message, initiated_at, completed_at
  FROM transactions WHERE pay_link_id=$1 AND type='collect'
  ORDER BY (status='authorized') DESC, initiated_at DESC LIMIT 1`;

/**
 * Crée la transaction pending + la session de checkout hébergé.
 * @returns {{ ok:true, txnId, gateway, redirectUrl, orderRef }} | {{ ok:false, status, body }}
 */
async function createCardCheckout({ link, merchant }) {
  const gateway = await hostedCardGatewayFor(merchant?.country || link.country);
  if (!gateway) return { ok: false, status: 410, body: { error: 'Paiement par carte indisponible pour ce marchand', code: 'CARD_PAYMENT_DISABLED' } };
  if (link.payment_method && !['card', 'pay_link', 'any'].includes(String(link.payment_method))) {
    return { ok: false, status: 409, body: { error: 'Ce lien est réservé au Mobile Money', code: 'CARD_NOT_ALLOWED_FOR_LINK' } };
  }

  const orchestrator = require('../orchestration/orchestrator');
  const txnId = crypto.randomUUID();
  const orderRef = `${link.short_id}-${Date.now().toString(36).toUpperCase()}`; // unique par tentative (≤ 40 car.)
  const amount = Number(link.amount);
  const currency = String(link.currency || merchant?.currency || 'XAF').toUpperCase();
  await orchestrator.createTransactionRecord({
    txnId, merchantId: link.merchant_id, type: 'collect', amount, currency,
    paymentMethod: 'pay_link',
    detectedInfo: { operator: null, network: null, country: merchant?.country || null },
    description: link.description || `Paiement carte ${link.short_id}`,
    deviceId: null, payLinkId: link.pay_link_id, status: 'pending',
  });

  const gw = HOSTED_GATEWAYS[gateway]();
  const returnUrl = returnUrlFor(link.short_id);
  let session;
  try {
    session = gateway === 'migs'
      ? gw.createHostedCheckout({ orderRef, amount, currency, description: link.description || link.short_id, returnUrl })
      : await gw.createHostedCheckout({ orderId: orderRef, amount, currency, description: link.description || link.short_id, returnUrl, cancelUrl: returnUrl, merchantName: merchant?.business_name });
  } catch (err) {
    session = { ok: false, reason: err.message };
  }
  if (!session || !session.ok) {
    await query(
      `UPDATE transactions SET status='failed', response_message=$2, gateway_name=$3 WHERE transaction_id=$1 AND status='pending'`,
      [txnId, `Checkout carte indisponible: ${String(session?.reason || 'erreur').slice(0, 180)}`, gateway]).catch(() => {});
    return { ok: false, status: 502, body: { error: 'Passerelle carte indisponible, réessayez plus tard', code: 'GATEWAY_ERROR', txnId } };
  }

  await query(
    `UPDATE transactions SET gateway_name=$2, gateway_order_id=$3, gateway_payment_id=$4, response_message=$5 WHERE transaction_id=$1`,
    [txnId, gateway, orderRef, session.sessionId || null, `Redirection vers le checkout ${gateway}`]);
  await orchestrator.addTransactionEvent({
    txnId, merchantId: link.merchant_id, eventType: 'CARD_CHECKOUT_CREATED',
    payload: { gateway, orderRef, sessionId: session.sessionId || null, successIndicator: session.successIndicator || null },
  }).catch((e) => logger.warn('card-link: event failed', { err: e.message }));
  return { ok: true, txnId, gateway, redirectUrl: session.redirectUrl, orderRef };
}

/**
 * Retour navigateur depuis la passerelle : finalise si la preuve est vérifiable côté serveur
 * (hash MIGS signé, ou getOrder MPGS). Sinon la transaction reste pending (webhook / réconciliation).
 */
async function handleCardReturn({ link, queryParams }) {
  const t = (await query(CURRENT_TXN_SQL, [link.pay_link_id])).rows[0];
  if (!t) return { status: linkStatus(link, null), txnId: null };
  if (t.status !== 'pending') return { status: linkStatus(link, t), txnId: t.transaction_id };
  const wh = require('../../routes/webhook-handlers');
  try {
    if (t.gateway_name === 'migs' && queryParams && queryParams.vpc_SecureHash) {
      const r = require('../gateways/migs.gateway').parseHostedReturn(queryParams);
      if (!r.valid) {
        logger.warn('card-link: MIGS return hash invalid', { txnId: t.transaction_id, reason: r.reason });
      } else if (String(r.orderRef) === String(t.gateway_order_id)) {
        const amount = r.amountMinor != null ? wh.minorToMajor(r.amountMinor, r.currency || t.currency) : null;
        await wh.applyMerchantPspResult({
          provider: 'migs', orderId: r.orderRef, isAuthorized: !!r.approved, authCode: r.authCode,
          responseCode: r.rawCode, amount, currency: r.currency || null, rawPayload: { source: 'hosted_return', vpc_TransactionNo: r.gatewayRef },
        });
      }
    } else if (t.gateway_name === 'mpgs' && queryParams && queryParams.resultIndicator) {
      const ev = await query(
        `SELECT payload FROM transaction_events WHERE transaction_id=$1 AND event_type='CARD_CHECKOUT_CREATED' ORDER BY created_at DESC LIMIT 1`,
        [t.transaction_id]);
      const expected = ev.rows[0]?.payload?.successIndicator;
      const indicatorOk = expected && String(queryParams.resultIndicator) === String(expected);
      const order = await require('../gateways/mpgs.gateway').getOrder(t.gateway_order_id);
      if (order && order.found && (order.result === 'SUCCESS' || order.result === 'FAILURE')) {
        await wh.applyMerchantPspResult({
          provider: 'mpgs', orderId: t.gateway_order_id, isAuthorized: order.result === 'SUCCESS' && !!indicatorOk,
          authCode: null, responseCode: order.result === 'SUCCESS' ? '00' : '05',
          amount: order.amount != null ? Number(order.amount) : null, currency: order.currency || null,
          rawPayload: { source: 'hosted_return', orderStatus: order.status, indicatorOk: !!indicatorOk },
        });
      }
    }
  } catch (err) {
    logger.warn('card-link: return finalisation failed (left pending)', { txnId: t.transaction_id, err: err.message });
  }
  const after = (await query(CURRENT_TXN_SQL, [link.pay_link_id])).rows[0] || t;
  return { status: linkStatus(link, after), txnId: after.transaction_id };
}

/** État public d'un lien : paid | pending | failed | expired | cancelled. */
const linkStatus = (link, txn) => {
  if (link.status === 'paid' || (txn && txn.status === 'authorized')) return 'paid';
  if (link.status === 'cancelled') return 'cancelled';
  if (link.expires_at && new Date(link.expires_at) < new Date()) return 'expired';
  if (txn && txn.status === 'failed') return 'failed';
  return 'pending';
};

async function getLinkStatus(link) {
  const t = (await query(CURRENT_TXN_SQL, [link.pay_link_id])).rows[0] || null;
  return { status: linkStatus(link, t), txnId: t ? t.transaction_id : null, txnStatus: t ? t.status : null, gateway: t ? t.gateway_name : null };
}

module.exports = { HOSTED_GATEWAYS, hostedGatewayConfigured, hostedCardGatewayFor, createCardCheckout, handleCardReturn, getLinkStatus, linkStatus, returnUrlFor };
