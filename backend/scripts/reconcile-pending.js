#!/usr/bin/env node
/**
 * WAVE-3 — réconciliation des transactions Mobile Money `pending` (cron / one-shot).
 *
 * Même service que POST /api/v1/admin/reconcile (services/reconcile.service.js) :
 * MTN, Airtel et les providers de la vague 2 (Orange, Wave, Africell, Express Union,
 * Free Money, Moov) via getStatus() quand l'opérateur l'expose ; finalisation par la
 * machine d'état des webhooks (services/mobilemoney/finalize.service.js). Une
 * transaction dont l'opérateur est injoignable reste `pending`.
 *
 * Usage :
 *   node scripts/reconcile-pending.js [--max-age-hours=24] [--min-age-minutes=5] [--limit=100] [--json]
 *
 * Exemple cron (toutes les 10 min) — voir docs/WAVE-3.md :
 *   "*\/10 * * * * cd /opt/cplus/backend && node scripts/reconcile-pending.js >> /var/log/cpay-reconcile.log 2>&1"
 *
 * Code de sortie : 0 (terminé, même si des transactions restent pending), 1 (erreur fatale).
 */
'use strict';

require('dotenv').config();

const arg = (name, def) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (!hit) return def;
  const v = parseInt(hit.split('=')[1], 10);
  return Number.isFinite(v) ? v : def;
};
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

const main = async () => {
  const maxAgeHours  = clamp(arg('max-age-hours', 24), 1, 720);
  const minAgeMinutes = clamp(arg('min-age-minutes', 5), 0, 1440);
  const limit        = clamp(arg('limit', 100), 1, 1000);
  const asJson       = process.argv.includes('--json');

  const { reconcilePending } = require('../src/services/reconcile.service');
  const { pool } = require('../src/config/database');
  const started = Date.now();
  const r = await reconcilePending({ maxAgeHours, limit, minAgeMinutes });

  if (asJson) {
    console.log(JSON.stringify({ at: new Date().toISOString(), durationMs: Date.now() - started, params: { maxAgeHours, minAgeMinutes, limit }, ...r }));
  } else {
    const s = r.summary;
    console.log(`[reconcile] ${new Date().toISOString()} scanned=${s.scanned} authorized=${s.authorized} failed=${s.failed} still_pending=${s.still_pending} skipped=${s.skipped} errors=${s.errors} (${Date.now() - started} ms)`);
    for (const x of r.results) {
      const state = x.updated ? `→ ${x.updated}` : x.error ? `erreur: ${x.error}` : x.skipped ? `ignorée (${x.skipped})` : `pending${x.providerStatus ? ` (${x.providerStatus})` : ''}${x.mismatch ? ' MONTANT/DEVISE INCOHÉRENT' : ''}`;
      console.log(`  ${x.txn} ${x.provider || ''} ${state}`);
    }
  }
  if (pool && typeof pool.end === 'function') await pool.end().catch(() => {});
};

main().then(() => process.exit(0)).catch((err) => {
  console.error('[reconcile] erreur fatale:', err.message);
  process.exit(1);
});
