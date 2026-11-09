/**
 * Lot 4 (audit 2026-11-02 mobile P0-2) — suppression de compte marchand.
 *
 *  - requestDeletion : enregistre la demande (une seule en attente par marchand), délai de rétractation
 *    RETRACT_DAYS, solde disponible mémorisé (à reverser avant exécution), e-mails marchand + opérations ;
 *  - cancelDeletion  : rétractation par le marchand tant que la demande est `pending` ;
 *  - process         : opérations C-Pay — `processed` désactive les utilisateurs du marchand, suspend le
 *    compte et révoque les sessions ; `rejected` conserve le compte. L'anonymisation des données personnelles
 *    hors obligations légales (LCB-FT, comptabilité : 5 à 10 ans) est documentée dans la page
 *    /legal/suppression-compte.html et réalisée par les opérations.
 */
'use strict';

const { query, withTransaction } = require('../../config/database');
const logger = require('../../config/logger');

const RETRACT_DAYS = parseInt(process.env.ACCOUNT_DELETION_RETRACT_DAYS, 10) || 30;
const OPS_EMAIL = () => process.env.ADMIN_ALERT_EMAIL || 'support@c-pay.global';

const sendMail = async (to, subject, html) => {
  try {
    const email = require('../notifications/email.service');
    await email.send({ to, subject, html });
  } catch (e) { logger.warn('account deletion: email failed', { to, subject, err: e.message }); }
};
const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const fmtDate = (d) => new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });

const serialize = (r) => r && ({
  requestId: r.request_id, merchantId: r.merchant_id, status: r.status, reason: r.reason || null, channel: r.channel,
  requestedAt: r.requested_at, retractUntil: r.retract_until, cancelledAt: r.cancelled_at || null,
  processedAt: r.processed_at || null, note: r.note || null, balanceAtRequest: r.balance_at_request == null ? null : Number(r.balance_at_request),
  canCancel: r.status === 'pending',
});

async function getPending(merchantId) {
  const r = await query(`SELECT * FROM account_deletion_requests WHERE merchant_id=$1 AND status='pending' ORDER BY requested_at DESC LIMIT 1`, [merchantId]);
  return r.rows[0] || null;
}

async function requestDeletion({ merchantId, userId, email, reason, channel = 'app', ip = null }) {
  const existing = await getPending(merchantId);
  if (existing) return { already: true, request: existing };
  const cash = require('../cash/cash.service');
  let balance = null;
  try { balance = (await cash.computeAvailableBalance(query, merchantId)).available; } catch (_) { /* solde indisponible : non bloquant */ }
  const m = await query(`SELECT business_name, email FROM merchants WHERE merchant_id=$1`, [merchantId]);
  const merchant = m.rows[0] || {};
  const r = await query(
    `INSERT INTO account_deletion_requests (merchant_id, user_id, email, reason, channel, retract_until, balance_at_request, ip_address)
     VALUES ($1,$2,$3,$4,$5, NOW() + ($6 || ' days')::interval, $7, $8) RETURNING *`,
    [merchantId, userId || null, email || merchant.email || null, reason ? String(reason).slice(0, 500) : null, channel, String(RETRACT_DAYS), balance, ip]
  );
  const req = r.rows[0];
  const to = email || merchant.email;
  if (to) {
    await sendMail(to, 'C-Pay — votre demande de suppression de compte',
      `<p>Bonjour ${esc(merchant.business_name || '')},</p>
       <p>Nous avons bien reçu votre demande de suppression de compte C-Pay le ${fmtDate(req.requested_at)}.</p>
       <p>Vous pouvez l'annuler depuis l'application (Profil → Confidentialité et données) ou en répondant à ce message
       jusqu'au <b>${fmtDate(req.retract_until)}</b>. Passé ce délai, vos accès seront désactivés et vos données personnelles
       supprimées, à l'exception de celles que la loi nous impose de conserver (transactions, pièces KYB).</p>
       ${balance != null && balance > 0 ? `<p>Votre solde disponible (${balance} XAF) doit être retiré avant la suppression : faites un retrait depuis la caisse.</p>` : ''}
       <p>Référence : <code>${req.request_id}</code></p>`);
  }
  await sendMail(OPS_EMAIL(), `Demande de suppression de compte — ${merchant.business_name || merchantId}`,
    `<p>Marchand <b>${esc(merchant.business_name || '')}</b> (${esc(merchantId)}) — utilisateur ${esc(email || userId || '')}</p>
     <p>Motif : ${esc(reason || '—')} · canal : ${esc(channel)} · solde disponible : ${balance == null ? 'n/d' : balance}</p>
     <p>Rétractation possible jusqu'au ${fmtDate(req.retract_until)}. Traitement : back-office → Marchands → Demandes de suppression.</p>`);
  logger.info('account deletion requested', { merchantId, requestId: req.request_id, channel });
  return { already: false, request: req };
}

