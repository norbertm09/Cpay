/**
 * WAVE-3 — webhooks SORTANTS (marchands / intégrations) : signature et en-têtes
 * en un seul endroit.
 *
 * Algorithme : HMAC-SHA256 (secret du marchand / de l'intégration) sur le corps
 * JSON BRUT envoyé (octets exacts, UTF-8), encodé en hexadécimal minuscule.
 *
 *   X-CPay-Signature : "sha256=<hex>"          (nouveau, à vérifier côté marchand)
 *   X-CPay-Event     : nom de l'événement        (ex. transaction.authorized)
 *   X-CPay-Timestamp : date d'envoi ISO 8601     (informatif, non signé)
 *   User-Agent       : CPay-Webhooks/1.0
 *
 * Transition : les anciens en-têtes X-CPlus-Signature / X-CPlus-Event sont encore
 * envoyés avec leur format HISTORIQUE (préfixé "sha256=" pour les webhooks marchands,
 * hex nu pour les intégrations) afin de ne casser aucun consommateur existant.
 * Ils seront retirés dans une vague ultérieure (voir docs/WEBHOOKS-SORTANTS.md).
 */
'use strict';

const crypto = require('crypto');

const USER_AGENT = 'CPay-Webhooks/1.0';
const SIGNATURE_PREFIX = 'sha256=';

/** HMAC-SHA256 hex du corps brut (string ou Buffer). */
const computeHmac = (secret, rawBody) =>
  crypto.createHmac('sha256', String(secret)).update(Buffer.isBuffer(rawBody) ? rawBody : String(rawBody), 'utf8').digest('hex');

/** Valeur de X-CPay-Signature : "sha256=<hex>". */
const signatureHeader = (secret, rawBody) => SIGNATURE_PREFIX + computeHmac(secret, rawBody);

/**
 * Vérification côté récepteur (référence pour la doc / les SDK) : accepte
 * "sha256=<hex>" ou "<hex>", comparaison en temps constant.
 */
const verifySignature = (secret, rawBody, header) => {
  if (!secret || header === undefined || header === null) return false;
  const given = String(header).trim().replace(/^sha256=/i, '').toLowerCase();
  const expected = computeHmac(secret, rawBody);
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'));
};

/**
 * En-têtes complets d'une livraison.
 * @param {object} o
 * @param {string} o.secret        secret HMAC
 * @param {string|Buffer} o.rawBody corps exact qui sera envoyé
 * @param {string} o.event         nom de l'événement
 * @param {boolean} [o.legacyPrefixed=true] format de l'ancien X-CPlus-Signature
 *        (true = "sha256=<hex>" — webhooks marchands ; false = "<hex>" — intégrations)
 * @param {boolean} [o.legacy=true] inclure les en-têtes X-CPlus-* de transition
 */
const buildHeaders = ({ secret, rawBody, event, legacyPrefixed = true, legacy = true, sentAt = new Date() }) => {
  const hex = computeHmac(secret, rawBody);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
    'X-CPay-Event': String(event || ''),
    'X-CPay-Signature': SIGNATURE_PREFIX + hex,
    'X-CPay-Timestamp': sentAt.toISOString(),
  };
  if (legacy) {
    headers['X-CPlus-Event'] = String(event || '');
    headers['X-CPlus-Signature'] = legacyPrefixed ? SIGNATURE_PREFIX + hex : hex;
  }
  return headers;
};

module.exports = { USER_AGENT, SIGNATURE_PREFIX, computeHmac, signatureHeader, verifySignature, buildHeaders };
