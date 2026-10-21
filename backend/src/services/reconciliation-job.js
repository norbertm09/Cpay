'use strict';
// One scheduler/CLI run per database. Holding the session lock requires one
// connection in addition to those used by the existing recovery services.
const LOCK_ID = 1129333081;
const boundedInterval = value => {
 const seconds = Number(value);
 return Number.isFinite(seconds) && seconds >= 30 && seconds <= 3600 ? seconds : 120;
};
const summarize = (name, result) => {
 const source = name === 'payouts' ? result?.transfers?.summary : result?.summary || result;
 const summary = {};
 for (const key of ['scanned','authorized','failed','still_pending','errors','repaired','completed','still_uncertain','flagged']) {
  if (Number.isFinite(source?.[key])) summary[key] = source[key];
 }
 if (name === 'payouts') {
  summary.transactionsScanned = Number(result?.transactions?.scanned) || 0;
  summary.errors = (summary.errors || 0) + (result?.transactions?.results || []).filter(r => r.error || r.alerted === false).length
    + (result?.transfers?.results || []).filter(r => r.alerted === false).length;
 }
 return summary;
};
function createReconciliationJob(options = {}) {
 const pool = options.pool || require('../config/database').pool;
 const logger = options.logger || require('../config/logger');
 const enabled = options.enabled ?? String(process.env.RECONCILE_ENABLED || 'true').toLowerCase() !== 'false';
 const intervalSeconds = boundedInterval(options.intervalSeconds ?? process.env.RECONCILE_INTERVAL_SECONDS);
 const stages = options.stages || {
  pending: params => require('./reconcile.service').reconcilePending(params),
  payouts: params => require('./reconcile.service').reconcileUncertainPayouts(params),
  repair: params => require('./settlement/settlement.repair').sweepAuthorizedWithoutQueue({ minAgeMinutes: 5, limit: params.limit, actor: 'system:reconciliation' }),
 };
 const observe = options.observe || (outcome => require('../config/metrics').recordReconciliationOutcome?.(outcome));
 const state = { enabled, scheduled: false, running: false, intervalSeconds,
  lastStartedAt: null, lastFinishedAt: null, lastSuccessfulAt: null, lastOutcome: 'never_run', consecutiveFailures: 0, stages: {} };
 let timer = null, active = null, stopped = false;
 const getStatus = () => JSON.parse(JSON.stringify(state));
 const run = (params = {}) => {
  if (stopped) return Promise.resolve({ skipped: 'stopped' });
  if (active) return Promise.resolve({ skipped: 'overlap' });
  state.running = true; state.lastStartedAt = new Date().toISOString();
  active = (async () => {
   let client, acquired = false, discard = false, lostLock = false;
   const output = { stages: {} };
   const lost = () => { lostLock = true; discard = true; };
   try {
    if (pool.options?.max < 2) throw Object.assign(new Error('reconciliation_requires_two_connections'), { code: 'POOL_TOO_SMALL' });
    client = await pool.connect();
    client.on?.('error', lost);
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [LOCK_ID]);
    acquired = lock.rows[0]?.acquired === true;
    if (!acquired) { state.lastOutcome = 'locked_elsewhere'; return { skipped: 'locked_elsewhere' }; }
    state.stages = {};
    const settings = { maxAgeHours: 720, minAgeMinutes: 5, limit: 100, ...params };
    let failed = false;
    for (const name of ['pending', 'payouts', 'repair']) {
     if ((name === 'payouts' && settings.skipPayouts) || (name === 'repair' && settings.skipRepair)) continue;
     if (lostLock) throw Object.assign(new Error('reconciliation_lock_lost'), { code: 'LOCK_LOST' });
     try {
      const result = await stages[name](settings);
      const summary = summarize(name, result);
      const status = summary.errors > 0 ? 'error' : 'success';
      failed ||= status === 'error';
      state.stages[name] = { status, summary, finishedAt: new Date().toISOString() };
      output.stages[name] = result;
     } catch (err) {
      failed = true;
      state.stages[name] = { status: 'error', finishedAt: new Date().toISOString() };
      output.stages[name] = { error: `${name}_failed` };
      logger.error('[reconciliation] stage failed', { stage: name, code: err.code || err.name || 'error' });
     }
    }
    if (lostLock) throw Object.assign(new Error('reconciliation_lock_lost'), { code: 'LOCK_LOST' });
    output.outcome = failed ? 'partial_failure' : 'success';
    state.lastOutcome = output.outcome;
    state.consecutiveFailures = failed ? state.consecutiveFailures + 1 : 0;
    if (!failed) state.lastSuccessfulAt = new Date().toISOString();
    logger.info('[reconciliation] completed', { outcome: output.outcome, stages: state.stages });
    return output;
   } catch (err) {
    state.lastOutcome = 'error'; state.consecutiveFailures++;
    logger.error('[reconciliation] run failed', { code: err.code || err.name || 'error' });
    return { ...output, outcome: 'error' };
   } finally {
    if (client) {
     if (acquired && !lostLock) {
      try { const r = await client.query('SELECT pg_advisory_unlock($1) AS released', [LOCK_ID]); if (r.rows[0]?.released !== true) discard = true; }
      catch (_) { discard = true; }
     }
     client.removeListener?.('error', lost);
     client.release(discard);
    }
    state.running = false; state.lastFinishedAt = new Date().toISOString();
    try { observe(state.lastOutcome); } catch (_) { /* Metrics must not block recovery. */ }
   }
  })().finally(() => { active = null; });
  return active;
 };
 const start = () => {
  if (timer || !enabled) return;
  stopped = false; state.scheduled = true;
  void run();
  timer = setInterval(() => { void run(); }, intervalSeconds * 1000);
  timer.unref?.();
  logger.info('[reconciliation] scheduler active', { intervalSeconds });
 };
 const stop = async () => {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null; state.scheduled = false;
  if (active) await active;
 };
 return { start, stop, run, getStatus };
}
let singleton;
const getJob = () => singleton || (singleton = createReconciliationJob());
module.exports = { createReconciliationJob, getJob, getStatus: () => getJob().getStatus() };
