'use strict';
const crypto = require('crypto');
const { query } = require('../config/database');

const PCI_EVENTS = {
  AUTH_SUCCESS:'AUTH_SUCCESS', AUTH_FAILURE:'AUTH_FAILURE', AUTH_LOCKOUT:'AUTH_LOCKOUT',
  PAYMENT_SUCCESS:'PAYMENT_SUCCESS', PAYMENT_FAILED:'PAYMENT_FAILED',
  CARD_FROZEN:'CARD_FROZEN', CARD_UNFROZEN:'CARD_UNFROZEN',
  PIN_CHANGE:'PIN_CHANGE', PROFILE_UPDATE:'PROFILE_UPDATE',
  TOPUP_SUCCESS:'TOPUP_SUCCESS', UNLOAD_SUCCESS:'UNLOAD_SUCCESS',
};

const auditLog = async (params) => {
  const { eventType, actorType='system', actorId, entityType, entityId, ipAddress, userAgent, success=true, details={}, requestId } = params;
  try {
    await query(
      `INSERT INTO pci_audit_logs (event_type,actor_type,actor_id,entity_type,entity_id,ip_address,user_agent,success,details,request_id,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
      [eventType,actorType,actorId,entityType,entityId,ipAddress,userAgent,success,JSON.stringify(details),requestId]
    );
  } catch (_) {}
};

const sessionActivity = new Map();
const updateSession  = (id) => sessionActivity.set(id, Date.now());
const destroySession = (id) => sessionActivity.delete(id);
const checkSession   = (id) => { const l = sessionActivity.get(id); return l && (Date.now()-l) < 30*60*1000; };

const maskPan = (pan) => {
  if (!pan || pan.length < 10) return pan;
  const c = pan.replace(/\s/g,'');
  return (c.slice(0,4)+'*'.repeat(c.length-8)+c.slice(-4)).match(/.{1,4}/g).join(' ');
};

const sanitizeCardResponse = (data) => {
  if (!data) return data;
  const s = {...data};
  delete s.pin_hash; delete s.cvv_hash; delete s.card_number; delete s.password_hash;
  return s;
};

const pciSecurityHeaders = (req, res, next) => {
  res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains; preload');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.removeHeader('X-Powered-By');
  if (req.path.includes('/card')||req.path.includes('/auth')||req.path.includes('/payment')) {
    res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, private');
  }
  next();
};

const pciInputValidation = (req, res, next) => { next(); };
const pciSessionCheck    = (req, res, next) => { next(); };
const pciAuditRequest    = (req, res, next) => { next(); };
const pciAnomalyDetection= (req, res, next) => { next(); };
const pciResponseSanitizer=(req,res,next)=>{ next(); };
const pciContentTypeCheck= (req, res, next) => { next(); };

const pciErrorHandler = (err, req, res, next) => {
  console.error('[PCI-ERROR]', err.message);
  const isProd = process.env.NODE_ENV === 'production';
  res.status(err.status||500).json({ error: isProd?'Une erreur est survenue':err.message, code: err.code||'INTERNAL_ERROR' });
};

module.exports = {
  pciSecurityHeaders, pciInputValidation, pciSessionCheck, pciAuditRequest,
  pciAnomalyDetection, pciResponseSanitizer, pciErrorHandler, pciContentTypeCheck,
  maskPan, sanitizeCardResponse, auditLog, updateSession, destroySession, checkSession,
  PCI_EVENTS, cardholderRateLimits: {},
};
