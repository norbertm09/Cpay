/**
 * Auth Middleware — C-Pay 2.6.0 (WAVE-2 : module d'authentification unique)
 *
 * Audit prod 2.6.0 §1.1 : six implementations locales de `jwt.verify` dans
 * les fichiers de routes. Ce module est desormais LE SEUL endroit ou un JWT
 * est signe ou verifie (test wave2-auth : grep `jwt.verify(`).
 *
 * Principes :
 *   - Access token JWT court (15 min pour TOUS les acteurs), claims
 *     { sub, type, role?, ... , iss, aud }. Verification stricte iss/aud.
 *   - Refresh token OPAQUE (32 octets aleatoires, base64url), stocke hashe
 *     (SHA-256) dans refresh_tokens, rotation a chaque usage (revocation
 *     atomique de l'ancien), revocable par acteur (revokeAll).
 *   - Le refresh transite dans un cookie HttpOnly / Secure / SameSite=Strict,
 *     host-only (PAS de Domain=.c-pay.global, audit §2.20), path restreint a
 *     la route /auth du portail concerne (cp_rt_<actorType>).
 *   - Jetons MFA (type `<acteur>_mfa`, 5 min) emis par le login quand la 2FA
 *     est active, consommes par POST /auth/2fa/validate.
 *   - Branche `legacy` : les anciens refresh JWT 7 jours (cardholder,
 *     partenaires) restent acceptes jusqu'a AUTH_LEGACY_REFRESH_UNTIL
 *     (30 jours apres le deploiement) et sont journalises.
 *
 * Le login verifie UNIQUEMENT l'existence et le mot de passe en base ; les
 * APIs externes (MM, gateways) ne sont jamais sollicitees ici.
 */
'use strict';

const jwt       = require('jsonwebtoken');
const crypto    = require('crypto');
const speakeasy = require('speakeasy');
const QRCode    = require('qrcode');
const { query } = require('../config/database');
const logger    = require('../config/logger');

// ─── Configuration ────────────────────────────────────────────────
const JWT_SECRET = () => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is required in production');
  }
  return 'dev_secret_change_in_production';
};

const JWT_ISSUER   = process.env.JWT_ISSUER   || 'api.c-pay.global';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'c-pay';

// 15 minutes pour tout le monde : un access token plus long resterait valide
// apres la revocation du refresh, ce qui viderait la revocation de son sens.
const ACCESS_TTL_SECONDS = 15 * 60;
const MFA_TTL_SECONDS    = 5 * 60;

// Duree des refresh : 30 j par defaut, 7 j pour l'admin (comportement conserve)
const REFRESH_TTL_DAYS = {
  default: parseInt(process.env.JWT_REFRESH_TTL_DAYS, 10) || 30,
  admin:   parseInt(process.env.JWT_REFRESH_TTL_DAYS_ADMIN, 10) || 7,
};

// Fenetre de tolerance des anciens refresh JWT (7 j) : 30 jours apres le
// deploiement de la wave-2. Passe cette date, seuls les refresh opaques
// stockes en base sont acceptes.
const LEGACY_REFRESH_UNTIL = Date.parse(process.env.AUTH_LEGACY_REFRESH_UNTIL || '2026-11-15T00:00:00Z');
const legacyWindowOpen = () => Number.isFinite(LEGACY_REFRESH_UNTIL) && Date.now() < LEGACY_REFRESH_UNTIL;

const PARTNER_TYPES = ['bank_user', 'agent'];
const PARTNER_ROLES = ['bank_admin', 'bank_user', 'agency_admin', 'agency_user', 'agent',
                       'customer_care', 'caissier_maker', 'caissier_checker', 'controleur', 'financier'];

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

const httpError = (statusCode, message, code) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  if (code) err.code = code;
  return err;
};

// ─── Access tokens ────────────────────────────────────────────────
const signAccessToken = (claims, expiresIn = ACCESS_TTL_SECONDS) =>
  jwt.sign({ ...claims }, JWT_SECRET(), { expiresIn, issuer: JWT_ISSUER, audience: JWT_AUDIENCE });

// Compat : signature historique `signToken(payload, expiresIn)`
const signToken = (payload, expiresIn = ACCESS_TTL_SECONDS) => signAccessToken(payload, expiresIn);

