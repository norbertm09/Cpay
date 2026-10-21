'use strict';
// WAVE-7 : Nodemailer 10.x via la fabrique commune (TLS vérifié, STARTTLS forcé hors 465,
// délais bornés, erreurs décrites sans secret). `secure` suit désormais le port : l'ancien
// `secure: true` figé rendait SMTP_PORT=587 inutilisable (TLS implicite sur un port STARTTLS).
const { createSmtpTransport, describeSmtpError } = require('./notifications/smtp-transport');

let _transporter = null;
const getTransporter = () => {
  if (_transporter) return _transporter;
  _transporter = createSmtpTransport({
    host: process.env.SMTP_HOST || 'smtp.mail.ovh.net',
    port: process.env.SMTP_PORT || '465',
    user: process.env.SMTP_USER || 'noreply@c-pay.global',
    pass: process.env.SMTP_PASS,
  });
  return _transporter;
};

const FROM = '"C-Pay | Calculus Plus" <noreply@c-pay.global>';

const send = async ({ to, subject, html }) => {
  try {
    if (!process.env.SMTP_PASS) {
      console.warn('[EmailService] SMTP_PASS non configuré — email ignoré:', subject);
      return false;
    }
    await getTransporter().sendMail({ from: FROM, to, subject, html });
    console.info(`[EmailService] Envoyé: ${subject} → ${to}`);
    return true;
  } catch (err) {
    const d = describeSmtpError(err);
    console.error(`[EmailService] Erreur ${d.code}${d.responseCode ? ` (${d.responseCode})` : ''}: ${d.message}`);
    return false;
  }
};

const sendCardholderWelcome       = (p) => send({ to:p.to, subject:'🎉 Bienvenue sur C-Pay', html:`<p>Bonjour ${p.firstName}, votre compte C-Pay est prêt.</p>` });
const sendPaymentNotification     = (p) => send({ to:p.to, subject:`💸 Paiement ${p.amount} XAF`, html:`<p>Paiement de ${p.amount} XAF effectué.</p>` });
const sendTopupNotification       = (p) => send({ to:p.to, subject:`⬆️ Rechargement ${p.credited} XAF`, html:`<p>Rechargement crédité.</p>` });
const sendCardFrozenNotification  = (p) => send({ to:p.to, subject:'❄️ Carte gelée', html:`<p>Votre carte a été gelée.</p>` });
const sendMerchantWelcome         = (p) => send({ to:p.to, subject:'🏪 Bienvenue Marchand C-Pay', html:`<p>Bonjour ${p.contactName}.</p>` });
const sendMerchantPaymentReceived = (p) => send({ to:p.to, subject:`💰 Paiement reçu ${p.amount} XAF`, html:`<p>Paiement reçu.</p>` });
const sendClaimConfirmation       = (p) => send({ to:p.to, subject:'📋 Réclamation enregistrée', html:`<p>Réclamation enregistrée.</p>` });
const sendClaimUpdateToAdmin      = (p) => send({ to:p.to, subject:'🚨 Nouvelle réclamation', html:`<p>Nouvelle réclamation.</p>` });
const sendClaimResolved           = (p) => send({ to:p.to, subject:'✅ Réclamation résolue', html:`<p>Réclamation résolue.</p>` });
const sendAlertApiDown            = (p) => send({ to:p.to, subject:`🔴 API DOWN: ${p.serviceName}`, html:`<p>Service indisponible.</p>` });
const sendAlertHighErrorRate      = (p) => send({ to:p.to, subject:`⚠️ Taux erreur ${p.errorRate}%`, html:`<p>Taux erreur élevé.</p>` });
const sendAlertFraud              = (p) => send({ to:p.to, subject:'🚨 Alerte fraude', html:`<p>Activité suspecte.</p>` });
const sendAlertDbIssue            = (p) => send({ to:p.to, subject:'🔴 Problème DB', html:`<p>${p.issueType}</p>` });
const sendAlertIncident           = (p) => send({ to:p.to, subject:`🚨 Incident: ${p.title}`, html:`<p>${p.description||''}</p>` });

module.exports = {
  send,
  sendCardholderWelcome, sendPaymentNotification, sendTopupNotification, sendCardFrozenNotification,
  sendMerchantWelcome, sendMerchantPaymentReceived,
  sendClaimConfirmation, sendClaimUpdateToAdmin, sendClaimResolved,
  sendAlertApiDown, sendAlertHighErrorRate, sendAlertFraud, sendAlertDbIssue, sendAlertIncident,
};
