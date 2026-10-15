'use strict';
const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const rateLimit = require('express-rate-limit');
const { query, withTransaction } = require('../config/database');
// WAVE-2 : module d'auth unique (audit §1.1) — aucun jwt.sign/verify local.
// `requireRole` garde son nom historique dans ce fichier (= requirePartnerRole).
const {
  partnerAuth, requirePartnerRole: requireRole, issueSession, rotateRefresh, revokeRefreshToken, revokeAll,
  readRefreshToken, clearRefreshCookie, signMfaToken, verifyMfaToken, verifyTotp, buildTotpEnrollment,
} = require('../middleware/auth');

// Rate limit login partenaires : 10 / 15 min / IP (audit §2.19)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Trop de tentatives de connexion, réessayez plus tard', code: 'RATE_LIMITED' }),
});
// Verrouillage du compte apres 10 echecs (15 min)
const PARTNER_MAX_FAILED = 10;

// Colonnes publiques (jamais password_hash / mfa_secret — audit §2.12)
const BANK_USER_PUBLIC = `u.user_id, u.bank_id, u.agency_id, u.first_name, u.last_name, u.email, u.phone, u.role, u.status,
                          u.is_mfa_enabled, u.temp_password, u.created_at, u.updated_at`;
const AGENT_PUBLIC     = `a.agent_id, a.agency_id, a.bank_id, a.first_name, a.last_name, a.email, a.phone, a.role, a.status,
                          a.float_balance, a.float_limit, a.is_mfa_enabled, a.temp_password, a.updated_at`;

// ─── HOTFIX P0 (audit 2.6.0 §2.6) ─────────────────────────────────
// /collect et /disburse créaient des transactions `completed` sans aucun
// mouvement chez l'opérateur. Désactivés (410) jusqu'au branchement provider.
const FEATURE_DISABLED = true;
const featureDisabled = (res) => res.status(410).json({
  error: 'Fonctionnalité désactivée en attendant l’intégration opérateur',
  code: 'FEATURE_DISABLED',
});

// Pagination bornée : limit ∈ [1,100], page ≥ 1
const parsePagination = (q = {}) => {
  const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));
  const page  = Math.max(1, parseInt(q.page, 10) || 1);
  return { limit, page, offset: (page - 1) * limit };
};

// Mot de passe temporaire : aléa cryptographique (jamais Math.random).
// Il est renvoyé UNE SEULE FOIS dans la réponse HTTP à l'admin qui crée le
// compte et n'est jamais stocké en clair (seul le hash bcrypt est persisté).
const tempPassword = (prefix) => `${prefix}@${crypto.randomBytes(6).toString('base64url')}`;

// Table/colonne de l'utilisateur partenaire courant (bank_users ou agents)
const userTarget = (u) => u.role === 'agent'
  ? { table: 'agents',     idCol: 'agent_id', id: u.agentId }
  : { table: 'bank_users', idCol: 'user_id',  id: u.sub };

// Claims de l'access token partenaire (type bank_user | agent conserve)
const partnerClaims = (user, type, tenantId) => ({
  email:    user.email,
  role:     user.role,
  type,
  bankId:   user.bank_id,
  agencyId: user.agency_id || null,
  agentId:  type === 'agent' ? user.agent_id : null,
  tenantId: tenantId || null,
  name:     `${user.first_name} ${user.last_name}`,
});

// Session partenaire — factorisée pour login, 2FA validate et refresh.
// WAVE-2 : access 15 min (etait 8 h), refresh opaque stocke/rotatif/revocable
// (actor_type 'partner', meta { userType, tenantId }) en cookie cp_rt_partner.
// refresh_token reste dans le JSON tant que le portail n'est pas migre.
const buildSession = async (user, type, tenantId, req, res) => {
  const sub = type === 'agent' ? user.agent_id : user.user_id;
  const session = await issueSession({
    actorType: 'partner', actorId: sub, claims: partnerClaims(user, type, tenantId),
    meta: { userType: type, tenantId: tenantId || null }, req, res,
  });
  return {
    ...session,
    mustChangePassword: !!user.temp_password,
    user: {
      id:         sub,
      name:       `${user.first_name} ${user.last_name}`,
      email:      user.email,
      role:       user.role,
      type,
      bankName:   user.bank_name,
      agencyName: user.agency_name || null,
      floatBalance: user.float_balance || null,
      floatLimit:   user.float_limit  || null,
      mfaEnabled: !!user.is_mfa_enabled,
    }
  };
};

// Recharge un partenaire par identifiant (2FA validate, refresh)
const loadPartnerUser = async (type, id) => {
  const r = type === 'agent'
    ? await query(`SELECT a.*, ag.agency_name, b.bank_name FROM agents a
        JOIN agencies ag ON ag.agency_id=a.agency_id JOIN banks b ON b.bank_id=a.bank_id
        WHERE a.agent_id=$1 AND a.status='active'`, [id])
    : await query(`SELECT u.*, b.bank_name, a.agency_name FROM bank_users u
        LEFT JOIN banks b ON b.bank_id=u.bank_id LEFT JOIN agencies a ON a.agency_id=u.agency_id
        WHERE u.user_id=$1 AND u.status='active'`, [id]);
  return r.rows[0] || null;
};

// NB : `u.*` / `a.*` ici sont internes au login (password_hash, mfa_secret,
// failed_attempts…) ; rien de cette ligne n'est renvoye tel quel au client.
const findPartnerUser = async (email) => {
  const bu = await query(`SELECT u.*, b.bank_name, a.agency_name FROM bank_users u
    LEFT JOIN banks b ON b.bank_id=u.bank_id
    LEFT JOIN agencies a ON a.agency_id=u.agency_id
    WHERE u.email=$1 AND u.status='active'`, [email]);
  if (bu.rows.length) return { user: bu.rows[0], type: 'bank_user' };
  const ag = await query(`SELECT a.*, ag.agency_name, b.bank_name FROM agents a
    JOIN agencies ag ON ag.agency_id=a.agency_id
    JOIN banks b ON b.bank_id=a.bank_id
    WHERE a.email=$1 AND a.status='active'`, [email]);
  if (ag.rows.length) return { user: ag.rows[0], type: 'agent' };
  return { user: null, type: null };
};

// ─── MIDDLEWARE TENANT ────────────────────────────────────────────
const resolveTenant = async (req, res, next) => {
  try {
    // Lire le subdomain depuis le header Origin ou Host
    const origin = req.headers.origin || req.headers.host || '';
    const host   = origin.replace('https://','').replace('http://','').split('/')[0];
    // Format: bcplus.partners.c-pay.global
    const parts  = host.split('.');
    let subdomain = null;
    if (parts.length >= 4 && parts[1] === 'partners') {
      subdomain = parts[0]; // bcplus
    }
    if (subdomain) {
      const t = await query('SELECT * FROM tenants WHERE subdomain=$1 AND is_active=TRUE', [subdomain]);
      if (t.rows.length) {
        req.tenant = t.rows[0];
      }
    }
    next();
  } catch(err) { next(); }
};

