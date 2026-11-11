/**
 * Prometheus Metrics — CPlus 2.6
 * Endpoint GET /metrics (protégé par token)
 */
'use strict';

// Metrics légères sans dépendance externe (pas de prom-client requis)
// Compteurs en mémoire — reset au redémarrage

const counters = {
  reconciliation_runs_total: {}, // bounded outcome labels
  transactions_total:         {},   // { status, method, gateway }
  transactions_amount_total:  {},   // { currency }
  api_requests_total:         {},   // { method, path, status }
  api_request_duration_sum:   {},
  api_request_duration_count: {},
  fraud_blocked_total:        {},
  fraud_flagged_total:        {},
  mm_requests_total:          {},   // { provider, status }
  gateway_requests_total:     {},   // { gateway, status }
};

const recoveryStatus = () => require('../services/reconciliation-job').getStatus();
const gauges = {
  reconciliation_enabled: () => Number(recoveryStatus().enabled),
  reconciliation_scheduled: () => Number(recoveryStatus().scheduled),
  reconciliation_running: () => Number(recoveryStatus().running),
  reconciliation_last_success_timestamp_seconds: () => recoveryStatus().lastSuccessfulAt ? Date.parse(recoveryStatus().lastSuccessfulAt) / 1000 : 0,
  reconciliation_last_finished_timestamp_seconds: () => recoveryStatus().lastFinishedAt ? Date.parse(recoveryStatus().lastFinishedAt) / 1000 : 0,
  reconciliation_consecutive_failures: () => recoveryStatus().consecutiveFailures,

  process_uptime_seconds:     () => Math.floor(process.uptime()),
  process_memory_rss_bytes:   () => process.memoryUsage().rss,
  process_memory_heap_bytes:  () => process.memoryUsage().heapUsed,
};

// ─── Helpers ─────────────────────────────────────────────────────
const key = (labels) => Object.entries(labels).map(([k,v]) => `${k}="${v}"`).join(',');
const inc = (counter, labels = {}, value = 1) => {
  const k = key(labels);
  counters[counter][k] = (counters[counter][k] || 0) + value;
};
const observe = (name, labels, value) => {
  const k = key(labels);
  counters[`${name}_sum`][k]   = (counters[`${name}_sum`][k]   || 0) + value;
  counters[`${name}_count`][k] = (counters[`${name}_count`][k] || 0) + 1;
};

// ─── Middleware HTTP metrics ──────────────────────────────────────
const httpMetrics = (req, res, next) => {
  if (req.path === '/metrics' || req.path === '/live') return next();
  // Classify before Express trims router mounts; never retain a raw path in a
  // metric label. Webhook secrets and arbitrary user identifiers are not labels.
  const categories = ['webhooks', 'merchant', 'cardholder', 'admin', 'partners', 'auth', 'consent', 'capabilities', 'detection', 'pay'];
  const path = categories.find(name => new RegExp(`^/api/v1/${name}(?:/|$)`).test(req.path))
    || (['/health', '/ready'].includes(req.path) ? req.path.slice(1) : 'unmatched');
  const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(req.method) ? req.method : 'OTHER';
  const start = Date.now();
  res.on('finish', () => {
    const labels = {
      method,
      path: req.route ? path : 'unmatched',
      status: String(res.statusCode),
    };
    inc('api_requests_total', labels);
    observe('api_request_duration', labels, Date.now() - start);
  });
  next();
};

