/**
 * Routes Marchands — CPlus 2.0 (portail web)
 * Toutes les routes nécessitent merchantAuth
 */
'use strict';

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');
const { query } = require('../config/database');
const { merchantAuth, signToken } = require('../middleware/auth');
const logger  = require('../config/logger');
const { detectFromPhone } = require('../services/detection/detection.engine');

// ─── LOGIN MARCHAND ───────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  const { emailOrPhone, password } = req.body;
  if (!emailOrPhone || !password) return res.status(422).json({ error: 'Identifiants requis' });

  try {
    const result = await query(
      `SELECT u.*, m.merchant_id, m.business_name, m.currency, m.kyb_level,
              m.merchant_status, m.country
       FROM merchant_users u
       JOIN merchants m ON u.merchant_id = m.merchant_id
       WHERE (u.email = $1 OR u.phone = $1) AND u.is_active = TRUE LIMIT 1`,
      [emailOrPhone.trim()]
    );

    if (!result.rows.length) return res.status(401).json({ error: 'Identifiants incorrects' });

    const user = result.rows[0];
    const ok   = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Identifiants incorrects' });

    if (user.merchant_status === 'suspended') {
      return res.status(403).json({ error: 'Compte suspendu — contactez le support', code: 'SUSPENDED' });
    }

    // NE PAS vérifier les APIs ici — juste l'utilisateur en DB
    const accessToken  = signToken({
      sub: user.user_id, merchantId: user.merchant_id,
      role: user.role, type: 'merchant',
    }, '8h');
    const refreshToken = signToken({ sub: user.user_id, type: 'merchant_refresh' }, '30d');

    res.json({
      access_token: accessToken, refresh_token: refreshToken,
      user: {
        userId: user.user_id, firstName: user.first_name, lastName: user.last_name,
        email: user.email, role: user.role,
        merchantId: user.merchant_id, businessName: user.business_name,
        currency: user.currency, country: user.country, kybLevel: user.kyb_level,
      },
    });
  } catch (err) {
    logger.error('Merchant login error', { err: err.message });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ─── PROFIL COMPTE ────────────────────────────────────────────────
router.get('/account', merchantAuth, async (req, res) => {
  const result = await query(
    `SELECT m.*, u.email, u.first_name, u.last_name, u.phone, u.role
     FROM merchants m
     JOIN merchant_users u ON m.merchant_id = u.merchant_id AND u.user_id = $1
     WHERE m.merchant_id = $2`,
    [req.user.sub, req.user.merchantId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Compte introuvable' });
  const row = result.rows[0];
  // Ne jamais retourner le password_hash
  delete row.password_hash;
  res.json(row);
});

router.put('/account', merchantAuth, async (req, res) => {
  const { firstName, lastName, phone, settlementType, settlementAccount, settlementProvider } = req.body;
  await query(
    `UPDATE merchant_users SET first_name = COALESCE($1, first_name), last_name = COALESCE($2, last_name),
     phone = COALESCE($3, phone) WHERE user_id = $4`,
    [firstName, lastName, phone, req.user.sub]
  );
  if (settlementType || settlementAccount || settlementProvider) {
    await query(
      `UPDATE merchants SET settlement_type = COALESCE($1::settlement_type, settlement_type),
       settlement_account = COALESCE($2, settlement_account),
       settlement_provider = COALESCE($3, settlement_provider), updated_at = NOW()
       WHERE merchant_id = $4`,
      [settlementType, settlementAccount, settlementProvider, req.user.merchantId]
    );
  }
  res.json({ success: true });
});

// ─── HISTORIQUE TRANSACTIONS ──────────────────────────────────────
router.get('/transactions', merchantAuth, async (req, res) => {
  const { page = 1, limit = 25, status, type, dateFrom, dateTo } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const params = [req.user.merchantId];
  let where = 'WHERE merchant_id = $1';
  if (status)   { params.push(status);   where += ` AND status = $${params.length}`; }
  if (type)     { params.push(type);     where += ` AND type = $${params.length}`; }
  if (dateFrom) { params.push(dateFrom); where += ` AND initiated_at >= $${params.length}`; }
  if (dateTo)   { params.push(dateTo);   where += ` AND initiated_at <= $${params.length}`; }

  params.push(parseInt(limit), offset);
  const [data, count] = await Promise.all([
    query(
      `SELECT transaction_id, type, amount, currency, payment_method, status,
              description, auth_code, fee_amount, net_amount,
              initiated_at, completed_at
       FROM transactions ${where}
       ORDER BY initiated_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    ),
    query(`SELECT COUNT(*) FROM transactions ${where}`, params.slice(0, -2)),
  ]);

  res.json({
    data: data.rows, total: parseInt(count.rows[0].count),
    page: parseInt(page), pages: Math.ceil(count.rows[0].count / parseInt(limit)),
  });
});

router.get('/transactions/:id', merchantAuth, async (req, res) => {
  const result = await query(
    `SELECT * FROM transactions WHERE transaction_id = $1 AND merchant_id = $2`,
    [req.params.id, req.user.merchantId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Transaction introuvable' });
  res.json(result.rows[0]);
});

// ─── TERMINAUX (self-service) ─────────────────────────────────────
router.get('/terminals', merchantAuth, async (req, res) => {
  const result = await query(
    'SELECT * FROM terminals WHERE merchant_id = $1 ORDER BY created_at DESC',
    [req.user.merchantId]
  );
  res.json({ data: result.rows });
});

// Créer un nouveau terminal
router.post('/terminals', merchantAuth, async (req, res) => {
  const { terminalName, deviceModel, androidId, appVersion } = req.body;
  if (!terminalName) return res.status(422).json({ error: 'terminalName requis' });

  try {
    // Générer un code unique
    const terminalCode = `TERM-${req.user.merchantId.slice(0, 6).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    const result = await query(
      `INSERT INTO terminals (merchant_id, terminal_code, terminal_name, device_model, android_id, app_version, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [req.user.merchantId, terminalCode, terminalName, deviceModel||null, androidId||null, appVersion||null, req.user.sub]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ce terminal est déjà enregistré' });
    res.status(500).json({ error: 'Erreur création terminal' });
  }
});

// Mettre à jour un terminal
router.put('/terminals/:id', merchantAuth, async (req, res) => {
  const { terminalName, deviceModel, appVersion } = req.body;
  const result = await query(
    `UPDATE terminals SET terminal_name = COALESCE($1, terminal_name),
     device_model = COALESCE($2, device_model),
     app_version  = COALESCE($3, app_version), updated_at = NOW()
     WHERE terminal_id = $4 AND merchant_id = $5 RETURNING *`,
    [terminalName, deviceModel, appVersion, req.params.id, req.user.merchantId]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Terminal introuvable' });
  res.json(result.rows[0]);
});

// Désactiver un terminal (soft delete)
router.delete('/terminals/:id', merchantAuth, async (req, res) => {
  await query(
    `UPDATE terminals SET status = 'inactive', updated_at = NOW()
     WHERE terminal_id = $1 AND merchant_id = $2`,
    [req.params.id, req.user.merchantId]
  );
  res.json({ success: true });
});

// Heartbeat depuis l'app Android
router.post('/terminals/:id/heartbeat', merchantAuth, async (req, res) => {
  const { appVersion, androidId } = req.body;
  await query(
    `UPDATE terminals SET last_seen_at = NOW(), last_ip = $1,
     app_version = COALESCE($2, app_version),
     android_id  = COALESCE($3, android_id)
     WHERE terminal_id = $4 AND merchant_id = $5`,
    [req.ip, appVersion||null, androidId||null, req.params.id, req.user.merchantId]
  );
  res.json({ ok: true });
});

// ─── RÈGLEMENTS ────────────────────────────────────────────────────
router.get('/settlements', merchantAuth, async (req, res) => {
  const result = await query(
    `SELECT batch_id, batch_date, total_gross, total_fees, total_net,
            currency, txn_count, settlement_type, status, created_at
     FROM settlement_batches WHERE merchant_id = $1
     ORDER BY batch_date DESC LIMIT 50`,
    [req.user.merchantId]
  );
  res.json({ data: result.rows });
});

// ─── DASHBOARD ────────────────────────────────────────────────────
router.get('/dashboard', merchantAuth, async (req, res) => {
  const [today, month, terminals] = await Promise.all([
    query(
      `SELECT COUNT(*)::int as txn_count, COALESCE(SUM(amount),0) as volume
       FROM transactions WHERE merchant_id = $1 AND DATE(initiated_at) = CURRENT_DATE AND status = 'authorized'`,
      [req.user.merchantId]
    ),
    query(
      `SELECT COUNT(*)::int as txn_count, COALESCE(SUM(amount),0) as volume
       FROM transactions WHERE merchant_id = $1 AND DATE_TRUNC('month', initiated_at) = DATE_TRUNC('month', NOW()) AND status = 'authorized'`,
      [req.user.merchantId]
    ),
    query('SELECT COUNT(*)::int as count FROM terminals WHERE merchant_id = $1 AND status = \'active\'', [req.user.merchantId]),
  ]);

  const settling = await query(
    `SELECT COALESCE(SUM(sq.amount),0) as amount
     FROM settlement_queue sq WHERE sq.merchant_id = $1 AND sq.settled = FALSE`,
    [req.user.merchantId]
  );

  res.json({
    today:          today.rows[0],
    thisMonth:      month.rows[0],
    activeTerminals: terminals.rows[0].count,
    settlingTomorrow: parseFloat(settling.rows[0].amount),
  });
});

module.exports = router;
