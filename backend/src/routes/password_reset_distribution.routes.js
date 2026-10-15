// ================================================================
// CPlus 2.6 — Password Reset + Distribution Routes
//
// RESET MOT DE PASSE :
// POST /cardholder/auth/forgot-password   — Demande reset cardholder
// POST /cardholder/auth/reset-password    — Nouveau mot de passe cardholder
// POST /merchant/auth/forgot-password     — Demande reset merchant
// POST /merchant/auth/reset-password      — Nouveau mot de passe merchant
//
// DISTRIBUTION (admin) :
// GET  /admin/distribution/banks          — Liste banques
// POST /admin/distribution/banks          — Créer banque
// GET  /admin/distribution/agencies       — Liste agences
// POST /admin/distribution/agencies       — Créer agence
// GET  /admin/distribution/agents         — Liste agents
// POST /admin/distribution/agents         — Créer agent
// GET  /admin/distribution/agents/:id/performance — Stats agent
//
// AGENT (portail agent) :
// POST /agent/auth/login                  — Login agent
// GET  /agent/cardholders                 — Mes porteurs
// POST /agent/cardholders                 — Enrôler un porteur
// GET  /agent/performance                 — Mes stats + commissions
// ================================================================
'use strict';

const express  = require('express');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const { query, withTransaction } = require('../config/database');
const email    = require('../services/email.service');

// ─── Auth middlewares ─────────────────────────────────────────────
// WAVE-2 : module d'auth unique (audit §1.1). aliasUser conserve req.admin /
// req.agent pour les handlers existants.
const {
  adminAuth: adminJwt, requireType, aliasUser, issueSession, revokeAll,
} = require('../middleware/auth');
const adminAuth = [adminJwt, aliasUser('admin')];
const agentAuth = [requireType('agent'), aliasUser('agent')];

// Rate limits forgot-password (audit §2.15, §2.19) : 5 / h / IP et 3 / h / email
// (cle = email normalise). Une instance par routeur (compteurs separes).
const forgotPasswordLimiters = () => [
  rateLimit({
    windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: 'Trop de demandes, réessayez plus tard', code: 'RATE_LIMITED' }),
  }),
  rateLimit({
    windowMs: 60 * 60 * 1000, limit: 3, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (req) => `email:${String(req.body?.email || '').toLowerCase().trim()}`,
    skip: (req) => !req.body?.email,
    // la cle n'est pas l'IP : les validations liees a l'IP / au proxy ne s'appliquent pas
    validate: { ip: false, trustProxy: false, xForwardedForHeader: false },
    handler: (req, res) => res.status(429).json({ error: 'Trop de demandes pour cet email, réessayez plus tard', code: 'RATE_LIMITED' }),
  }),
];

// Pagination bornée : limit ∈ [1,100], page ≥ 1
const parsePagination = (q = {}) => {
  const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));
  const page  = Math.max(1, parseInt(q.page, 10) || 1);
  return { limit, page, offset: (page - 1) * limit };
};

// ─── HELPER : Générer et envoyer token reset ──────────────────────
const generateResetToken = () => {
  const raw  = crypto.randomBytes(32).toString('hex'); // token envoyé par email
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
};

const sendResetEmail = async ({ to, firstName, resetUrl, actorType }) => {
  const label = actorType === 'merchant_user' ? 'Marchand' : 'Cardholder';
  return email.send
    ? email.send({
        to,
        subject: `🔐 Réinitialisation de votre mot de passe C-Pay ${label}`,
        html: `
          <!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"/><style>
          body{font-family:Arial,sans-serif;background:#f0f4f8;margin:0;padding:32px}
          .box{background:#fff;border-radius:12px;padding:32px;max-width:520px;margin:0 auto}
          .btn{display:inline-block;background:#12b6c7;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin:20px 0}
          .warn{font-size:12px;color:#8a9ab0;margin-top:16px}
          </style></head><body>
          <div class="box">
            <h2>Réinitialisation du mot de passe</h2>
            <p>Bonjour <strong>${firstName}</strong>,</p>
            <p>Vous avez demandé la réinitialisation de votre mot de passe C-Pay. Cliquez sur le bouton ci-dessous :</p>
            <div style="text-align:center"><a href="${resetUrl}" class="btn">Réinitialiser mon mot de passe →</a></div>
            <p class="warn">⏱️ Ce lien est valable <strong>1 heure</strong>.<br/>
            Si vous n'avez pas fait cette demande, ignorez cet email — votre mot de passe reste inchangé.<br/>
            🔒 Ne partagez jamais ce lien.</p>
          </div></body></html>
        `,
      })
    : Promise.resolve(false);
};