const verifyAccessToken = (token) =>
  jwt.verify(token, JWT_SECRET(), { issuer: JWT_ISSUER, audience: JWT_AUDIENCE });

const bearerFrom = (req) => {
  const header = req.headers.authorization;
  return header && header.startsWith('Bearer ') ? header.slice(7) : null;
};

// ─── Middlewares ──────────────────────────────────────────────────
const verifyToken = (req, res, next) => {
  const token = bearerFrom(req);
  if (!token) {
    return res.status(401).json({ error: 'Non authentifié', code: 'MISSING_TOKEN' });
  }
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token invalide ou expiré', code: 'INVALID_TOKEN' });
  }
};

// Type(s) d'acteur requis ; `message`/`code` personnalisent le 403.
const requireType = (types, { message = 'Accès refusé', code = 'FORBIDDEN' } = {}) => {
  const allowed = Array.isArray(types) ? types : [types];
  return (req, res, next) => {
    verifyToken(req, res, () => {
      if (!allowed.includes(req.user.type)) {
        return res.status(403).json({ error: message, code });
      }
      next();
    });
  };
};

// Un acteur sans sub n'est jamais accepte : un jeton signe mais sans identite
// ne doit pas pouvoir atteindre une requete scopee par req.chId / req.user.sub.
const requireSub = (req, res, next) => {
  if (req.user?.sub === undefined || req.user?.sub === null || req.user?.sub === '') {
    return res.status(403).json({ error: 'Accès refusé', code: 'FORBIDDEN' });
  }
  next();
};

const merchantAuth = (req, res, next) =>
  requireType('merchant', { message: 'Accès refusé', code: 'NOT_MERCHANT' })(req, res, () => requireSub(req, res, next));

const adminAuth = (req, res, next) =>
  requireType('admin', { message: 'Accès admin requis', code: 'NOT_ADMIN' })(req, res, () => requireSub(req, res, next));

// Porteur : expose req.chId (= sub) et conserve req.cardholder pour les
// routes historiques (cardholder/gtp/claims lisent req.cardholder.sub).
const cardholderAuth = (req, res, next) =>
  requireType('cardholder', { message: 'Accès refusé', code: 'NOT_CARDHOLDER' })(req, res, () =>
    requireSub(req, res, () => {
      req.chId = req.user.sub;
      req.cardholder = req.user;
      next();
    }));

// Partenaires (portail banques/agences/agents) : type bank_user | agent ET
// role dans la liste des roles partenaires. Un JWT distribution/admin/
// marchand n'est plus accepte (audit §1.1 : partnerAuth ne controlait que role).
const partnerAuth = (req, res, next) =>
  requireType(PARTNER_TYPES, { message: 'Accès refusé', code: 'NOT_PARTNER' })(req, res, () => {
    if (!PARTNER_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Accès refusé', code: 'NOT_PARTNER' });
    }
    requireSub(req, res, next);
  });

// Portails distribution (bank / agency / agent de distribution.routes.js)
const distributionAuth = (...roles) => (req, res, next) =>
  requireType('distribution')(req, res, () => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Accès refusé', code: 'INSUFFICIENT_ROLE' });
    }
    requireSub(req, res, next);
  });

