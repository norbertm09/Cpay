'use strict';

const sendSmsSmpp = ({ to, text }) => new Promise((resolve, reject) => {
  let smpp;
  try {
    smpp = require('smpp');
  } catch (_) {
    const err = new Error('Dependance smpp non installee');
    err.code = 'SMPP_DEPENDENCY_MISSING';
    reject(err);
    return;
  }

  const host = process.env.SMPP_HOST;
  const port = parseInt(process.env.SMPP_PORT || '2775', 10);
  const systemId = process.env.SMPP_SYSTEM_ID;
  const password = process.env.SMPP_PASSWORD;
  const sourceAddr = process.env.SMPP_SOURCE_ADDR || 'CPLUS';
  const timeoutMs = parseInt(process.env.SMPP_TIMEOUT_MS || '20000', 10);

  if (!host || !systemId || !password) {
    const err = new Error('Configuration SMPP manquante');
    err.code = 'SMPP_NOT_CONFIGURED';
    reject(err);
    return;
  }

  const session = smpp.connect({ url: `smpp://${host}:${port}` });
  const timer = setTimeout(() => {
    session.close();
    reject(new Error('SMPP timeout'));
  }, timeoutMs);

  const done = (err, payload) => {
    clearTimeout(timer);
    session.close();
    if (err) reject(err);
    else resolve(payload);
  };

  session.on('error', done);
  session.bind_transceiver({ system_id: systemId, password }, (bindPdu) => {
    if (bindPdu.command_status !== 0) {
      done(new Error(`SMPP bind failed: ${bindPdu.command_status}`));
      return;
    }

    // Normaliser le numero au format international (242XXXXXXXXX, sans +)
    let dest = String(to).replace(/[^0-9]/g, '');
    if (dest.startsWith('00')) dest = dest.slice(2);
    if (!dest.startsWith('242') && dest.length === 9) dest = '242' + dest;

    session.submit_sm({
      source_addr_ton: 5,        // alphanumeric (pour un Sender ID texte comme CPLUS)
      source_addr_npi: 0,
      source_addr: sourceAddr,
      dest_addr_ton: 1,          // international
      dest_addr_npi: 1,          // ISDN/E.164
      destination_addr: dest,
      short_message: text,
    }, (submitPdu) => {
      if (submitPdu.command_status !== 0) {
        done(new Error(`SMPP submit failed: ${submitPdu.command_status}`));
        return;
      }
      done(null, { messageId: submitPdu.message_id });
    });
  });
});

module.exports = { sendSmsSmpp };

// ─── Notification multi-canal : SMS + email en secours ──────────────
// Envoie par SMS (SMPP) ET par email si l'email est fourni. Non bloquant :
// reussit si au moins un canal passe. Tant que le fournisseur SMS regle sa
// route, la notification arrive par email.
const notifyMultiChannel = async ({ phone, email, text, subject }) => {
  const out = { sms: false, email: false };
  if (phone) {
    try { await sendSmsSmpp({ to: phone, text }); out.sms = true; }
    catch (e) { console.error('[notify][sms]', e.message); }
  }
  if (email) {
    try {
      const emailSvc = require('./email.service');
      await emailSvc.send({
        to: email,
        subject: subject || 'C-Pay — notification',
        html: `<div style="font-family:Arial,sans-serif;max-width:420px">
          <p style="white-space:pre-line;color:#1e2d3d;font-size:14px">${String(text).replace(/</g,'&lt;')}</p>
          <hr style="border:none;border-top:1px solid #e2e8f0">
          <p style="color:#5a6677;font-size:12px">C-Pay · c-pay.global</p></div>`,
      });
      out.email = true;
    } catch (e) { console.error('[notify][email]', e.message); }
  }
  return out;
};

module.exports.notifyMultiChannel = notifyMultiChannel;