// ================================================================
// RESET MOT DE PASSE — CARDHOLDER
// ================================================================
const cardholderResetRouter = express.Router();

// POST /cardholder/auth/forgot-password
cardholderResetRouter.post('/auth/forgot-password', ...forgotPasswordLimiters(), async (req, res) => {
  const { email: emailInput } = req.body;
  if (!emailInput) return res.status(422).json({ error: 'Email requis' });

  // Toujours répondre OK (éviter l'énumération d'emails)
  res.json({ success: true, message: 'Si cet email existe, un lien de réinitialisation a été envoyé.' });

  try {
    const r = await query(
      `SELECT cardholder_id, first_name, last_name, email FROM cardholders WHERE email=$1 AND is_active=TRUE LIMIT 1`,
      [emailInput.toLowerCase().trim()]
    );
    if (!r.rows.length) return; // Silence — email non trouvé
    const ch = r.rows[0];

    // Invalider les anciens tokens
    await query(`UPDATE password_reset_tokens SET used_at=NOW() WHERE actor_id=$1 AND actor_type='cardholder' AND used_at IS NULL`, [ch.cardholder_id]);

    // Générer nouveau token
    const { raw, hash } = generateResetToken();
    await query(
      `INSERT INTO password_reset_tokens (actor_type, actor_id, email, token_hash, ip_address) VALUES ('cardholder',$1,$2,$3,$4)`,
      [ch.cardholder_id, ch.email, hash, req.ip]
    );

    // Envoyer email
    const resetUrl = `${process.env.APP_URL_CARDHOLDER || 'https://app.c-pay.global'}/reset-password?token=${raw}&type=cardholder`;
    await sendResetEmail({ to: ch.email, firstName: ch.first_name, resetUrl, actorType: 'cardholder' });
  } catch (err) { console.error('[ForgotPassword:Cardholder]', err.message); }
});