router.use(resolveTenant);

// ─── ROUTE PUBLIQUE — Config tenant ──────────────────────────────
router.get('/tenant/config', async (req, res) => {
  if (!req.tenant) return res.json({
    display_name: 'CPlus Partners',
    primary_color: '#12b6c7',
    secondary_color: '#1d4f92',
    accent_color: '#00c896',
    logo_url: null,
    subdomain: null
  });
  res.json({
    tenant_id:       req.tenant.tenant_id,
    display_name:    req.tenant.display_name,
    primary_color:   req.tenant.primary_color,
    secondary_color: req.tenant.secondary_color,
    accent_color:    req.tenant.accent_color,
    logo_url:        req.tenant.logo_url,
    favicon_url:     req.tenant.favicon_url,
    support_email:   req.tenant.support_email,
    support_phone:   req.tenant.support_phone,
    subdomain:       req.tenant.subdomain,
  });
});

// ─── MIDDLEWARE AUTH ──────────────────────────────────────────────
// WAVE-2 : partnerAuth / requireRole viennent du module commun (type
// bank_user | agent + role partenaire ; iss/aud verifies).

// ─── AUTH ─────────────────────────────────────────────────────────
router.post('/auth/login', loginLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(422).json({error:'Email et mot de passe requis'});
  try {
    const { user, type } = await findPartnerUser(email);
    if (!user) return res.status(401).json({error:'Identifiants incorrects'});
    const table = type === 'agent' ? 'agents' : 'bank_users';
    const idCol = type === 'agent' ? 'agent_id' : 'user_id';
    const id    = type === 'agent' ? user.agent_id : user.user_id;

    // Verrouillage apres PARTNER_MAX_FAILED echecs (audit §2.19)
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return res.status(423).json({ error: 'Compte temporairement verrouillé', lockedUntil: user.locked_until });
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const attempts = (user.failed_attempts || 0) + 1;
      const lockUntil = attempts >= PARTNER_MAX_FAILED ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await query(`UPDATE ${table} SET failed_attempts=$1, locked_until=$2 WHERE ${idCol}=$3`, [attempts, lockUntil, id]).catch(() => {});
      return res.status(401).json({error:'Identifiants incorrects', attemptsLeft: Math.max(0, PARTNER_MAX_FAILED - attempts)});
    }
    await query(`UPDATE ${table} SET failed_attempts=0, locked_until=NULL, last_login_at=NOW() WHERE ${idCol}=$1`, [id]).catch(() => {});

    const tenantId = req.tenant?.tenant_id || user.tenant_id || null;

    // 2FA (audit §2.11) : si la 2FA est activée, pas de session tant
    // que le code TOTP n'est pas validé via POST /auth/2fa/validate.
    if (user.is_mfa_enabled && user.mfa_secret) {
      const mfaToken = signMfaToken({ actorType: 'partner', sub: id, userType: type, tenantId });
      return res.json({ mfaRequired: true, mfaToken });
    }

    res.json(await buildSession(user, type, tenantId, req, res));
  } catch(err){ res.status(500).json({error:err.message}); }
});

// 2FA — validation du code TOTP après login (émet la session)
router.post('/auth/2fa/validate', async (req, res) => {
  const { mfaToken, code } = req.body;
  if (!mfaToken || !code) return res.status(422).json({error:'mfaToken et code requis'});
  try {
    let payload;
    try { payload = verifyMfaToken(mfaToken, 'partner'); }
    catch (e) { return res.status(401).json({error: e.message, code: e.code}); }

    const isAgent = payload.userType === 'agent';
    const user = await loadPartnerUser(isAgent ? 'agent' : 'bank_user', payload.sub);
    if (!user) return res.status(401).json({error:'Utilisateur introuvable'});
    if (!user.mfa_secret) return res.status(400).json({error:'2FA non configurée'});

    if (!verifyTotp(user.mfa_secret, code)) return res.status(401).json({error:'Code 2FA invalide', code:'INVALID_TOTP'});

    res.json(await buildSession(user, isAgent ? 'agent' : 'bank_user', payload.tenantId || null, req, res));
  } catch(err){ res.status(500).json({error:err.message}); }
});

// Refresh : cookie cp_rt_partner (ou corps), rotation + revocation.
// Branche legacy : l'ancien refresh JWT 7 j (payload complet, type bank_user |
// agent) est accepte pendant la fenetre de transition et journalise. Un access
// token ordinaire (8 h max) ne peut pas servir de refresh : exp - iat > 8 h.
router.post('/auth/refresh', async (req, res) => {
  const token = readRefreshToken(req, 'partner');
  if (!token) return res.status(422).json({error:'refreshToken requis'});
  try {
    const tokens = await rotateRefresh({
      actorType: 'partner', token, req, res,
      legacy: (d) => (['bank_user','agent'].includes(d.type) && d.sub && (d.exp - d.iat) > 8 * 3600)
        ? { actorId: d.sub, meta: { userType: d.type, tenantId: d.tenantId || null } } : null,
      buildClaims: async ({ actorId, meta }) => {
        const type = meta?.userType === 'agent' ? 'agent' : 'bank_user';
        const user = await loadPartnerUser(type, actorId);
        if (!user) throw new Error('Utilisateur introuvable');
        return partnerClaims(user, type, meta?.tenantId || null);
      },
    });
    res.json({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in });
  } catch (err) {
    res.status(err.statusCode || 401).json({ error: 'Refresh token invalide', code: err.code || 'INVALID_REFRESH' });
  }
});

router.post('/auth/logout', async (req, res) => {
  await revokeRefreshToken(readRefreshToken(req, 'partner'));
  clearRefreshCookie(res, 'partner');
  res.json({ success: true });
});

