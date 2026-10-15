#!/usr/bin/env node
'use strict';

require('dotenv').config();

const { pool, query } = require('../src/config/database');

const main = async () => {
  const checks = [];
  const mode = (process.env.PILOT_CONTROL_MODE || 'audit').toLowerCase();

  checks.push({
    key: 'pilot_control_mode',
    ok: ['audit', 'enforce'].includes(mode),
    detail: `PILOT_CONTROL_MODE=${mode}`,
  });

  const requiredTables = [
    'pilot_programs',
    'pilot_merchant_enrollments',
    'feature_flags',
    'feature_flag_overrides',
    'pilot_decision_logs',
    'pilot_readiness_checks',
  ];

  for (const table of requiredTables) {
    const result = await query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = $1
       ) AS present`,
      [table]
    );
    checks.push({ key: `table_${table}`, ok: result.rows[0].present, detail: table });
  }

  const program = await query(
    "SELECT pilot_key, status FROM pilot_programs WHERE pilot_key = 'cplus-2-6-production-ovh' LIMIT 1"
  );
  checks.push({
    key: 'default_pilot_program',
    ok: program.rows.length === 1 && ['active', 'paused'].includes(program.rows[0].status),
    detail: program.rows[0] ? `${program.rows[0].pilot_key}:${program.rows[0].status}` : 'missing',
  });

  const flags = await query('SELECT COUNT(*)::int AS total FROM feature_flags');
  checks.push({ key: 'feature_flags_seeded', ok: flags.rows[0].total >= 8, detail: `${flags.rows[0].total} flags` });

  const readiness = await query(
    "SELECT COUNT(*)::int AS blockers FROM pilot_readiness_checks WHERE required = TRUE AND status <> 'done'"
  );
  checks.push({
    key: 'readiness_blockers',
    ok: readiness.rows[0].blockers === 0,
    detail: `${readiness.rows[0].blockers} blocker(s)`,
  });

  const failed = checks.filter((check) => !check.ok);
  checks.forEach((check) => console.log(`${check.ok ? 'OK' : 'FAIL'} ${check.key} - ${check.detail}`));

  if (failed.length) {
    console.error(`Pilot readiness failed: ${failed.length} issue(s).`);
    process.exitCode = 1;
  } else {
    console.log('Pilot readiness OK.');
  }
};

main()
  .catch((err) => {
    console.error(`Pilot readiness error: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
