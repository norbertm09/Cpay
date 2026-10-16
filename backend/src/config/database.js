'use strict';
const { Pool } = require('pg');
const logger = require('./logger');

const intFromEnv = (name, fallback) => {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     intFromEnv('DB_PORT', 5432),
  database: process.env.DB_NAME     || 'cplus_db',
  user:     process.env.DB_USER     || 'cplus_user',
  password: process.env.DB_PASSWORD,
  ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
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
module.exports = { pool, query, withTransaction };
