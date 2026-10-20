'use strict';
/**
 * Gardes de capacités — vague 6, lot 2. Montées dans server.js AVANT les routes financières
 * (Express exécute les middlewares dans l'ordre de montage), sans modifier ces routes :
 *
 *   capabilityGuard          POST /merchant/cash/{collect|withdraw|transfers}  (après merchantAuth)
 *   legacyCapabilityGuard    POST /merchant/collect, /merchant/disburse, /collect, /payout (après merchantAuth)
 *   registerCapabilityGuard  POST /merchant/auth/register → 422 COUNTRY_NOT_OPEN
 *   payCardCapabilityGuard   POST /pay/:shortId/card (page publique) → pays du marchand du lien
 *
 * Refus : 403 { error, code:'CAPABILITY_NOT_ACTIVE', country, operation, method, status, message }.
 * Les requêtes GET, les corps invalides et les marchands introuvables passent (la route répond).
 */
const registry = require('../services/capabilities/registry');
const logger = require('../config/logger');

const registrationGuardEnabled = () => String(process.env.CAPABILITY_REGISTRATION_GUARD || 'on').toLowerCase() !== 'off';

const sendCapabilityError = (res, err) => res.status(err.statusCode || 403).json(err.toJSON ? err.toJSON() : { error: err.message, code: 'CAPABILITY_NOT_ACTIVE' });

/** Pays (et devise) du marchand connecté, mis en cache sur la requête. */
async function merchantCountry(req) {
  if (req.capabilityMerchant !== undefined) return req.capabilityMerchant;
  const merchantId = req.merchant?.merchantId || req.user?.merchantId;
  if (!merchantId) { req.capabilityMerchant = null; return null; }
  const { query } = require('../config/database');
  const r = await query('SELECT merchant_id, country, currency FROM merchants WHERE merchant_id=$1', [merchantId]);
  req.capabilityMerchant = (r && r.rows && r.rows[0]) ? { merchantId, country: r.rows[0].country, currency: r.rows[0].currency } : null;
  return req.capabilityMerchant;
}

/** Opération / méthode demandées par un POST caisse (null = la garde ne s'applique pas). */
const mapCashRequest = (req) => {
  const path = String(req.path || '').replace(/\/+$/, '') || '/';
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  if (path === '/collect') {
    if (!['mobile_money', 'card'].includes(body.method)) return null;          // la route renvoie 422
    return { operation: 'collect', method: body.method, operator: body.method === 'mobile_money' ? body.operator : null };
  }
  if (path === '/withdraw') return { operation: 'withdraw', method: 'mobile_money' };
  if (path === '/transfers') {
    if (!registry.TRANSFER_DIRECTIONS.includes(body.direction)) return null;   // la route renvoie 422
    return { operation: 'transfer', method: body.direction };
  }
  return null;
};

/** Routes historiques : /merchant/collect, /merchant/disburse, /collect, /payout. */
const mapLegacyRequest = (req) => {
  const path = String(req.path || '').replace(/\/+$/, '');
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const last = path.split('/').pop();
  const card = ['card', 'card_nfc', 'qr'].includes(String(body.method || '').toLowerCase()) || !!body.emvPayload || !!body.aidDetected;
  if (last === 'collect') return { operation: 'collect', method: card ? 'card' : 'mobile_money', operator: card ? null : (body.method && body.method !== 'mobile_money' ? body.method : body.operator) };
  if (last === 'disburse' || last === 'payout') return { operation: 'withdraw', method: card ? 'card' : 'mobile_money', operator: card ? null : (body.method && body.method !== 'mobile_money' ? body.method : body.operator) };
  return null;
};

const guardWith = (mapper) => async (req, res, next) => {
  try {
    if (req.method !== 'POST') return next();
    const wanted = mapper(req);
    if (!wanted) return next();
    const m = await merchantCountry(req);
    if (!m || !m.country) return next();                                        // 404 par la route
    await registry.loadFacts().catch(() => null);
    const r = registry.isAllowed({ country: m.country, ...wanted });
    if (r.allowed) return next();
    logger.warn('capability: refused', { merchantId: m.merchantId, country: m.country, ...wanted, status: r.status, path: req.originalUrl });
    const err = new registry.CapabilityError({ country: r.country, operation: r.operation, method: r.method, status: r.status, message: r.message, operator: r.operator });
    return sendCapabilityError(res, err);
  } catch (err) { return next(err); }
};

const capabilityGuard = guardWith(mapCashRequest);
const legacyCapabilityGuard = guardWith(mapLegacyRequest);

/** Inscription : pays déduit du téléphone (comme la route) — doit être ouvert (collect active|pilot). */
const registerCapabilityGuard = async (req, res, next) => {
  try {
    if (req.method !== 'POST' || !registrationGuardEnabled()) return next();
    const phone = req.body && req.body.phone;
    if (!phone) return next();                                                  // 422 par la route
    const { detectFromPhone } = require('../services/detection/detection.engine');
    const d = detectFromPhone(String(phone));
    if (!d || !d.country) return next();                                        // UNSUPPORTED_PHONE par la route
    await registry.loadFacts().catch(() => null);
    const r = registry.countryOpenForRegistration(d.country);
    if (r.open) return next();
    const c = registry.COUNTRIES[r.country];
    const name = c ? c.name : r.country;
    const message = c && c.legacy
      ? `${name} est hors du périmètre de lancement C-Pay (CEMAC et RD Congo) : inscription impossible.`
      : c ? `${name} : aucun moyen d’encaissement n’est encore activé, l’inscription ouvrira après activation des partenaires.`
          : `Pays ${r.country} hors du périmètre C-Pay.`;
    logger.warn('capability: registration refused', { country: r.country, status: r.status });
    return res.status(422).json({ error: message, code: 'COUNTRY_NOT_OPEN', country: r.country, status: r.status, launchCountries: registry.LAUNCH_COUNTRIES });
  } catch (err) { return next(err); }
};

/**
 * Page publique de paiement par carte : capacité `collect/card` du pays du marchand du lien.
 * Refus structurels seulement (pays hors registre, `planned`, pays historique bloqué) : l'absence de
 * passerelle configurée reste tranchée par la route elle-même (410 CARD_PAYMENT_DISABLED via
 * card-link.service.hostedCardGatewayFor), qui répond aussi 404 / 409 pour un lien invalide ou déjà payé.
 */
const payCardCapabilityGuard = async (req, res, next) => {
  try {
    if (req.method !== 'POST') return next();
    const shortId = req.params && req.params.shortId;
    if (!shortId) return next();
    const { query } = require('../config/database');
    const r = await query(`SELECT m.country FROM pay_links pl JOIN merchants m ON m.merchant_id = pl.merchant_id WHERE pl.short_id=$1`, [shortId]);
    const row = r && r.rows && r.rows[0];
    if (!row || !row.country) return next();                                    // 404 par la route
    const a = registry.isAllowed({ country: row.country, operation: 'collect', method: 'card' });
    const structural = !a.cell || a.status === registry.STATUS.PLANNED || a.legacy;
    if (a.allowed || !structural) return next();
    logger.warn('capability: public card payment refused', { shortId, country: a.country, status: a.status });
    const err = new registry.CapabilityError({ country: a.country, operation: 'collect', method: 'card', status: a.status, message: a.message });
    return sendCapabilityError(res, err);
  } catch (err) { return next(err); }
};

module.exports = { capabilityGuard, legacyCapabilityGuard, registerCapabilityGuard, payCardCapabilityGuard, merchantCountry, mapCashRequest, mapLegacyRequest };
