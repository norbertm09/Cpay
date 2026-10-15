#!/usr/bin/env node
/**
 * WAVE-2 — chiffrement one-shot des secrets providers stockés en clair
 * (api_configurations.api_key / api_secret / extra_params.{secret,pass,token,key,pin,private}).
 *
 * Usage :
 *   CONFIG_ENCRYPTION_KEY=<64 hex> node scripts/encrypt-api-configs.js [--dry-run]
 *
 * Idempotent : les valeurs déjà préfixées enc:v1: ne sont pas re-chiffrées.
 * --dry-run : affiche ce qui serait chiffré sans écrire en base.
 */
'use strict';

require('dotenv').config();
const secrets = require('../src/config/secrets');

const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-n');

const main = async () => {
  if (!secrets._loadKey()) {
    console.error('CONFIG_ENCRYPTION_KEY manquante (32 octets : 64 hex ou 44 base64). Abandon.');
    process.exit(2);
  }
  const { query, pool } = require('../src/config/database');

  const r = await query(`SELECT config_id, provider_key, api_key, api_secret, extra_params FROM api_configurations ORDER BY provider_key`);
  let touched = 0;
  for (const row of r.rows) {
    const extra = row.extra_params && typeof row.extra_params === 'object' ? row.extra_params : {};
    const newKey    = secrets.encrypt(row.api_key);
    const newSecret = secrets.encrypt(row.api_secret);
    const newExtra  = secrets.encryptExtraParams(extra);

    const changedFields = [];
    if (newKey !== row.api_key) changedFields.push('api_key');
    if (newSecret !== row.api_secret) changedFields.push('api_secret');
    const changedExtra = Object.keys(newExtra).filter(k => newExtra[k] !== extra[k]);
    if (changedExtra.length) changedFields.push(`extra_params.{${changedExtra.join(',')}}`);

    if (!changedFields.length) { console.log(`= ${row.provider_key}: déjà chiffré / rien à faire`); continue; }
    touched += 1;
    console.log(`${dryRun ? '~' : '+'} ${row.provider_key}: ${changedFields.join(', ')}`);
    if (dryRun) continue;

    await query(
      `UPDATE api_configurations SET api_key=$1, api_secret=$2, extra_params=$3::jsonb, updated_at=NOW() WHERE config_id=$4`,
      [newKey ?? null, newSecret ?? null, JSON.stringify(newExtra), row.config_id]
    );
  }
  console.log(`${dryRun ? '[dry-run] ' : ''}${touched} configuration(s) ${dryRun ? 'à chiffrer' : 'chiffrée(s)'} sur ${r.rows.length}.`);
  await pool.end().catch(() => {});
};

main().catch((err) => { console.error('encrypt-api-configs:', err.message); process.exit(1); });
