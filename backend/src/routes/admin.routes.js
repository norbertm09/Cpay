/**
 * Routes Admin — CPlus 2.0
 *
 * /admin/auth          — login admin
 * /admin/api-configs   — CRUD configurations API (MM + gateways)
 * /admin/merchants     — liste, détail, suspension marchands
 * /admin/activity      — monitoring transactions temps réel
 * /admin/terminals     — gestion terminaux tous marchands
 * /admin/stats         — statistiques globales
 */
'use strict';

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const { query } = require('../config/database');
const { adminAuth, requireRole, signToken } = require('../middleware/auth');
const { invalidateCache } = require('../services/mobilemoney/mobilemoney.router');
const logger  = require('../config/logger');

// ─── LOGIN ADMIN ──────────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(422).json({ error: 'email et password requis' });

  try {
    const result = await query(
      'SELECT * FROM admin_users WHERE email = $1 AND is_active = TRUE LIMIT 1',
      [email.toLowerCase().trim()]
    );
    if (!result.rows.length) return res.status(401).json({ error: 'Identifiants incorrects' });

    const admin = result.rows[0];
    const ok    = await bcrypt.compare(password, admin.password_hash);
    if (!ok) return res.status(401).json({ error: 'Identifiants incorrects' });

    await query('UPDATE admin_users SET last_login_at = NOW() WHERE admin_id = $1', [admin.admin_id]);

    const accessToken  = signToken({ sub: admin.admin_id, email: admin.email, role: admin.role, type: 'admin' }, '8h');
    const refreshToken = signToken({ sub: admin.admin_id, type: 'admin_refresh' }, '7d');

    res.json({
      access_token: accessToken, refresh_token: refreshToken,
      admin: { adminId: admin.admin_id, email: admin.email, firstName: admin.first_name, lastName: admin.last_name, role: admin.role },
    });
  } catch (err) {
    logger.error('Admin login error', { err: err.message });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── API CONFIGURATIONS ───────────────────────────────────────────

// GET toutes les configs
router.get('/api-configs', adminAuth, async (req, res) => {
  const { country, type, status } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (country) { params.push(country); where += ` AND country = $${params.length}`; }
  if (type)    { params.push(type);    where += ` AND provider_type = $${params.length}`; }
  if (status)  { params.push(status);  where += ` AND status = $${params.length}`; }

  const result = await query(
    `SELECT config_id, provider_key, provider_type, display_name, country,
            base_url, status, last_tested_at, last_test_ok, last_error, notes,
            -- Masquer les secrets
            CASE WHEN api_key IS NOT NULL THEN '***' || RIGHT(api_key, 4) ELSE NULL END AS api_key_masked,
            CASE WHEN api_secret IS NOT NULL THEN 'configured' ELSE NULL END AS api_secret_status,
            extra_params, created_at, updated_at
     FROM api_configurations ${where}
     ORDER BY provider_type, country, provider_key`,
    params
  );
  res.json({ data: result.rows, total: result.rows.length });
});

// GET une config (avec les vraies valeurs pour l'admin super)
router.get('/api-configs/:id', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const result = await query(
    'SELECT * FROM api_configurations WHERE config_id = $1',
    [req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Configuration introuvable' });

  const config = result.rows[0];
  // Masquer les secrets sauf pour super_admin
  if (req.user.role !== 'super_admin') {
    config.api_key    = config.api_key    ? '***' + config.api_key.slice(-4)    : null;
    config.api_secret = config.api_secret ? '[hidden]' : null;
  }
  res.json(config);
});

// PUT créer ou mettre à jour une config
router.put('/api-configs/:key', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const { key } = req.params;
  const { baseUrl, apiKey, apiSecret, extraParams, notes, status } = req.body;

  try {
    // Lire les anciennes valeurs pour l'audit
    const old = await query('SELECT * FROM api_configurations WHERE provider_key = $1', [key]);

    const result = await query(
      `UPDATE api_configurations
       SET base_url    = COALESCE($1, base_url),
           api_key     = COALESCE($2, api_key),
           api_secret  = COALESCE($3, api_secret),
           extra_params = COALESCE($4::jsonb, extra_params),
           notes       = COALESCE($5, notes),
           status      = COALESCE($6::api_status, status),
           updated_by  = $7,
           updated_at  = NOW()
       WHERE provider_key = $8
       RETURNING config_id, provider_key, display_name, status, updated_at`,
      [baseUrl||null, apiKey||null, apiSecret||null,
       extraParams ? JSON.stringify(extraParams) : null,
       notes||null, status||null, req.user.sub, key]
    );

    if (!result.rows.length) return res.status(404).json({ error: 'Provider non trouvé' });

    // Invalider le cache MM
    invalidateCache();

    // Audit log
    await query(
      `INSERT INTO audit_logs (actor_id, actor_type, actor_email, action, entity_type, entity_id, old_values, new_values, ip_address)
       VALUES ($1,'admin',$2,'API_CONFIG_UPDATE','api_config',$3,$4,$5,$6)`,
      [req.user.sub, req.user.email, result.rows[0].config_id,
       JSON.stringify({ status: old.rows[0]?.status }),
       JSON.stringify({ baseUrl: !!baseUrl, apiKey: !!apiKey, apiSecret: !!apiSecret, status }),
       req.socket?.remoteAddress || req.ip]
    );

    res.json({ success: true, config: result.rows[0] });
  } catch (err) {
    logger.error('API config update error', { err: err.message });
    res.status(500).json({ error: 'Erreur mise à jour' });
  }
});

// POST tester une connexion API
router.post('/api-configs/:key/test', adminAuth, async (req, res) => {
  const { key } = req.params;

  const cfgRow = await query(
    'SELECT * FROM api_configurations WHERE provider_key = $1', [key]
  );
  if (!cfgRow.rows.length) return res.status(404).json({ error: 'Provider non trouvé' });

  let testResult = { ok: false, reason: 'Test non implémenté pour ce provider' };

  try {
    const cfg = cfgRow.rows[0];
    if (cfg.provider_type === 'mobile_money') {
      const { testProvider } = require('../services/mobilemoney/mobilemoney.router');
      testResult = await testProvider(key);
    } else if (cfg.provider_type === 'card_gateway') {
      const GW_PING = {
        cybersource: () => require('../services/gateways/cybersource.gateway').ping,
        mpgs:        () => require('../services/gateways/mpgs.gateway').ping,
        stripe:      () => require('../services/gateways/stripe.gateway').ping,
        migs:        () => require('../services/gateways/migs.gateway').ping,
      };
      const pingFn = GW_PING[key]?.();
      if (pingFn) testResult = await pingFn();
    }
  } catch (err) {
    testResult = { ok: false, reason: err.message };
  }

  // Enregistrer le résultat du test
  await query(
    `UPDATE api_configurations
     SET last_tested_at = NOW(), last_test_ok = $1, last_error = $2,
         status = CASE WHEN $1 THEN 'active'::api_status ELSE status END
     WHERE provider_key = $3`,
    [testResult.ok, testResult.ok ? null : testResult.reason, key]
  );

  res.json({ provider: key, ...testResult, testedAt: new Date().toISOString() });
});

// ─── GESTION MARCHANDS ────────────────────────────────────────────

router.get('/merchants', adminAuth, async (req, res) => {
  const { page = 1, limit = 20, search, status, country } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const params = [];
  let where = 'WHERE 1=1';
  if (search) { params.push(`%${search}%`); where += ` AND (m.business_name ILIKE $${params.length} OR m.email ILIKE $${params.length} OR m.phone ILIKE $${params.length})`; }
  if (status)  { params.push(status);  where += ` AND m.merchant_status = $${params.length}`; }
  if (country) { params.push(country); where += ` AND m.country = $${params.length}`; }

  params.push(parseInt(limit), offset);
  const [data, count] = await Promise.all([
    query(
      `SELECT m.*, COUNT(t.transaction_id) as txn_count, COALESCE(SUM(t.amount),0) as total_volume
       FROM merchants m LEFT JOIN transactions t ON m.merchant_id = t.merchant_id
       ${where} GROUP BY m.merchant_id ORDER BY m.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    ),
    query(`SELECT COUNT(*) FROM merchants m ${where}`, params.slice(0, -2)),
  ]);

  res.json({
    data: data.rows, total: parseInt(count.rows[0].count),
    page: parseInt(page), limit: parseInt(limit),
    pages: Math.ceil(count.rows[0].count / parseInt(limit)),
  });
});

router.get('/merchants/:id', adminAuth, async (req, res) => {
  const result = await query(
    `SELECT m.*,
       (SELECT COUNT(*) FROM transactions WHERE merchant_id = m.merchant_id) as total_txn,
       (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE merchant_id = m.merchant_id AND status='authorized') as total_volume,
       (SELECT COUNT(*) FROM terminals WHERE merchant_id = m.merchant_id) as terminal_count
     FROM merchants m WHERE m.merchant_id = $1`,
    [req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Marchand introuvable' });
  res.json(result.rows[0]);
});

// Changer le statut d'un marchand (suspend, activate)
router.patch('/merchants/:id/status', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const { status, reason } = req.body;
  if (!['active','suspended','closed'].includes(status)) {
    return res.status(400).json({ error: 'Statut invalide' });
  }

  const old = await query('SELECT merchant_status FROM merchants WHERE merchant_id = $1', [req.params.id]);
  if (!old.rows.length) return res.status(404).json({ error: 'Marchand introuvable' });

  await query(
    'UPDATE merchants SET merchant_status = $1, updated_at = NOW() WHERE merchant_id = $2',
    [status, req.params.id]
  );

  await query(
    `INSERT INTO audit_logs (actor_id, actor_type, actor_email, action, entity_type, entity_id, old_values, new_values, ip_address)
     VALUES ($1,'admin',$2,'MERCHANT_STATUS_CHANGE','merchant',$3,$4,$5,$6)`,
    [req.user.sub, req.user.email, req.params.id,
     JSON.stringify({ status: old.rows[0].merchant_status }),
     JSON.stringify({ status, reason }),
     req.ip]
  );

  res.json({ success: true, merchantId: req.params.id, newStatus: status });
});

// Mettre à jour le niveau KYB
router.patch('/merchants/:id/kyb', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const { kybLevel, kybStatus } = req.body;
  await query(
    'UPDATE merchants SET kyb_level = COALESCE($1, kyb_level), kyb_status = COALESCE($2::kyb_status, kyb_status), updated_at = NOW() WHERE merchant_id = $3',
    [kybLevel, kybStatus, req.params.id]
  );
  res.json({ success: true });
});

// ─── MONITORING ACTIVITÉ ──────────────────────────────────────────

router.get('/activity/live', adminAuth, async (req, res) => {
  // Transactions des 24 dernières heures
  const result = await query(
    `SELECT t.transaction_id, t.type, t.amount, t.currency, t.payment_method,
            t.status, t.detected_operator, t.detected_network, t.detected_country,
            t.initiated_at, t.completed_at, m.business_name, m.country
     FROM transactions t
     JOIN merchants m ON t.merchant_id = m.merchant_id
     WHERE t.initiated_at > NOW() - INTERVAL '24 hours'
     ORDER BY t.initiated_at DESC LIMIT 100`,
    []
  );
  res.json({ data: result.rows, timestamp: new Date().toISOString() });
});

router.get('/stats/global', adminAuth, async (req, res) => {
  const [today, merchants, operators, gateways] = await Promise.all([
    query(`SELECT
      COUNT(*) FILTER (WHERE status='authorized')::int as approved,
      COUNT(*) FILTER (WHERE status='failed')::int as failed,
      COUNT(*)::int as total,
      COALESCE(SUM(amount) FILTER (WHERE status='authorized'),0) as volume
      FROM transactions WHERE DATE(initiated_at) = CURRENT_DATE`),
    query(`SELECT COUNT(*)::int as total, COUNT(*) FILTER (WHERE merchant_status='active')::int as active FROM merchants`),
    query(`SELECT detected_operator as operator, COUNT(*)::int as count
      FROM transactions WHERE initiated_at > NOW() - INTERVAL '7 days' AND detected_operator IS NOT NULL
      GROUP BY detected_operator ORDER BY count DESC LIMIT 10`),
    query(`SELECT gateway_name as gateway, COUNT(*)::int as count
      FROM transactions WHERE initiated_at > NOW() - INTERVAL '7 days' AND gateway_name IS NOT NULL
      GROUP BY gateway_name ORDER BY count DESC`),
  ]);

  res.json({
    today:         today.rows[0],
    merchants:     merchants.rows[0],
    topOperators:  operators.rows,
    gateways:      gateways.rows,
    timestamp:     new Date().toISOString(),
  });
});

// ─── GESTION TERMINAUX (tous marchands) ───────────────────────────

router.get('/terminals', adminAuth, async (req, res) => {
  const { merchantId, status } = req.query;
  let where = 'WHERE 1=1';
  const params = [];
  if (merchantId) { params.push(merchantId); where += ` AND t.merchant_id = $${params.length}`; }
  if (status)     { params.push(status);     where += ` AND t.status = $${params.length}`; }

  const result = await query(
    `SELECT t.*, m.business_name FROM terminals t JOIN merchants m ON t.merchant_id = m.merchant_id
     ${where} ORDER BY t.created_at DESC LIMIT 100`,
    params
  );
  res.json({ data: result.rows });
});

router.patch('/terminals/:id/status', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const { status } = req.body;
  if (!['active','inactive','blocked'].includes(status)) return res.status(400).json({ error: 'Statut invalide' });
  await query('UPDATE terminals SET status = $1, updated_at = NOW() WHERE terminal_id = $2', [status, req.params.id]);
  res.json({ success: true });
});

// ─── AUDIT LOGS ───────────────────────────────────────────────────

router.get('/audit-logs', requireRole('super_admin'), async (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const result = await query(
    `SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [parseInt(limit), offset]
  );
  res.json({ data: result.rows });
});

module.exports = router;