// Rôle admin requis
const requireRole = (...roles) => (req, res, next) => {
  adminAuth(req, res, () => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Rôle requis : ${roles.join(' ou ')}`, code: 'INSUFFICIENT_ROLE' });
    }
    next();
  });
};

const requireMerchantRole = (...roles) => (req, res, next) => {
  merchantAuth(req, res, () => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Rôle insuffisant pour cette opération', code: 'INSUFFICIENT_ROLE' });
    }
    next();
  });
};

// WAVE-6 (audit 17/10/2026 §3) : gestion des bénéficiaires (wallet, comptes bancaires)
// réservée au propriétaire du compte marchand. Le rôle vient du JWT émis au login
// (merchant_users.role : owner | cashier | manager | viewer) ; les clés API (role 'api')
// et les autres rôles reçoivent 403 INSUFFICIENT_ROLE. Le step-up (cash.verifyStepUp)
// reste à la charge de la route.
const MERCHANT_OWNER_ROLES = ['owner'];
const requireMerchantOwner = (req, res, next) =>
  merchantAuth(req, res, () => {
    if (!MERCHANT_OWNER_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Seul le propriétaire du compte peut modifier les bénéficiaires', code: 'INSUFFICIENT_ROLE' });
    }
    next();
  });

// Utilisable seul (`requirePartnerRole('bank_admin')`) ou apres partnerAuth
// (`partnerAuth, requireRole('bank_admin')` dans partners.routes.js) sans
// double verification du jeton.
const requirePartnerRole = (...roles) => (req, res, next) => {
  const check = () => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Permission insuffisante', code: 'INSUFFICIENT_ROLE' });
    }
    next();
  };
  if (req.user) return check();
  partnerAuth(req, res, check);
};

// Copie req.user sous un autre nom (req.actor, req.admin, req.agent…) pour
// les routes historiques, sans dupliquer la verification du jeton.
const aliasUser = (alias) => (req, _res, next) => { req[alias] = req.user; next(); };

// ─── Cookies de refresh (HttpOnly, host-only, SameSite=Strict) ───
//
// Un cookie par acteur, path restreint a la route /auth du portail :
//   - noms distincts  -> deux portails ouverts ne s'ecrasent pas
//   - path restreint  -> le cookie n'est envoye qu'aux routes /auth
//   - host-only       -> jamais de Domain=.c-pay.global : une XSS sur
//                        pay.c-pay.global ne doit pas voir le refresh (audit §2.20)
//   - SameSite=Strict -> les portails sont des sous-domaines de c-pay.global
//                        (meme site), aucune requete cross-site n'emporte le cookie
const REFRESH_COOKIE_BASE = 'cp_rt';
const refreshCookieName = (actorType) => `${REFRESH_COOKIE_BASE}_${actorType}`;

const COOKIE_PATHS = {
  merchant:   '/api/v1/merchant/auth',
  admin:      '/api/v1/admin/auth',
  cardholder: '/api/v1/cardholder/auth',
  partner:    '/api/v1/partners/auth',
  bank:       '/api/v1/bank/auth',
  agency:     '/api/v1/agency/auth',
  agent:      '/api/v1/agent/auth',
};
const cookiePathFor = (actorType, override) => override || COOKIE_PATHS[actorType] || `/api/v1/${actorType}/auth`;

// Secure partout sauf en developpement explicite (http://localhost sans TLS).
const cookieSecure = () => {
  if (process.env.COOKIE_SECURE !== undefined) return process.env.COOKIE_SECURE === 'true';
  return process.env.NODE_ENV !== 'development';
};

const refreshCookieOptions = (path, maxAgeMs) => ({
  httpOnly: true,
  secure: cookieSecure(),
  sameSite: 'strict',
  path,
  ...(maxAgeMs ? { maxAge: maxAgeMs } : {}),
});

const setRefreshCookie = (res, { actorType, token, expiresAt, cookiePath }) => {
  const maxAgeMs = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  res.cookie(refreshCookieName(actorType), token, refreshCookieOptions(cookiePathFor(actorType, cookiePath), maxAgeMs));
};

const clearRefreshCookie = (res, actorTypeOrOpts) => {
  const { actorType, cookiePath } = typeof actorTypeOrOpts === 'string'
    ? { actorType: actorTypeOrOpts } : (actorTypeOrOpts || {});
  res.clearCookie(refreshCookieName(actorType), refreshCookieOptions(cookiePathFor(actorType, cookiePath)));
};

// Cookie d'abord, corps en repli tant que les portails ne sont pas migres.
const readRefreshToken = (req, actorType) =>
  (req.cookies && req.cookies[refreshCookieName(actorType)])
  || req.body?.refreshToken
  || req.body?.refresh_token
  || null;

// ─── Sessions (access + refresh opaque stocke hashe) ──────────────
const newRefreshToken = () => crypto.randomBytes(32).toString('base64url');

const isJwtShaped = (token) => typeof token === 'string' && token.split('.').length === 3;

/**
 * Emet une session complete : access JWT 15 min + refresh opaque stocke
 * hashe + cookie HttpOnly cp_rt_<actorType>.
 *
 * @param {object} p
 * @param {string} p.actorType  merchant | admin | cardholder | partner | bank | agency | agent
 * @param {string} p.actorId    identifiant du sujet (sub)
 * @param {object} p.claims     claims additionnels de l'access token (type, role, merchantId…)
 * @param {object} [p.meta]     donnees persistees avec le refresh (userType, tenantId…)
 * @param {object} [p.req]      pour user-agent / ip
 * @param {object} [p.res]      pour poser le cookie
 * @param {number} [p.refreshTtlDays]
 * @param {string} [p.cookiePath]
 * @returns {Promise<{access_token:string, refresh_token:string, expires_in:number}>}
 */
const issueSession = async ({ actorType, actorId, claims = {}, meta = {}, req, res, refreshTtlDays, cookiePath }) => {
  if (!actorType || actorId === undefined || actorId === null) {
    throw new Error('issueSession: actorType et actorId requis');
  }
  const ttlDays   = refreshTtlDays || REFRESH_TTL_DAYS[actorType] || REFRESH_TTL_DAYS.default;
  const expiresAt = new Date(Date.now() + ttlDays * 86400 * 1000);
  const refresh   = newRefreshToken();

  await query(
    `INSERT INTO refresh_tokens (subject_id, actor_type, token_hash, expires_at, meta, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [String(actorId), actorType, hashToken(refresh), expiresAt, JSON.stringify(meta || {}),
     (req?.headers?.['user-agent'] || '').slice(0, 512) || null, req?.ip || null]
  );

  const access = signAccessToken({ type: actorType, ...claims, sub: String(actorId) });
  if (res) setRefreshCookie(res, { actorType, token: refresh, expiresAt, cookiePath });

  return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL_SECONDS };
};