async function cancelDeletion({ merchantId, userId }) {
  const r = await query(
    `UPDATE account_deletion_requests SET status='cancelled', cancelled_at=NOW(), note=COALESCE(note,'') || $2
      WHERE merchant_id=$1 AND status='pending' RETURNING *`,
    [merchantId, `annulée par l'utilisateur ${userId || ''} le ${new Date().toISOString()}`]
  );
  return r.rows[0] || null;
}

async function list({ status = 'pending', limit = 50, offset = 0 } = {}) {
  const params = [];
  let where = '1=1';
  if (status && status !== 'all') { params.push(status); where += ` AND d.status=$${params.length}`; }
  params.push(limit, offset);
  const r = await query(
    `SELECT d.*, m.business_name, m.country, m.currency, m.merchant_status
       FROM account_deletion_requests d LEFT JOIN merchants m ON m.merchant_id = d.merchant_id
      WHERE ${where} ORDER BY d.requested_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  return r.rows.map((row) => ({ ...serialize(row), businessName: row.business_name, country: row.country, currency: row.currency, merchantStatus: row.merchant_status }));
}

/**
 * Traitement par les opérations : `processed` (compte fermé) ou `rejected` (demande refusée, compte conservé).
 * processed : utilisateurs désactivés, marchand suspendu, sessions révoquées — exécuté dans une transaction.
 */
async function processRequest({ requestId, status, note, adminId }) {
  if (!['processed', 'rejected'].includes(status)) throw Object.assign(new Error('status invalide'), { statusCode: 422, code: 'VALIDATION_ERROR' });
  const result = await withTransaction(async (client) => {
    const exec = (t, p) => client.query(t, p);
    const cur = await exec(`SELECT * FROM account_deletion_requests WHERE request_id=$1 FOR UPDATE`, [requestId]);
    const req = cur.rows[0];
    if (!req) return { error: { status: 404, body: { error: 'Demande introuvable', code: 'NOT_FOUND' } } };
    if (req.status !== 'pending') return { error: { status: 409, body: { error: `Demande déjà ${req.status}`, code: 'INVALID_STATUS', status: req.status } } };
    const upd = await exec(
      `UPDATE account_deletion_requests SET status=$2, processed_at=NOW(), processed_by=$3, note=$4 WHERE request_id=$1 RETURNING *`,
      [requestId, status, adminId || null, note ? String(note).slice(0, 1000) : null]);
    let users = [];
    if (status === 'processed') {
      const u = await exec(`UPDATE merchant_users SET is_active=FALSE, updated_at=NOW() WHERE merchant_id=$1 RETURNING user_id`, [req.merchant_id]);
      users = u.rows.map((x) => x.user_id);
      await exec(`UPDATE merchants SET merchant_status='suspended', updated_at=NOW() WHERE merchant_id=$1`, [req.merchant_id]);
    }
    return { request: upd.rows[0], users };
  });
  if (result.error) return result;
  if (status === 'processed') {
    try {
      const { revokeAll } = require('../../middleware/auth');
      for (const uid of result.users) await revokeAll('merchant', uid);
    } catch (e) { logger.warn('account deletion: revokeAll failed', { requestId, err: e.message }); }
    if (result.request.email) {
      await sendMail(result.request.email, 'C-Pay — compte supprimé',
        `<p>Votre compte C-Pay a été fermé le ${fmtDate(result.request.processed_at)} conformément à votre demande. Les données que la
         loi nous impose de conserver (historique des transactions, pièces d'identification) sont archivées puis supprimées à l'issue du délai légal.</p>`);
    }
  }
  logger.info('account deletion processed', { requestId, status, adminId });
  return { request: result.request };
}

module.exports = { requestDeletion, cancelDeletion, getPending, list, processRequest, serialize, RETRACT_DAYS };
