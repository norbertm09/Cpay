'use strict';

let transporter = null;

const getTransporter = () => {
  if (transporter) return transporter;
  const nodemailer = require('nodemailer');

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    const e = new Error('Configuration SMTP manquante');
    e.code = 'SMTP_NOT_CONFIGURED';
    throw e;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  });
  return transporter;
};

// ─── Template HTML CPlus ──────────────────────────────────────────
const wrap = (title, body, footer = '') => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:24px 12px;">
<tr><td align="center">
<table width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(29,79,146,0.08);">
  <tr><td style="background:linear-gradient(135deg,#1d4f92 0%,#005a96 100%);padding:24px;text-align:center;">
    <div style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:1px;">CALCULUS<span style="color:#00c8c8;"> PLUS</span></div>
    <div style="color:#a8c8e8;font-size:11px;letter-spacing:2px;margin-top:4px;">INNOVER. TRANSFORMER. RÉUSSIR.</div>
  </td></tr>
  <tr><td style="padding:28px 24px;">
    <h2 style="margin:0 0 16px;color:#1e2d3d;font-size:19px;">${title}</h2>
    ${body}
  </td></tr>
  <tr><td style="background:#f8fafc;padding:18px 24px;border-top:1px solid #e2e8f0;text-align:center;">
    <div style="color:#5a6677;font-size:12px;line-height:1.6;">${footer || 'Cet email est envoyé automatiquement, merci de ne pas y répondre.'}</div>
    <div style="color:#9aa5b1;font-size:11px;margin-top:8px;">
      <a href="https://c-pay.global" style="color:#12b6c7;text-decoration:none;">c-pay.global</a> · Calculus Plus SAS
    </div>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;

const row = (label, value, bold = false) => `
  <tr>
    <td style="padding:9px 0;color:#5a6677;font-size:14px;border-bottom:1px solid #f0f4f8;">${label}</td>
    <td style="padding:9px 0;color:#1e2d3d;font-size:14px;text-align:right;border-bottom:1px solid #f0f4f8;${bold ? 'font-weight:700;' : ''}">${value}</td>
  </tr>`;

const btn = (text, url) => `
  <div style="text-align:center;margin:22px 0;">
    <a href="${url}" style="display:inline-block;background:#12b6c7;color:#ffffff;text-decoration:none;padding:13px 30px;border-radius:8px;font-weight:700;font-size:15px;">${text}</a>
  </div>`;

const fmt = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(n));

// ─── Envoi generique ──────────────────────────────────────────────
const send = async ({ to, subject, html, text }) => {
  const t = getTransporter();
  const info = await t.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    html,
    text: text || subject,
  });
  return { success: true, messageId: info.messageId, accepted: info.accepted };
};

// ═══════════ TEMPLATES METIER ═══════════

// Recu de transaction
const sendReceipt = ({ to, type, amount, fee, reference, authCode, date, method, counterparty }) => {
  const net = amount - (fee || 0);
  const html = wrap(`Reçu — ${type}`, `
    <div style="background:#e8fff8;border-left:4px solid #00c896;padding:14px;margin-bottom:20px;border-radius:0 6px 6px 0;">
      <div style="color:#007a5a;font-size:13px;font-weight:600;">✓ Transaction confirmée</div>
    </div>
    <div style="text-align:center;margin:20px 0;">
      <div style="color:#5a6677;font-size:13px;">Montant</div>
      <div style="color:#1d4f92;font-size:32px;font-weight:700;margin-top:4px;">${fmt(amount)} XAF</div>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0">
      ${row('Type', type)}
      ${method ? row('Méthode', method) : ''}
      ${counterparty ? row('Contrepartie', counterparty) : ''}
      ${fee ? row('Frais', `${fmt(fee)} XAF`) : ''}
      ${fee ? row('Net', `${fmt(net)} XAF`, true) : ''}
      ${row('Référence', `<code style="background:#f0f4f8;padding:3px 7px;border-radius:4px;font-size:12px;">${reference}</code>`)}
      ${authCode ? row('Code autorisation', authCode) : ''}
      ${row('Date', date || new Date().toLocaleString('fr-FR'))}
    </table>
  `, 'Conservez ce reçu pour vos archives.');

  return send({ to, subject: `C-Pay — Reçu ${type} · ${fmt(amount)} XAF`, html });
};

// Transfert bancaire
const sendTransferNotice = ({ to, direction, amount, institution, accountNumber, accountName, transactionId, newBalance }) => {
  const isOut = direction === 'to_bank';
  const html = wrap(
    isOut ? 'Virement vers votre banque' : 'Virement reçu de votre banque', `
    <div style="text-align:center;margin:20px 0;">
      <div style="font-size:34px;">${isOut ? '📤' : '📥'}</div>
      <div style="color:#1d4f92;font-size:30px;font-weight:700;margin-top:8px;">${fmt(amount)} XAF</div>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0">
      ${row(isOut ? 'Vers' : 'Depuis', institution)}
      ${row('Compte', accountNumber)}
      ${row('Titulaire', accountName)}
      ${row('Transaction', transactionId)}
      ${newBalance !== null && newBalance !== undefined ? row('Nouveau solde', `${fmt(newBalance)} XAF`, true) : ''}
      ${row('Date', new Date().toLocaleString('fr-FR'))}
    </table>
    <div style="background:#fff8e8;padding:12px;border-radius:6px;margin-top:18px;">
      <div style="color:#c47000;font-size:12px;">⏱️ Le crédit peut prendre 24 à 48h ouvrées selon l'institution.</div>
    </div>
  `);
  return send({
    to,
    subject: `C-Pay — Virement ${isOut ? 'vers' : 'depuis'} ${institution} · ${fmt(amount)} XAF`,
    html,
  });
};