/**
 * Consomme un refresh token (rotation) et emet une nouvelle session.
 *
 * @param {object} p
 * @param {string} p.actorType
 * @param {string} p.token          refresh (cookie ou corps)
 * @param {Function} p.buildClaims  async ({ actorId, meta }) => claims (jette si sujet inactif)
 * @param {Function} [p.legacy]     (decodedJwt) => { actorId, meta } | null : accepte un ancien
 *                                  refresh JWT (7 j) pendant la fenetre de transition
 * @param {object} [p.req] @param {object} [p.res] @param {number} [p.refreshTtlDays] @param {string} [p.cookiePath]
 */
const rotateRefresh = async ({ actorType, token, buildClaims, legacy, req, res, refreshTtlDays, cookiePath }) => {
  if (!token) throw httpError(401, 'Refresh token requis', 'MISSING_REFRESH');

  const tokenHash = hashToken(token);
  // Revocation atomique : deux appels concurrents avec le meme token ne
  // peuvent pas tous deux obtenir une session.
  const consumed = await query(
    `UPDATE refresh_tokens SET revoked_at = NOW(), last_used_at = NOW()
     WHERE token_hash = $1 AND actor_type = $2 AND revoked_at IS NULL AND expires_at > NOW()
     RETURNING subject_id, meta`,
    [tokenHash, actorType]
  );

  let actorId, meta = {};
  if (consumed.rows.length) {
    actorId = consumed.rows[0].subject_id;
    meta    = consumed.rows[0].meta || {};
  } else {
    // Reutilisation d'un refresh deja consomme : vol probable -> on revoque
    // toute la famille de sessions du sujet.
    const reused = await query(
      `SELECT subject_id FROM refresh_tokens WHERE token_hash = $1 AND actor_type = $2 AND revoked_at IS NOT NULL LIMIT 1`,
      [tokenHash, actorType]
    );
    if (reused.rows.length) {
      logger.warn('auth: refresh token reuse detected, revoking all sessions', { actorType, sub: reused.rows[0].subject_id });
      await revokeAll(actorType, reused.rows[0].subject_id);
      throw httpError(401, 'Refresh token revoqué', 'REFRESH_REUSED');
    }

    // Branche legacy : ancien refresh JWT (7 j) non stocke en base.
    if (typeof legacy === 'function' && isJwtShaped(token) && legacyWindowOpen()) {
      let decoded;
      try { decoded = jwt.verify(token, JWT_SECRET()); }
      catch { throw httpError(401, 'Refresh token invalide', 'INVALID_REFRESH'); }
      const mapped = legacy(decoded);
      if (!mapped || mapped.actorId === undefined || mapped.actorId === null) {
        throw httpError(401, 'Refresh token invalide', 'INVALID_REFRESH');
      }
      actorId = mapped.actorId;
      meta    = mapped.meta || {};
      logger.warn('auth: legacy JWT refresh accepted (transition window)', {
        actorType, sub: String(actorId), legacyUntil: new Date(LEGACY_REFRESH_UNTIL).toISOString(),
      });
    } else {
      throw httpError(401, 'Refresh token invalide ou expiré', 'INVALID_REFRESH');
    }
  }

  let claims;
  try { claims = await buildClaims({ actorId, meta }); }
  catch (err) { throw httpError(err.statusCode || 401, err.message || 'Sujet introuvable', err.code || 'SUBJECT_INACTIVE'); }

  const session = await issueSession({ actorType, actorId, claims, meta, req, res, refreshTtlDays, cookiePath });
  return { ...session, actorId, meta };
};

