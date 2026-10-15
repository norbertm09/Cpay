'use strict';

const fs = require('fs');
const path = require('path');
const { pool } = require('./database');
const logger = require('./logger');

const migrationsDir = path.resolve(__dirname, '../../database');

const run = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const files = fs.readdirSync(migrationsDir)
      .filter((file) => /^\d+_.*\.sql$/i.test(file))
      .sort();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const checksum = require('crypto').createHash('sha256').update(sql).digest('hex');
      const existing = await client.query('SELECT checksum FROM schema_migrations WHERE filename = $1', [file]);

      if (existing.rows.length) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`Migration checksum changed after apply: ${file}`);
        }
        logger.info('Migration already applied', { file });
        continue;
      }

      logger.info('Applying migration', { file });
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
    }

    await client.query('COMMIT');
    logger.info('Migrations complete', { count: files.length });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Migration failed', { err: err.message });
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
};

run();
