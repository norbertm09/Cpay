'use strict';
const { Pool } = require('pg');
const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432'),
  database: process.env.DB_NAME     || 'calculus_db',
  user:     process.env.DB_USER     || 'calculus_user',
  password: process.env.DB_PASSWORD,
  ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 20, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000,
});
const query = (text, params) => pool.query(text, params);
const withTransaction = async (fn) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};
module.exports = { pool, query, withTransaction };
