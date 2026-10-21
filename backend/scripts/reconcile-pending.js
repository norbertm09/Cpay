#!/usr/bin/env node
/**
 * WAVE-3 — réconciliation des transactions Mobile Money `pending` (cron / one-shot).
 * WAVE-6 — couvre aussi : les retraits incertains (`merchant_transfers` en `unknown` /
 * `processing` : statut réel opérateur, period de grâce CASH_UNKNOWN_GRACE_MINUTES, revue ops
 * après CASH_UNKNOWN_ALERT_HOURS), les décaissements `pending_unknown`, et la réparation de la
 * file de règlement (encaissements `authorized` sans ligne settlement_queue depuis plus de 5 min).
 *
 * Même service que POST /api/v1/admin/reconcile (services/reconcile.service.js) :
 * MTN, Airtel et les providers de la vague 2 (Orange, Wave, Africell, Express Union,
 * Free Money, Moov) via getStatus() quand l'opérateur l'expose ; finalisation par la
 * machine d'état des webhooks (services/mobilemoney/finalize.service.js). Une
 * transaction dont l'opérateur est injoignable reste `pending`.
 *
 * Usage :
 *   node scripts/reconcile-pending.js [--max-age-hours=24] [--min-age-minutes=5] [--limit=100]
 *                                     [--grace-minutes=30] [--alert-hours=2] [--skip-payouts] [--skip-repair] [--json]
 *
 * Exemple cron (toutes les 10 min) — voir docs/WAVE-3.md et docs/WAVE-6-LOT1.md :
 *   "*\/10 * * * * cd /opt/cplus/backend && node scripts/reconcile-pending.js >> /var/log/cpay-reconcile.log 2>&1"
 *
 * Code de sortie : 0 (terminé, même si des transactions restent pending), 1 (erreur fatale).
 */
'use strict';

require('dotenv').config();

const arg = (name, def) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (!hit) return def;
  const v = parseFloat(hit.split('=')[1]);
  return Number.isFinite(v) ? v : def;
};
const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

const main = async () => {
  const maxAgeHours  = clamp(arg('max-age-hours', 24), 1, 720);
  const minAgeMinutes = clamp(arg('min-age-minutes', 5), 0, 1440);
  const limit        = clamp(arg('limit', 100), 1, 1000);
  const graceMinutes = process.argv.some(a => a.startsWith('--grace-minutes=')) ? clamp(arg('grace-minutes', 30), 0, 1440) : null;
  const alertHours   = process.argv.some(a => a.startsWith('--alert-hours=')) ? clamp(arg('alert-hours', 2), 0, 720) : null;
  const skipPayouts  = process.argv.includes('--skip-payouts');
  const skipRepair   = process.argv.includes('--skip-repair');
  const asJson       = process.argv.includes('--json');

  const { createReconciliationJob } = require('../src/services/reconciliation-job');
  const { pool } = require('../src/config/database');
  const job = createReconciliationJob({ enabled: false });
  const started = Date.now();
  const result = await job.run({ maxAgeHours, minAgeMinutes, limit, graceMinutes, alertHours, skipPayouts, skipRepair });
  await job.stop();
  if (result.skipped) {
    console.log(JSON.stringify({ skipped: result.skipped }));
    await pool.end(); return;
  }
  if (result.outcome !== 'success') process.exitCode = 1;
  const r = result.stages.pending?.summary ? result.stages.pending : { summary: { scanned: 0, authorized: 0, failed: 0, still_pending: 0, skipped: 0, errors: 1 }, results: [] };
  const payouts = result.stages.payouts || null;
  const repair = result.stages.repair || null;

  if (asJson) {
    console.log(JSON.stringify({ at: new Date().toISOString(), durationMs: Date.now() - started, params: { maxAgeHours, minAgeMinutes, limit, graceMinutes, alertHours }, outcome: result.outcome, ...r, uncertainPayouts: payouts, settlementRepair: repair }));
  } else {
    const s = r.summary;
    console.log(`[reconcile] ${new Date().toISOString()} scanned=${s.scanned} authorized=${s.authorized} failed=${s.failed} still_pending=${s.still_pending} skipped=${s.skipped} errors=${s.errors} (${Date.now() - started} ms)`);
    for (const x of r.results) {
      const state = x.updated ? `→ ${x.updated}` : x.error ? `erreur: ${x.error}` : x.skipped ? `ignorée (${x.skipped})` : `pending${x.providerStatus ? ` (${x.providerStatus})` : ''}${x.mismatch ? ' MONTANT/DEVISE INCOHÉRENT' : ''}`;
      console.log(`  ${x.txn} ${x.provider || ''} ${state}`);
    }
    if (payouts && !payouts.error) {
      const p = payouts.transfers.summary;
      console.log(`[reconcile] retraits incertains : scanned=${p.scanned} completed=${p.completed} failed=${p.failed} still_uncertain=${p.still_uncertain} flagged=${p.flagged} errors=${p.errors}`);
      for (const x of payouts.transfers.results) console.log(`  ${x.transferId} ${x.reference || ''} ${x.from} → ${x.status}${x.check ? ` (${x.check})` : ''}${x.needsReview ? ' NEEDS_REVIEW' : ''}`);
      console.log(`[reconcile] décaissements pending_unknown : scanned=${payouts.transactions.scanned} flagged=${payouts.transactions.flagged}`);
    }
    if (repair && !repair.error) {
      console.log(`[reconcile] réparation file de règlement : scanned=${repair.scanned} repaired=${repair.repaired} errors=${repair.errors}`);
      for (const id of repair.transactionIds) console.log(`  ${id} → settlement_queue`);
    }
  }
  if (pool && typeof pool.end === 'function') await pool.end().catch(() => {});
};

main().then(() => process.exit(process.exitCode || 0)).catch((err) => {
  console.error('[reconcile] erreur fatale:', err.message);
  process.exit(1);
});
