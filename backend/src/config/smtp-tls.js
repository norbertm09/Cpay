'use strict';

const fs = require('fs');

// Private CAs must be explicitly trusted, never bypass certificate verification.
// An unreadable configured file throws: sending must not fall back to insecure TLS.
const smtpTlsOptions = (env = process.env) => {
  const ca = env.SMTP_TLS_CA
    ? String(env.SMTP_TLS_CA).replace(/\\n/g, '\n')
    : env.SMTP_TLS_CA_FILE ? fs.readFileSync(env.SMTP_TLS_CA_FILE, 'utf8') : null;
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
};

module.exports = { smtpTlsOptions };
