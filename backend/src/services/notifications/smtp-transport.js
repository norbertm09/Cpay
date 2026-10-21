'use strict';
/**
 * WAVE-7 — fabrique SMTP commune (Nodemailer 10.x).
 *
 * Un seul endroit construit les options de transport pour les deux services
 * e-mail et pour les tests SMTP de l'admin :
 *   - TLS obligatoire : `secure` (TLS implicite, 465) ou STARTTLS forcé (`requireTLS`),
 *     jamais de repli en clair ; certificat toujours vérifié (`smtpTlsOptions`) ;
 *   - délais bornés : Nodemailer 10.1 impute l'attente du greeting à `connectionTimeout`
 *     (2 min par défaut) ; un relais injoignable doit échouer vite côté métier ;
 *   - `describeSmtpError` : erreur lisible et non sensible (code Nodemailer, code de
 *     réponse SMTP, commande) sans jamais recopier identifiant ni mot de passe.
 *
 * Nodemailer 10 conserve `createTransport(options)`, `transporter.verify()` et la forme
 * du résultat de `sendMail` (`messageId`, `accepted`, `rejected`, `response`, `envelope`).
 * Le point d'entrée CommonJS (`require('nodemailer')`) est maintenu par le champ `exports`.
 */
const nodemailer = require('nodemailer');
const { smtpTlsOptions } = require('../../config/smtp-tls');

const DEFAULT_TIMEOUTS = Object.freeze({ connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 30000 });

const toPort = (port, fallback) => {
  const n = parseInt(port, 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : fallback;
};

/**
 * Construit les options Nodemailer. `secure` par défaut : vrai seulement pour le port 465.
 * `requireTLS` reste vrai (ignoré par Nodemailer lorsque la connexion est déjà `secure`).
 */
const buildTransportOptions = ({ host, port, secure, user, pass, timeouts = DEFAULT_TIMEOUTS, env = process.env } = {}) => {
  const p = toPort(port, 465);
  return {
    host,
    port: p,
    secure: typeof secure === 'boolean' ? secure : p === 465,
    auth: { user, pass },
    requireTLS: true,
    tls: smtpTlsOptions(env),
    ...timeouts,
  };
};

const createSmtpTransport = (params) => nodemailer.createTransport(buildTransportOptions(params));

const MESSAGES = {
  EAUTH: 'Identifiants SMTP refusés par le relais',
  ECONNECTION: 'Connexion au relais SMTP impossible',
  ETIMEDOUT: 'Délai dépassé en attendant le relais SMTP',
  ESOCKET: 'Erreur de socket ou de TLS avec le relais SMTP',
  EENVELOPE: 'Enveloppe refusée par le relais (expéditeur ou destinataire)',
  EMESSAGE: 'Message refusé par le relais SMTP',
  EDNS: 'Résolution DNS du relais SMTP impossible',
  ETLS: 'Négociation TLS refusée (certificat ou protocole)',
  EPROTOCOL: 'Réponse SMTP inattendue',
};

const TLS_PATTERN = /certificate|self[- ]signed|unable to verify|altname|CERT_|SSL|TLS|STARTTLS/i;

/**
 * Décrit une erreur Nodemailer/SMTP pour les journaux et les réponses API.
 * Ne renvoie que : code, code de réponse SMTP, commande, message court. Le texte brut du
 * relais est tronqué et débarrassé de toute séquence ressemblant à un mot de passe en base64
 * (réponse 334/535 d'AUTH PLAIN).
 */
const describeSmtpError = (err) => {
  if (!err) return { code: 'UNKNOWN', responseCode: null, command: null, message: 'Erreur SMTP inconnue' };
  const code = err.code || (TLS_PATTERN.test(String(err.message || '')) ? 'ETLS' : 'UNKNOWN');
  const responseCode = Number.isInteger(err.responseCode) ? err.responseCode : null;
  const command = typeof err.command === 'string' ? err.command.split(' ')[0] : null;
  let detail = String(err.response || err.message || '').replace(/[A-Za-z0-9+/=]{24,}/g, '[masqué]').replace(/\s+/g, ' ').trim();
  if (detail.length > 160) detail = `${detail.slice(0, 157)}...`;
  const base = MESSAGES[code] || (responseCode ? `Le relais SMTP a répondu ${responseCode}` : 'Erreur SMTP');
  const auth535 = code === 'EAUTH' || responseCode === 535;
  const message = auth535
    ? `${MESSAGES.EAUTH} (535) : vérifier SMTP_USER / SMTP_PASS. Aucune nouvelle tentative automatique.`
    : detail ? `${base} : ${detail}` : base;
  return { code: auth535 ? 'EAUTH' : code, responseCode: auth535 && !responseCode ? 535 : responseCode, command, message, retryable: !auth535 && ['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS'].includes(code) };
};

module.exports = { buildTransportOptions, createSmtpTransport, describeSmtpError, DEFAULT_TIMEOUTS };
