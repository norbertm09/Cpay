'use strict';
// Service OTP unifie : SMS (SMPP) + email en parallele, avec log de secours.
// Reussit si AU MOINS un canal passe. Pendant que le fournisseur SMS regle sa
// route, l'OTP arrive par email et reste visible dans les logs.

const { sendSmsSmpp } = require('./smpp.service');

let emailSvc = null;
try { emailSvc = require('./email.service'); } catch (_) {}

/**
 * Envoie un code OTP par tous les canaux disponibles.
 * @param {object} p
 * @param {string} [p.phone]   numero destinataire (SMS)
 * @param {string} [p.email]   email destinataire
 * @param {string} p.code      le code OTP
 * @param {string} [p.purpose] libelle ('connexion', 'verification', ...)
 * @returns {Promise<{sms:boolean, email:boolean, delivered:boolean}>}
 */
const sendOtp = async ({ phone, email, code, purpose = 'verification' }) => {
  const text = `CPlus : votre code de ${purpose} est ${code}. Valable 5 minutes. Ne le partagez avec personne.`;
  const result = { sms: false, email: false, delivered: false };

  // Toujours logguer (secours pilote — visible dans docker logs)
  console.log(`[OTP] code=${code} purpose=${purpose} phone=${phone || '-'} email=${email || '-'}`);

  const tasks = [];

  // Canal SMS
  if (phone) {
    tasks.push(
      sendSmsSmpp({ to: phone, text })
        .then(() => { result.sms = true; })
        .catch((e) => { console.error('[OTP][sms]', e.message); })
    );
  }

  // Canal email (fallback systematique)
  if (email && emailSvc && emailSvc.send) {
    tasks.push(
      emailSvc.send({
        to: email,
        subject: `CPlus — code de ${purpose}`,
        html: `<div style="font-family:Arial,sans-serif;max-width:400px;margin:0 auto">
          <h2 style="color:#1d4f92">Votre code de ${purpose}</h2>
          <div style="background:#f0f4f8;border-radius:12px;padding:24px;text-align:center;margin:16px 0">
            <div style="font-size:36px;font-weight:800;letter-spacing:8px;color:#1d4f92;font-family:monospace">${code}</div>
          </div>
          <p style="color:#5a6677;font-size:13px">Ce code est valable 5 minutes. Ne le partagez avec personne.</p>
        </div>`,
      })
        .then(() => { result.email = true; })
        .catch((e) => { console.error('[OTP][email]', e.message); })
    );
  }

  await Promise.allSettled(tasks);
  result.delivered = result.sms || result.email;
  return result;
};

module.exports = { sendOtp };
