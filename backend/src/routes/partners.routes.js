'use strict';
const express  = require('express');
const router   = express.Router();
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { query } = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET;
const signToken  = (payload, exp = '8h') => jwt.sign(payload, JWT_SECRET, { expiresIn: exp });

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
const partnerAuth = async (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({error:'Non authentifié'});
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
    if (!['bank_admin','bank_user','agency_admin','agency_user','agent'].includes(decoded.role)) {
      return res.status(403).json({error:'Accès refusé'});
    }
    req.user = decoded;
    next();
  } catch { res.status(401).json({error:'Token invalide'}); }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role)) return res.status(403).json({error:'Permission insuffisante'});
  next();
};

// ─── AUTH ─────────────────────────────────────────────────────────
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(422).json({error:'Email et mot de passe requis'});
  try {
    // Essayer bank_users d'abord
    let user = null;
    let type = null;
    const bu = await query(`SELECT u.*, b.bank_name, a.agency_name FROM bank_users u
      LEFT JOIN banks b ON b.bank_id=u.bank_id
      LEFT JOIN agencies a ON a.agency_id=u.agency_id
      WHERE u.email=$1 AND u.status='active'`, [email]);
    if (bu.rows.length) { user = bu.rows[0]; type = 'bank_user'; }

    // Essayer agents
    if (!user) {
      const ag = await query(`SELECT a.*, ag.agency_name, b.bank_name FROM agents a
        JOIN agencies ag ON ag.agency_id=a.agency_id
        JOIN banks b ON b.bank_id=a.bank_id
        WHERE a.email=$1 AND a.status='active'`, [email]);
      if (ag.rows.length) { user = ag.rows[0]; type = 'agent'; }
    }

    if (!user) return res.status(401).json({error:'Identifiants incorrects'});
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({error:'Identifiants incorrects'});

    const tenantId = req.tenant?.tenant_id || user.tenant_id || null;
    const payload = {
      sub:      type === 'agent' ? user.agent_id : user.user_id,
      email:    user.email,
      role:     user.role,
      type,
      bankId:   user.bank_id,
      agencyId: user.agency_id || null,
      agentId:  type === 'agent' ? user.agent_id : null,
      tenantId,
      name:     `${user.first_name} ${user.last_name}`,
    };
    res.json({
      access_token:  signToken(payload),
      refresh_token: signToken(payload, '7d'),
      user: {
        id:         payload.sub,
        name:       payload.name,
        email:      user.email,
        role:       user.role,
        type,
        bankName:   user.bank_name,
        agencyName: user.agency_name || null,
        floatBalance: user.float_balance || null,
        floatLimit:   user.float_limit  || null,
      }
    });
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
    const tempPassword = 'Agent@' + Math.random().toString(36).slice(2,8).toUpperCase();
    const hash = await bcrypt.hash(tempPassword, 12);
    const aId  = agencyId || req.user.agencyId;
    const r = await query(
      `INSERT INTO agents (agency_id, bank_id, first_name, last_name, email, phone, password_hash, float_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING agent_id, email, first_name, last_name`,
      [aId, req.user.bankId, firstName, lastName, email, phone||null, hash, floatLimit]
    );
    res.status(201).json({...r.rows[0], tempPassword});
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.patch('/agents/:id/status', partnerAuth, requireRole('bank_admin','agency_admin'), async (req, res) => {
  try {
    await query(`UPDATE agents SET status=$1, updated_at=NOW() WHERE agent_id=$2`, [req.body.status, req.params.id]);
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.patch('/agents/:id/float', partnerAuth, requireRole('bank_admin','agency_admin'), async (req, res) => {
  const { amount, type='float_in' } = req.body;
  if (!amount || amount <= 0) return res.status(422).json({error:'Montant invalide'});
  try {
    const sign = type === 'float_in' ? 1 : -1;
    await query(`UPDATE agents SET float_balance=float_balance+$1, updated_at=NOW() WHERE agent_id=$2`,
      [parseFloat(amount)*sign, req.params.id]);
    if (type === 'float_in') {
      await query(`UPDATE agencies SET float_balance=float_balance-$1 WHERE agency_id=(SELECT agency_id FROM agents WHERE agent_id=$2)`,
        [parseFloat(amount), req.params.id]);
    }
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── AGENT — COLLECT / DISBURSE ───────────────────────────────────
router.post('/collect', partnerAuth, requireRole('agent'), async (req, res) => {
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
  const { amount, recipientPhone, method, description, reference } = req.body;
  if (!amount || !recipientPhone || !method) return res.status(422).json({error:'amount, recipientPhone et method requis'});
  try {
    const agent = await query(`SELECT * FROM agents WHERE agent_id=$1`, [req.user.agentId]);
    const ag = agent.rows[0];
    if (parseFloat(ag.float_balance) < parseFloat(amount)) return res.status(400).json({error:'Solde flottant insuffisant'});
    const ref = reference || 'DSB-' + Date.now().toString(36).toUpperCase();
    const fee = Math.round(parseFloat(amount) * 0.01);
    const r = await query(
      `INSERT INTO agent_transactions (agent_id, agency_id, bank_id, type, amount, fee_amount, net_amount, currency, method, customer_phone, status, reference, description)
       VALUES ($1,$2,$3,'disburse',$4,$5,$6,'XAF',$7,$8,'completed',$9,$10) RETURNING *`,
      [req.user.agentId, ag.agency_id, ag.bank_id,
       parseFloat(amount), fee, parseFloat(amount)+fee, method, recipientPhone, ref, description||null]
    );
    await query(`UPDATE agents SET float_balance=float_balance-$1 WHERE agent_id=$2`, [parseFloat(amount)+fee, req.user.agentId]);
    res.json({success:true, txnId:r.rows[0].txn_id, reference:ref, status:'completed', amount, fee});
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
  const { page=1, limit=20, status, type, dateFrom, dateTo } = req.query;
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
    const offset = (parseInt(page)-1)*parseInt(limit);
    const r = await query(
      `SELECT t.*, a.first_name||' '||a.last_name as agent_name, ag.agency_name
       FROM agent_transactions t
       JOIN agents a ON a.agent_id=t.agent_id
       JOIN agencies ag ON ag.agency_id=t.agency_id
       WHERE ${conds.join(' AND ')}
       ORDER BY t.initiated_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, parseInt(limit), offset]
    );
    const cnt = await query(`SELECT COUNT(*), SUM(amount) FROM agent_transactions t WHERE ${conds.join(' AND ')}`, params);
    res.json({ data:r.rows, total:parseInt(cnt.rows[0].count), volume:parseFloat(cnt.rows[0].sum||0), page:parseInt(page), limit:parseInt(limit) });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── PROFILE ──────────────────────────────────────────────────────
router.get('/profile', partnerAuth, async (req, res) => {
  try {
    const { role, agentId, sub } = req.user;
    if (role === 'agent') {
      const r = await query(`SELECT a.*, ag.agency_name, b.bank_name FROM agents a JOIN agencies ag ON ag.agency_id=a.agency_id JOIN banks b ON b.bank_id=a.bank_id WHERE a.agent_id=$1`, [agentId]);
      return res.json({...r.rows[0], password_hash:undefined});
    }
    const r = await query(`SELECT u.*, b.bank_name, a.agency_name FROM bank_users u LEFT JOIN banks b ON b.bank_id=u.bank_id LEFT JOIN agencies a ON a.agency_id=u.agency_id WHERE u.user_id=$1`, [sub]);
    res.json({...r.rows[0], password_hash:undefined});
  } catch(err){ res.status(500).json({error:err.message}); }
});

module.exports = router;

// ─── GESTION UTILISATEURS BANQUE ─────────────────────────────────
const ALLOWED_ROLES = ['bank_admin','bank_user','agency_admin','agency_user',
                       'customer_care','caissier_maker','caissier_checker','controleur','financier'];

router.get('/users', partnerAuth, requireRole('bank_admin'), async (req, res) => {
  try {
    const r = await query(`SELECT u.*, a.agency_name FROM bank_users u
      LEFT JOIN agencies a ON a.agency_id=u.agency_id
      WHERE u.bank_id=$1 ORDER BY u.created_at DESC`, [req.user.bankId]);
    res.json({ data: r.rows.map(u=>({...u,password_hash:undefined})) });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/users', partnerAuth, requireRole('bank_admin','agency_admin'), async (req, res) => {
  const { firstName, lastName, email, phone, role, agencyId } = req.body;
  if (!firstName || !email || !role) return res.status(422).json({error:'firstName, email et role requis'});
  if (!ALLOWED_ROLES.includes(role)) return res.status(422).json({error:'Rôle invalide'});
  try {
    const bcrypt  = require('bcryptjs');
    const crypto  = require('crypto');
    const tempPwd = 'User@' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const hash    = await bcrypt.hash(tempPwd, 12);
    const aId     = agencyId || req.user.agencyId || null;
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
    const bcrypt = require('bcryptjs');
    const table  = req.user.role==='agent' ? 'agents' : 'bank_users';
    const idCol  = req.user.role==='agent' ? 'agent_id' : 'user_id';
    const id     = req.user.role==='agent' ? req.user.agentId : req.user.sub;
    const r = await query(`SELECT password_hash FROM ${table} WHERE ${idCol}=$1`, [id]);
    if (!r.rows.length) return res.status(404).json({error:'Utilisateur introuvable'});
    const valid = await bcrypt.compare(currentPassword, r.rows[0].password_hash);
    if (!valid) return res.status(401).json({error:'Mot de passe actuel incorrect'});
    const hash = await bcrypt.hash(newPassword, 12);
    await query(`UPDATE ${table} SET password_hash=$1, updated_at=NOW() WHERE ${idCol}=$2`, [hash, id]);
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── 2FA SETUP/VERIFY/DISABLE ────────────────────────────────────
router.get('/auth/2fa/status', partnerAuth, async (req, res) => {
  try {
    const table = req.user.role==='agent' ? 'agents' : 'bank_users';
    const idCol = req.user.role==='agent' ? 'agent_id' : 'user_id';
    const id    = req.user.role==='agent' ? req.user.agentId : req.user.sub;
    const r = await query(`SELECT is_mfa_enabled FROM ${table} WHERE ${idCol}=$1`, [id]);
    res.json({ mfaEnabled: r.rows[0]?.is_mfa_enabled || false });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/auth/2fa/setup', partnerAuth, async (req, res) => {
  try {
    const secret  = require('crypto').randomBytes(20).toString('base32').slice(0,32);
    const qrCode  = `otpauth://totp/CPlus%20Partners:${encodeURIComponent(req.user.email)}?secret=${secret}&issuer=CPlus`;
    const table   = req.user.role==='agent' ? 'agents' : 'bank_users';
    const idCol   = req.user.role==='agent' ? 'agent_id' : 'user_id';
    const id      = req.user.role==='agent' ? req.user.agentId : req.user.sub;
    // Stocker secret temporairement
    await query(`UPDATE ${table} SET is_mfa_enabled=FALSE WHERE ${idCol}=$1`, [id]).catch(()=>{});
    // Stocker secret dans une colonne temp (utiliser description ou metadata)
    await query(`INSERT INTO admin_notifications (type, title, message, metadata) VALUES ('2fa_setup_pending','','',$1)
      ON CONFLICT DO NOTHING`, [JSON.stringify({ userId: id, secret })]).catch(()=>{});
    res.json({ secret, qrCode });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/auth/2fa/verify', partnerAuth, async (req, res) => {
  const { token, secret } = req.body;
  if (!token || !secret) return res.status(422).json({error:'Token et secret requis'});
  try {
    // Vérification TOTP simplifiée — accepter si token = 6 chiffres valides
    if (!/^[0-9]{6}$/.test(token)) return res.status(400).json({error:'Code invalide'});
    const table = req.user.role==='agent' ? 'agents' : 'bank_users';
    const idCol = req.user.role==='agent' ? 'agent_id' : 'user_id';
    const id    = req.user.role==='agent' ? req.user.agentId : req.user.sub;
    await query(`UPDATE ${table} SET is_mfa_enabled=TRUE WHERE ${idCol}=$1`, [id]);
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/auth/2fa/disable', partnerAuth, async (req, res) => {
  try {
    const table = req.user.role==='agent' ? 'agents' : 'bank_users';
    const idCol = req.user.role==='agent' ? 'agent_id' : 'user_id';
    const id    = req.user.role==='agent' ? req.user.agentId : req.user.sub;
    await query(`UPDATE ${table} SET is_mfa_enabled=FALSE WHERE ${idCol}=$1`, [id]);
    res.json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── RESET LINK (admin → user) ───────────────────────────────────
router.post('/users/:id/reset-link', partnerAuth, requireRole('bank_admin','agency_admin'), async (req, res) => {
  try {
    const crypto  = require('bcryptjs');
    const token   = require('crypto').randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24*3600*1000);
    // Stocker le token
    await query(`INSERT INTO admin_notifications (type, title, message, metadata)
      VALUES ('password_reset_link','Reset link',$1,$2)`,
      [req.params.id, JSON.stringify({ token, expires: expires.toISOString(), userId: req.params.id })]
    );
    const resetUrl = `https://partners.c-pay.global/reset?token=${token}`;
    // TODO: Envoyer par email
    console.log(`[Reset Link] User ${req.params.id} → ${resetUrl}`);
    res.json({ success:true, resetUrl, message:'Lien de réinitialisation généré (valable 24h)' });
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
      // Exécuter directement si <= seuil
      const r = await query(
        `INSERT INTO agent_transactions (agent_id, agency_id, bank_id, type, amount, fee_amount, net_amount, currency, method, customer_phone, status, reference, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'XAF',$8,$9,'completed',$10,$11) RETURNING *`,
        [req.user.agentId, ag.agency_id, ag.bank_id, type, parseFloat(amount), fee,
         type==='collect'?parseFloat(amount)-fee:parseFloat(amount)+fee,
         method, customerPhone, ref, description||null]
      );
      if (type==='collect') await query(`UPDATE agents SET float_balance=float_balance+$1 WHERE agent_id=$2`, [parseFloat(amount)-fee, req.user.agentId]);
      else await query(`UPDATE agents SET float_balance=float_balance-$1 WHERE agent_id=$2`, [parseFloat(amount)+fee, req.user.agentId]);
      res.json({ success:true, status:'completed', txnId:r.rows[0].txn_id, reference:ref, amount, fee });
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
router.post('/approvals/:id/approve', partnerAuth, requireRole('caissier_checker','agency_admin','bank_admin'), async (req, res) => {
  try {
    const r = await query(`SELECT * FROM pending_approvals WHERE approval_id=$1 AND status='pending'`, [req.params.id]);
    if (!r.rows.length) return res.status(404).json({error:'Demande introuvable ou déjà traitée'});
    const ap = r.rows[0];

    // Vérifier que le checker n'est pas le maker
    if (ap.maker_id === req.user.agentId) return res.status(403).json({error:'Vous ne pouvez pas approuver votre propre transaction'});

    // Exécuter la transaction
    const net = ap.type==='collect' ? parseFloat(ap.amount)-parseFloat(ap.fee_amount) : parseFloat(ap.amount)+parseFloat(ap.fee_amount);
    const txn = await query(
      `INSERT INTO agent_transactions (agent_id, agency_id, bank_id, type, amount, fee_amount, net_amount, currency, method, customer_phone, status, reference, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'completed',$11,$12) RETURNING txn_id`,
      [ap.maker_id, ap.agency_id, ap.bank_id, ap.type, ap.amount, ap.fee_amount, net, ap.currency, ap.method, ap.customer_phone, ap.reference, ap.description]
    );
    // Update float
    if (ap.type==='collect') await query(`UPDATE agents SET float_balance=float_balance+$1 WHERE agent_id=$2`, [net, ap.maker_id]);
    else await query(`UPDATE agents SET float_balance=float_balance-$1 WHERE agent_id=$2`, [net, ap.maker_id]);

    // Marquer comme approuvé
    await query(`UPDATE pending_approvals SET status='approved', checker_id=$1, approved_at=NOW(), updated_at=NOW() WHERE approval_id=$2`,
      [req.user.sub, req.params.id]);

    res.json({ success:true, txnId: txn.rows[0].txn_id, message:'Transaction approuvée et exécutée ✅' });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// Checker — rejeter une transaction
router.post('/approvals/:id/reject', partnerAuth, requireRole('caissier_checker','agency_admin','bank_admin'), async (req, res) => {
  const { reason } = req.body;
  try {
    const r = await query(`SELECT * FROM pending_approvals WHERE approval_id=$1 AND status='pending'`, [req.params.id]);
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
  const { page=1, limit=20, status } = req.query;
  const { role, agencyId, bankId, agentId } = req.user;
  try {
    const conds = ['1=1']; const params = [];
    if (['bank_admin','bank_user'].includes(role))         { params.push(bankId);   conds.push(`pa.bank_id=$${params.length}`); }
    else if (['agency_admin','agency_user','caissier_checker'].includes(role)) { params.push(agencyId); conds.push(`pa.agency_id=$${params.length}`); }
    else                                                   { params.push(agentId);  conds.push(`pa.maker_id=$${params.length}`); }
    if (status) { params.push(status); conds.push(`pa.status=$${params.length}`); }
    const offset = (parseInt(page)-1)*parseInt(limit);
    const r = await query(
      `SELECT pa.*, a.first_name||' '||a.last_name as maker_name, ag.agency_name
       FROM pending_approvals pa
       JOIN agents a ON a.agent_id=pa.maker_id
       JOIN agencies ag ON ag.agency_id=pa.agency_id
       WHERE ${conds.join(' AND ')}
       ORDER BY pa.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, parseInt(limit), offset]
    );
    const cnt = await query(`SELECT COUNT(*) FROM pending_approvals pa WHERE ${conds.join(' AND ')}`, params);
    res.json({ data: r.rows, total: parseInt(cnt.rows[0].count) });
  } catch(err){ res.status(500).json({error:err.message}); }
});
