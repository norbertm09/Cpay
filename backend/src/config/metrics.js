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
      path,
      status: String(res.statusCode),
    };
    inc('api_requests_total', labels);
    observe('api_request_duration', labels, Date.now() - start);
  });
  next();
};

// ─── Générer le format Prometheus text ───────────────────────────
const renderMetrics = () => {
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

  // Timestamp
  const ts = Date.now();
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
  res.send(renderMetrics());
};

module.exports = {
  httpMetrics, metricsHandler,
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
