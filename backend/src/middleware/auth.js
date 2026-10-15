/**
 * Auth Middleware — CPlus 2.6.0
 *
 * Principe : le login vérifie UNIQUEMENT l'existence et le mot de passe
 * de l'utilisateur en base. Aucune vérification des APIs externes.
 *
 * Les APIs (MM, gateways) sont vérifiées uniquement au moment de la transaction.
 */
'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { query } = require('../config/database');

const JWT_SECRET = () => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET is required in production');
  }
  return 'dev_secret_change_in_production';
};

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

// ─── Vérifier un token JWT ────────────────────────────────────────
const verifyToken = (req, res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Non authentifié', code: 'MISSING_TOKEN' });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET());
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token invalide ou expiré', code: 'INVALID_TOKEN' });
  }
};

// ─── Marchand authentifié ─────────────────────────────────────────
const merchantAuth = (req, res, next) => {
  verifyToken(req, res, () => {
    if (req.user.type !== 'merchant') {
      return res.status(403).json({ error: 'Accès refusé', code: 'NOT_MERCHANT' });
    }
    next();
  });
};

// ─── Admin authentifié ────────────────────────────────────────────
const adminAuth = (req, res, next) => {
  verifyToken(req, res, () => {
    if (req.user.type !== 'admin') {
      return res.status(403).json({ error: 'Accès admin requis', code: 'NOT_ADMIN' });
    }
    next();
  });
};

// ─── Rôle admin requis ────────────────────────────────────────────
const requireRole = (...roles) => (req, res, next) => {
  adminAuth(req, res, () => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `Rôle requis : ${roles.join(' ou ')}`, code: 'INSUFFICIENT_ROLE' });
    }
    next();
  });
};

// ─── Générer un token ─────────────────────────────────────────────
const signToken = (payload, expiresIn = '15m') =>
  jwt.sign(payload, JWT_SECRET(), { expiresIn });

const signRefreshToken = async ({ subjectId, actorType, payload, expiresIn = '30d' }) => {
  // jti aleatoire indispensable : sans lui, deux logins dans la meme seconde
  // produisent un JWT identique (memes sub, type, iat, exp), donc le meme
  // SHA-256, donc une violation de refresh_tokens_token_hash_key et un 500.
  // Un marchand qui double-clique sur "Se connecter" suffit a le declencher.
  const token = signToken({ ...payload, jti: crypto.randomUUID() }, expiresIn);
  const decoded = jwt.decode(token);
  await query(
    `INSERT INTO refresh_tokens (subject_id, actor_type, token_hash, expires_at)
     VALUES ($1, $2, $3, to_timestamp($4))`,
    [subjectId, actorType, hashToken(token), decoded.exp]
  );
  return token;
};

// accessExpiresIn passe de 8h a 15m : un access token de 8h reste valide
// 8h apres la revocation du refresh, ce qui vide la revocation de son sens.
const rotateRefreshToken = async ({ token, expectedType, actorType, buildAccessPayload, accessExpiresIn = '15m', refreshExpiresIn = '30d' }) => {
  const decoded = jwt.verify(token, JWT_SECRET());
  if (decoded.type !== expectedType) {
    const err = new Error('Invalid refresh token type');
    err.statusCode = 401;
    throw err;
  }

  const tokenHash = hashToken(token);
  const existing = await query(
    `SELECT * FROM refresh_tokens
     WHERE token_hash = $1 AND actor_type = $2 AND revoked_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    [tokenHash, actorType]
  );
  if (!existing.rows.length) {
    const err = new Error('Refresh token revoked or expired');
    err.statusCode = 401;
    throw err;
  }

  await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1', [tokenHash]);
  const accessPayload = await buildAccessPayload(decoded.sub);
  return {
    accessToken: signToken(accessPayload, accessExpiresIn),
    refreshToken: await signRefreshToken({
      subjectId: decoded.sub,
      actorType,
      payload: { sub: decoded.sub, type: expectedType },
      expiresIn: refreshExpiresIn,
    }),
  };
};

const revokeRefreshToken = async (token) => {
  if (!token) return;
  await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1', [hashToken(token)]);
};

// ─── Cookies de refresh (HttpOnly) ────────────────────────────────
//
// Le refresh token ne doit jamais etre lisible par du JavaScript : une XSS
// sur un portail donnerait sinon un acces persistant de 30 jours.
//
// Un cookie par acteur, avec un path restreint :
//   - noms distincts    -> deux portails ouverts ne s'ecrasent pas
//   - path restreint    -> le cookie n'est envoye qu'aux routes /auth du
//                          portail concerne, pas sur chaque appel API
//   - domain partage    -> les portails sont sur des sous-domaines de
//                          c-pay.global, sameSite=lax suffit
const REFRESH_COOKIE_BASE = 'cp_rt';

const refreshCookieName = (actorType) => `${REFRESH_COOKIE_BASE}_${actorType}`;

const isProd = () => process.env.NODE_ENV === 'production';

const refreshCookieOptions = (path, maxAgeMs) => ({
  httpOnly: true,
  secure: isProd(),
  sameSite: 'lax',
  domain: isProd() ? (process.env.COOKIE_DOMAIN || '.c-pay.global') : undefined,
  path,
  maxAge: maxAgeMs || 30 * 24 * 60 * 60 * 1000,
});

// La duree du cookie est calee sur l'expiration reelle du JWT plutot que
// codee en dur : le refresh admin vaut 7 jours, le marchand 30. Un cookie
// qui survit a son JWT ne sert qu'a produire des 401 inutiles.
const setRefreshCookie = (res, { actorType, path, token }) => {
  let maxAgeMs;
  try {
    const exp = jwt.decode(token)?.exp;
    if (exp) maxAgeMs = Math.max(0, exp * 1000 - Date.now());
  } catch (e) { /* repli sur la valeur par defaut */ }
  res.cookie(refreshCookieName(actorType), token, refreshCookieOptions(path, maxAgeMs));
};

const clearRefreshCookie = (res, { actorType, path }) => {
  const opts = refreshCookieOptions(path);
  delete opts.maxAge;
  res.clearCookie(refreshCookieName(actorType), opts);
};

// Lit le refresh depuis le cookie en priorite, puis depuis le corps.
// Le repli sur le corps disparaitra en phase 3, une fois les 7 portails
// migres. Il est indispensable ici pour ne casser aucune session en cours.
const readRefreshToken = (req, actorType) =>
  (req.cookies && req.cookies[refreshCookieName(actorType)])
  || req.body?.refreshToken
  || req.body?.refresh_token
  || null;

module.exports = {
  verifyToken,
  merchantAuth,
  adminAuth,
  requireRole,
  signToken,
  signRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  setRefreshCookie,
  clearRefreshCookie,
  readRefreshToken,
  refreshCookieName,
};
