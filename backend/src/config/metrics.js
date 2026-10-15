/**
 * Prometheus Metrics — CPlus 2.6
 * Endpoint GET /metrics (protégé par token)
 */
'use strict';

// Metrics légères sans dépendance externe (pas de prom-client requis)
// Compteurs en mémoire — reset au redémarrage

const counters = {
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

const gauges = {
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
  const start = Date.now();
  res.on('finish', () => {
    const labels = {
      method: req.method,
      path:   req.path.replace(/\/[0-9a-f-]{36}/gi, '/:id').replace(/\/\d+/g, '/:n'),
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
  if (token) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${token}` && req.query.token !== token) {
      return res.status(403).json({ error: 'Metrics access denied' });
    }
  }
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(renderMetrics());
};

module.exports = {
  httpMetrics, metricsHandler,
  incTransaction: (labels) => inc('transactions_total', labels),
  incAmount:      (currency, amount) => inc('transactions_amount_total', { currency }, amount),
  incFraudBlock:  (labels) => inc('fraud_blocked_total', labels),
  incFraudFlag:   (labels) => inc('fraud_flagged_total', labels),
  incMM:          (labels) => inc('mm_requests_total', labels),
  incGateway:     (labels) => inc('gateway_requests_total', labels),
};
