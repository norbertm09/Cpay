'use strict';
const { Pool } = require('pg');
const logger = require('./logger');

const intFromEnv = (name, fallback) => {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * TLS PostgreSQL — vague 6, lot 2 (audit 2026-10-17, P2 n°6) : le certificat du serveur est VÉRIFIÉ.
 *   DB_SSL=true                      → { rejectUnauthorized: true } (magasin système : OVH Cloud DB = CA publique)
 *   DB_SSL_CA (PEM) / DB_SSL_CA_FILE → idem avec cette CA (export « certificat CA » du manager OVH)
 *   DB_SSL_REJECT_UNAUTHORIZED=false → ancien mode NON SÛR (certificat non vérifié) : avertissement au démarrage
 *   DB_SSL_SERVERNAME                → nom attendu dans le certificat si DB_HOST est une IP / un alias
 * Voir docs/WAVE-6-LOT2.md §4.
 */
const buildSslConfig = (env = process.env) => {
  if (String(env.DB_SSL || '').toLowerCase() !== 'true') return { ssl: false, mode: 'off' };
  const explicitInsecure = String(env.DB_SSL_REJECT_UNAUTHORIZED || '').trim().toLowerCase() === 'false';
  let ca = env.DB_SSL_CA ? String(env.DB_SSL_CA).replace(/\\n/g, '\n') : null;
  if (!ca && env.DB_SSL_CA_FILE) {
    try { ca = require('fs').readFileSync(env.DB_SSL_CA_FILE, 'utf8'); }
    catch (err) { logger.error('DB_SSL_CA_FILE unreadable', { file: env.DB_SSL_CA_FILE, err: err.message }); }
  }
  if (ca && !/-----BEGIN CERTIFICATE-----/.test(ca)) { logger.error('DB_SSL_CA / DB_SSL_CA_FILE : contenu PEM invalide (ignoré)'); ca = null; }
  if (explicitInsecure) {
    logger.warn('PostgreSQL TLS: DB_SSL_REJECT_UNAUTHORIZED=false — certificat serveur NON vérifié (mode non sûr, à retirer : fournir DB_SSL_CA ou DB_SSL_CA_FILE)');
    return { ssl: { rejectUnauthorized: false, ...(ca ? { ca } : {}) }, mode: 'insecure' };
  }
  const ssl = { rejectUnauthorized: true, ...(ca ? { ca } : {}), ...(env.DB_SSL_SERVERNAME ? { servername: env.DB_SSL_SERVERNAME } : {}) };
  return { ssl, mode: ca ? 'verify-ca' : 'verify-system' };
};
const sslConfig = buildSslConfig();
if (sslConfig.mode !== 'off') logger.info('PostgreSQL TLS enabled', { mode: sslConfig.mode });

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     intFromEnv('DB_PORT', 5432),
  database: process.env.DB_NAME     || 'cplus_db',
  user:     process.env.DB_USER     || 'cplus_user',
  password: process.env.DB_PASSWORD,
  ssl:      sslConfig.ssl,
  max: intFromEnv('DB_POOL_MAX', 20),
  idleTimeoutMillis: intFromEnv('DB_IDLE_TIMEOUT_MS', 30000),
  connectionTimeoutMillis: intFromEnv('DB_CONNECT_TIMEOUT_MS', 5000),
  statement_timeout: intFromEnv('DB_STATEMENT_TIMEOUT_MS', 30000),
  application_name: process.env.DB_APPLICATION_NAME || 'cpay-api',
});

pool.on('error', (err) => {
  logger.error('Unexpected PostgreSQL pool error', { err: err.message });
});

const query = (text, params) => pool.query(text, params);
const withTransaction = async (fn, connection = null) => {
  const client = connection || await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    if (!connection) client.release();
  }
};
module.exports = { pool, query, withTransaction, buildSslConfig };
