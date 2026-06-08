/**
 * CPlus 2.0 — Payment Orchestration Platform
 *
 * Démarrage : aucune vérification des APIs externes.
 * On vérifie uniquement que la base de données est accessible.
 * Les APIs (MM, gateways) sont testées uniquement lors des transactions.
 */
'use strict';

require('dotenv').config();
const express  = require('express');
const helmet   = require('helmet');
const cors     = require('cors');
const rateLimit= require('express-rate-limit');
const crypto   = require('crypto');
const logger   = require('./config/logger');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Sécurité & parsing ───────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: (process.env.ALLOWED_ORIGINS || 'http://localhost:3001,http://localhost:3002').split(','),
  credentials: true,
}));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => { req.requestId = crypto.randomUUID(); next(); });

// Rate limiting
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true }));
app.use('/api/v1/merchant/auth/login', rateLimit({ windowMs: 15*60*1000, max: 10 }));
app.use('/api/v1/admin/auth/login',    rateLimit({ windowMs: 15*60*1000, max: 10 }));

// ─── Routes ───────────────────────────────────────────────────────
const adminRoutes    = require('./routes/admin.routes');
const merchantRoutes = require('./routes/merchant.routes');
const orchestrator   = require('./services/orchestration/orchestrator');
const { detectFromPhone, detectFromCard } = require('./services/detection/detection.engine');
const { runSettlement } = require('./services/settlement/settlement.engine');
const { merchantAuth } = require('./middleware/auth');

// Admin
app.use('/api/v1/admin', adminRoutes);

// Marchand (portail web)
app.use('/api/v1/merchant', merchantRoutes);

// ─── Transactions (app Android + portail) ─────────────────────────
app.post('/api/v1/collect', merchantAuth, async (req, res) => {
  const { amount, customerPhone, emvPayload, aidDetected, description, deviceId } = req.body;
  const result = await orchestrator.processTransaction({
    merchantId: req.user.merchantId, type: 'collect',
    amount, customerPhone, emvPayload, aidDetected, description, deviceId,
  });
  res.status(result.success ? 200 : 402).json({
    success: result.success, txnId: result.txnId,
    message: result.message, amount: result.amount, currency: result.currency,
    authCode: result.authCode, error: result.error || null,
  });
});

app.post('/api/v1/payout', merchantAuth, async (req, res) => {
  const { amount, customerPhone, emvPayload, aidDetected, description, deviceId } = req.body;
  const result = await orchestrator.processTransaction({
    merchantId: req.user.merchantId, type: 'payout',
    amount, customerPhone, emvPayload, aidDetected, description, deviceId,
  });
  res.status(result.success ? 200 : 402).json({
    success: result.success, txnId: result.txnId,
    message: result.message, amount: result.amount, currency: result.currency,
    error: result.error || null,
  });
});

app.post('/api/v1/qr-code', merchantAuth, async (req, res) => {
  const { amount, description } = req.body;
  const { query } = require('./config/database');
  const m = await query('SELECT currency FROM merchants WHERE merchant_id=$1', [req.user.merchantId]);
  const r = await orchestrator.generateQRPayload({ merchantId: req.user.merchantId, amount, currency: m.rows[0]?.currency || 'XOF', description });
  res.json(r);
});

app.post('/api/v1/pay-link', merchantAuth, async (req, res) => {
  const { amount, description } = req.body;
  const { query } = require('./config/database');
  const m = await query('SELECT currency FROM merchants WHERE merchant_id=$1', [req.user.merchantId]);
  const r = await orchestrator.generatePayLink({ merchantId: req.user.merchantId, amount, currency: m.rows[0]?.currency || 'XOF', description });
  res.json(r);
});

// ─── Détection (utilitaire, pas d'auth requise) ───────────────────
app.post('/api/v1/detect/phone', (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone requis' });
  res.json(detectFromPhone(phone));
});

// ─── Settlement cron ──────────────────────────────────────────────
app.post('/internal/settlement/run', (req, res) => {
  if (req.headers['x-internal-token'] !== process.env.INTERNAL_TOKEN) return res.status(403).end();
  runSettlement().then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message }));
});

// ─── Health ───────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  const dbOk = await require('./config/database').pool.query('SELECT 1').then(() => true).catch(() => false);
  // NE PAS tester les APIs externes ici — on rend juste compte de la DB
  res.status(dbOk ? 200 : 503).json({
    status:    dbOk ? 'ok' : 'degraded',
    db:        dbOk ? 'connected' : 'unreachable',
    version:   '2.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ─── 404 + Error handler ─────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'Route introuvable', path: req.originalUrl }));
app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { err: err.message, path: req.path, requestId: req.requestId });
  res.status(500).json({ error: 'Erreur interne', requestId: req.requestId });
});

// ─── Démarrage ────────────────────────────────────────────────────
const start = async () => {
  try {
    // Vérifier uniquement la DB — jamais les APIs externes
    const { pool } = require('./config/database');
    await pool.query('SELECT 1');
    logger.info('Database connected');
  } catch (err) {
    logger.error('Database unreachable — starting anyway (transactions will fail)', { err: err.message });
    // Ne pas stopper le démarrage même si la DB est down
  }

  app.listen(PORT, () => logger.info(`CPlus 2.0 API started on :${PORT}`));
};

if (require.main === module) start();
module.exports = app;