const revokeRefreshToken = async (token) => {
  if (!token) return;
  await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL', [hashToken(token)]);
};

// Revoque toutes les sessions d'un acteur (changement / reset de mot de passe,
// compromission). Les access tokens en cours expirent sous 15 min.
const revokeAll = async (actorType, actorId) => {
  if (!actorType || actorId === undefined || actorId === null) return;
  await query(
    'UPDATE refresh_tokens SET revoked_at = NOW() WHERE actor_type = $1 AND subject_id = $2 AND revoked_at IS NULL',
    [actorType, String(actorId)]
  );
};

// ─── 2FA (TOTP) ───────────────────────────────────────────────────
const signMfaToken = ({ actorType, sub, ...extra }) =>
  signAccessToken({ ...extra, sub: String(sub), type: `${actorType}_mfa` }, MFA_TTL_SECONDS);

// Renvoie le payload ou jette une erreur 401 (type ou signature invalide)
const verifyMfaToken = (token, actorType) => {
  let payload;
  try { payload = verifyAccessToken(token); }
  catch { throw httpError(401, 'Token 2FA invalide ou expiré', 'INVALID_MFA_TOKEN'); }
  if (payload.type !== `${actorType}_mfa`) throw httpError(401, 'Token 2FA invalide', 'INVALID_MFA_TOKEN');
  return payload;
};

const verifyTotp = (secret, code) => {
  if (!secret || code === undefined || code === null) return false;
  const token = String(code).replace(/\s/g, '');
  if (!/^\d{6,8}$/.test(token)) return false;
  return !!speakeasy.totp.verify({ secret, encoding: 'base32', token, window: 1 });
};

// Secret TOTP + otpauth URL + QR (data-URL PNG) genere cote serveur
const buildTotpEnrollment = async ({ label, issuer = 'C-Pay' }) => {
  const secret = speakeasy.generateSecret({ name: `${issuer}:${label}`, issuer, length: 20 });
  let qrCode = null;
  try { qrCode = await QRCode.toDataURL(secret.otpauth_url); }
  catch (e) { logger.warn('auth: QR 2FA indisponible', { err: e.message }); }
  return { secret: secret.base32, otpauthUrl: secret.otpauth_url, qrCode };
};

// ─── Mots de passe temporaires ────────────────────────────────────
// Alea cryptographique, 16 caracteres, jamais stocke en clair (bcrypt seul).
const generateTempPassword = (prefix = 'Tmp') => `${prefix}-${crypto.randomBytes(12).toString('base64url')}`;

module.exports = {
  // constantes
  JWT_ISSUER, JWT_AUDIENCE, ACCESS_TTL_SECONDS, MFA_TTL_SECONDS, PARTNER_ROLES, PARTNER_TYPES,
  // middlewares
  verifyToken, requireType, merchantAuth, adminAuth, cardholderAuth, partnerAuth, distributionAuth,
  requireRole, requireMerchantRole, requireMerchantOwner, MERCHANT_OWNER_ROLES, requirePartnerRole, aliasUser,
  // jetons
  signToken, signAccessToken, verifyAccessToken, hashToken,
  // sessions
  issueSession, rotateRefresh, revokeRefreshToken, revokeAll,
  readRefreshToken, clearRefreshCookie, refreshCookieName, legacyWindowOpen,
  // 2FA
  signMfaToken, verifyMfaToken, verifyTotp, buildTotpEnrollment,
  // divers
  generateTempPassword,
};