// POST /cardholder/auth/reset-password
cardholderResetRouter.post('/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(422).json({ error: 'Token et nouveau mot de passe requis' });
  if (newPassword.length < 8) return res.status(422).json({ error: 'Mot de passe trop court (min 8 caractères)' });
  if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword))
    return res.status(422).json({ error: 'Le mot de passe doit contenir majuscule, minuscule et chiffre' });

  try {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const r = await query(
      `SELECT * FROM password_reset_tokens WHERE token_hash=$1 AND actor_type='cardholder' AND used_at IS NULL AND expires_at > NOW() LIMIT 1`,
      [hash]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Lien invalide ou expiré', code: 'INVALID_TOKEN' });

    const resetRecord = r.rows[0];
    const pwdHash = await bcrypt.hash(newPassword, 12);

    await withTransaction(async client => {
      // Changer le mot de passe (leve aussi temp_password)
      await client.query(
        `UPDATE cardholders SET password_hash=$1, temp_password=FALSE, failed_attempts=0, locked_until=NULL, updated_at=NOW() WHERE cardholder_id=$2`,
        [pwdHash, resetRecord.actor_id]
      );
      // Marquer le token comme utilisé
      await client.query(`UPDATE password_reset_tokens SET used_at=NOW() WHERE token_id=$1`, [resetRecord.token_id]);
      // Invalider tous les autres tokens pour cet utilisateur
      await client.query(`UPDATE password_reset_tokens SET used_at=NOW() WHERE actor_id=$1 AND actor_type='cardholder' AND token_id!=$2`, [resetRecord.actor_id, resetRecord.token_id]);
    });
    // WAVE-2 (audit §2.15) : revocation de toutes les sessions apres reset
    await revokeAll('cardholder', resetRecord.actor_id);

    res.json({ success: true, message: 'Mot de passe réinitialisé avec succès. Vous pouvez maintenant vous connecter.', sessionsRevoked: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================================================================
// RESET MOT DE PASSE — MERCHANT
// ================================================================
const merchantResetRouter = express.Router();

// POST /merchant/auth/forgot-password
merchantResetRouter.post('/auth/forgot-password', ...forgotPasswordLimiters(), async (req, res) => {
  const { email: emailInput } = req.body;
  if (!emailInput) return res.status(422).json({ error: 'Email requis' });

  res.json({ success: true, message: 'Si cet email existe, un lien de réinitialisation a été envoyé.' });

  try {
    const r = await query(
      `SELECT mu.user_id, mu.first_name, mu.last_name, mu.email, m.business_name
       FROM merchant_users mu JOIN merchants m ON m.merchant_id=mu.merchant_id
       WHERE mu.email=$1 AND mu.is_active=TRUE LIMIT 1`,
      [emailInput.toLowerCase().trim()]
    );
    if (!r.rows.length) return;
    const mu = r.rows[0];

    await query(`UPDATE password_reset_tokens SET used_at=NOW() WHERE actor_id=$1 AND actor_type='merchant_user' AND used_at IS NULL`, [mu.user_id]);

    const { raw, hash } = generateResetToken();
    await query(
      `INSERT INTO password_reset_tokens (actor_type, actor_id, email, token_hash, ip_address) VALUES ('merchant_user',$1,$2,$3,$4)`,
      [mu.user_id, mu.email, hash, req.ip]
    );

    const resetUrl = `${process.env.APP_URL_MERCHANT || 'https://merchant.c-pay.global'}/reset-password?token=${raw}&type=merchant`;
    await sendResetEmail({ to: mu.email, firstName: mu.first_name, resetUrl, actorType: 'merchant_user' });
  } catch (err) { console.error('[ForgotPassword:Merchant]', err.message); }
});

// POST /merchant/auth/reset-password
merchantResetRouter.post('/auth/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(422).json({ error: 'Token et nouveau mot de passe requis' });
  if (newPassword.length < 8) return res.status(422).json({ error: 'Mot de passe trop court (min 8 caractères)' });
  if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/[0-9]/.test(newPassword))
    return res.status(422).json({ error: 'Le mot de passe doit contenir majuscule, minuscule et chiffre' });

  try {
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const r = await query(
      `SELECT * FROM password_reset_tokens WHERE token_hash=$1 AND actor_type='merchant_user' AND used_at IS NULL AND expires_at > NOW() LIMIT 1`,
      [hash]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Lien invalide ou expiré', code: 'INVALID_TOKEN' });

    const resetRecord = r.rows[0];
    const pwdHash = await bcrypt.hash(newPassword, 12);

    await withTransaction(async client => {
      await client.query(
        `UPDATE merchant_users SET password_hash=$1, temp_password=FALSE, failed_attempts=0, locked_until=NULL, updated_at=NOW() WHERE user_id=$2`,
        [pwdHash, resetRecord.actor_id]
      );
      await client.query(`UPDATE password_reset_tokens SET used_at=NOW() WHERE token_id=$1`, [resetRecord.token_id]);
      await client.query(`UPDATE password_reset_tokens SET used_at=NOW() WHERE actor_id=$1 AND actor_type='merchant_user' AND token_id!=$2`, [resetRecord.actor_id, resetRecord.token_id]);
    });
    // WAVE-2 (audit §2.15) : revocation de toutes les sessions apres reset
    await revokeAll('merchant', resetRecord.actor_id);

    res.json({ success: true, message: 'Mot de passe réinitialisé avec succès.', sessionsRevoked: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ================================================================
// DISTRIBUTION — ADMIN
// ================================================================
const distributionAdminRouter = express.Router();

// GET /admin/distribution/banks
distributionAdminRouter.get('/banks', adminAuth, async (req, res) => {
  const r = await query(`SELECT b.*, COUNT(a.agency_id) as agency_count FROM distribution_banks b LEFT JOIN distribution_agencies a ON a.bank_id=b.bank_id GROUP BY b.bank_id ORDER BY b.bank_name`);
  res.json({ data: r.rows });
});

// POST /admin/distribution/banks
distributionAdminRouter.post('/banks', adminAuth, async (req, res) => {
  const { bankName, bankCode, country = 'CM', swiftCode, commissionRate = 0.002 } = req.body;
  if (!bankName || !bankCode) return res.status(422).json({ error: 'bankName et bankCode requis' });
  try {
    const r = await query(
      `INSERT INTO distribution_banks (bank_name, bank_code, country, swift_code, commission_rate) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [bankName, bankCode.toUpperCase(), country, swiftCode || null, commissionRate]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Code banque déjà utilisé' });
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/distribution/agencies
distributionAdminRouter.get('/agencies', adminAuth, async (req, res) => {
  const { bankId } = req.query;
  const cond = bankId ? 'WHERE a.bank_id=$1' : '';
  const r = await query(
    `SELECT a.*, b.bank_name, COUNT(ag.agent_id) as agent_count
     FROM distribution_agencies a
     JOIN distribution_banks b ON b.bank_id=a.bank_id
     LEFT JOIN distribution_agents ag ON ag.agency_id=a.agency_id
     ${cond} GROUP BY a.agency_id, b.bank_name ORDER BY a.agency_name`,
    bankId ? [bankId] : []
  );
  res.json({ data: r.rows });
});

// POST /admin/distribution/agencies
distributionAdminRouter.post('/agencies', adminAuth, async (req, res) => {
  const { bankId, agencyName, agencyCode, city, country = 'CM', region, contactName, contactEmail, contactPhone, commissionRate = 0.0015, maxAgents = 50 } = req.body;
  if (!bankId || !agencyName || !agencyCode || !city) return res.status(422).json({ error: 'bankId, agencyName, agencyCode et city requis' });
  try {
    const r = await query(
      `INSERT INTO distribution_agencies (bank_id, agency_name, agency_code, city, country, region, contact_name, contact_email, contact_phone, commission_rate, max_agents)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [bankId, agencyName, agencyCode.toUpperCase(), city, country, region || null, contactName || null, contactEmail || null, contactPhone || null, commissionRate, maxAgents]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Code agence déjà utilisé' });
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/distribution/agents
distributionAdminRouter.get('/agents', adminAuth, async (req, res) => {
  const { agencyId, bankId } = req.query;
  const { page, limit, offset } = parsePagination(req.query);
  try {
    const conds = ['1=1']; const params = [];
    if (agencyId) { params.push(agencyId); conds.push(`a.agency_id=$${params.length}`); }
    if (bankId)   { params.push(bankId);   conds.push(`a.bank_id=$${params.length}`); }
    const r = await query(
      `SELECT a.*, ag.agency_name, b.bank_name,
              COUNT(ch.cardholder_id) as cardholder_count
       FROM distribution_agents a
       JOIN distribution_agencies ag ON ag.agency_id=a.agency_id
       JOIN distribution_banks b ON b.bank_id=a.bank_id
       LEFT JOIN cardholders ch ON ch.agent_id=a.agent_id AND ch.is_active=TRUE
       WHERE ${conds.join(' AND ')} GROUP BY a.agent_id, ag.agency_name, b.bank_name
       ORDER BY a.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    res.json({ data: r.rows.map(a => ({ ...a, password_hash: undefined })), page, limit });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /admin/distribution/agents
distributionAdminRouter.post('/agents', adminAuth, async (req, res) => {
  const { agencyId, bankId, firstName, lastName, phone, email: agentEmail, password, idType, idNumber, commissionRate = 0.001, cardsLimit = 200 } = req.body;
  if (!agencyId || !bankId || !firstName || !lastName || !phone || !password) return res.status(422).json({ error: 'Champs obligatoires manquants' });
  try {
    const pwdHash   = await bcrypt.hash(password, 12);
    const agentCode = `AGT-${Date.now().toString(36).toUpperCase()}`;
    const r = await query(
      `INSERT INTO distribution_agents (agency_id, bank_id, agent_code, first_name, last_name, phone, email, password_hash, id_type, id_number, commission_rate, cards_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [agencyId, bankId, agentCode, firstName, lastName, phone, agentEmail || null, pwdHash, idType || null, idNumber || null, commissionRate, cardsLimit]
    );
    res.status(201).json({ ...r.rows[0], password_hash: undefined });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Téléphone déjà utilisé' });
    res.status(500).json({ error: err.message });
  }
});

// GET /admin/distribution/agents/:id/performance
distributionAdminRouter.get('/agents/:id/performance', adminAuth, async (req, res) => {
  const r = await query(`SELECT * FROM agent_performance WHERE agent_id=$1`, [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Agent introuvable' });
  const commissions = await query(
    `SELECT DATE_TRUNC('month', created_at) as month, SUM(agent_amount) as total, COUNT(*) as txn_count
     FROM distribution_commissions WHERE agent_id=$1 GROUP BY month ORDER BY month DESC LIMIT 12`,
    [req.params.id]
  );
  res.json({ ...r.rows[0], commissionsHistory: commissions.rows });
});

// ================================================================
// DISTRIBUTION — AGENT (portail agent)
// ================================================================
const agentRouter = express.Router();

// POST /agent/auth/login
agentRouter.post('/auth/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(422).json({ error: 'Téléphone et mot de passe requis' });
  try {
    const r = await query(
      `SELECT a.*, ag.agency_name, b.bank_name FROM distribution_agents a
       JOIN distribution_agencies ag ON ag.agency_id=a.agency_id
       JOIN distribution_banks b ON b.bank_id=a.bank_id
       WHERE a.phone=$1 AND a.is_active=TRUE LIMIT 1`,
      [phone.trim()]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Identifiants incorrects' });
    const agent = r.rows[0];

    if (agent.locked_until && new Date(agent.locked_until) > new Date())
      return res.status(423).json({ error: 'Compte verrouillé', lockedUntil: agent.locked_until });

    const ok = await bcrypt.compare(password, agent.password_hash);
    if (!ok) {
      const attempts = (agent.failed_attempts || 0) + 1;
      const lockUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await query(`UPDATE distribution_agents SET failed_attempts=$1, locked_until=$2 WHERE agent_id=$3`, [attempts, lockUntil, agent.agent_id]);
      return res.status(401).json({ error: 'Identifiants incorrects', attemptsLeft: Math.max(0, 5 - attempts) });
    }

    await query(`UPDATE distribution_agents SET failed_attempts=0, locked_until=NULL, last_login_at=NOW() WHERE agent_id=$1`, [agent.agent_id]);
    // WAVE-2 : access 15 min (etait 8 h) + refresh opaque en cookie cp_rt_agent
    const session = await issueSession({
      actorType: 'agent', actorId: agent.agent_id,
      claims: { type: 'agent', agencyId: agent.agency_id, bankId: agent.bank_id }, req, res,
    });

    res.json({
      ...session,
      mustChangePassword: !!agent.temp_password,
      agent: {
        agentId: agent.agent_id, agentCode: agent.agent_code,
        firstName: agent.first_name, lastName: agent.last_name,
        phone: agent.phone, agencyName: agent.agency_name, bankName: agent.bank_name,
        cardsIssued: agent.cards_issued, cardsLimit: agent.cards_limit,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /agent/cardholders — Mes porteurs de carte
agentRouter.get('/cardholders', agentAuth, async (req, res) => {
  const { search } = req.query;
  const { page, limit, offset } = parsePagination(req.query);
  try {
    const conds  = ['ch.agent_id=$1']; const params = [req.agent.sub];
    if (search) { params.push(`%${search}%`); conds.push(`(ch.first_name ILIKE $${params.length} OR ch.last_name ILIKE $${params.length} OR ch.phone ILIKE $${params.length})`); }
    const r = await query(
      `SELECT ch.cardholder_id, ch.first_name, ch.last_name, ch.phone, ch.email, ch.kyc_level, ch.created_at,
              vc.card_masked, vc.balance, vc.currency, vc.status as card_status
       FROM cardholders ch LEFT JOIN virtual_cards vc ON vc.card_id=ch.card_id
       WHERE ${conds.join(' AND ')} ORDER BY ch.created_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    const cnt = await query(`SELECT COUNT(*) FROM cardholders ch WHERE ${conds.join(' AND ')}`, params);
    res.json({ data: r.rows, total: parseInt(cnt.rows[0].count), page, limit });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /agent/cardholders — Enrôler un nouveau porteur
agentRouter.post('/cardholders', agentAuth, async (req, res) => {
  const { firstName, lastName, phone, email: chEmail, dateOfBirth, idType, idNumber, country = 'CM', password } = req.body;
  if (!firstName || !lastName || !phone || !password) return res.status(422).json({ error: 'Champs obligatoires manquants' });

  try {
    // Vérifier que l'agent peut encore émettre des cartes
    const agentRes = await query(`SELECT cards_issued, cards_limit FROM distribution_agents WHERE agent_id=$1`, [req.agent.sub]);
    const agent    = agentRes.rows[0];
    if (agent.cards_issued >= agent.cards_limit)
      return res.status(429).json({ error: `Limite de cartes atteinte (${agent.cards_limit})` });

    const pwdHash = await bcrypt.hash(password, 12);

    // HOTFIX : réponse envoyée après COMMIT (withTransaction retourne les données)
    const created = await withTransaction(async client => {
      // Créer la carte virtuelle
      const cardId  = uuidv4();
      const chId    = uuidv4();
      const last4   = Math.floor(1000 + Math.random() * 9000).toString();
      const cardNum = ('4000000000000000' + last4).slice(-16);
      const masked  = cardNum.slice(0, 4) + ' **** **** ' + last4;
      const expYear = new Date().getFullYear() + 3;
      const emboss  = (firstName.slice(0, 13) + ' ' + lastName.slice(0, 13)).toUpperCase();

      // HOTFIX IDOR : la carte est rattachée à son porteur dès la création
      await client.query(
        `INSERT INTO virtual_cards (card_id, cardholder_id, card_number, card_masked, cardholder_name, expiry_month, expiry_year, balance, currency, network, country)
         VALUES ($1,$2,$3,$4,$5,12,$6,0,'XAF','visa',$7)`,
        [cardId, chId, cardNum, masked, emboss, expYear, country]
      );

      // Créer le cardholder lié à l'agent
      await client.query(
        `INSERT INTO cardholders (cardholder_id, card_id, first_name, last_name, phone, email, date_of_birth, id_type, id_number, country, password_hash, kyc_level, agent_id, agency_id, bank_id, onboarded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$13,$14,'agent')`,
        [chId, cardId, firstName, lastName, phone, chEmail || null, dateOfBirth || null, idType || null, idNumber || null, country, pwdHash, req.agent.sub, req.agent.agencyId, req.agent.bankId]
      );

      // Incrémenter le compteur de l'agent
      await client.query(`UPDATE distribution_agents SET cards_issued=cards_issued+1 WHERE agent_id=$1`, [req.agent.sub]);

      return { chId, cardId, masked, emboss, expYear };
    });

    const { chId, cardId, masked, emboss, expYear } = created;
    res.status(201).json({
      success:     true,
      cardholderId: chId,
      card: { cardId, cardMasked: masked, cardholderName: emboss, expiryMonth: 12, expiryYear: expYear },
      message: `Porteur ${firstName} ${lastName} enrôlé avec succès.`,
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Téléphone ou email déjà utilisé' });
    res.status(500).json({ error: err.message });
  }
});

// GET /agent/performance — Stats + commissions de l'agent
agentRouter.get('/performance', agentAuth, async (req, res) => {
  const r = await query(`SELECT * FROM agent_performance WHERE agent_id=$1`, [req.agent.sub]);
  if (!r.rows.length) return res.status(404).json({ error: 'Agent introuvable' });
  const recent = await query(
    `SELECT dc.*, ch.first_name, ch.last_name FROM distribution_commissions dc
     LEFT JOIN cardholders ch ON ch.cardholder_id=dc.cardholder_id
     WHERE dc.agent_id=$1 ORDER BY dc.created_at DESC LIMIT 10`,
    [req.agent.sub]
  );
  res.json({ performance: r.rows[0], recentCommissions: recent.rows });
});

module.exports = {
  cardholderResetRouter,
  merchantResetRouter,
  distributionAdminRouter,
  agentRouter,
};
