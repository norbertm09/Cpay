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

module.exports = { ApiError, asyncHandler, notFound, errorHandler };
