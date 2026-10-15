#!/usr/bin/env node
'use strict';

require('dotenv').config();

const bcrypt = require('bcryptjs');
const { pool, query } = require('../src/config/database');

const email = (process.env.FIRST_ADMIN_EMAIL || '').trim().toLowerCase();
const password = process.env.FIRST_ADMIN_PASSWORD || '';
const firstName = process.env.FIRST_ADMIN_FIRST_NAME || 'Super';
const lastName = process.env.FIRST_ADMIN_LAST_NAME || 'Admin';

const main = async () => {
  if (!email || !password) {
    throw new Error('FIRST_ADMIN_EMAIL and FIRST_ADMIN_PASSWORD are required');
  }
  if (password.length < 14) {
    throw new Error('FIRST_ADMIN_PASSWORD must be at least 14 characters');
  }

  const existing = await query('SELECT admin_id FROM admin_users WHERE email = $1 LIMIT 1', [email]);
  if (existing.rows.length) {
    throw new Error(`Admin already exists: ${email}`);
  }

  const hash = await bcrypt.hash(password, 12);
  const result = await query(
    `INSERT INTO admin_users (email, password_hash, first_name, last_name, role, is_active)
     VALUES ($1,$2,$3,$4,'super_admin',TRUE)
     RETURNING admin_id, email, role`,
    [email, hash, firstName, lastName]
  );

  console.log(`FIRST_ADMIN_CREATED ${result.rows[0].email} ${result.rows[0].admin_id}`);
};

main()
  .catch((err) => {
    console.error(`FIRST_ADMIN_FAILED ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
