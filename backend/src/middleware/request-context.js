'use strict';

const crypto = require('crypto');
const logger = require('../config/logger');

const requestContext = (req, res, next) => {
  const incoming = req.headers['x-request-id'];
  req.requestId = typeof incoming === 'string' && incoming.length <= 128
    ? incoming
    : crypto.randomUUID();

  const startedAt = process.hrtime.bigint();
  res.setHeader('X-Request-Id', req.requestId);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger.log(level, 'HTTP request', {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Math.round(durationMs),
      ip: req.ip,
      userId: req.user?.sub,
      merchantId: req.user?.merchantId,
    });
  });

  next();
};

module.exports = { requestContext };