// ─── Collecteurs asynchrones (une requete SQL, bornee dans le temps) ──────────
// Lot « alertes retraits incertains » (2026-11) : etat des ordres sortants incertains (merchant_transfers), pour les
// regles cplus-cash de monitoring/prometheus/alerts.yml. cash_metrics_up=0 quand la base ne repond pas : l'absence
// de la metrique ou sa valeur 0 declenche CashMetricsMissing, sans faire tomber tout /metrics.
const CASH_STATUSES = ['pending', 'sending', 'processing', 'unknown'];
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms).unref())]);
const collectCash = async () => {
  const cash = require('../services/cash/cash.service');
  const lines = [];
  const sweep = cash.getSweepState();
  try {
    const s = await withTimeout(cash.getUncertainPayoutStats(), 2000);
    lines.push('# TYPE cash_metrics_up gauge', 'cash_metrics_up 1');
    lines.push('# TYPE cash_payouts_uncertain gauge');
    for (const st of CASH_STATUSES) lines.push(`cash_payouts_uncertain{status="${st}"} ${s.byStatus[st] || 0}`);
    lines.push('# TYPE cash_payouts_uncertain_total gauge', `cash_payouts_uncertain_total ${s.total}`);
    lines.push('# TYPE cash_payouts_uncertain_oldest_age_seconds gauge', `cash_payouts_uncertain_oldest_age_seconds ${s.oldestAgeSeconds}`);
    lines.push('# TYPE cash_payouts_needs_review gauge', `cash_payouts_needs_review ${s.needsReview}`);
  } catch (err) {
    require('./logger').warn('metrics: cash stats unavailable', { err: err.message });
    lines.push('# TYPE cash_metrics_up gauge', 'cash_metrics_up 0');
  }
  lines.push('# TYPE cash_payouts_sweep_last_success_timestamp_seconds gauge', `cash_payouts_sweep_last_success_timestamp_seconds ${sweep.lastSuccessAt ? Math.floor(sweep.lastSuccessAt / 1000) : 0}`);
  lines.push('# TYPE cash_payouts_sweep_last_finished_timestamp_seconds gauge', `cash_payouts_sweep_last_finished_timestamp_seconds ${sweep.lastFinishedAt ? Math.floor(sweep.lastFinishedAt / 1000) : 0}`);
  lines.push('# TYPE cash_payouts_sweep_last_errors gauge', `cash_payouts_sweep_last_errors ${sweep.lastErrors}`);
  lines.push('# TYPE cash_payouts_sweep_last_flagged gauge', `cash_payouts_sweep_last_flagged ${sweep.lastFlagged}`);
  return lines;
};
const collectors = [collectCash];

// ─── Générer le format Prometheus text ───────────────────────────
const renderMetrics = async () => {
  const lines = ['# CPlus 2.6 metrics'];

  // Counters
  for (const [name, data] of Object.entries(counters)) {
    lines.push(`# TYPE ${name} counter`);
    for (const [labels, value] of Object.entries(data)) {
      lines.push(labels ? `${name}{${labels}} ${value}` : `${name} ${value}`);
    }
  }

  // Gauges
  for (const [name, fn] of Object.entries(gauges)) {
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${fn()}`);
  }

  // Collecteurs asynchrones : un collecteur en echec ne retire que ses propres lignes
  for (const c of collectors) {
    try { lines.push(...await c()); } catch (err) { require('./logger').warn('metrics: collector failed', { err: err.message }); }
  }

  // Timestamp
  lines.push(`# Generated at ${new Date().toISOString()}`);
  lines.push('');
  return lines.join('\n');
};

// ─── Handler Express ──────────────────────────────────────────────
const metricsHandler = (req, res) => {
  const token = process.env.METRICS_TOKEN;
  // Fail-closed : sans METRICS_TOKEN configuré, l'endpoint n'existe pas ; jamais de jeton en query string
  if (!token) return res.status(404).json({ error: 'Not found' });
  const auth = String(req.headers.authorization || '');
  const expected = `Bearer ${token}`;
  const ok = auth.length === expected.length && require('crypto').timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
  if (!ok) return res.status(403).json({ error: 'Metrics access denied' });
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  renderMetrics().then((body) => res.send(body)).catch((err) => {
    require('./logger').error('metrics: render failed', { err: err.message });
    res.status(500).send('# metrics unavailable\n');
  });
};

module.exports = {
  httpMetrics, metricsHandler, renderMetrics,
  recordReconciliationOutcome: (outcome) => {
    if (['success', 'partial_failure', 'error', 'locked_elsewhere'].includes(outcome)) inc('reconciliation_runs_total', { outcome });
  },
  incTransaction: (labels) => inc('transactions_total', labels),
  incAmount:      (currency, amount) => inc('transactions_amount_total', { currency }, amount),
  incFraudBlock:  (labels) => inc('fraud_blocked_total', labels),
  incFraudFlag:   (labels) => inc('fraud_flagged_total', labels),
  incMM:          (labels) => inc('mm_requests_total', labels),
  incGateway:     (labels) => inc('gateway_requests_total', labels),
};