// Profil courant — sans secrets
router.get('/auth/me', partnerAuth, async (req, res) => {
  try {
    const r = req.user.role === 'agent'
      ? await query(`SELECT ${AGENT_PUBLIC}, ag.agency_name, b.bank_name FROM agents a JOIN agencies ag ON ag.agency_id=a.agency_id JOIN banks b ON b.bank_id=a.bank_id WHERE a.agent_id=$1`, [req.user.agentId])
      : await query(`SELECT ${BANK_USER_PUBLIC}, b.bank_name, a.agency_name FROM bank_users u LEFT JOIN banks b ON b.bank_id=u.bank_id LEFT JOIN agencies a ON a.agency_id=u.agency_id WHERE u.user_id=$1`, [req.user.sub]);
    if (!r.rows.length) return res.status(404).json({error:'Utilisateur introuvable'});
    const { temp_password, ...profile } = r.rows[0];
    res.json({ user: profile, mustChangePassword: !!temp_password });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── DASHBOARD STATS ──────────────────────────────────────────────
router.get('/dashboard', partnerAuth, async (req, res) => {
  try {
    const { role, bankId, agencyId, agentId } = req.user;

    if (['bank_admin','bank_user'].includes(role)) {
      const [agencies, agents, txns, volume] = await Promise.all([
        query(`SELECT COUNT(*) FROM agencies WHERE bank_id=$1`, [bankId]),
        query(`SELECT COUNT(*) FROM agents WHERE bank_id=$1`, [bankId]),
        query(`SELECT COUNT(*), SUM(amount) FROM agent_transactions WHERE bank_id=$1 AND DATE(initiated_at)=CURRENT_DATE`, [bankId]),
        query(`SELECT SUM(amount) FROM agent_transactions WHERE bank_id=$1 AND status='completed' AND initiated_at > NOW()-INTERVAL '30 days'`, [bankId]),
      ]);
      return res.json({
        role: 'bank',
        agencies:      parseInt(agencies.rows[0].count),
        agents:        parseInt(agents.rows[0].count),
        txnsToday:     parseInt(txns.rows[0].count),
        volumeToday:   parseFloat(txns.rows[0].sum||0),
        volumeMonth:   parseFloat(volume.rows[0].sum||0),
      });
    }

    if (['agency_admin','agency_user'].includes(role)) {
      const [agents, txns, float_] = await Promise.all([
        query(`SELECT COUNT(*) FROM agents WHERE agency_id=$1`, [agencyId]),
        query(`SELECT COUNT(*), SUM(amount) FROM agent_transactions WHERE agency_id=$1 AND DATE(initiated_at)=CURRENT_DATE`, [agencyId]),
        query(`SELECT float_balance FROM agencies WHERE agency_id=$1`, [agencyId]),
      ]);
      return res.json({
        role: 'agency',
        agents:      parseInt(agents.rows[0].count),
        txnsToday:   parseInt(txns.rows[0].count),
        volumeToday: parseFloat(txns.rows[0].sum||0),
        floatBalance: parseFloat(float_.rows[0]?.float_balance||0),
      });
    }

    if (role === 'agent') {
      const [txns, agent] = await Promise.all([
        query(`SELECT COUNT(*), SUM(amount), type FROM agent_transactions WHERE agent_id=$1 AND DATE(initiated_at)=CURRENT_DATE GROUP BY type`, [agentId]),
        query(`SELECT float_balance, float_limit FROM agents WHERE agent_id=$1`, [agentId]),
      ]);
      const stats = { collect:0, disburse:0, count:0 };
      txns.rows.forEach(r => { stats[r.type] = parseFloat(r.sum||0); stats.count += parseInt(r.count); });
      return res.json({
        role: 'agent',
        floatBalance: parseFloat(agent.rows[0]?.float_balance||0),
        floatLimit:   parseFloat(agent.rows[0]?.float_limit||0),
        collectToday:  stats.collect,
        disburseToday: stats.disburse,
        txnsToday:     stats.count,
      });
    }

    res.json({role});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── BANK — AGENCES ───────────────────────────────────────────────
router.get('/agencies', partnerAuth, requireRole('bank_admin','bank_user'), async (req, res) => {
  try {
    const r = await query(`SELECT a.*, COUNT(ag.agent_id) as agent_count
      FROM agencies a LEFT JOIN agents ag ON ag.agency_id=a.agency_id
      WHERE a.bank_id=$1 GROUP BY a.agency_id ORDER BY a.created_at DESC`, [req.user.bankId]);
    res.json({data: r.rows});
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/agencies', partnerAuth, requireRole('bank_admin'), async (req, res) => {
  const { agencyName, agencyCode, city, address, contactPhone, floatBalance=0 } = req.body;
  if (!agencyName || !agencyCode) return res.status(422).json({error:'agencyName et agencyCode requis'});
  try {
    const r = await query(
      `INSERT INTO agencies (bank_id, agency_name, agency_code, city, address, contact_phone, float_balance)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.user.bankId, agencyName, agencyCode, city||null, address||null, contactPhone||null, floatBalance]
    );
    res.status(201).json(r.rows[0]);
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.patch('/agencies/:id/status', partnerAuth, requireRole('bank_admin'), async (req, res) => {
  try {
    await query(`UPDATE agencies SET status=$1, updated_at=NOW() WHERE agency_id=$2 AND bank_id=$3`,
      [req.body.status, req.params.id, req.user.bankId]);
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── BANK/AGENCY — AGENTS ─────────────────────────────────────────
router.get('/agents', partnerAuth, async (req, res) => {
  try {
    const { role, bankId, agencyId } = req.user;
    const cond  = ['bank_admin','bank_user'].includes(role) ? 'a.bank_id=$1' : 'a.agency_id=$1';
    const param = ['bank_admin','bank_user'].includes(role) ? bankId : agencyId;
    const r = await query(
      `SELECT a.*, ag.agency_name FROM agents a
       JOIN agencies ag ON ag.agency_id=a.agency_id
       WHERE ${cond} ORDER BY a.created_at DESC`, [param]);
    res.json({data: r.rows.map(a => ({...a, password_hash:undefined}))});
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/agents', partnerAuth, requireRole('bank_admin','agency_admin'), async (req, res) => {
  const { firstName, lastName, email, phone, agencyId, floatLimit=500000 } = req.body;
  if (!firstName || !email) return res.status(422).json({error:'firstName et email requis'});
  try {
    // HOTFIX : mot de passe temporaire via crypto.randomBytes, renvoyé une seule fois
    const tempPwd = tempPassword('Agent');
    const hash = await bcrypt.hash(tempPwd, 12);
    const aId  = agencyId || req.user.agencyId;
    // Scoping : un agency_admin ne peut créer que dans sa propre agence
    if (req.user.role === 'agency_admin' && String(aId) !== String(req.user.agencyId))
      return res.status(403).json({error:'Agence hors périmètre'});
    const r = await query(
      `INSERT INTO agents (agency_id, bank_id, first_name, last_name, email, phone, password_hash, float_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING agent_id, email, first_name, last_name`,
      [aId, req.user.bankId, firstName, lastName, email, phone||null, hash, floatLimit]
    );
    res.status(201).json({...r.rows[0], tempPassword: tempPwd});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// HOTFIX IDOR (audit §2.17) : :id scopé à la banque (bank_admin) ou à l'agence (agency_admin)
const agentScope = (u) => u.role === 'bank_admin'
  ? { col: 'bank_id',   val: u.bankId }
  : { col: 'agency_id', val: u.agencyId };

router.patch('/agents/:id/status', partnerAuth, requireRole('bank_admin','agency_admin'), async (req, res) => {
  if (!['active','suspended','inactive'].includes(req.body.status)) return res.status(422).json({error:'Statut invalide'});
  try {
    const s = agentScope(req.user);
    const r = await query(`UPDATE agents SET status=$1, updated_at=NOW() WHERE agent_id=$2 AND ${s.col}=$3 RETURNING agent_id`,
      [req.body.status, req.params.id, s.val]);
    if (!r.rows.length) return res.status(404).json({error:'Agent introuvable'});
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.patch('/agents/:id/float', partnerAuth, requireRole('bank_admin','agency_admin'), async (req, res) => {
  const { amount, type='float_in' } = req.body;
  const amt = parseFloat(amount);
  if (!(amt > 0)) return res.status(422).json({error:'Montant invalide'});
  if (!['float_in','float_out'].includes(type)) return res.status(422).json({error:'Type invalide'});
  try {
    const s = agentScope(req.user);
    // HOTFIX concurrence (audit §2.7) : mises à jour atomiques `... AND float_balance >= $1`
    // dans une transaction, plus de check-then-update.
    const fail = (status, error) => Object.assign(new Error(error), { statusCode: status });
    await withTransaction(async client => {
      const ag = await client.query(`SELECT agent_id, agency_id FROM agents WHERE agent_id=$1 AND ${s.col}=$2 FOR UPDATE`,
        [req.params.id, s.val]);
      if (!ag.rows.length) throw fail(404, 'Agent introuvable');
      if (type === 'float_in') {
        const dec = await client.query(
          `UPDATE agencies SET float_balance=float_balance-$1, updated_at=NOW()
           WHERE agency_id=$2 AND float_balance >= $1 RETURNING agency_id`,
          [amt, ag.rows[0].agency_id]);
        if (!dec.rows.length) throw fail(400, 'Solde flottant agence insuffisant');
        await client.query(`UPDATE agents SET float_balance=float_balance+$1, updated_at=NOW() WHERE agent_id=$2`,
          [amt, req.params.id]);
      } else {
        const dec = await client.query(
          `UPDATE agents SET float_balance=float_balance-$1, updated_at=NOW()
           WHERE agent_id=$2 AND float_balance >= $1 RETURNING agent_id`,
          [amt, req.params.id]);
        if (!dec.rows.length) throw fail(400, 'Solde flottant agent insuffisant');
      }
    });
    res.json({success:true});
  } catch(err){
    if (err.statusCode) return res.status(err.statusCode).json({error:err.message});
    res.status(500).json({error:err.message});
  }
});

// ─── AGENT — COLLECT / DISBURSE ───────────────────────────────────
router.post('/collect', partnerAuth, requireRole('agent'), async (req, res) => {
  // HOTFIX P0 : `completed` immédiat sans opérateur → 410 (code conservé ci-dessous)
  if (FEATURE_DISABLED) return featureDisabled(res);
  const { amount, customerPhone, method, description, reference } = req.body;
  if (!amount || !customerPhone || !method) return res.status(422).json({error:'amount, customerPhone et method requis'});
  try {
    const agent = await query(`SELECT * FROM agents WHERE agent_id=$1`, [req.user.agentId]);
    if (!agent.rows.length) return res.status(404).json({error:'Agent introuvable'});
    const ref = reference || 'AGT-' + Date.now().toString(36).toUpperCase();
    const fee = Math.round(parseFloat(amount) * 0.015); // 1.5% frais
    const net = parseFloat(amount) - fee;
    const r = await query(
      `INSERT INTO agent_transactions (agent_id, agency_id, bank_id, type, amount, fee_amount, net_amount, currency, method, customer_phone, status, reference, description)
       VALUES ($1,$2,$3,'collect',$4,$5,$6,'XAF',$7,$8,'completed',$9,$10) RETURNING *`,
      [req.user.agentId, agent.rows[0].agency_id, agent.rows[0].bank_id,
       parseFloat(amount), fee, net, method, customerPhone, ref, description||null]
    );
    // Update float agent
    await query(`UPDATE agents SET float_balance=float_balance+$1 WHERE agent_id=$2`, [net, req.user.agentId]);
    res.json({success:true, txnId:r.rows[0].txn_id, reference:ref, status:'completed', amount, fee, net});
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/disburse', partnerAuth, requireRole('agent'), async (req, res) => {
  // HOTFIX P0 : `completed` immédiat sans opérateur → 410 (code conservé ci-dessous)
  if (FEATURE_DISABLED) return featureDisabled(res);
  const { amount, recipientPhone, method, description, reference } = req.body;
  if (!amount || !recipientPhone || !method) return res.status(422).json({error:'amount, recipientPhone et method requis'});
  try {
    const agent = await query(`SELECT * FROM agents WHERE agent_id=$1`, [req.user.agentId]);
    const ag = agent.rows[0];
    if (!ag) return res.status(404).json({error:'Agent introuvable'});
    const ref = reference || 'DSB-' + Date.now().toString(36).toUpperCase();
    const fee = Math.round(parseFloat(amount) * 0.01);
    const total = parseFloat(amount)+fee;
    // Débit atomique du float (plus de check-then-update)
    const out = await withTransaction(async client => {
      const dec = await client.query(
        `UPDATE agents SET float_balance=float_balance-$1 WHERE agent_id=$2 AND float_balance >= $1 RETURNING agent_id`,
        [total, req.user.agentId]);
      if (!dec.rows.length) return null;
      const r = await client.query(
        `INSERT INTO agent_transactions (agent_id, agency_id, bank_id, type, amount, fee_amount, net_amount, currency, method, customer_phone, status, reference, description)
         VALUES ($1,$2,$3,'disburse',$4,$5,$6,'XAF',$7,$8,'completed',$9,$10) RETURNING *`,
        [req.user.agentId, ag.agency_id, ag.bank_id,
         parseFloat(amount), fee, total, method, recipientPhone, ref, description||null]
      );
      return r.rows[0];
    });
    if (!out) return res.status(400).json({error:'Solde flottant insuffisant'});
    res.json({success:true, txnId:out.txn_id, reference:ref, status:'completed', amount, fee});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── TRANSACTIONS ─────────────────────────────────────────────────
// ─── RAPPORT CONSOLIDÉ ───────────────────────────────────────────
router.get('/transactions/report', partnerAuth, async (req, res) => {
  const { dateFrom, dateTo, agencyId, agentId, groupBy='day' } = req.query;
  const { role, bankId, agencyId: userAgencyId, agentId: userAgentId } = req.user;
  try {
    const conds = ['1=1']; const params = [];

    if (['bank_admin','bank_user'].includes(role)) {
      params.push(bankId); conds.push(`t.bank_id=$${params.length}`);
      if (agencyId) { params.push(agencyId); conds.push(`t.agency_id=$${params.length}`); }
      if (agentId)  { params.push(agentId);  conds.push(`t.agent_id=$${params.length}`); }
    } else if (['agency_admin','agency_user'].includes(role)) {
      params.push(userAgencyId); conds.push(`t.agency_id=$${params.length}`);
      if (agentId) { params.push(agentId); conds.push(`t.agent_id=$${params.length}`); }
    } else {
      params.push(userAgentId); conds.push(`t.agent_id=$${params.length}`);
    }

    if (dateFrom) { params.push(dateFrom); conds.push(`t.initiated_at>=$${params.length}`); }
    if (dateTo)   { params.push(dateTo+'T23:59:59'); conds.push(`t.initiated_at<=$${params.length}`); }

    const trunc = groupBy==='month' ? 'month' : groupBy==='week' ? 'week' : 'day';

    const [byPeriod, byType, byAgent, totals] = await Promise.all([
      query(`SELECT DATE_TRUNC('${trunc}', t.initiated_at) as period,
        COUNT(*) as count, SUM(t.amount) as volume, SUM(t.fee_amount) as fees
        FROM agent_transactions t WHERE ${conds.join(' AND ')}
        GROUP BY period ORDER BY period DESC LIMIT 90`, params),
      query(`SELECT t.type, COUNT(*) as count, SUM(t.amount) as volume
        FROM agent_transactions t WHERE ${conds.join(' AND ')}
        GROUP BY t.type`, params),
      query(`SELECT a.first_name||' '||a.last_name as agent_name, ag.agency_name,
        COUNT(*) as count, SUM(t.amount) as volume
        FROM agent_transactions t
        JOIN agents a ON a.agent_id=t.agent_id
        JOIN agencies ag ON ag.agency_id=t.agency_id
        WHERE ${conds.join(' AND ')}
        GROUP BY a.agent_id, a.first_name, a.last_name, ag.agency_name
        ORDER BY volume DESC LIMIT 20`, params),
      query(`SELECT COUNT(*) as total_txns, SUM(amount) as total_volume,
        SUM(fee_amount) as total_fees,
        SUM(CASE WHEN status='completed' THEN amount ELSE 0 END) as completed_volume,
        SUM(CASE WHEN type='collect' THEN amount ELSE 0 END) as collect_volume,
        SUM(CASE WHEN type='disburse' THEN amount ELSE 0 END) as disburse_volume
        FROM agent_transactions t WHERE ${conds.join(' AND ')}`, params)
    ]);

    res.json({
      totals: totals.rows[0],
      byPeriod: byPeriod.rows,
      byType: byType.rows,
      topAgents: byAgent.rows,
    });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.get('/transactions', partnerAuth, async (req, res) => {
  const { status, type, dateFrom, dateTo } = req.query;
  const { page, limit, offset } = parsePagination(req.query);
  const { role, bankId, agencyId, agentId } = req.user;
  try {
    const conds = ['1=1']; const params = [];
    if (['bank_admin','bank_user'].includes(role)) { params.push(bankId); conds.push(`t.bank_id=$${params.length}`); }
    else if (['agency_admin','agency_user'].includes(role)) { params.push(agencyId); conds.push(`t.agency_id=$${params.length}`); }
    else { params.push(agentId); conds.push(`t.agent_id=$${params.length}`); }
    if (status) { params.push(status); conds.push(`t.status=$${params.length}`); }
    if (type)   { params.push(type);   conds.push(`t.type=$${params.length}`); }
    if (dateFrom){ params.push(dateFrom); conds.push(`t.initiated_at>=$${params.length}`); }
    if (dateTo)  { params.push(dateTo);   conds.push(`t.initiated_at<=$${params.length}`); }
    const r = await query(
      `SELECT t.*, a.first_name||' '||a.last_name as agent_name, ag.agency_name
       FROM agent_transactions t
       JOIN agents a ON a.agent_id=t.agent_id
       JOIN agencies ag ON ag.agency_id=t.agency_id
       WHERE ${conds.join(' AND ')}
       ORDER BY t.initiated_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    const cnt = await query(`SELECT COUNT(*), SUM(amount) FROM agent_transactions t WHERE ${conds.join(' AND ')}`, params);
    res.json({ data:r.rows, total:parseInt(cnt.rows[0].count), volume:parseFloat(cnt.rows[0].sum||0), page, limit });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── PROFILE ──────────────────────────────────────────────────────
router.get('/profile', partnerAuth, async (req, res) => {
  try {
    const { role, agentId, sub } = req.user;
    // WAVE-2 (audit §2.12) : colonnes explicites — jamais password_hash / mfa_secret
    if (role === 'agent') {
      const r = await query(`SELECT ${AGENT_PUBLIC}, ag.agency_name, b.bank_name FROM agents a JOIN agencies ag ON ag.agency_id=a.agency_id JOIN banks b ON b.bank_id=a.bank_id WHERE a.agent_id=$1`, [agentId]);
      return res.json({...r.rows[0]});
    }
    const r = await query(`SELECT ${BANK_USER_PUBLIC}, b.bank_name, a.agency_name FROM bank_users u LEFT JOIN banks b ON b.bank_id=u.bank_id LEFT JOIN agencies a ON a.agency_id=u.agency_id WHERE u.user_id=$1`, [sub]);
    res.json({...r.rows[0]});
  } catch(err){ res.status(500).json({error:err.message}); }
});

module.exports = router;

// ─── GESTION UTILISATEURS BANQUE ─────────────────────────────────
const ALLOWED_ROLES = ['bank_admin','bank_user','agency_admin','agency_user',
                       'customer_care','caissier_maker','caissier_checker','controleur','financier'];

router.get('/users', partnerAuth, requireRole('bank_admin'), async (req, res) => {
  try {
    // WAVE-2 (audit §2.12) : colonnes explicites — jamais password_hash / mfa_secret
    const r = await query(`SELECT ${BANK_USER_PUBLIC}, a.agency_name FROM bank_users u
      LEFT JOIN agencies a ON a.agency_id=u.agency_id
      WHERE u.bank_id=$1 ORDER BY u.created_at DESC`, [req.user.bankId]);
    res.json({ data: r.rows });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/users', partnerAuth, requireRole('bank_admin','agency_admin'), async (req, res) => {
  const { firstName, lastName, email, phone, role, agencyId } = req.body;
  if (!firstName || !email || !role) return res.status(422).json({error:'firstName, email et role requis'});
  if (!ALLOWED_ROLES.includes(role)) return res.status(422).json({error:'Rôle invalide'});
  try {
    // HOTFIX : mot de passe temporaire via crypto.randomBytes, renvoyé une seule fois (jamais stocké en clair)
    const tempPwd = tempPassword('User');
    const hash    = await bcrypt.hash(tempPwd, 12);
    const aId     = agencyId || req.user.agencyId || null;
    if (req.user.role === 'agency_admin' && String(aId) !== String(req.user.agencyId))
      return res.status(403).json({error:'Agence hors périmètre'});
    const r = await query(
      `INSERT INTO bank_users (bank_id, agency_id, first_name, last_name, email, phone, password_hash, role, temp_password)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE) RETURNING user_id, email, first_name, last_name, role`,
      [req.user.bankId, aId, firstName, lastName||'', email, phone||null, hash, role]
    );
    res.status(201).json({ ...r.rows[0], tempPassword: tempPwd });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.patch('/users/:id/status', partnerAuth, requireRole('bank_admin'), async (req, res) => {
  try {
    await query(`UPDATE bank_users SET status=$1, updated_at=NOW() WHERE user_id=$2 AND bank_id=$3`,
      [req.body.status, req.params.id, req.user.bankId]);
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.patch('/users/:id/role', partnerAuth, requireRole('bank_admin'), async (req, res) => {
  if (!ALLOWED_ROLES.includes(req.body.role)) return res.status(422).json({error:'Rôle invalide'});
  try {
    await query(`UPDATE bank_users SET role=$1, updated_at=NOW() WHERE user_id=$2 AND bank_id=$3`,
      [req.body.role, req.params.id, req.user.bankId]);
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── CHANGE PASSWORD ─────────────────────────────────────────────
router.post('/auth/change-password', partnerAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(422).json({error:'Champs requis'});
  if (newPassword.length < 8) return res.status(422).json({error:'8 caractères minimum'});
  try {
    const { table, idCol, id } = userTarget(req.user);
    const r = await query(`SELECT password_hash FROM ${table} WHERE ${idCol}=$1`, [id]);
    if (!r.rows.length) return res.status(404).json({error:'Utilisateur introuvable'});
    const valid = await bcrypt.compare(currentPassword, r.rows[0].password_hash);
    if (!valid) return res.status(401).json({error:'Mot de passe actuel incorrect'});
    const hash = await bcrypt.hash(newPassword, 12);
    // WAVE-2 : leve temp_password, revoque toutes les sessions du partenaire
    await query(`UPDATE ${table} SET password_hash=$1, temp_password=FALSE, updated_at=NOW() WHERE ${idCol}=$2`, [hash, id]);
    await revokeAll('partner', id);
    clearRefreshCookie(res, 'partner');
    res.json({success:true, sessionsRevoked:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── 2FA SETUP/VERIFY/DISABLE ────────────────────────────────────
// HOTFIX 2FA (audit §2.11) : TOTP réel via speakeasy, secret base32 stocké sur
// la ligne utilisateur (mfa_secret, cf. 007a), QR généré côté serveur.
router.get('/auth/2fa/status', partnerAuth, async (req, res) => {
  try {
    const { table, idCol, id } = userTarget(req.user);
    const r = await query(`SELECT is_mfa_enabled FROM ${table} WHERE ${idCol}=$1`, [id]);
    res.json({ mfaEnabled: r.rows[0]?.is_mfa_enabled || false });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/auth/2fa/setup', partnerAuth, async (req, res) => {
  try {
    const { table, idCol, id } = userTarget(req.user);
    const enrollment = await buildTotpEnrollment({ label: req.user.email, issuer: 'C-Pay Partners' });
    // Secret stocké sur l'utilisateur, 2FA non activée tant que /verify n'a pas réussi
    await query(`UPDATE ${table} SET mfa_secret=$1, is_mfa_enabled=FALSE, updated_at=NOW() WHERE ${idCol}=$2`, [enrollment.secret, id]);
    res.json(enrollment);
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/auth/2fa/verify', partnerAuth, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') return res.status(400).json({error:'Code requis'});
  try {
    const { table, idCol, id } = userTarget(req.user);
    const u = await query(`SELECT mfa_secret FROM ${table} WHERE ${idCol}=$1`, [id]);
    if (!u.rows[0]?.mfa_secret) return res.status(400).json({error:'2FA non configurée'});
    if (!verifyTotp(u.rows[0].mfa_secret, token)) return res.status(400).json({error:'Code invalide'});
    await query(`UPDATE ${table} SET is_mfa_enabled=TRUE, updated_at=NOW() WHERE ${idCol}=$1`, [id]);
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/auth/2fa/disable', partnerAuth, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') return res.status(400).json({error:'Code requis'});
  try {
    const { table, idCol, id } = userTarget(req.user);
    const u = await query(`SELECT mfa_secret FROM ${table} WHERE ${idCol}=$1`, [id]);
    if (!u.rows[0]?.mfa_secret) return res.status(400).json({error:'2FA non configurée'});
    if (!verifyTotp(u.rows[0].mfa_secret, token)) return res.status(400).json({error:'Code invalide'});
    await query(`UPDATE ${table} SET is_mfa_enabled=FALSE, mfa_secret=NULL, updated_at=NOW() WHERE ${idCol}=$1`, [id]);
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── RESET LINK (admin → user) ───────────────────────────────────
// HOTFIX (audit §2.14) : le token n'est JAMAIS renvoyé à l'appelant ; seul son
// hash SHA-256 est stocké (partner_password_resets, cf. 007a) ; :id est scopé
// à la banque (bank_admin) / l'agence (agency_admin) de l'appelant ; le lien
// part par email au destinataire. POST /auth/reset-password le consomme.
router.post('/users/:id/reset-link', partnerAuth, requireRole('bank_admin','agency_admin'), async (req, res) => {
  try {
    const scope = req.user.role === 'bank_admin'
      ? { sql: 'bank_id=$2', val: req.user.bankId }
      : { sql: 'agency_id=$2', val: req.user.agencyId };
    const target = await query(
      `SELECT user_id, email, first_name FROM bank_users WHERE user_id=$1 AND ${scope.sql}`,
      [req.params.id, scope.val]);
    if (!target.rows.length) return res.status(404).json({error:'Utilisateur introuvable'});
    const u = target.rows[0];

    const raw     = crypto.randomBytes(32).toString('hex');
    const hash    = crypto.createHash('sha256').update(raw).digest('hex');
    const expires = new Date(Date.now() + 24*3600*1000);
    await query(`UPDATE partner_password_resets SET used_at=NOW() WHERE user_id=$1 AND used_at IS NULL`, [String(u.user_id)]);
    await query(
      `INSERT INTO partner_password_resets (user_type, user_id, token_hash, expires_at, created_by)
       VALUES ('bank_user',$1,$2,$3,$4)`,
      [String(u.user_id), hash, expires, String(req.user.sub)]);

    const resetUrl = `${process.env.APP_URL_PARTNERS || 'https://partners.c-pay.global'}/reset?token=${raw}`;
    let emailed = false;
    try {
      const emailSvc = require('../services/notifications/email.service');
      if (emailSvc.send) {
        await emailSvc.send({
          to: u.email,
          subject: 'Réinitialisation de votre mot de passe CPlus Partners',
          html: `<p>Bonjour ${u.first_name || ''},</p><p>Un administrateur a demandé la réinitialisation de votre mot de passe.</p>
            <p><a href="${resetUrl}">Réinitialiser mon mot de passe</a></p><p>Ce lien est valable 24h.</p>`,
        });
        emailed = true;
      }
    } catch (e) { console.error('[reset-link] email:', e.message); }

    res.json({ success:true, emailed, message:'Lien de réinitialisation envoyé au destinataire (valable 24h)' });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// Consommation du lien (utilisateur bank_users)
router.post('/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(422).json({error:'Token et nouveau mot de passe requis'});
  if (newPassword.length < 8) return res.status(422).json({error:'8 caractères minimum'});
  try {
    const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const r = await query(
      `SELECT reset_id, user_id FROM partner_password_resets
       WHERE token_hash=$1 AND user_type='bank_user' AND used_at IS NULL AND expires_at > NOW() LIMIT 1`, [hash]);
    if (!r.rows.length) return res.status(400).json({error:'Lien invalide ou expiré', code:'INVALID_TOKEN'});
    const pwdHash = await bcrypt.hash(newPassword, 12);
    await withTransaction(async client => {
      await client.query(`UPDATE bank_users SET password_hash=$1, temp_password=FALSE, failed_attempts=0, locked_until=NULL, updated_at=NOW() WHERE user_id=$2`, [pwdHash, r.rows[0].user_id]);
      await client.query(`UPDATE partner_password_resets SET used_at=NOW() WHERE reset_id=$1`, [r.rows[0].reset_id]);
    });
    // WAVE-2 (audit §2.15) : toutes les sessions existantes sont revoquees apres un reset
    await revokeAll('partner', r.rows[0].user_id);
    res.json({ success:true, message:'Mot de passe réinitialisé.', sessionsRevoked:true });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── MAKER/CHECKER WORKFLOW ───────────────────────────────────────
const APPROVAL_THRESHOLD = 100; // XAF — toute transaction > seuil nécessite approbation

// Maker — soumettre une transaction pour approbation
router.post('/approvals', partnerAuth, requireRole('caissier_maker','agent'), async (req, res) => {
  const { type, amount, customerPhone, method, description, reference } = req.body;
  if (!type || !amount || !customerPhone || !method) return res.status(422).json({error:'type, amount, customerPhone et method requis'});
  try {
    const agent = await query(`SELECT * FROM agents WHERE agent_id=$1`, [req.user.agentId]);
    if (!agent.rows.length) return res.status(404).json({error:'Agent introuvable'});
    const ag = agent.rows[0];

    const fee = Math.round(parseFloat(amount) * (type==='collect'?0.015:0.01));
    const ref = reference || 'MK-' + Date.now().toString(36).toUpperCase();

    if (parseFloat(amount) > APPROVAL_THRESHOLD) {
      // Soumettre pour approbation
      const r = await query(
        `INSERT INTO pending_approvals (agency_id, bank_id, maker_id, type, amount, fee_amount, currency, method, customer_phone, description, reference)
         VALUES ($1,$2,$3,$4,$5,$6,'XAF',$7,$8,$9,$10) RETURNING *`,
        [ag.agency_id, ag.bank_id, req.user.agentId, type, parseFloat(amount), fee, method, customerPhone, description||null, ref]
      );
      // Notifier les checkers de l'agence
      await query(`INSERT INTO admin_notifications (type, title, message, metadata)
        VALUES ('maker_approval_request','Approbation requise',$1,$2)`,
        [`Transaction ${type} de ${parseFloat(amount).toLocaleString('fr-FR')} XAF en attente d'approbation`,
         JSON.stringify({ approvalId: r.rows[0].approval_id, agencyId: ag.agency_id, amount, type })]
      ).catch(()=>{});
      res.status(201).json({ success:true, status:'pending_approval', approvalId:r.rows[0].approval_id, reference:ref,
        message:`Transaction soumise pour approbation — en attente du Checker` });
    } else {
      // Exécuter directement si <= seuil — float ajusté atomiquement (HOTFIX concurrence)
      const net = type==='collect' ? parseFloat(amount)-fee : parseFloat(amount)+fee;
      const out = await withTransaction(async client => {
        const upd = type==='collect'
          ? await client.query(`UPDATE agents SET float_balance=float_balance+$1 WHERE agent_id=$2 RETURNING agent_id`, [net, req.user.agentId])
          : await client.query(`UPDATE agents SET float_balance=float_balance-$1 WHERE agent_id=$2 AND float_balance >= $1 RETURNING agent_id`, [net, req.user.agentId]);
        if (!upd.rows.length) return null;
        const r = await client.query(
          `INSERT INTO agent_transactions (agent_id, agency_id, bank_id, type, amount, fee_amount, net_amount, currency, method, customer_phone, status, reference, description)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'XAF',$8,$9,'completed',$10,$11) RETURNING *`,
          [req.user.agentId, ag.agency_id, ag.bank_id, type, parseFloat(amount), fee, net,
           method, customerPhone, ref, description||null]
        );
        return r.rows[0];
      });
      if (!out) return res.status(400).json({error:'Solde flottant insuffisant'});
      res.json({ success:true, status:'completed', txnId:out.txn_id, reference:ref, amount, fee });
    }
  } catch(err){ res.status(500).json({error:err.message}); }
});

// Maker — lister ses demandes en attente
router.get('/approvals/mine', partnerAuth, requireRole('caissier_maker','agent'), async (req, res) => {
  try {
    const r = await query(`SELECT * FROM pending_approvals WHERE maker_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.user.agentId]);
    res.json({ data: r.rows });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// Checker — lister les demandes en attente de son agence
router.get('/approvals/pending', partnerAuth, requireRole('caissier_checker','agency_admin','bank_admin'), async (req, res) => {
  try {
    const { role, agencyId, bankId } = req.user;
    const cond  = ['bank_admin'].includes(role) ? 'pa.bank_id=$1'   : 'pa.agency_id=$1';
    const param = ['bank_admin'].includes(role) ? bankId : agencyId;
    const r = await query(
      `SELECT pa.*, a.first_name||' '||a.last_name as maker_name, ag.agency_name
       FROM pending_approvals pa
       JOIN agents a ON a.agent_id=pa.maker_id
       JOIN agencies ag ON ag.agency_id=pa.agency_id
       WHERE ${cond} AND pa.status='pending'
       ORDER BY pa.created_at DESC`, [param]
    );
    res.json({ data: r.rows, total: r.rows.length });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// Checker — approuver une transaction
// HOTFIX IDOR (audit §2.17) : le checker doit appartenir à la même banque
// (bank_admin) ou à la même agence (agency_admin / caissier_checker).
const approvalScope = (u) => u.role === 'bank_admin'
  ? { sql: 'bank_id=$2',   val: u.bankId }
  : { sql: 'agency_id=$2', val: u.agencyId };

router.post('/approvals/:id/approve', partnerAuth, requireRole('caissier_checker','agency_admin','bank_admin'), async (req, res) => {
  try {
    const scope = approvalScope(req.user);
    const fail = (status, error) => Object.assign(new Error(error), { statusCode: status });
    const out = await withTransaction(async client => {
      const r = await client.query(
        `SELECT * FROM pending_approvals WHERE approval_id=$1 AND ${scope.sql} AND status='pending' FOR UPDATE`,
        [req.params.id, scope.val]);
      if (!r.rows.length) throw fail(404, 'Demande introuvable ou déjà traitée');
      const ap = r.rows[0];

      // Vérifier que le checker n'est pas le maker
      if (req.user.agentId && String(ap.maker_id) === String(req.user.agentId))
        throw fail(403, 'Vous ne pouvez pas approuver votre propre transaction');

      // Float ajusté atomiquement AVANT l'écriture de la transaction (HOTFIX concurrence)
      const net = ap.type==='collect' ? parseFloat(ap.amount)-parseFloat(ap.fee_amount) : parseFloat(ap.amount)+parseFloat(ap.fee_amount);
      const upd = ap.type==='collect'
        ? await client.query(`UPDATE agents SET float_balance=float_balance+$1 WHERE agent_id=$2 RETURNING agent_id`, [net, ap.maker_id])
        : await client.query(`UPDATE agents SET float_balance=float_balance-$1 WHERE agent_id=$2 AND float_balance >= $1 RETURNING agent_id`, [net, ap.maker_id]);
      if (!upd.rows.length) throw fail(400, 'Solde flottant insuffisant');

      const txn = await client.query(
        `INSERT INTO agent_transactions (agent_id, agency_id, bank_id, type, amount, fee_amount, net_amount, currency, method, customer_phone, status, reference, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'completed',$11,$12) RETURNING txn_id`,
        [ap.maker_id, ap.agency_id, ap.bank_id, ap.type, ap.amount, ap.fee_amount, net, ap.currency, ap.method, ap.customer_phone, ap.reference, ap.description]
      );

      await client.query(`UPDATE pending_approvals SET status='approved', checker_id=$1, approved_at=NOW(), updated_at=NOW() WHERE approval_id=$2`,
        [req.user.sub, req.params.id]);
      return txn.rows[0];
    });

    res.json({ success:true, txnId: out.txn_id, message:'Transaction approuvée et exécutée ✅' });
  } catch(err){
    if (err.statusCode) return res.status(err.statusCode).json({error:err.message});
    res.status(500).json({error:err.message});
  }
});

// Checker — rejeter une transaction
router.post('/approvals/:id/reject', partnerAuth, requireRole('caissier_checker','agency_admin','bank_admin'), async (req, res) => {
  const { reason } = req.body;
  try {
    const scope = approvalScope(req.user);
    const r = await query(`SELECT * FROM pending_approvals WHERE approval_id=$1 AND ${scope.sql} AND status='pending'`, [req.params.id, scope.val]);
    if (!r.rows.length) return res.status(404).json({error:'Demande introuvable ou déjà traitée'});
    if (r.rows[0].maker_id === req.user.agentId) return res.status(403).json({error:'Vous ne pouvez pas rejeter votre propre transaction'});

    await query(`UPDATE pending_approvals SET status='rejected', checker_id=$1, rejection_reason=$2, rejected_at=NOW(), updated_at=NOW() WHERE approval_id=$3`,
      [req.user.sub, reason||'Rejetée par le checker', req.params.id]);

    res.json({ success:true, message:'Transaction rejetée ✅' });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// Maker — annuler une demande
router.post('/approvals/:id/cancel', partnerAuth, requireRole('caissier_maker','agent'), async (req, res) => {
  try {
    await query(`UPDATE pending_approvals SET status='cancelled', updated_at=NOW() WHERE approval_id=$1 AND maker_id=$2 AND status='pending'`,
      [req.params.id, req.user.agentId]);
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// Historique approvals (all roles)
router.get('/approvals/history', partnerAuth, async (req, res) => {
  const { status } = req.query;
  const { page, limit, offset } = parsePagination(req.query);
  const { role, agencyId, bankId, agentId } = req.user;
  try {
    const conds = ['1=1']; const params = [];
    if (['bank_admin','bank_user'].includes(role))         { params.push(bankId);   conds.push(`pa.bank_id=$${params.length}`); }
    else if (['agency_admin','agency_user','caissier_checker'].includes(role)) { params.push(agencyId); conds.push(`pa.agency_id=$${params.length}`); }
    else                                                   { params.push(agentId);  conds.push(`pa.maker_id=$${params.length}`); }
    if (status) { params.push(status); conds.push(`pa.status=$${params.length}`); }
    const r = await query(
      `SELECT pa.*, a.first_name||' '||a.last_name as maker_name, ag.agency_name
       FROM pending_approvals pa
       JOIN agents a ON a.agent_id=pa.maker_id
       JOIN agencies ag ON ag.agency_id=pa.agency_id
       WHERE ${conds.join(' AND ')}
       ORDER BY pa.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    const cnt = await query(`SELECT COUNT(*) FROM pending_approvals pa WHERE ${conds.join(' AND ')}`, params);
    res.json({ data: r.rows, total: parseInt(cnt.rows[0].count), page, limit });
  } catch(err){ res.status(500).json({error:err.message}); }
});
