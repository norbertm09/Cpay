/**
 * Auth Middleware — CPlus 2.0
 *
 * Principe : le login vérifie UNIQUEMENT l'existence et le mot de passe
 * de l'utilisateur en base. Aucune vérification des APIs externes.
 *
 * Les APIs (MM, gateways) sont vérifiées uniquement au moment de la transaction.
 */
'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET = () => process.env.JWT_SECRET || 'dev_secret_change_in_production';

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

module.exports = { verifyToken, merchantAuth, adminAuth, requireRole, signToken };