// Bienvenue
const sendWelcome = ({ to, firstName, userType }) => {
  const isM = userType === 'merchant';
  const html = wrap(`Bienvenue ${firstName || ''} !`, `
    <p style="color:#5a6677;font-size:15px;line-height:1.6;">
      Votre compte ${isM ? 'marchand' : 'porteur'} C-Pay est actif.
      ${isM ? 'Vous pouvez maintenant encaisser des paiements Mobile Money, QR et sans contact.'
            : 'Vous pouvez créer vos cartes, les recharger et payer partout.'}
    </p>
    ${btn('Ouvrir C-Pay', isM ? 'https://merchant.c-pay.global' : 'https://app.c-pay.global')}
    <p style="color:#5a6677;font-size:13px;">
      📱 Application mobile : <a href="https://merchant.c-pay.global/download/" style="color:#12b6c7;">télécharger l'application Android</a>
    </p>
  `);
  return send({ to, subject: 'Bienvenue sur C-Pay 🎉', html });
};

// Reinitialisation de mot de passe
const sendPasswordReset = ({ to, token, userType }) => {
  const base = userType === 'merchant' ? 'https://merchant.c-pay.global' : 'https://app.c-pay.global';
  const html = wrap('Réinitialisation de mot de passe', `
    <p style="color:#5a6677;font-size:15px;line-height:1.6;">
      Vous avez demandé la réinitialisation de votre mot de passe. Ce lien expire dans 1 heure.
    </p>
    ${btn('Réinitialiser mon mot de passe', `${base}/reset-password?token=${token}`)}
    <p style="color:#9aa5b1;font-size:12px;">
      Ou copiez ce code dans l'application :<br>
      <code style="background:#f0f4f8;padding:8px;border-radius:4px;display:inline-block;margin-top:6px;font-size:12px;word-break:break-all;">${token}</code>
    </p>
    <div style="background:#fff0f0;padding:12px;border-radius:6px;margin-top:18px;">
      <div style="color:#c53030;font-size:12px;">⚠️ Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</div>
    </div>
  `);
  return send({ to, subject: 'C-Pay — Réinitialisation de mot de passe', html });
};

// Alerte securite
const sendSecurityAlert = ({ to, event, ip, device, date }) => {
  const html = wrap('Alerte de sécurité', `
    <div style="background:#fff0f0;border-left:4px solid #ff3b30;padding:14px;margin-bottom:20px;border-radius:0 6px 6px 0;">
      <div style="color:#c53030;font-size:14px;font-weight:600;">${event}</div>
    </div>
    <table width="100%" cellpadding="0" cellspacing="0">
      ${row('Date', date || new Date().toLocaleString('fr-FR'))}
      ${ip ? row('Adresse IP', ip) : ''}
      ${device ? row('Appareil', device) : ''}
    </table>
    <p style="color:#5a6677;font-size:13px;margin-top:18px;">
      Si vous êtes à l'origine de cette action, ignorez cet email.
      Sinon, changez immédiatement votre mot de passe et contactez le support.
    </p>
    ${btn('Sécuriser mon compte', 'https://app.c-pay.global/profile')}
  `);
  return send({ to, subject: `C-Pay — ${event}`, html });
};

// Carte creee / emise
const sendCardIssued = ({ to, cardMasked, label, cardholderName }) => {
  const html = wrap('Nouvelle carte créée', `
    <div style="background:linear-gradient(135deg,#1d4f92 0%,#005a96 100%);border-radius:12px;padding:22px;margin:18px 0;">
      <div style="color:#a8c8e8;font-size:11px;">${label || 'CARTE VIRTUELLE'}</div>
      <div style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:2px;margin-top:16px;">${cardMasked}</div>
      <div style="color:#a8c8e8;font-size:12px;margin-top:12px;">${cardholderName || ''}</div>
    </div>
    <p style="color:#5a6677;font-size:14px;">
      Votre carte est active. Définissez votre code PIN dans l'application avant de l'utiliser.
    </p>
    ${btn('Configurer ma carte', 'https://app.c-pay.global/cards')}
  `);
  return send({ to, subject: 'C-Pay — Votre nouvelle carte est prête 💳', html });
};

// KYC
const sendKycStatus = ({ to, status, level, reason }) => {
  const ok = status === 'approved' || status === 'verified';
  const html = wrap(ok ? 'Vérification approuvée ✅' : 'Vérification en attente', `
    <div style="background:${ok ? '#e8fff8' : '#fff8e8'};border-left:4px solid ${ok ? '#00c896' : '#ff9500'};padding:14px;margin-bottom:20px;border-radius:0 6px 6px 0;">
      <div style="color:${ok ? '#007a5a' : '#c47000'};font-size:14px;font-weight:600;">
        ${ok ? 'Niveau KYC ' + level + ' atteint' : 'Documents en cours d examen'}
      </div>
    </div>
    ${reason ? `<p style="color:#5a6677;font-size:14px;">${reason}</p>` : ''}
    <p style="color:#5a6677;font-size:14px;">
      ${ok ? 'Vos plafonds ont été relevés. Vous avez maintenant accès à toutes les fonctionnalités.'
           : 'Nos équipes examinent vos documents. Vous serez notifié sous 48h.'}
    </p>
  `);
  return send({ to, subject: `C-Pay — Vérification ${ok ? 'approuvée' : 'en cours'}`, html });
};

// Test SMTP
const testConnection = async () => {
  const t = getTransporter();
  await t.verify();
  return { success: true, host: process.env.SMTP_HOST, from: process.env.SMTP_FROM };
};

module.exports = {
  send,
  sendReceipt,
  sendTransferNotice,
  sendWelcome,
  sendPasswordReset,
  sendSecurityAlert,
  sendCardIssued,
  sendKycStatus,
  testConnection,
};
