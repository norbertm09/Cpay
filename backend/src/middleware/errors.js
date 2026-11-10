'use strict';

class ApiError extends Error {
  constructor(statusCode, message, code, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

const notFound = (req, res) => res.status(404).json({
  error: 'Route introuvable',
  code: 'ROUTE_NOT_FOUND',
  path: req.originalUrl,
  requestId: req.requestId,
});

const errorHandler = (logger) => (err, req, res, _next) => {
  const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  const code = err.code && statusCode < 500 ? err.code : 'INTERNAL_ERROR';

  logger.error('Unhandled error', {
    err: err.message,
    stack: err.stack,
    path: req.path,
    requestId: req.requestId,
    statusCode,
  });

  res.status(statusCode).json({
    error: statusCode >= 500 ? 'Erreur interne' : err.message,
    code,
    requestId: req.requestId,
    ...(err.details && statusCode < 500 ? { details: err.details } : {}),
  });
};

// Audit 2026-11-02 § 5 (dette) : aucune route ne doit exposer err.message dans une reponse 5xx (chemins internes,
// SQL, hotes). Plutot que de reprendre 200 handlers, le corps de toute reponse >= 500 passee par res.json est
// remplace par un message generique, le detail est journalise avec requestId. EXPOSE_ERROR_DETAILS=true (dev) le conserve.
const sanitizeServerErrors = (logger) => (req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 500 && body && typeof body === 'object' && !Array.isArray(body) && process.env.EXPOSE_ERROR_DETAILS !== 'true') {
      logger.error('Server error response', { path: req.originalUrl, method: req.method, statusCode: res.statusCode, requestId: req.requestId, error: body.error, code: body.code });
      return originalJson({ error: 'Erreur interne', code: body.code && /^[A-Z0-9_]+$/.test(String(body.code)) ? body.code : 'INTERNAL_ERROR', requestId: req.requestId });
    }
    return originalJson(body);
  };
  next();
};

// Audit § 5 : promesses rejetees sans gestionnaire (journalisees, le processus continue) et exceptions non rattrapees
// (journalisees puis sortie : tini / docker restart relancent l'API dans un etat sain).
const installProcessHandlers = (logger, { exitOnUncaught = true } = {}) => {
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { err: reason && reason.message ? reason.message : String(reason), stack: reason && reason.stack });
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception — arret du processus', { err: err.message, stack: err.stack });
    if (exitOnUncaught) setTimeout(() => process.exit(1), 200).unref();
  });
};

module.exports = { ApiError, asyncHandler, notFound, errorHandler, sanitizeServerErrors, installProcessHandlers };
