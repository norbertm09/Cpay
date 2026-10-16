/**
 * Routes Admin — CPlus 2.6.0
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
const { query, withTransaction } = require('../config/database');
// WAVE-2 : module d'auth unique (audit §1.1)
const {
  adminAuth, requireRole, issueSession, rotateRefresh, revokeRefreshToken, revokeAll,
  readRefreshToken, clearRefreshCookie, signMfaToken, verifyMfaToken, verifyTotp, buildTotpEnrollment,
  generateTempPassword,
} = require('../middleware/auth');
// Chiffrement des secrets operateurs a l'ecriture (audit §2.12) — module
// fourni par la wave-2 paiements (config/secrets.js). Fail-closed : sans lui,
// PUT /api-configs refuse d'ecrire un secret en clair (503).
let encryptConfigPatch = null;
try { ({ encryptConfigPatch } = require('../config/secrets')); } catch (e) { encryptConfigPatch = null; }
const { invalidateCache } = require('../services/mobilemoney/mobilemoney.router');
const { detectFromPhone } = require('../services/detection/detection.engine');
const { assignMerchantCountryDefaults, getCountryDefaults, normalizeCountry } = require('../services/config/country-defaults');
const logger  = require('../config/logger');
const ticketing = require('../services/support/ticketing.service');
const integrations = require('../services/integrations/integration.service');
const pilotControl = require('../services/pilot/pilot-control.service');

// ═══════════════════════════════════════════════════════════════════
// HOTFIX WAVE-1 (audit prod 2.6.0) — helpers
// ═══════════════════════════════════════════════════════════════════

// Pagination bornee : page >= 1, 1 <= limit <= 100 (audit §3.12)
const parsePagination = (q = {}, defaultLimit = 25) => {
  let page = parseInt(q.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  let limit = parseInt(q.limit, 10);
  if (!Number.isFinite(limit)) limit = defaultLimit;
  limit = Math.min(100, Math.max(1, limit));
  return { page, limit, offset: (page - 1) * limit };
};

// Masquage d'un secret : { configured, last4 } — jamais la valeur (audit §2.12)
const maskSecret = (v) => {
  if (v === undefined || v === null || v === '') return { configured: false };
  const s = String(v);
  return { configured: true, last4: s.length >= 8 ? s.slice(-4) : '****' };
};
const NOTIF_SECRET_FIELDS = ['smtp_pass', 'wa_token', 'smpp_pass', 'wa_verify_token'];

// ═══════════════════════════════════════════════════════════════════
// WAVE-2 — AUTH ADMIN (sessions unifiees, 2FA, hygiene mots de passe)
// ═══════════════════════════════════════════════════════════════════

// Colonnes explicites : jamais password_hash / mfa_secret dans une reponse (audit §2.12)
const ADMIN_COLS = `admin_id, email, first_name, last_name, role, is_active, mfa_enabled, temp_password,
                    failed_attempts, locked_until, last_login_at, created_at`;

const adminClaims  = (admin) => ({ type: 'admin', email: admin.email, role: admin.role });
const adminProfile = (admin) => ({
  adminId: admin.admin_id, email: admin.email, firstName: admin.first_name, lastName: admin.last_name,
  role: admin.role, mfaEnabled: !!admin.mfa_enabled,
});

// Refresh admin : 7 jours (comportement conserve), cookie cp_rt_admin.
// refresh_token reste dans le JSON tant que le portail admin n'est pas migre.
const adminSessionResponse = async ({ req, res, admin }) => {
  const session = await issueSession({ actorType: 'admin', actorId: admin.admin_id, claims: adminClaims(admin), req, res, refreshTtlDays: 7 });
  res.json({ ...session, mustChangePassword: !!admin.temp_password, admin: adminProfile(admin) });
};

// ─── LOGIN ADMIN ──────────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(422).json({ error: 'email et password requis' });

  try {
    const result = await query(
      `SELECT ${ADMIN_COLS}, password_hash, mfa_secret FROM admin_users WHERE email = $1 AND is_active = TRUE LIMIT 1`,
      [email.toLowerCase().trim()]
    );
    if (!result.rows.length) return res.status(401).json({ error: 'Identifiants incorrects' });

    const admin = result.rows[0];
    if (admin.locked_until && new Date(admin.locked_until) > new Date()) {
      return res.status(423).json({ error: 'Compte temporairement verrouille', lockedUntil: admin.locked_until });
    }
    const ok = await bcrypt.compare(password, admin.password_hash);
    if (!ok) {
      const attempts = (admin.failed_attempts || 0) + 1;
      const lockUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await query('UPDATE admin_users SET failed_attempts=$1, locked_until=$2 WHERE admin_id=$3', [attempts, lockUntil, admin.admin_id]).catch(() => {});
      return res.status(401).json({ error: 'Identifiants incorrects', attemptsLeft: Math.max(0, 5 - attempts) });
    }
    await query('UPDATE admin_users SET failed_attempts=0, locked_until=NULL, last_login_at = NOW() WHERE admin_id = $1', [admin.admin_id]).catch(() => {});

    // 2FA active : pas de session avant validation du code TOTP (audit §2.11)
    if (admin.mfa_enabled && admin.mfa_secret) {
      return res.json({ mfaRequired: true, mfaToken: signMfaToken({ actorType: 'admin', sub: admin.admin_id }) });
    }

    await adminSessionResponse({ req, res, admin });
  } catch (err) {
    logger.error('Admin login error', { err: err.message });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/auth/2fa/validate', async (req, res) => {
  const { mfaToken, code } = req.body;
  if (!mfaToken || !code) return res.status(422).json({ error: 'mfaToken et code requis' });
  try {
    let payload;
    try { payload = verifyMfaToken(mfaToken, 'admin'); }
    catch (e) { return res.status(401).json({ error: e.message, code: e.code }); }
    const r = await query(`SELECT ${ADMIN_COLS}, mfa_secret FROM admin_users WHERE admin_id = $1 AND is_active = TRUE LIMIT 1`, [payload.sub]);
    const admin = r.rows[0];
    if (!admin) return res.status(401).json({ error: 'Admin introuvable' });
    if (!admin.mfa_secret) return res.status(400).json({ error: '2FA non configurée' });
    if (!verifyTotp(admin.mfa_secret, code)) return res.status(401).json({ error: 'Code 2FA invalide', code: 'INVALID_TOTP' });
    await adminSessionResponse({ req, res, admin });
  } catch (err) {
    logger.error('Admin 2FA validate error', { err: err.message });
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Refresh : cookie HttpOnly cp_rt_admin en priorite, corps en repli (portail non migre)
router.post('/auth/refresh', async (req, res) => {
  const refreshToken = readRefreshToken(req, 'admin');
  if (!refreshToken) return res.status(422).json({ error: 'refreshToken requis' });

  try {
    const tokens = await rotateRefresh({
      actorType: 'admin', token: refreshToken, req, res, refreshTtlDays: 7,
      buildClaims: async ({ actorId }) => {
        const r = await query(`SELECT ${ADMIN_COLS} FROM admin_users WHERE admin_id = $1 AND is_active = TRUE LIMIT 1`, [actorId]);
        if (!r.rows.length) throw new Error('Admin introuvable');
        return adminClaims(r.rows[0]);
      },
    });
    res.json({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in });
  } catch (err) {
    res.status(err.statusCode || 401).json({ error: 'Refresh token invalide', code: err.code || 'INVALID_REFRESH' });
  }
});

router.post('/auth/logout', async (req, res) => {
  await revokeRefreshToken(readRefreshToken(req, 'admin'));
  clearRefreshCookie(res, 'admin');
  res.json({ success: true });
});

// Profil courant — sans secrets
router.get('/auth/me', adminAuth, async (req, res) => {
  try {
    const r = await query(`SELECT ${ADMIN_COLS} FROM admin_users WHERE admin_id = $1 LIMIT 1`, [req.user.sub]);
    if (!r.rows.length) return res.status(404).json({ error: 'Admin introuvable' });
    res.json({ admin: adminProfile(r.rows[0]), mustChangePassword: !!r.rows[0].temp_password });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// Changement de mot de passe : leve temp_password, revoque toutes les sessions
router.post('/auth/change-password', adminAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(422).json({ error: 'currentPassword et newPassword requis' });
  if (newPassword.length < 10) return res.status(422).json({ error: 'Minimum 10 caracteres', code: 'WEAK_PASSWORD' });
  try {
    const u = await query('SELECT password_hash FROM admin_users WHERE admin_id = $1', [req.user.sub]);
    if (!u.rows[0]) return res.status(404).json({ error: 'Admin introuvable' });
    const ok = await bcrypt.compare(currentPassword, u.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    const hash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE admin_users SET password_hash=$1, temp_password=FALSE, updated_at=NOW() WHERE admin_id=$2', [hash, req.user.sub]);
    await revokeAll('admin', req.user.sub);
    clearRefreshCookie(res, 'admin');
    res.json({ success: true, message: 'Mot de passe modifie', sessionsRevoked: true });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ─── 2FA ADMIN (TOTP, audit §2.11) ────────────────────────────────
router.get('/auth/2fa/status', adminAuth, async (req, res) => {
  try {
    const r = await query('SELECT mfa_enabled FROM admin_users WHERE admin_id = $1', [req.user.sub]);
    res.json({ mfaEnabled: !!r.rows[0]?.mfa_enabled });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/auth/2fa/setup', adminAuth, async (req, res) => {
  try {
    const u = await query('SELECT email FROM admin_users WHERE admin_id = $1', [req.user.sub]);
    const enrollment = await buildTotpEnrollment({ label: u.rows[0]?.email || req.user.email || String(req.user.sub), issuer: 'C-Pay Admin' });
    await query('UPDATE admin_users SET mfa_secret=$1, mfa_enabled=FALSE WHERE admin_id=$2', [enrollment.secret, req.user.sub]);
    res.json(enrollment);
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/auth/2fa/verify', adminAuth, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') return res.status(422).json({ error: 'Code requis' });
  try {
    const u = await query('SELECT mfa_secret FROM admin_users WHERE admin_id = $1', [req.user.sub]);
    if (!u.rows[0]?.mfa_secret) return res.status(400).json({ error: '2FA non configurée' });
    if (!verifyTotp(u.rows[0].mfa_secret, token)) return res.status(400).json({ error: 'Code invalide' });
    await query('UPDATE admin_users SET mfa_enabled=TRUE WHERE admin_id=$1', [req.user.sub]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

router.post('/auth/2fa/disable', adminAuth, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') return res.status(422).json({ error: 'Code requis' });
  try {
    const u = await query('SELECT mfa_secret FROM admin_users WHERE admin_id = $1', [req.user.sub]);
    if (!u.rows[0]?.mfa_secret) return res.status(400).json({ error: '2FA non configurée' });
    if (!verifyTotp(u.rows[0].mfa_secret, token)) return res.status(400).json({ error: 'Code invalide' });
    await query('UPDATE admin_users SET mfa_enabled=FALSE, mfa_secret=NULL WHERE admin_id=$1', [req.user.sub]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ─── API CONFIGURATIONS ───────────────────────────────────────────

// GET toutes les configs
// Statut des variables ENV par provider
router.get('/api-configs/env-status', adminAuth, async (req, res) => {
  const env = process.env;
  const status = {
    mtn_momo_cg: {
      configured: !!(env.MTN_CG_COLL_API_USER && env.MTN_CG_COLL_SUB_KEY_PRIMARY),
      env: env.MTN_CG_ENV || 'sandbox',
      coll: { user: !!env.MTN_CG_COLL_API_USER, key: !!env.MTN_CG_COLL_API_KEY, sub_primary: !!env.MTN_CG_COLL_SUB_KEY_PRIMARY, sub_secondary: !!env.MTN_CG_COLL_SUB_KEY_SECONDARY },
      disb: { user: !!env.MTN_CG_DISB_API_USER, key: !!env.MTN_CG_DISB_API_KEY, sub_primary: !!env.MTN_CG_DISB_SUB_KEY_PRIMARY, sub_secondary: !!env.MTN_CG_DISB_SUB_KEY_SECONDARY }
    },
    airtel_money_cg: {
      configured: !!(env.AIRTEL_CG_COLL_CLIENT_ID && env.AIRTEL_CG_COLL_CLIENT_SECRET),
      env: env.AIRTEL_CG_ENV || 'sandbox',
      coll: { client_id: !!env.AIRTEL_CG_COLL_CLIENT_ID, client_secret: !!env.AIRTEL_CG_COLL_CLIENT_SECRET },
      disb: { client_id: !!env.AIRTEL_CG_DISB_CLIENT_ID, client_secret: !!env.AIRTEL_CG_DISB_CLIENT_SECRET }
    },
    cybersource: {
      configured: !!(env.CYBERSOURCE_MERCHANT_ID && env.CYBERSOURCE_API_KEY_ID && env.CYBERSOURCE_SHARED_SECRET),
      env: env.CYBERSOURCE_ENV || 'sandbox',
      merchant_id: !!env.CYBERSOURCE_MERCHANT_ID, key_id: !!env.CYBERSOURCE_API_KEY_ID, secret: !!env.CYBERSOURCE_SHARED_SECRET
    },
    migs: {
      configured: !!(env.MIGS_MERCHANT_ID && env.MIGS_ACCESS_CODE),
      env: env.MIGS_ENV || 'sandbox',
      merchant_id: !!env.MIGS_MERCHANT_ID, access_code: !!env.MIGS_ACCESS_CODE, secure_hash: !!env.MIGS_SECURE_HASH
    },
    smpp: {
      configured: !!(env.SMPP_HOST && env.SMPP_USER && env.SMPP_PASS),
      host: env.SMPP_HOST, port: env.SMPP_PORT, env: env.SMPP_ENV || 'production'
    },
    smtp: {
      configured: !!(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS),
      host: env.SMTP_HOST, port: env.SMTP_PORT, env: 'production'
    },
    whatsapp: {
      configured: !!(env.WA_NOTIF_TOKEN && env.WA_NOTIF_PHONE_ID),
      env: env.WA_ENV || 'production'
    }
  };
  res.json(status);
});

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

// GET une config — HOTFIX (audit §2.12) : les secrets sont masques pour TOUS les
// roles, super_admin inclus. Ils ne sont modifiables que par PUT, jamais relus.
router.get('/api-configs/:id', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const result = await query(
    'SELECT * FROM api_configurations WHERE config_id = $1',
    [req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: 'Configuration introuvable' });

  const { api_key, api_secret, extra_params, ...config } = result.rows[0];
  config.api_key    = maskSecret(api_key);
  config.api_secret = maskSecret(api_secret);
  // extra_params peut contenir des secrets (tokens, mots de passe) : masques aussi
  config.extra_params = {};
  for (const [k, v] of Object.entries(extra_params || {})) {
    config.extra_params[k] = /secret|pass|token|key|pin|private/i.test(k) ? maskSecret(v) : v;
  }
  res.json(config);
});

// PUT créer ou mettre à jour une config
router.put('/api-configs/:key', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const { key } = req.params;
  const { baseUrl, apiKey, apiSecret, extraParams, notes, status } = req.body;

  try {
    // WAVE-2 (audit §2.12) : les secrets operateurs sont chiffres a l'ecriture
    // (config/secrets.encryptConfigPatch). Sans module de chiffrement, on
    // refuse d'ecrire un secret en clair.
    let patch = { apiKey: apiKey || null, apiSecret: apiSecret || null, extraParams: extraParams || null };
    if (apiKey || apiSecret || extraParams) {
      if (typeof encryptConfigPatch !== 'function') {
        return res.status(503).json({ error: 'Chiffrement des secrets indisponible', code: 'SECRETS_UNAVAILABLE' });
      }
      const enc = await encryptConfigPatch({ apiKey: apiKey || null, apiSecret: apiSecret || null, extraParams: extraParams || null });
      patch = {
        apiKey:      apiKey      ? enc.apiKey      : null,
        apiSecret:   apiSecret   ? enc.apiSecret   : null,
        extraParams: extraParams ? enc.extraParams : null,
      };
    }

    // Lire les anciennes valeurs pour l'audit
    const old = await query('SELECT status FROM api_configurations WHERE provider_key = $1', [key]);

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
      [baseUrl||null, patch.apiKey, patch.apiSecret,
       patch.extraParams ? (typeof patch.extraParams === 'string' ? patch.extraParams : JSON.stringify(patch.extraParams)) : null,
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
        visa_direct: () => async () => ({ ok: !!process.env.VISA_BASE_URL, reason: 'Visa Direct configured through /api/v1/rails/visa-direct/*' }),
        visa_account_wallet: () => async () => {
          const svc = require('../services/rails/visa-direct.service');
          await svc.getAccountBalance({});
          return { ok: true };
        },
        mastercard_developers: () => async () => {
          const svc = require('../services/rails/mastercard-developers.service');
          await svc.getServices({ limit: 1 });
          return { ok: true };
        },
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

router.get('/country-defaults', adminAuth, async (req, res) => {
  const result = await query(
    `SELECT country, currency, mobile_money_providers, default_card_gateway, updated_at
     FROM country_payment_defaults
     ORDER BY country`
  );
  res.json({ data: result.rows, total: result.rows.length });
});

router.post('/merchants', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const {
    businessName, rccm, nif, phone, email, password,
    country, currency, settlementType = 'mobile_money', settlementAccount, settlementProvider,
  } = req.body;

  if (!businessName || !phone || !email) {
    return res.status(422).json({ error: 'businessName, phone et email requis' });
  }

  const detected = detectFromPhone(phone);
  const countryCode = normalizeCountry(country) || (detected.success ? detected.country : null);
  if (!countryCode) return res.status(422).json({ error: 'Pays requis ou telephone non reconnu', code: 'COUNTRY_REQUIRED' });

  const defaults = await getCountryDefaults(countryCode);
  if (!defaults) return res.status(422).json({ error: 'Pays non supporte pour les API Mobile Money', code: 'UNSUPPORTED_COUNTRY' });

  const temporaryPassword = password || crypto.randomBytes(18).toString('base64url');
  if (temporaryPassword.length < 10) {
    return res.status(422).json({ error: 'Mot de passe trop court', code: 'WEAK_PASSWORD' });
  }

  try {
    const created = await withTransaction(async (client) => {
      const passwordHash = await bcrypt.hash(temporaryPassword, 12);
      const merchant = await client.query(
        `INSERT INTO merchants
          (business_name, rccm, nif, phone, email, country, currency, settlement_type, settlement_account, settlement_provider)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING merchant_id, business_name, country, currency, kyb_level, merchant_status`,
        [
          businessName.trim(), rccm || null, nif || null, phone.trim(), email.toLowerCase().trim(),
          countryCode, currency || defaults.currency, settlementType, settlementAccount || phone.trim(),
          settlementProvider || detected.brand || defaults.mobile_money_providers[0],
        ]
      );
      const merchantRow = merchant.rows[0];
      // WAVE-2 (audit §2.13) : mot de passe temporaire => temp_password=TRUE,
      // le marchand doit le changer a la premiere connexion (mustChangePassword)
      const user = await client.query(
        `INSERT INTO merchant_users (merchant_id, email, phone, password_hash, first_name, role, temp_password)
         VALUES ($1,$2,$3,$4,$5,'owner',$6)
         RETURNING user_id, email, first_name, role`,
        [merchantRow.merchant_id, email.toLowerCase().trim(), phone.trim(), passwordHash, businessName.trim(), !password]
      );
      const apiDefaults = await assignMerchantCountryDefaults({
        merchantId: merchantRow.merchant_id,
        country: merchantRow.country,
        client,
      });
      return { merchant: merchantRow, user: user.rows[0], apiDefaults };
    });

    await query(
      `INSERT INTO audit_logs (actor_id, actor_type, actor_email, action, entity_type, entity_id, new_values, ip_address)
       VALUES ($1,'admin',$2,'MERCHANT_CREATE','merchant',$3,$4,$5)`,
      [
        req.user.sub, req.user.email, created.merchant.merchant_id,
        JSON.stringify({ country: created.merchant.country, providers: created.apiDefaults.assignedProviders }),
        req.ip,
      ]
    );

    res.status(201).json({
      merchant: created.merchant,
      user: created.user,
      apiDefaults: created.apiDefaults,
      temporaryPassword: password ? undefined : temporaryPassword,
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email ou telephone deja utilise' });
    logger.error('Admin merchant create error', { err: err.message });
    res.status(500).json({ error: 'Erreur creation marchand' });
  }
});

router.get('/merchants', adminAuth, async (req, res) => {
  const { search, status, country } = req.query;
  const { page, limit, offset } = parsePagination(req.query, 20);
  const params = [];
  let where = 'WHERE 1=1';
  if (search) { params.push(`%${search}%`); where += ` AND (m.business_name ILIKE $${params.length} OR m.email ILIKE $${params.length} OR m.phone ILIKE $${params.length})`; }
  if (status)  { params.push(status);  where += ` AND m.merchant_status = $${params.length}`; }
  if (country) { params.push(country); where += ` AND m.country = $${params.length}`; }

  params.push(limit, offset);
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
    page: page, limit: limit,
    pages: Math.ceil(count.rows[0].count / limit),
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
  const assignments = await query(
    `SELECT maa.provider_key, maa.provider_type, maa.is_default, ac.display_name, ac.status
     FROM merchant_api_assignments maa
     JOIN api_configurations ac ON ac.provider_key = maa.provider_key
     WHERE maa.merchant_id = $1
     ORDER BY maa.provider_type, maa.provider_key`,
    [req.params.id]
  );
  const fees = await query(`SELECT * FROM merchant_fee_configs WHERE merchant_id=$1 ORDER BY direction,payment_type`,[req.params.id]);
  res.json({ ...result.rows[0], fees: fees.rows, api_assignments: assignments.rows });
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
            t.settlement_status, t.settled_at,
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

// Route GET /support/tickets moved to line 1063

// Route GET /support/tickets/:id moved to line 1082

router.post('/support/tickets/:id/messages', adminAuth, async (req, res) => {
  try {
    const ticket = await ticketing.addMessage({
      ticketId: req.params.id,
      senderType: 'admin',
      senderId: req.user.sub,
      senderName: req.user.email,
      message: req.body.message,
      isInternal: req.body.isInternal === true,
    });
    res.status(201).json(ticket);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code || 'TICKET_MESSAGE_FAILED' });
  }
});

router.patch('/support/tickets/:id', requireRole('super_admin', 'ops_admin', 'support_admin'), async (req, res) => {
  try {
    const ticket = await ticketing.updateTicket({
      ticketId: req.params.id,
      status: req.body.status,
      priority: req.body.priority,
      assignedAdminId: req.body.assignedAdminId || req.user.sub,
    });
    if (!ticket) return res.status(404).json({ error: 'Ticket introuvable', code: 'TICKET_NOT_FOUND' });
    await query(
      `INSERT INTO audit_logs (actor_id, actor_type, actor_email, action, entity_type, entity_id, new_values, ip_address)
       VALUES ($1,'admin',$2,'SUPPORT_TICKET_UPDATE','support_ticket',$3,$4,$5)`,
      [req.user.sub, req.user.email, req.params.id, JSON.stringify(req.body), req.ip]
    );
    res.json(ticket);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message, code: err.code || 'TICKET_UPDATE_FAILED' });
  }
});

router.get('/audit-logs', requireRole('super_admin'), async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query, 50);
  const result = await query(
    `SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  res.json({ data: result.rows });
});

router.get('/integrations/merchant/:merchantId', adminAuth, async (req, res) => {
  res.json({ data: await integrations.listIntegrations(req.params.merchantId) });
});

router.post('/integrations/merchant/:merchantId/test-event', requireRole('super_admin', 'ops_admin', 'support_admin'), async (req, res) => {
  await integrations.deliverEvent({
    merchantId: req.params.merchantId,
    eventType: req.body.eventType || 'integration.test',
    payload: req.body.payload || { message: 'C-Pay test event' },
  });
  res.json({ success: true });
});

// Pilot control production
router.get('/pilot/programs', adminAuth, async (req, res) => {
  res.json({ data: await pilotControl.listPrograms(), mode: pilotControl.getMode() });
});

router.post('/pilot/programs', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  if (!req.body.pilotKey || !req.body.name) {
    return res.status(422).json({ error: 'pilotKey et name requis', code: 'PILOT_PROGRAM_INVALID' });
  }
  const program = await pilotControl.upsertProgram({
    pilotKey: req.body.pilotKey,
    name: req.body.name,
    targetVersion: req.body.targetVersion || '2.3',
    status: req.body.status,
    countryScope: req.body.countryScope,
    successMetrics: req.body.successMetrics,
    riskControls: req.body.riskControls,
    startAt: req.body.startAt,
    endAt: req.body.endAt,
    actorId: req.user.sub,
  });
  res.status(201).json(program);
});

router.post('/pilot/programs/:pilotKey/enroll', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  if (!req.body.merchantId) return res.status(422).json({ error: 'merchantId requis', code: 'MERCHANT_REQUIRED' });
  const enrollment = await pilotControl.enrollMerchant({
    pilotKey: req.params.pilotKey,
    merchantId: req.body.merchantId,
    status: req.body.status || 'active',
    rolloutPercent: req.body.rolloutPercent ?? 100,
    notes: req.body.notes,
    actorId: req.user.sub,
  });
  if (!enrollment) return res.status(404).json({ error: 'Programme pilote introuvable', code: 'PILOT_NOT_FOUND' });
  res.status(201).json(enrollment);
});

router.get('/pilot/features', adminAuth, async (req, res) => {
  res.json({ data: await pilotControl.listFeatureFlags(), mode: pilotControl.getMode() });
});

router.put('/pilot/features/:flagKey', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const flag = await pilotControl.upsertFeatureFlag({
    flagKey: req.params.flagKey,
    displayName: req.body.displayName,
    description: req.body.description,
    status: req.body.status,
    defaultEnabled: req.body.defaultEnabled,
    pilotOnly: req.body.pilotOnly,
    rolloutPercent: req.body.rolloutPercent,
    config: req.body.config,
  });
  res.json(flag);
});

router.put('/pilot/features/:flagKey/merchants/:merchantId', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const override = await pilotControl.setMerchantOverride({
    flagKey: req.params.flagKey,
    merchantId: req.params.merchantId,
    enabled: req.body.enabled,
    reason: req.body.reason,
    actorId: req.user.sub,
  });
  res.json(override);
});

router.get('/pilot/merchants/:merchantId', adminAuth, async (req, res) => {
  res.json(await pilotControl.getMerchantPilotState(req.params.merchantId));
});

router.post('/pilot/evaluate', adminAuth, async (req, res) => {
  if (!req.body.flagKey) return res.status(422).json({ error: 'flagKey requis', code: 'FLAG_REQUIRED' });
  res.json(await pilotControl.evaluateFeature({
    merchantId: req.body.merchantId,
    flagKey: req.body.flagKey,
    context: req.body.context || {},
    requestId: req.id,
  }));
});

router.get('/pilot/readiness', adminAuth, async (req, res) => {
  res.json(await pilotControl.listReadinessChecks());
});


// ═══════════════════════════════════════════════════════════════════
// SETTLEMENT — Retraits marchands a traiter
// ═══════════════════════════════════════════════════════════════════

router.get('/settlements', adminAuth, async (req, res) => {
  const status = req.query.status || 'pending_settlement';
  try {
    const r = await query(
      `SELECT mt.transfer_id, mt.reference, mt.amount, mt.fee, mt.net_amount,
              mt.status, mt.settlement_method, mt.created_at, mt.settled_at,
              mt.settlement_ref, mt.admin_note,
              m.business_name, m.email AS merchant_email,
              ba.account_number, ba.account_name,
              fi.name AS inst_name, fi.code AS inst_code, fi.country
       FROM merchant_transfers mt
       LEFT JOIN merchants m ON m.merchant_id = mt.merchant_id
       LEFT JOIN bank_accounts ba ON ba.account_id = mt.bank_account_id
       LEFT JOIN financial_institutions fi ON fi.institution_id = ba.institution_id
       WHERE mt.dest_type='bank' AND mt.status=$1
       ORDER BY mt.created_at ASC`, [status]);

    res.json({
      data: r.rows.map(t => ({
        transferId: t.transfer_id,
        reference: t.reference,
        merchant: t.business_name,
        merchantEmail: t.merchant_email,
        amount: parseFloat(t.amount),
        fee: parseFloat(t.fee || 0),
        net: parseFloat(t.net_amount || 0),
        status: t.status,
        method: t.settlement_method,
        bank: t.inst_name,
        bankCode: t.inst_code,
        country: t.country,
        accountNumber: t.account_number,
        accountName: t.account_name,
        settlementRef: t.settlement_ref,
        adminNote: t.admin_note,
        createdAt: t.created_at,
        settledAt: t.settled_at,
      })),
      total: r.rows.length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/settlements/summary', adminAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status='pending_settlement') AS a_traiter,
         COALESCE(SUM(net_amount) FILTER (WHERE status='pending_settlement'),0) AS montant_a_traiter,
         COUNT(*) FILTER (WHERE status='completed') AS traites,
         COALESCE(SUM(net_amount) FILTER (WHERE status='completed'),0) AS montant_traite
       FROM merchant_transfers WHERE dest_type='bank'`);
    const s = r.rows[0];
    res.json({
      pending: parseInt(s.a_traiter, 10),
      pendingAmount: parseFloat(s.montant_a_traiter),
      completed: parseInt(s.traites, 10),
      completedAmount: parseFloat(s.montant_traite),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Marquer un retrait comme vire (settlement manuel)
router.post('/settlements/:transferId/complete', requireRole('super_admin', 'finance_admin'), async (req, res) => {
  const { settlementRef, note } = req.body;
  const adminId = req.admin?.adminId || req.user?.adminId || req.user?.sub;

  try {
    const t = await query(
      `SELECT mt.*, m.email AS merchant_email, m.business_name,
              fi.name AS inst_name, ba.account_number
       FROM merchant_transfers mt
       LEFT JOIN merchants m ON m.merchant_id = mt.merchant_id
       LEFT JOIN bank_accounts ba ON ba.account_id = mt.bank_account_id
       LEFT JOIN financial_institutions fi ON fi.institution_id = ba.institution_id
       WHERE mt.transfer_id=$1 AND mt.status='pending_settlement'`,
      [req.params.transferId]);

    if (!t.rows[0])
      return res.status(404).json({ error: 'Retrait introuvable ou deja traite' });
    const tr = t.rows[0];

    await query(
      `UPDATE merchant_transfers
       SET status='completed', settled_by=$1, settlement_ref=$2,
           admin_note=$3, settled_at=NOW(), completed_at=NOW()
       WHERE transfer_id=$4`,
      [adminId, settlementRef || null, note || null, req.params.transferId]);

    // Notifier le marchand
    if (tr.merchant_email) {
      try {
        const email = require('../services/notifications/email.service');
        await email.send({
          to: tr.merchant_email,
          subject: `Virement effectue — ${parseFloat(tr.net_amount)} XAF`,
          html: `<h2>Votre retrait a ete traite</h2>
            <p>Bonjour ${tr.business_name || ''},</p>
            <p>Le virement de <b>${parseFloat(tr.net_amount)} XAF</b> vers
            <b>${tr.inst_name}</b> (compte ${tr.account_number}) a ete effectue.</p>
            ${settlementRef ? `<p>Reference bancaire : <code>${settlementRef}</code></p>` : ''}
            <p>Le credit peut prendre 24 a 48h selon votre banque.</p>`,
        });
      } catch (e) { console.error('[settle-notify]', e.message); }
    }

    res.json({ success: true, transferId: req.params.transferId, status: 'completed' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Rejeter un retrait (rembourse le solde marchand)
router.post('/settlements/:transferId/reject', requireRole('super_admin', 'finance_admin'), async (req, res) => {
  const { reason } = req.body;
  try {
    const r = await query(
      `UPDATE merchant_transfers
       SET status='failed', error_message=$1, completed_at=NOW()
       WHERE transfer_id=$2 AND status='pending_settlement'
       RETURNING merchant_id, net_amount`,
      [reason || 'Rejete par admin', req.params.transferId]);

    if (!r.rows[0])
      return res.status(404).json({ error: 'Retrait introuvable ou deja traite' });

    res.json({ success: true, status: 'failed', refunded: parseFloat(r.rows[0].net_amount) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Reconciliation manuelle des transactions pending ───────────
// Deplacee depuis merchant.routes.js (audit §2.18) : operation GLOBALE, reservee
// aux roles super_admin / ops_admin.
router.post('/reconcile', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  try {
    const { reconcilePending } = require('../services/reconcile.service');
    let maxAgeHours = parseInt(req.body?.maxAgeHours, 10);
    if (!Number.isFinite(maxAgeHours) || maxAgeHours < 1 || maxAgeHours > 720) maxAgeHours = 24;
    // WAVE-3 : minAgeMinutes (defaut 5) — ne pas concurrencer un push / webhook encore en vol ;
    // couvre MTN/Airtel ET les providers de la vague 2 (getStatus + finalisation webhook).
    let minAgeMinutes = parseInt(req.body?.minAgeMinutes, 10);
    if (!Number.isFinite(minAgeMinutes) || minAgeMinutes < 0 || minAgeMinutes > 1440) minAgeMinutes = 5;
    const r = await reconcilePending({ maxAgeHours, limit: 100, minAgeMinutes });
    await query(
      `INSERT INTO audit_logs (actor_type, actor_id, actor_email, action, entity_type, entity_id, new_values, ip_address)
       VALUES ('admin',$1,$2,'RECONCILE_RUN','system','reconcile',$3,$4)`,
      [req.user.sub, req.user.email, JSON.stringify({ maxAgeHours, minAgeMinutes, summary: r?.summary || null }), req.ip]
    ).catch(() => {});
    res.json(r.summary);
  } catch (err) {
    logger.error('[reconcile]', { err: err.message });
    res.status(500).json({ error: 'Erreur reconciliation' });
  }
});

// ================================================================
// ROUTES ENRICHIES v2 — Fraud, Transactions, Users, Alerts
// ================================================================

// ─── FRAUD EVENTS ────────────────────────────────────────────────
router.get('/fraud/events', adminAuth, async (req, res) => {
  const { action } = req.query;
  // limit borne [1,100], offset >= 0 (audit §3.12)
  const { limit } = parsePagination(req.query, 50);
  let offset = parseInt(req.query.offset, 10); if (!Number.isFinite(offset) || offset < 0) offset = 0;
  try {
    const conditions = ['1=1'];
    const params = [];
    if (action) { params.push(action); conditions.push(`fe.action_taken = $${params.length}`); }
    const r = await query(
      `SELECT fe.*, m.business_name
       FROM fraud_events fe
       LEFT JOIN merchants m ON m.merchant_id = fe.merchant_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY fe.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    const cnt = await query(`SELECT COUNT(*) FROM fraud_events fe WHERE ${conditions.join(' AND ')}`, params);
    res.json({ data: r.rows, total: parseInt(cnt.rows[0].count) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/fraud/events/:id/review', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const { outcome } = req.body;
  if (!['false_positive', 'confirmed_fraud'].includes(outcome)) return res.status(422).json({ error: 'outcome invalide' });
  const { query } = require('../config/database');
  try {
    await query(
      `UPDATE fraud_events SET review_outcome=$1, reviewed_by=$2 WHERE event_id=$3`,
      [outcome, req.user.sub, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── FRAUD RULES ─────────────────────────────────────────────────
router.get('/fraud/rules', adminAuth, async (req, res) => {
  const { query } = require('../config/database');
  try {
    const r = await query(`SELECT * FROM fraud_rules ORDER BY priority ASC`);
    res.json({ data: r.rows, total: r.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/fraud/rules', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const { rule_name, rule_type, conditions, action, risk_score_add = 0, priority = 100 } = req.body;
  if (!rule_name || !rule_type || !action) return res.status(422).json({ error: 'Champs obligatoires manquants' });
  const { query } = require('../config/database');
  try {
    const r = await query(
      `INSERT INTO fraud_rules (rule_name, rule_type, conditions, action, risk_score_add, priority)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [rule_name, rule_type, JSON.stringify(conditions || {}), action, risk_score_add, priority]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/fraud/rules/:id', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const { rule_name, rule_type, conditions, action, risk_score_add, priority, is_active } = req.body;
  const { query } = require('../config/database');
  try {
    const sets = [];
    const params = [];
    const add = (col, val) => { if (val !== undefined) { params.push(val); sets.push(`${col}=$${params.length}`); } };
    add('rule_name', rule_name); add('rule_type', rule_type); add('action', action);
    add('risk_score_add', risk_score_add); add('priority', priority); add('is_active', is_active);
    if (conditions !== undefined) { params.push(JSON.stringify(conditions)); sets.push(`conditions=$${params.length}`); }
    if (!sets.length) return res.status(422).json({ error: 'Rien à mettre à jour' });
    params.push(req.params.id);
    const r = await query(`UPDATE fraud_rules SET ${sets.join(',')} WHERE rule_id=$${params.length} RETURNING *`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'Règle introuvable' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── TRANSACTIONS (liste globale admin) ──────────────────────────
router.get('/transactions', adminAuth, async (req, res) => {
  const { status, type, method, merchant_id } = req.query;
  const { page, limit, offset } = parsePagination(req.query, 25);
  try {
    const conditions = ['1=1'];
    const params = [];
    const add = (col, val) => { if (val) { params.push(val); conditions.push(`t.${col}=$${params.length}`); } };
    add('status', status); add('type', type); add('payment_method', method); add('merchant_id', merchant_id);
    const r = await query(
      `SELECT t.*, m.business_name, m.country, m.currency as merchant_currency
       FROM transactions t
       LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY t.initiated_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    const cnt = await query(`SELECT COUNT(*) FROM transactions t WHERE ${conditions.join(' AND ')}`, params);
    res.json({ data: r.rows, total: parseInt(cnt.rows[0].count), page: page });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/transactions/:id', adminAuth, async (req, res) => {
  const { query } = require('../config/database');
  try {
    const r = await query(
      `SELECT t.*, m.business_name FROM transactions t
       LEFT JOIN merchants m ON m.merchant_id = t.merchant_id
       WHERE t.transaction_id=$1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Transaction introuvable' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// HOTFIX (audit §3.13) : le remboursement marquait la transaction 'reversed' sans
// aucun appel gateway/operateur (argent jamais rendu au client). Desactive tant
// que le remboursement reel n'est pas implemente. Aucune ecriture.
router.post('/transactions/:id/refund', requireRole('super_admin', 'ops_admin'), (req, res) => {
  res.status(501).json({
    error: 'Remboursement non implémenté : aucun appel opérateur/gateway disponible',
    code: 'REFUND_NOT_IMPLEMENTED',
  });
});

// ─── USERS (opérateurs/caissiers marchands) ───────────────────────
router.get('/users', adminAuth, async (req, res) => {
  const { search } = req.query;
  const { page, limit, offset } = parsePagination(req.query, 20);
  try {
    const params = [];
    let where = '1=1';
    if (search) { params.push(`%${search}%`); where += ` AND (u.email ILIKE $${params.length} OR u.first_name ILIKE $${params.length} OR u.last_name ILIKE $${params.length})`; }
    // HOTFIX (audit §2.12) : colonnes explicites — jamais password_hash / mfa_secret
    const r = await query(
      `SELECT u.user_id, u.merchant_id, u.email, u.phone, u.first_name, u.last_name,
              u.role, u.is_active, u.last_login_at, u.created_at, u.updated_at,
              m.business_name FROM merchant_users u
       LEFT JOIN merchants m ON m.merchant_id = u.merchant_id
       WHERE ${where} ORDER BY u.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    const cnt = await query(`SELECT COUNT(*) FROM merchant_users u WHERE ${where}`, params);
    res.json({ data: r.rows, total: parseInt(cnt.rows[0].count) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/users', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const bcrypt = require('bcryptjs');
  const { email, phone, firstName, lastName, password, role = 'cashier', merchantId } = req.body;
  if (!email || !password) return res.status(422).json({ error: 'email et password requis' });
  const { query } = require('../config/database');
  try {
    const hash = await bcrypt.hash(password, 12);
    const r = await query(
      `INSERT INTO merchant_users (email, phone, first_name, last_name, password_hash, role, merchant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING user_id, email, role`,
      [email, phone || null, firstName || null, lastName || null, hash, role, merchantId || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email déjà utilisé' });
    res.status(500).json({ error: err.message });
  }
});

router.patch('/users/:id/status', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const { is_active } = req.body;
  if (is_active === undefined) return res.status(422).json({ error: 'is_active requis' });
  const { query } = require('../config/database');
  try {
    await query(`UPDATE merchant_users SET is_active=$1 WHERE user_id=$2`, [is_active, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// WAVE-3 : réinitialisation de mot de passe par un admin.
//   :id       = merchant_users.user_id (défaut, ?type=merchant) ou admin_users.admin_id (?type=admin)
//   ops_admin = comptes marchands uniquement ; super_admin = marchands + admins (jamais son propre compte).
//   Génère un mot de passe temporaire (generateTempPassword), bcrypt(12), temp_password=TRUE
//   (=> mustChangePassword au prochain login), 2FA conservé, toutes les sessions révoquées (revokeAll),
//   audit_logs. Le mot de passe en clair est renvoyé UNE SEULE FOIS à l'admin (aucun e-mail fiable) :
//   il doit être remis à l'utilisateur par un canal sûr, voir docs/WAVE-3.md.
const RESET_TARGETS = {
  merchant: { table: 'merchant_users', pk: 'user_id',  actorType: 'merchant', entity: 'merchant_user', prefix: 'Tmp' },
  admin:    { table: 'admin_users',    pk: 'admin_id', actorType: 'admin',    entity: 'admin_user',    prefix: 'Adm' },
};
router.post('/users/:id/reset-password', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const type = String(req.query.type || req.body?.type || 'merchant').toLowerCase();
  const target = RESET_TARGETS[type];
  if (!target) return res.status(422).json({ error: 'type invalide (merchant | admin)', code: 'VALIDATION_ERROR' });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(req.params.id))) {
    return res.status(404).json({ error: 'Utilisateur introuvable' });
  }
  if (type === 'admin') {
    if (req.user.role !== 'super_admin') return res.status(403).json({ error: 'Seul un super_admin peut réinitialiser un compte admin', code: 'FORBIDDEN' });
    if (String(req.params.id) === String(req.user.sub)) return res.status(422).json({ error: 'Utilisez /auth/change-password pour votre propre compte', code: 'SELF_RESET' });
  }
  try {
    const r = await query(`SELECT ${target.pk} AS id, email, role, is_active FROM ${target.table} WHERE ${target.pk}=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Utilisateur introuvable' });
    const user = r.rows[0];
    if (type === 'admin' && user.role === 'super_admin' && req.user.role !== 'super_admin') {
      return res.status(403).json({ error: 'Réinitialisation réservée aux super_admin', code: 'FORBIDDEN' });
    }
    const tempPassword = generateTempPassword(target.prefix);
    const hash = await bcrypt.hash(tempPassword, 12);
    const upd = await query(
      `UPDATE ${target.table} SET password_hash=$1, temp_password=TRUE, updated_at=NOW() WHERE ${target.pk}=$2`,
      [hash, req.params.id]
    );
    if (upd && upd.rowCount === 0) return res.status(404).json({ error: 'Utilisateur introuvable' });
    await revokeAll(target.actorType, req.params.id);
    await query(
      `INSERT INTO audit_logs (actor_type, actor_id, actor_email, action, entity_type, entity_id, new_values, ip_address)
       VALUES ('admin',$1,$2,'USER_PASSWORD_RESET',$3,$4,$5,$6)`,
      [req.user.sub, req.user.email, target.entity, req.params.id,
       JSON.stringify({ email: user.email, type, tempPassword: true, sessionsRevoked: true }), req.ip]
    ).catch((e) => logger.warn('[reset-password] audit log failed', { err: e.message }));
    res.json({
      success: true,
      type,
      email: user.email,
      tempPassword,
      mustChangePassword: true,
      message: 'Mot de passe temporaire affiché une seule fois : transmettez-le par un canal sûr. Les sessions de l\'utilisateur ont été révoquées ; il devra le changer à la prochaine connexion.',
    });
  } catch (err) {
    logger.error('[reset-password]', { err: err.message });
    res.status(500).json({ error: 'Erreur réinitialisation' });
  }
});

// ─── ALERTS ──────────────────────────────────────────────────────
router.get('/alerts', adminAuth, async (req, res) => {
  const { severity, resolved = false } = req.query;
  const { page, limit, offset } = parsePagination(req.query, 25);
  try {
    const conditions = ['1=1'];
    const params = [];
    if (severity) { params.push(parseInt(severity)); conditions.push(`severity=$${params.length}`); }
    const resolvedBool = resolved === 'true' || resolved === true;
    params.push(resolvedBool); conditions.push(`resolved=$${params.length}`);
    const r = await query(
      `SELECT a.*, m.business_name FROM aml_alerts a
       LEFT JOIN merchants m ON m.merchant_id = a.merchant_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY a.severity DESC, a.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    const cnt = await query(`SELECT COUNT(*) FROM aml_alerts a WHERE ${conditions.join(' AND ')}`, params);
    res.json({ data: r.rows, total: parseInt(cnt.rows[0].count) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.patch('/alerts/:id/resolve', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const { note } = req.body;
  const { query } = require('../config/database');
  try {
    const r = await query(
      `UPDATE aml_alerts SET resolved=TRUE, resolved_by=$1, resolved_at=NOW()
       WHERE alert_id=$2 RETURNING alert_id`,
      [req.user.sub, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Alerte introuvable' });
    await query(
      `INSERT INTO audit_logs (actor_type, actor_id, actor_email, action, entity_type, entity_id, ip_address, after_state)
       VALUES ('admin',$1,$2,'ALERT_RESOLVED','aml_alert',$3,$4,$5)`,
      [req.user.sub, req.user.email, req.params.id, req.ip, JSON.stringify({ note })]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── CREATE MERCHANT (enrichi) ───────────────────────────────────
router.post('/merchants/create', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const bcrypt = require('bcryptjs');
  const { v4: uuidv4 } = require('uuid');
  const { businessName, phone, email, password, country = 'CM', currency = 'XAF', settlementType = 'mobile_money', settlementAccount } = req.body;
  if (!businessName || !phone || !email || !password) return res.status(422).json({ error: 'Champs obligatoires manquants' });
  const { query, withTransaction } = require('../config/database');
  try {
    const hash = await bcrypt.hash(password, 12);
    const merchantId = uuidv4();
    const countryDefaults = require('../services/config/country-defaults').getCountryDefaults(country);
    await withTransaction(async client => {
      await client.query(
        `INSERT INTO merchants (merchant_id, business_name, phone, email, country, currency, settlement_type, settlement_account, merchant_status, kyb_level)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',0)`,
        [merchantId, businessName, phone, email, country, currency || countryDefaults?.defaultCurrency || 'XAF', settlementType, settlementAccount || phone]
      );
      await client.query(
        `INSERT INTO merchant_users (email, phone, password_hash, role, merchant_id, is_active)
         VALUES ($1,$2,$3,'owner',$4,TRUE)`,
        [email, phone, hash, merchantId]
      );
    });
    await query(
      `INSERT INTO audit_logs (actor_type, actor_id, actor_email, action, entity_type, entity_id, ip_address)
       VALUES ('admin',$1,$2,'MERCHANT_CREATED','merchant',$3,$4)`,
      [req.user.sub, req.user.email, merchantId, req.ip]
    );
    res.status(201).json({ success: true, merchantId, businessName });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email ou téléphone déjà utilisé' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/merchants/:id/fees', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const { fees } = req.body;
  if (!Array.isArray(fees)) return res.status(422).json({error:'fees doit être un tableau'});
  try {
    for (const fee of fees) {
      await query(
        `INSERT INTO merchant_fee_configs (merchant_id, payment_type, direction, fee_rate, fee_fixed, fee_min, fee_max, is_active, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
         ON CONFLICT (merchant_id, payment_type, direction) DO UPDATE
         SET fee_rate=$4, fee_fixed=$5, fee_min=$6, fee_max=$7, is_active=$8, updated_at=NOW()`,
        [req.params.id, fee.payment_type, fee.direction,
         parseFloat(fee.fee_rate)||0, parseFloat(fee.fee_fixed)||0,
         parseFloat(fee.fee_min)||0, fee.fee_max ? parseFloat(fee.fee_max) : null,
         fee.is_active !== false]
      );
    }
    res.json({ success: true, updated: fees.length });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// GET velocite d'un marchand
router.get('/merchants/:id/velocity', adminAuth, async (req, res) => {
  try {
    const r = await query(`SELECT velocity_max_per_txn, velocity_max_daily_amount,
      velocity_max_daily_count, velocity_max_monthly_amount, velocity_max_monthly_count
      FROM merchants WHERE merchant_id=$1`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Marchand introuvable' });
    res.json(r.rows[0]);
  } catch(err){ res.status(500).json({error:err.message}); }
});

// PUT velocite d'un marchand
router.put('/merchants/:id/velocity', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const { velocity_max_per_txn, velocity_max_daily_amount, velocity_max_daily_count,
          velocity_max_monthly_amount, velocity_max_monthly_count } = req.body;
  const num = v => (v === '' || v === null || v === undefined) ? null : parseFloat(v);
  const int = v => (v === '' || v === null || v === undefined) ? null : parseInt(v);
  try {
    await query(`UPDATE merchants SET
      velocity_max_per_txn=$1, velocity_max_daily_amount=$2, velocity_max_daily_count=$3,
      velocity_max_monthly_amount=$4, velocity_max_monthly_count=$5, updated_at=NOW()
      WHERE merchant_id=$6`,
      [num(velocity_max_per_txn), num(velocity_max_daily_amount), int(velocity_max_daily_count),
       num(velocity_max_monthly_amount), int(velocity_max_monthly_count), req.params.id]);
    res.json({ success: true });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── KYB DOCUMENTS ───────────────────────────────────────────────
// GET /admin/merchants/:id/kyb
router.get('/merchants/:id/kyb', adminAuth, async (req, res) => {
  try {
    const docs = await query(
      `SELECT * FROM kyb_documents WHERE merchant_id=$1 ORDER BY uploaded_at DESC`,
      [req.params.id]
    );
    const merchant = await query(
      `SELECT kyb_level, kyb_status, kyb_notes, kyb_submitted_at, kyb_reviewed_at FROM merchants WHERE merchant_id=$1`,
      [req.params.id]
    );
    res.json({ kyb: merchant.rows[0], documents: docs.rows });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// POST /admin/merchants/:id/kyb/documents — Ajouter un document manuellement
router.post('/merchants/:id/kyb/documents', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const { docType, docLabel, fileUrl, fileName, fileSize, mimeType } = req.body;
  if (!docType || !fileUrl) return res.status(422).json({error:'docType et fileUrl requis'});
  try {
    const r = await query(
      `INSERT INTO kyb_documents (merchant_id, doc_type, doc_label, file_url, file_name, file_size, mime_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.id, docType, docLabel||docType, fileUrl, fileName||null, fileSize||null, mimeType||null]
    );
    res.status(201).json(r.rows[0]);
  } catch(err){ res.status(500).json({error:err.message}); }
});

// PATCH /admin/merchants/:id/kyb/documents/:docId — Approuver/Rejeter
router.patch('/merchants/:id/kyb/documents/:docId', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const { status, rejectionReason } = req.body;
  if (!['approved','rejected','pending'].includes(status)) return res.status(422).json({error:'Statut invalide'});
  try {
    await query(
      `UPDATE kyb_documents SET status=$1, rejection_reason=$2, reviewed_by=$3, reviewed_at=NOW() WHERE doc_id=$4 AND merchant_id=$5`,
      [status, rejectionReason||null, req.user?.sub, req.params.docId, req.params.id]
    );
    res.json({ success: true });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/settlement/run', requireRole('super_admin', 'finance_admin'), async (req, res) => {
  try {
    const { runAutoSettlement } = require('../services/settlement/auto-settlement');
    await runAutoSettlement();
    res.json({ success: true, message: 'Règlement J+1 exécuté manuellement' });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── TICKETS SUPPORT ADMIN ────────────────────────────────────────
router.get('/support/tickets', adminAuth, async (req, res) => {
  const { status, priority } = req.query;
  const { page, limit, offset } = parsePagination(req.query, 20);
  const conds = ['1=1']; const params = [];
  if (status)   { params.push(status);   conds.push(`t.status=$${params.length}`); }
  if (priority) { params.push(priority); conds.push(`t.priority=$${params.length}`); }
  try {
    const r = await query(
      `SELECT t.*,
              COALESCE(m.business_name, ch.first_name || ' ' || ch.last_name, 'Cardholder') as business_name,
              COALESCE(m.email, ch.email) as merchant_email,
              CASE WHEN t.cardholder_id IS NOT NULL THEN 'cardholder' ELSE 'merchant' END as ticket_source
       FROM support_tickets t
       LEFT JOIN merchants m ON m.merchant_id=t.merchant_id
       LEFT JOIN cardholders ch ON ch.cardholder_id=t.cardholder_id
       WHERE ${conds.join(' AND ')} ORDER BY t.created_at DESC
       LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    const cnt = await query(`SELECT COUNT(*) FROM support_tickets t WHERE ${conds.join(' AND ')}`, params);
    res.json({ data: r.rows, total: parseInt(cnt.rows[0].count) });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.get('/support/tickets/:id', adminAuth, async (req, res) => {
  try {
    const t = await query(
      `SELECT t.*, m.business_name, m.email as merchant_email, m.phone as merchant_phone
       FROM support_tickets t JOIN merchants m ON m.merchant_id=t.merchant_id
       WHERE t.ticket_id=$1`,
      [req.params.id]
    );
    if (!t.rows.length) return res.status(404).json({ error: 'Ticket introuvable' });
    const msgs = await query('SELECT * FROM ticket_messages WHERE ticket_id=$1 ORDER BY created_at ASC', [req.params.id]);
    res.json({ ticket: t.rows[0], messages: msgs.rows });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.patch('/support/tickets/:id/status', adminAuth, async (req, res) => {
  const { status, adminNotes, resolution } = req.body;
  const valid = ['open','pending_admin','pending_merchant','resolved','closed'];
  if (!valid.includes(status)) return res.status(422).json({ error: 'Statut invalide: ' + status });
  try {
    const resolvedAt = status === 'resolved' ? new Date().toISOString() : null;
    await query(
      `UPDATE support_tickets SET
        status=$1::support_ticket_status,
        admin_notes=COALESCE($2,admin_notes),
        resolution=COALESCE($3,resolution),
        updated_at=NOW(),
        resolved_at=COALESCE($4::timestamptz, resolved_at)
       WHERE ticket_id=$5`,
      [status, adminNotes||null, resolution||null, resolvedAt, req.params.id]
    );
    res.json({ success: true });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── GESTION UTILISATEURS ADMIN ──────────────────────────────────
router.get('/admin-users', adminAuth, async (req, res) => {
  try {
    const r = await query(`SELECT admin_id, email, first_name, last_name, role, is_active, last_login_at, created_at FROM admin_users ORDER BY created_at DESC`);
    res.json({ data: r.rows });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/admin-users', requireRole('super_admin'), async (req, res) => {
  const { email, password, firstName, lastName, role } = req.body;
  const validRoles = ['super_admin','ops_admin','finance_admin','support_agent'];
  if (!email || !password || !role) return res.status(422).json({error:'Champs requis'});
  if (!validRoles.includes(role)) return res.status(422).json({error:'Role invalide'});
  try {
    // bcryptjs (module-level) — `bcrypt` natif n'est pas installe (audit §3.5)
    const hash = await bcrypt.hash(password, 12);
    const r = await query(
      `INSERT INTO admin_users (email, password_hash, first_name, last_name, role, is_active)
       VALUES ($1,$2,$3,$4,$5,true) RETURNING admin_id, email, role`,
      [email, hash, firstName||'', lastName||'', role]
    );
    res.status(201).json(r.rows[0]);
  } catch(err){
    if (err.code === '23505') return res.status(409).json({error:'Email déjà utilisé'});
    res.status(500).json({error:err.message});
  }
});

router.patch('/admin-users/:id', requireRole('super_admin'), async (req, res) => {
  const { role, isActive, firstName, lastName } = req.body;
  const validRoles = ['super_admin','ops_admin','finance_admin','support_agent'];
  if (role && !validRoles.includes(role)) return res.status(422).json({error:'Role invalide'});
  try {
    await query(
      `UPDATE admin_users SET
        role=COALESCE($1,role),
        is_active=COALESCE($2,is_active),
        first_name=COALESCE($3,first_name),
        last_name=COALESCE($4,last_name),
        updated_at=NOW()
       WHERE admin_id=$5`,
      [role||null, isActive!=null?isActive:null, firstName||null, lastName||null, req.params.id]
    );
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.delete('/admin-users/:id', requireRole('super_admin'), async (req, res) => {
  if (String(req.params.id) === String(req.user.sub)) return res.status(422).json({error:'Impossible de desactiver son propre compte'});
  try {
    await query(`UPDATE admin_users SET is_active=false WHERE admin_id=$1`, [req.params.id]);
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── RÈGLEMENTS FINANCE ───────────────────────────────────────────
router.get('/finance/settlements', requireRole('super_admin', 'finance_admin'), async (req, res) => {
  const { status, merchantId } = req.query;
  const { page, limit, offset } = parsePagination(req.query, 20);
  const conds = ['1=1']; const params = [];
  if (status)     { params.push(status);     conds.push(`sb.status=$${params.length}`); }
  if (merchantId) { params.push(merchantId); conds.push(`sb.merchant_id=$${params.length}`); }
  try {
    const r = await query(
      `SELECT sb.*, m.business_name, m.settlement_account, m.settlement_type,
              COUNT(t.transaction_id) as txn_count_real
       FROM settlement_batches sb
       JOIN merchants m ON m.merchant_id=sb.merchant_id
       LEFT JOIN transactions t ON t.settlement_batch_id=sb.batch_id
       WHERE ${conds.join(' AND ')}
       GROUP BY sb.batch_id, m.business_name, m.settlement_account, m.settlement_type
       ORDER BY sb.batch_date DESC
       LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    const cnt = await query(`SELECT COUNT(*), COALESCE(SUM(total_net),0) as total_net, COALESCE(SUM(total_gross),0) as total_gross FROM settlement_batches sb WHERE ${conds.join(' AND ')}`, params);
    res.json({ data: r.rows, total: parseInt(cnt.rows[0].count), summary: cnt.rows[0] });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// Transitions financières : état source contrôlé et audit dans le même COMMIT.
const transitionBatch = async (req, res, nextStatus) => {
  const reference = String(req.body.reference || '').trim();
  const reason = String(req.body.reason || '').trim();
  if (nextStatus === 'completed' && !reference) return res.status(422).json({ error: 'Référence de virement requise', code: 'VALIDATION_ERROR' });
  if (nextStatus === 'failed' && reason.length < 3) return res.status(422).json({ error: 'Motif requis', code: 'VALIDATION_ERROR' });
  try {
    const result = await withTransaction(async client => {
      const r = await client.query('SELECT status FROM settlement_batches WHERE batch_id=$1 FOR UPDATE', [req.params.id]);
      if (!r.rows.length) return { status: 404, error: 'Lot introuvable' };
      // Un lot soumis à un opérateur ne peut pas être rejeté manuellement : résultat encore incertain.
      const allowed = nextStatus === 'completed' ? ['pending', 'submitted'] : ['pending'];
      if (!allowed.includes(r.rows[0].status)) return { status: 409, error: 'Transition de règlement interdite' };
      await client.query(
        `UPDATE settlement_batches SET status=$1, completed_at=CASE WHEN $1='completed' THEN NOW() ELSE NULL END,
         payout_ref=COALESCE($2,payout_ref), failure_reason=$3 WHERE batch_id=$4`,
        [nextStatus, reference || null, nextStatus === 'failed' ? reason : null, req.params.id]);
      await client.query(
        `INSERT INTO audit_logs (actor_type, actor_id, actor_email, action, entity_type, entity_id, new_values, ip_address)
         VALUES ('admin',$1,$2,$3,'settlement',$4,$5,$6)`,
        [req.user.sub, req.user.email, nextStatus === 'completed' ? 'VALIDATE_SETTLEMENT' : 'REJECT_SETTLEMENT',
         req.params.id, JSON.stringify({ reference, reason, notes: req.body.notes || null, from: r.rows[0].status, to: nextStatus }), req.ip]);
      return { status: 200 };
    });
    if (result.error) return res.status(result.status).json({ error: result.error, code: result.status === 404 ? 'NOT_FOUND' : 'INVALID_TRANSITION' });
    res.json({ success: true });
  } catch (err) { logger.error('Batch transition failed', { err: err.message }); res.status(500).json({ error: 'Erreur de validation du règlement' }); }
};
router.patch('/finance/settlements/:id/validate', requireRole('super_admin', 'finance_admin'), (req,res) => transitionBatch(req,res,'completed'));
router.patch('/finance/settlements/:id/reject', requireRole('super_admin', 'finance_admin'), (req,res) => transitionBatch(req,res,'failed'));

// Export CSV règlements
router.get('/finance/settlements/export', requireRole('super_admin', 'finance_admin'), async (req, res) => {
  try {
    const r = await query(
      `SELECT sb.batch_date, m.business_name, m.settlement_account, sb.txn_count, sb.total_gross, sb.total_fees, sb.total_net, sb.currency, sb.status, sb.completed_at
       FROM settlement_batches sb JOIN merchants m ON m.merchant_id=sb.merchant_id
       ORDER BY sb.batch_date DESC LIMIT 1000`
    );
    // HOTFIX (audit §2.22) : cellules quotees, guillemets echappes, anti-injection de formule
    const header = integrations.csvRow(['Date','Merchant','Compte','Transactions','Brut','Frais','Net','Devise','Statut','Date paiement']) + '\n';
    const rows = r.rows.map(r => integrations.csvRow([
      r.batch_date, r.business_name, r.settlement_account, r.txn_count, r.total_gross,
      r.total_fees, r.total_net, r.currency, r.status, r.completed_at || '',
    ])).join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename=reglements.csv');
    res.send(header + rows);
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── CUSTOMER CARE ────────────────────────────────────────────────
// Prendre en charge un ticket
router.patch('/support/tickets/:id/assign', adminAuth, async (req, res) => {
  try {
    await query(
      `UPDATE support_tickets SET assigned_admin_id=$1, status='open', updated_at=NOW() WHERE ticket_id=$2`,
      [req.user?.sub, req.params.id]
    );
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// Débloquer un terminal
router.patch('/terminals/:id/unblock', adminAuth, async (req, res) => {
  try {
    await query(`UPDATE terminals SET status='active', updated_at=NOW() WHERE terminal_id=$1`, [req.params.id]);
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── ESCALADE ─────────────────────────────────────────────────────
// GET /admin/support/agents — liste des agents disponibles par rôle
router.get('/support/agents', adminAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT admin_id, email, first_name, last_name, role
       FROM admin_users WHERE is_active=true AND role != 'support_agent'
       ORDER BY role, first_name`,
    );
    res.json({ data: r.rows });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// POST /admin/support/tickets/:id/escalate
router.post('/support/tickets/:id/escalate', adminAuth, async (req, res) => {
  const { escalateTo, escalationLevel, escalationNotes } = req.body;
  if (!escalateTo || !escalationLevel) return res.status(422).json({error:'Destinataire et niveau requis'});
  try {
    // Récupérer les infos du destinataire
    const agent = await query('SELECT email, first_name, last_name, role FROM admin_users WHERE admin_id=$1', [escalateTo]);
    if (!agent.rows.length) return res.status(404).json({error:'Agent introuvable'});
    const agentInfo = agent.rows[0];

    // Récupérer les infos de l'escaladeur
    const escalader = await query('SELECT email, first_name, last_name FROM admin_users WHERE admin_id=$1', [req.user?.sub]);
    const escaladerInfo = escalader.rows[0] || { email: req.user?.email, first_name: 'Admin', last_name: '' };

    // Mettre à jour le ticket
    await query(
      `UPDATE support_tickets SET
        escalation_level=$1, escalated_to=$2, escalated_at=NOW(),
        escalation_notes=$3, escalated_by=$4,
        status='pending_admin', updated_at=NOW()
       WHERE ticket_id=$5`,
      [parseInt(escalationLevel), escalateTo, escalationNotes||null, req.user?.sub, req.params.id]
    );

    // Ajouter un message système dans l'historique
    const LEVEL_LABELS = { 2:'Ops Admin', 3:'Finance', 4:'Super Admin' };
    const systemMsg = `🔺 Ticket escaladé N${escalationLevel} → ${LEVEL_LABELS[escalationLevel]||'Admin'} (${agentInfo.email})\nPar: ${escaladerInfo.first_name} ${escaladerInfo.last_name} (${escaladerInfo.email})\n${escalationNotes ? 'Note: ' + escalationNotes : ''}`;

    await query(
      `INSERT INTO ticket_messages (ticket_id, sender_type, sender_id, sender_name, message, attachments)
       VALUES ($1,'admin',$2,'Système C-Pay',$3,'[]')`,
      [req.params.id, req.user?.sub, systemMsg]
    );

    res.json({ success: true, escalatedTo: agentInfo });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── REVIEW KYC CARDHOLDER ───────────────────────────────────────
router.patch('/cardholders/:id/kyc/documents/:docId', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const { status, rejectionReason } = req.body;
  if (!['approved','rejected','pending'].includes(status)) return res.status(422).json({error:'Statut invalide'});
  try {
    await query(
      `UPDATE kyb_documents SET status=$1, rejection_reason=$2, reviewed_by=$3, reviewed_at=NOW() WHERE doc_id=$4 AND cardholder_id=$5`,
      [status, rejectionReason||null, req.user?.sub, req.params.docId, req.params.id]
    );
    // Notifier le cardholder
    try {
      const ch = await query(
        `SELECT ch.first_name, ch.last_name, ch.email, ch.phone, kd.doc_label
         FROM cardholders ch JOIN kyb_documents kd ON kd.doc_id=$1
         WHERE ch.cardholder_id=$2 LIMIT 1`,
        [req.params.docId, req.params.id]
      );
      if (ch.rows.length) {
        const { first_name, last_name, email, phone, doc_label } = ch.rows[0];
        const name = first_name + ' ' + last_name;
        const statusLabel = status === 'approved' ? 'approuvé ✅' : status === 'rejected' ? 'rejeté ❌' : 'mis à jour';
        const msg = `C-Pay: Votre document KYC "${doc_label}" a été ${statusLabel}.${rejectionReason ? ' Raison: ' + rejectionReason : ''} Connectez-vous sur app.c-pay.global pour plus de détails.`;
        if (phone) {
          try {
            const { sendSmsSmpp } = require('../services/notifications/smpp.service');
            await sendSmsSmpp({ to: phone, message: msg });
          } catch(smsErr) { console.log('SMS cardholder non envoyé:', smsErr.message); }
        }
        await notify({
          type: status === 'approved' ? 'kyc_document_approved' : 'kyc_document_rejected',
          title: `Document KYC ${statusLabel}`,
          message: `${name}: ${doc_label} ${statusLabel}`,
          entityType: 'cardholder',
          entityId: req.params.id,
          metadata: { docId: req.params.docId, status, rejectionReason, email, phone }
        });
      }
    } catch(notifErr) { console.error('Notification KYC review error:', notifErr.message); }
    res.json({ success: true });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── NOTIFICATIONS ADMIN ──────────────────────────────────────────
router.get('/notifications', adminAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT * FROM admin_notifications ORDER BY created_at DESC LIMIT 50`
    );
    const unread = await query(`SELECT COUNT(*) FROM admin_notifications WHERE is_read=FALSE`);
    res.json({ data: r.rows, unread: parseInt(unread.rows[0].count) });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.patch('/notifications/:id/read', adminAuth, async (req, res) => {
  try {
    await query(
      `UPDATE admin_notifications SET is_read=TRUE, read_by=$1, read_at=NOW() WHERE notification_id=$2`,
      [req.user?.sub, req.params.id]
    );
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.patch('/notifications/read-all', adminAuth, async (req, res) => {
  try {
    await query(`UPDATE admin_notifications SET is_read=TRUE, read_at=NOW() WHERE is_read=FALSE`);
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── NOTIFICATION CONFIGS ─────────────────────────────────────────
router.get('/notification-configs', adminAuth, async (req, res) => {
  try {
    const r = await query(`SELECT provider_key, extra_params, last_tested_at, last_test_ok FROM api_configurations WHERE provider_key LIKE 'notif_%'`);
    const cfg = {};
    // HOTFIX (audit §2.12) : les secrets ne sortent jamais en clair
    r.rows.forEach(row => {
      for (const [k, v] of Object.entries(row.extra_params || {})) {
        cfg[k] = NOTIF_SECRET_FIELDS.includes(k) ? maskSecret(v) : v;
      }
    });
    // Ajouter statuts de test
    r.rows.forEach(row => {
      const section = row.provider_key.replace('notif_','');
      cfg[`${section}_last_tested`] = row.last_tested_at;
      cfg[`${section}_test_ok`] = row.last_test_ok;
    });
    res.json(cfg);
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/notification-configs', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const { section, ...allParams } = req.body;
  if (!section) return res.status(422).json({error:'section requis'});
  try {
    const key = `notif_${section}`;
    // Filtrer seulement les champs de la section
    const sectionFields = {
      smpp: ['smpp_host','smpp_port','smpp_user','smpp_pass','smpp_src'],
      smtp: ['smtp_host','smtp_port','smtp_user','smtp_pass','smtp_from','smtp_secure'],
      whatsapp: ['wa_token','wa_phone_id','wa_verify_token']
    };
    const fields = sectionFields[section] || Object.keys(allParams);
    const params = {};
    fields.forEach(f => {
      const v = allParams[f];
      if (v === undefined) return;
      // Un secret renvoye masque par l'UI ({configured,last4}) ou vide n'ecrase pas la valeur stockee
      if (NOTIF_SECRET_FIELDS.includes(f) && (v === '' || v === null || typeof v === 'object')) return;
      params[f] = v;
    });

    const existing = await query(`SELECT config_id, extra_params FROM api_configurations WHERE provider_key=$1`, [key]);
    if (existing.rows.length) {
      // Merger avec les données existantes
      const merged = { ...(existing.rows[0].extra_params||{}), ...params };
      await query(`UPDATE api_configurations SET extra_params=$1, updated_at=NOW() WHERE provider_key=$2`,
        [JSON.stringify(merged), key]);
    } else {
      await query(
        `INSERT INTO api_configurations (provider_key, provider_type, display_name, status, extra_params)
         VALUES ($1,'notification',$2,'active',$3)`,
        [key, `Notification ${section.toUpperCase()}`, JSON.stringify(params)]
      );
    }
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── TEST NOTIFICATION CONFIGS ────────────────────────────────────
router.post('/notification-configs/test', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const { section } = req.body;
  try {
    const r = await query(`SELECT extra_params FROM api_configurations WHERE provider_key=$1`, [`notif_${section}`]);
    if (!r.rows.length) return res.status(404).json({error:'Configuration non trouvée — sauvegardez d\'abord'});
    const cfg = r.rows[0].extra_params;

    if (section === 'smpp') {
      const net = require('net');
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: cfg.smpp_host, port: parseInt(cfg.smpp_port||2775), timeout: 5000 });
        socket.on('connect', () => { socket.destroy(); resolve(); });
        socket.on('error', reject);
        socket.on('timeout', () => { socket.destroy(); reject(new Error('Timeout connexion')); });
      });
      return res.json({ success:true, message:`Connexion SMPP ${cfg.smpp_host}:${cfg.smpp_port} établie ✅` });
    }

    if (section === 'smtp') {
      try { const nodemailer = require('nodemailer');
        const t = nodemailer.createTransport({ host:cfg.smtp_host, port:parseInt(cfg.smtp_port||587), secure:cfg.smtp_secure==='ssl', auth:{user:cfg.smtp_user,pass:cfg.smtp_pass} });
        await t.verify();
        return res.json({ success:true, message:`Connexion SMTP ${cfg.smtp_host}:${cfg.smtp_port} établie ✅` });
      } catch(e) { return res.status(400).json({success:false, error:e.message}); }
    }

    if (section === 'whatsapp') {
      if (!cfg.wa_token || !cfg.wa_phone_id) return res.status(400).json({error:'Token et Phone ID requis'});
      const https = require('https');
      const result = await new Promise((resolve,reject) => {
        const req2 = https.get(`https://graph.facebook.com/v18.0/${cfg.wa_phone_id}?access_token=${cfg.wa_token}`, r2=>{
          let d=''; r2.on('data',c=>d+=c); r2.on('end',()=>resolve(JSON.parse(d)));
        });
        req2.on('error',reject);
      });
      if (result.error) return res.status(400).json({success:false, error:result.error.message});
      return res.json({ success:true, message:`WhatsApp connecté ✅ (${result.display_phone_number||result.id})` });
    }

    res.status(400).json({error:'Section invalide'});
  } catch(err){ res.status(400).json({success:false, error:err.message}); }
});

// ─── SEND TEST MESSAGE ────────────────────────────────────────────
router.post('/notification-configs/send-test', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const { section, to } = req.body;
  if (!to) return res.status(422).json({error:'Destinataire requis'});
  try {
    const r = await query(`SELECT extra_params FROM api_configurations WHERE provider_key=$1`, [`notif_${section}`]);
    if (!r.rows.length) return res.status(404).json({error:'Configuration non trouvée — sauvegardez dabord'});
    const cfg = r.rows[0].extra_params;

    if (section === 'smtp') {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: cfg.smtp_host, port: parseInt(cfg.smtp_port||587),
        secure: cfg.smtp_secure === 'ssl',
        auth: { user: cfg.smtp_user, pass: cfg.smtp_pass }
      });
      await transporter.sendMail({
        from: `"C-Pay Admin" <${cfg.smtp_from||cfg.smtp_user}>`,
        to,
        subject: 'C-Pay — Test configuration Email',
        html: `<div style="font-family:Arial,sans-serif;padding:20px;max-width:500px">
          <h2 style="color:#12b6c7">Calculus Plus</h2>
          <p>Configuration SMTP opérationnelle.</p>
          <p style="background:#f0f4f8;padding:12px;border-radius:8px">
            Serveur: ${cfg.smtp_host}:${cfg.smtp_port}<br/>
            Date: ${new Date().toLocaleString('fr-FR')}
          </p>
          <p style="color:#5a6677;font-size:12px">C-Pay — admin.c-pay.global</p>
        </div>`
      });
      return res.json({ success:true, message:`Email test envoyé à ${to} ✅` });
    }

    if (section === 'smpp') {
      const net = require('net');
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host:cfg.smpp_host, port:parseInt(cfg.smpp_port||2775), timeout:5000 });
        socket.on('connect', ()=>{ socket.destroy(); resolve(); });
        socket.on('error', reject);
        socket.on('timeout', ()=>{ socket.destroy(); reject(new Error('Timeout')); });
      });
      return res.json({ success:true, message:`SMS test vers ${to} via ${cfg.smpp_host} ✅` });
    }

    if (section === 'whatsapp') {
      if (!cfg.wa_token || !cfg.wa_phone_id) return res.status(400).json({error:'Token et Phone ID requis'});
      const https = require('https');
      const body = JSON.stringify({ messaging_product:'whatsapp', to:to.replace(/\D/g,''), type:'text', text:{ body:`C-Pay Test — ${new Date().toLocaleString('fr-FR')}` } });
      const result = await new Promise((resolve,reject) => {
        const req2 = https.request({ hostname:'graph.facebook.com', path:`/v18.0/${cfg.wa_phone_id}/messages`, method:'POST', headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${cfg.wa_token}`, 'Content-Length':Buffer.byteLength(body) } }, r2=>{ let d=''; r2.on('data',c=>d+=c); r2.on('end',()=>resolve(JSON.parse(d))); });
        req2.on('error',reject); req2.write(body); req2.end();
      });
      if (result.error) return res.status(400).json({success:false, error:result.error.message});
      return res.json({ success:true, message:`WhatsApp envoyé à ${to} ✅` });
    }

    res.status(400).json({error:'Section invalide'});
  } catch(err){ res.status(400).json({success:false, error:err.message}); }
});

// ─── DEVELOPER REGISTRATION ───────────────────────────────────────
router.post('/developer/register', async (req, res) => {
  const { name, email, phone, appName, integrationType, country } = req.body;
  if (!name || !email || !phone || !appName) return res.status(422).json({error:'Champs requis manquants'});
  try {
    // Créer un compte merchant sandbox
    const crypto = require('crypto');
    const sandboxPassword = 'Dev@' + crypto.randomBytes(4).toString('hex');
    const businessName = appName + ' (Sandbox)';

    // Notifier l'admin
    await query(
      `INSERT INTO admin_notifications (type, title, message, metadata)
       VALUES ('developer_registration', 'Nouveau développeur inscrit', $1, $2)`,
      [`${name} (${email}) — App: ${appName} — Pays: ${country}`,
       JSON.stringify({ name, email, phone, appName, integrationType, country })]
    );

    // TODO: Envoyer email avec credentials sandbox via SMTP
    res.json({
      success: true,
      message: 'Compte sandbox en cours de création — vous recevrez vos credentials par email sous 24h.'
    });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── PARTNERS — BANKS (Admin) ─────────────────────────────────────
router.get('/partners/banks', adminAuth, async (req, res) => {
  try {
    const r = await query(`SELECT b.*, COUNT(DISTINCT a.agency_id) as agency_count, COUNT(DISTINCT ag.agent_id) as agent_count
      FROM banks b LEFT JOIN agencies a ON a.bank_id=b.bank_id LEFT JOIN agents ag ON ag.bank_id=b.bank_id
      GROUP BY b.bank_id ORDER BY b.created_at DESC`);
    res.json({ data: r.rows, total: r.rows.length });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.get('/partners/banks/:id', adminAuth, async (req, res) => {
  try {
    const r = await query(`SELECT b.*, COUNT(DISTINCT a.agency_id) as agency_count, COUNT(DISTINCT ag.agent_id) as agent_count
      FROM banks b LEFT JOIN agencies a ON a.bank_id=b.bank_id LEFT JOIN agents ag ON ag.bank_id=b.bank_id
      WHERE b.bank_id=$1 GROUP BY b.bank_id`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({error:'Banque introuvable'});
    res.json(r.rows[0]);
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.get('/partners/banks/:id/agencies', adminAuth, async (req, res) => {
  try {
    const r = await query(`SELECT a.*, COUNT(ag.agent_id) as agent_count FROM agencies a
      LEFT JOIN agents ag ON ag.agency_id=a.agency_id
      WHERE a.bank_id=$1 GROUP BY a.agency_id ORDER BY a.created_at DESC`, [req.params.id]);
    res.json({ data: r.rows });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.get('/partners/banks/:id/agents', adminAuth, async (req, res) => {
  try {
    const r = await query(`SELECT ag.*, a.agency_name FROM agents ag
      JOIN agencies a ON a.agency_id=ag.agency_id
      WHERE ag.bank_id=$1 ORDER BY ag.created_at DESC`, [req.params.id]);
    res.json({ data: r.rows.map(a=>({...a,password_hash:undefined})) });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/partners/banks', requireRole('super_admin'), async (req, res) => {
  const { bankName, bankCode, country='CG', contactEmail, contactPhone, address, city, swift, status='active',
          adminFirstName, adminLastName, adminEmail, adminPhone } = req.body;
  if (!bankName || !bankCode) return res.status(422).json({error:'bankName et bankCode requis'});
  if (!adminEmail || !adminFirstName) return res.status(422).json({error:'adminEmail et adminFirstName requis'});
  try {
    const bcrypt = require('bcryptjs');
    const crypto = require('crypto');

    // Créer la banque
    const bankRes = await query(
      `INSERT INTO banks (bank_name, bank_code, country, contact_email, contact_phone, status)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [bankName, bankCode, country, contactEmail||adminEmail, contactPhone||null, status]
    );
    const bank = bankRes.rows[0];

    // Générer mot de passe temporaire (crypto.randomBytes, 16 caracteres — audit §2.13)
    const tempPwd = generateTempPassword('Bank');
    const hash    = await bcrypt.hash(tempPwd, 12);

    // Créer l'utilisateur bank_admin
    const userRes = await query(
      `INSERT INTO bank_users (bank_id, first_name, last_name, email, phone, password_hash, role, temp_password)
       VALUES ($1,$2,$3,$4,$5,$6,'bank_admin',TRUE) RETURNING user_id, email, first_name, last_name, role`,
      [bank.bank_id, adminFirstName, adminLastName||'', adminEmail, adminPhone||null, hash]
    );

    // Notifier admin CPlus
    await query(`INSERT INTO admin_notifications (type, title, message, metadata)
      VALUES ('bank_created','Nouvelle banque créée',$1,$2)`,
      [`${bankName} (${bankCode}) — Admin: ${adminEmail}`,
       JSON.stringify({ bankId: bank.bank_id, bankName, adminEmail })]
    ).catch(()=>{});

    // Le mot de passe temporaire est renvoye UNE fois au super_admin createur, jamais stocke en clair
    res.status(201).json({
      bank,
      admin: { ...userRes.rows[0], tempPassword: tempPwd },
      message: `Banque créée ✅ — Admin: ${adminEmail} (mot de passe temporaire ci-joint, non réaffiché)`
    });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.patch('/partners/banks/:id', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  const { bankName, bankCode, contactEmail, contactPhone, city, address, swift } = req.body;
  try {
    await query(`UPDATE banks SET bank_name=COALESCE($1,bank_name), bank_code=COALESCE($2,bank_code),
      contact_email=COALESCE($3,contact_email), contact_phone=COALESCE($4,contact_phone),
      city=COALESCE($5,city), address=COALESCE($6,address), updated_at=NOW() WHERE bank_id=$7`,
      [bankName||null, bankCode||null, contactEmail||null, contactPhone||null, city||null, address||null, req.params.id]);
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.patch('/partners/banks/:id/status', requireRole('super_admin', 'ops_admin'), async (req, res) => {
  try {
    await query(`UPDATE banks SET status=$1, updated_at=NOW() WHERE bank_id=$2`, [req.body.status, req.params.id]);
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.get('/partners/agencies/all', adminAuth, async (req, res) => {
  try {
    const r = await query(`SELECT a.*, b.bank_name, COUNT(ag.agent_id) as agent_count
      FROM agencies a JOIN banks b ON b.bank_id=a.bank_id
      LEFT JOIN agents ag ON ag.agency_id=a.agency_id
      GROUP BY a.agency_id, b.bank_name ORDER BY a.created_at DESC`);
    res.json({ data: r.rows });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.get('/partners/agents/all', adminAuth, async (req, res) => {
  try {
    const r = await query(`SELECT ag.*, a.agency_name, b.bank_name FROM agents ag
      JOIN agencies a ON a.agency_id=ag.agency_id
      JOIN banks b ON b.bank_id=ag.bank_id
      ORDER BY ag.created_at DESC`);
    res.json({ data: r.rows.map(a=>({...a,password_hash:undefined})) });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── TENANTS ADMIN ────────────────────────────────────────────────
router.get('/tenants', adminAuth, async (req, res) => {
  try {
    const r = await query(`SELECT t.*, b.bank_name, b.bank_code,
      COUNT(DISTINCT u.user_id) as user_count,
      COUNT(DISTINCT a.agent_id) as agent_count
      FROM tenants t
      JOIN banks b ON b.bank_id=t.bank_id
      LEFT JOIN bank_users u ON u.tenant_id=t.tenant_id
      LEFT JOIN agents a ON a.tenant_id=t.tenant_id
      GROUP BY t.tenant_id, b.bank_name, b.bank_code
      ORDER BY t.created_at DESC`);
    res.json({ data: r.rows });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/tenants', requireRole('super_admin'), async (req, res) => {
  const { bankId, subdomain, displayName, primaryColor='#12b6c7', secondaryColor='#1d4f92', accentColor='#00c896', logoUrl, supportEmail, supportPhone } = req.body;
  if (!bankId || !subdomain || !displayName) return res.status(422).json({error:'bankId, subdomain et displayName requis'});
  if (!/^[a-z0-9-]+$/.test(subdomain)) return res.status(422).json({error:'Subdomain: lettres minuscules, chiffres et tirets uniquement'});
  try {
    const r = await query(
      `INSERT INTO tenants (bank_id, subdomain, display_name, primary_color, secondary_color, accent_color, logo_url, support_email, support_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [bankId, subdomain.toLowerCase(), displayName, primaryColor, secondaryColor, accentColor, logoUrl||null, supportEmail||null, supportPhone||null]
    );
    // Lier les utilisateurs de la banque au tenant
    await query('UPDATE bank_users SET tenant_id=$1 WHERE bank_id=$2', [r.rows[0].tenant_id, bankId]);
    await query('UPDATE agents     SET tenant_id=$1 WHERE bank_id=$2', [r.rows[0].tenant_id, bankId]);
    await query('UPDATE agencies   SET tenant_id=$1 WHERE bank_id=$2', [r.rows[0].tenant_id, bankId]);
    res.status(201).json(r.rows[0]);
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.patch('/tenants/:id', requireRole('super_admin'), async (req, res) => {
  const { displayName, primaryColor, secondaryColor, accentColor, logoUrl, supportEmail, supportPhone, isActive } = req.body;
  try {
    await query(`UPDATE tenants SET
      display_name=COALESCE($1,display_name), primary_color=COALESCE($2,primary_color),
      secondary_color=COALESCE($3,secondary_color), accent_color=COALESCE($4,accent_color),
      logo_url=COALESCE($5,logo_url), support_email=COALESCE($6,support_email),
      support_phone=COALESCE($7,support_phone),
      is_active=COALESCE($8,is_active), updated_at=NOW()
      WHERE tenant_id=$9`,
      [displayName||null, primaryColor||null, secondaryColor||null, accentColor||null,
       logoUrl||null, supportEmail||null, supportPhone||null, isActive??null, req.params.id]);
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

module.exports = router;
