// ================================================================
// CPlus 2.6 — Cardholder Routes
// Auth, Card, Transactions, TopUp, Unload, PIN, Profile
// ================================================================
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const router  = express.Router();
const {
  auditLog, updateSession, destroySession, maskPan,
  sanitizeCardResponse, PCI_EVENTS
} = require('../middleware/pci.middleware');
const {
  enrollCard, listEnrolledCards, setDefaultCard,
  revokeCard, resolveToken, generateSessionKey,
} = require('../services/tokenization/card-enrollment.service');
const { query, withTransaction } = require('../config/database');
const { notify } = require('../services/notifications');

// ─── HOTFIX P0 (audit 2.6.0 §2.6) ─────────────────────────────────
// Les endpoints qui créditent/débitent une carte sans mouvement réel
// chez un opérateur sont désactivés (410) tant qu'aucun provider n'est
// branché. Le code reste en place derrière FEATURE_DISABLED.
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

// ─── Middleware Auth Cardholder ───────────────────────────────────
const cardAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token requis' });
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (decoded.type !== 'cardholder') return res.status(403).json({ error: 'Accès refusé' });
    req.cardholder = decoded;
    next();
  } catch { res.status(401).json({ error: 'Token invalide' }); }
};

// ─── AUTH ─────────────────────────────────────────────────────────

// Login cardholder
router.post('/auth/login', async (req, res) => {
  const { emailOrPhone, password } = req.body;
  if (!emailOrPhone || !password) return res.status(422).json({ error: 'Identifiants requis' });
  try {
    const r = await query(
      `SELECT ch.*, vc.card_id, vc.card_number, vc.card_masked, vc.balance,
              vc.currency, vc.status as card_status, vc.expiry_month, vc.expiry_year,
              vc.cardholder_name, vc.network, vc.daily_limit, vc.monthly_limit
       FROM cardholders ch
       JOIN virtual_cards vc ON vc.card_id = ch.card_id
       WHERE (ch.email = $1 OR ch.phone = $1) AND ch.is_active = TRUE LIMIT 1`,
      [emailOrPhone.trim()]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Identifiants incorrects' });
    const ch = r.rows[0];

    // Vérifier verrouillage
    if (ch.locked_until && new Date(ch.locked_until) > new Date()) {
      return res.status(423).json({ error: 'Compte temporairement verrouillé', lockedUntil: ch.locked_until });
    }

    const ok = await bcrypt.compare(password, ch.password_hash);
    if (!ok) {
      const attempts = (ch.failed_attempts || 0) + 1;
      const lockUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await query(`UPDATE cardholders SET failed_attempts=$1, locked_until=$2 WHERE cardholder_id=$3`, [attempts, lockUntil, ch.cardholder_id]);
      // REQ 10.2.4 : Log échec d'authentification
      await auditLog({ eventType: attempts >= 5 ? PCI_EVENTS.AUTH_LOCKOUT : PCI_EVENTS.AUTH_FAILURE, actorType: 'cardholder', actorId: ch.cardholder_id, ipAddress: req.ip, userAgent: req.headers['user-agent'], success: false, details: { attempts, locked: attempts >= 5 } });
      return res.status(401).json({ error: 'Identifiants incorrects', attemptsLeft: Math.max(0, 5 - attempts) });
    }

    await query(`UPDATE cardholders SET failed_attempts=0, locked_until=NULL, last_login_at=NOW() WHERE cardholder_id=$1`, [ch.cardholder_id]);
    // REQ 10.2.4 : Log authentification réussie
    await auditLog({ eventType: PCI_EVENTS.AUTH_SUCCESS, actorType: 'cardholder', actorId: ch.cardholder_id, entityType: 'card', entityId: ch.card_id, ipAddress: req.ip, userAgent: req.headers['user-agent'], success: true });
    // REQ 8 : Démarrer la session
    updateSession(ch.cardholder_id);

    const access  = jwt.sign({ sub: ch.cardholder_id, cardId: ch.card_id, type: 'cardholder', email: ch.email }, process.env.JWT_SECRET, { expiresIn: '8h' });
    const refresh = jwt.sign({ sub: ch.cardholder_id, type: 'cardholder_refresh' }, process.env.JWT_SECRET, { expiresIn: '7d' });

    res.json({
      access_token: access, refresh_token: refresh,
      cardholder: { cardholderId: ch.cardholder_id, firstName: ch.first_name, lastName: ch.last_name, email: ch.email, phone: ch.phone, kycLevel: ch.kyc_level },
      card: { cardId: ch.card_id, cardMasked: ch.card_masked, cardholderName: ch.cardholder_name, balance: parseFloat(ch.balance), currency: ch.currency, status: ch.card_status, expiryMonth: ch.expiry_month, expiryYear: ch.expiry_year, network: ch.network, dailyLimit: parseFloat(ch.daily_limit), monthlyLimit: parseFloat(ch.monthly_limit) }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Refresh token
router.post('/auth/refresh', async (req, res) => {
  try {
    const decoded = jwt.verify(req.body.refreshToken, process.env.JWT_SECRET);
    if (decoded.type !== 'cardholder_refresh') return res.status(401).json({ error: 'Token invalide' });
    const r = await query(`SELECT ch.*, vc.card_id FROM cardholders ch JOIN virtual_cards vc ON vc.card_id = ch.card_id WHERE ch.cardholder_id=$1 AND ch.is_active=TRUE`, [decoded.sub]);
    if (!r.rows.length) return res.status(401).json({ error: 'Compte introuvable' });
    const access = jwt.sign({ sub: decoded.sub, cardId: r.rows[0].card_id, type: 'cardholder', email: r.rows[0].email }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ access_token: access });
  } catch { res.status(401).json({ error: 'Refresh token invalide' }); }
});


// ─── REGISTER CARDHOLDER ─────────────────────────────────────────
router.post('/auth/register', async (req, res) => {
  const { firstName, lastName, phone, email, dateOfBirth, idType, idNumber, country = 'CM', password } = req.body;
  if (!firstName || !lastName || !phone || !email || !password)
    return res.status(422).json({ error: "Champs requis : prénom, nom, téléphone, email, mot de passe" });
  if (password.length < 8)
    return res.status(422).json({ error: "Mot de passe trop court (min 8 caractères)" });
  try {
    const hash = await bcrypt.hash(password, 12);
    // La réponse (JWT) n'est envoyée qu'après COMMIT : withTransaction retourne les données.
    const created = await withTransaction(async client => {
      const cardId  = uuidv4();
      const chId    = uuidv4();
      const last4   = Math.floor(1000 + Math.random() * 9000).toString();
      const cardNum = ('4000000000000000' + last4).slice(-16);
      const masked  = cardNum.slice(0,4)+' **** **** '+last4;
      const expYear = new Date().getFullYear() + 3;
      const emboss  = (firstName.slice(0,13)+' '+lastName.slice(0,13)).toUpperCase();
      // HOTFIX IDOR : la carte est rattachée à son porteur dès la création
      await client.query(
        `INSERT INTO virtual_cards (card_id,cardholder_id,card_number,card_masked,cardholder_name,expiry_month,expiry_year,balance,currency,network,country) VALUES ($1,$2,$3,$4,$5,12,$6,0,'XAF','visa',$7)`,
        [cardId, chId, cardNum, masked, emboss, expYear, country]
      );
      await client.query(
        `INSERT INTO cardholders (cardholder_id,card_id,first_name,last_name,email,phone,date_of_birth,id_type,id_number,country,password_hash,kyc_level) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)`,
        [chId, cardId, firstName, lastName, email.toLowerCase(), phone, dateOfBirth||null, idType||null, idNumber||null, country, hash]
      );

      // Token de verification email
      const verifyRaw   = crypto.randomBytes(32).toString('hex');
      const verifyHash  = crypto.createHash('sha256').update(verifyRaw).digest('hex');
      await client.query(
        `UPDATE cardholders SET email_verify_token=$1, email_verified=FALSE WHERE cardholder_id=$2`,
        [verifyHash, chId]);

      return { chId, cardId, masked, emboss, expYear, verifyRaw };
    });

    const { chId, cardId, masked, emboss, expYear, verifyRaw } = created;
    const accessToken  = jwt.sign({ sub: chId, cardId, type: 'cardholder', email }, process.env.JWT_SECRET, { expiresIn: '8h' });
    const refreshToken = jwt.sign({ sub: chId, type: 'cardholder_refresh' }, process.env.JWT_SECRET, { expiresIn: '7d' });
    await auditLog({ eventType: 'CARDHOLDER_REGISTERED', actorType: 'cardholder', actorId: chId, ipAddress: req.ip, success: true, details: { country, email } });

    // Email d'activation (best-effort, ne bloque pas l'inscription) — envoyé après COMMIT
    const verifyUrl = `${process.env.APP_URL_CARDHOLDER || 'https://app.c-pay.global'}/verify-email?token=${verifyRaw}`;
    (async () => {
      try {
        const emailSvc = require('../services/notifications/email.service');
        await emailSvc.send({
          to: email.toLowerCase(),
          subject: 'Activez votre compte CPlus',
          html: `<h2>Bienvenue ${firstName} !</h2>
            <p>Merci de votre inscription. Cliquez sur le bouton ci-dessous pour activer votre compte :</p>
            <p><a href="${verifyUrl}" style="display:inline-block;background:#1d4f92;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Activer mon compte</a></p>
            <p style="color:#5a6677;font-size:13px">Ou copiez ce lien : ${verifyUrl}</p>
            <p style="color:#5a6677;font-size:13px">Ce lien expire dans 48h. Si vous n'êtes pas à l'origine de cette inscription, ignorez cet email.</p>`,
        });
      } catch (e) { console.error('[verify-email]', e.message); }
    })();

    res.status(201).json({
      access_token: accessToken, refresh_token: refreshToken,
      cardholder: { cardholderId: chId, firstName, lastName, email, phone, kycLevel: 1, emailVerified: false },
      card: { cardId, cardMasked: masked, cardholderName: emboss, balance: 0, currency: 'XAF', status: 'active', expiryMonth: 12, expiryYear: expYear, network: 'visa' },
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: "Email ou téléphone déjà utilisé", code: 'DUPLICATE' });
    res.status(500).json({ error: err.message });
  }
});

// ─── VERIFICATION EMAIL ─────────────────────────────────────────────
router.get('/auth/verify-email', async (req, res) => {
  const raw = req.query.token;
  if (!raw) return res.status(422).json({ error: 'Token requis' });
  try {
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const r = await query(
      `UPDATE cardholders SET email_verified=TRUE, email_verified_at=NOW(), email_verify_token=NULL
       WHERE email_verify_token=$1 AND email_verified=FALSE
       RETURNING cardholder_id, email`, [hash]);
    if (!r.rows.length)
      return res.status(400).json({ error: 'Lien invalide ou deja utilise', code: 'INVALID_TOKEN' });
    res.json({ success: true, message: 'Email verifie avec succes', email: r.rows[0].email });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/auth/resend-verification', cardAuth, async (req, res) => {
  try {
    const chId = req.cardholder.cardholderId || req.cardholder.sub;
    const ch = await query(`SELECT email, first_name, email_verified FROM cardholders WHERE cardholder_id=$1`, [chId]);
    if (!ch.rows[0]) return res.status(404).json({ error: 'Compte introuvable' });
    if (ch.rows[0].email_verified) return res.json({ success: true, alreadyVerified: true });
    const raw  = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    await query(`UPDATE cardholders SET email_verify_token=$1 WHERE cardholder_id=$2`, [hash, chId]);
    const verifyUrl = `${process.env.APP_URL_CARDHOLDER || 'https://app.c-pay.global'}/verify-email?token=${raw}`;
    const emailSvc = require('../services/notifications/email.service');
    await emailSvc.send({
      to: ch.rows[0].email,
      subject: 'Activez votre compte CPlus',
      html: `<h2>Bonjour ${ch.rows[0].first_name},</h2><p>Votre lien d'activation :</p><p><a href="${verifyUrl}" style="display:inline-block;background:#1d4f92;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Activer mon compte</a></p>`,
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CARTE ────────────────────────────────────────────────────────

// Info carte + solde
router.get('/card', cardAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT vc.*, ch.first_name, ch.last_name, ch.email, ch.phone, ch.kyc_level, ch.address, ch.city
       FROM virtual_cards vc
       JOIN cardholders ch ON ch.card_id = vc.card_id
       WHERE vc.card_id=$1`,
      [req.cardholder.cardId]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Carte introuvable" });
    const c = r.rows[0];
    res.json({
      cardId:         c.card_id,
      cardMasked:     c.card_masked,
      cardholderName: c.cardholder_name,
      balance:        parseFloat(c.balance),
      currency:       c.currency,
      status:         c.status,
      network:        c.network,
      expiryMonth:    c.expiry_month,
      expiryYear:     c.expiry_year,
      dailyLimit:     parseFloat(c.daily_limit),
      monthlyLimit:   parseFloat(c.monthly_limit),
      cardholder:     { firstName: c.first_name, lastName: c.last_name, email: c.email, phone: c.phone, kycLevel: c.kyc_level, address: c.address, city: c.city }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Activer/Désactiver la carte (freeze/unfreeze)
router.patch('/card/status', cardAuth, async (req, res) => {
  const { action } = req.body; // 'freeze' | 'unfreeze'
  if (!['freeze', 'unfreeze'].includes(action)) return res.status(422).json({ error: 'Action invalide' });
  const newStatus = action === 'freeze' ? 'frozen' : 'active';
  try {
    const r = await query(`SELECT status FROM virtual_cards WHERE card_id=$1`, [req.cardholder.cardId]);
    if (!r.rows.length) return res.status(404).json({ error: "Carte introuvable" });
    if (r.rows[0].status === 'cancelled') return res.status(422).json({ error: 'Carte annulée définitivement' });
    await query(`UPDATE virtual_cards SET status=$1, updated_at=NOW() WHERE card_id=$2`, [newStatus, req.cardholder.cardId]);
    await _auditCard(req.cardholder.cardId, req.cardholder.sub, action === 'freeze' ? 'CARD_FROZEN' : 'CARD_UNFROZEN', req.ip);
    res.json({ success: true, status: newStatus });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── PIN ──────────────────────────────────────────────────────────

// Créer/changer le PIN
router.post('/card/pin', cardAuth, async (req, res) => {
  const bcrypt = require('bcryptjs');
  const { currentPin, newPin, pin, cardId } = req.body;
  const targetPin = newPin || pin;

  if (!targetPin || !/^[0-9]{4}$/.test(targetPin))
    return res.status(422).json({ error: 'PIN doit etre 4 chiffres' });

  try {
    const chId = req.cardholder.cardholderId || req.cardholder.sub;
    const target = cardId || req.cardholder.cardId;

    // HOTFIX IDOR : uniquement la carte dont le porteur est propriétaire
    const r = await query(
      `SELECT pin_hash FROM virtual_cards
       WHERE card_id=$1 AND cardholder_id=$2`,
      [target, chId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Carte introuvable' });

    if (r.rows[0].pin_hash) {
      if (!currentPin) return res.status(422).json({ error: 'PIN actuel requis' });
      const ok = await bcrypt.compare(currentPin, r.rows[0].pin_hash);
      if (!ok) {
        await query(`INSERT INTO pin_attempts (card_id, ip_address, success) VALUES ($1,$2,FALSE)`,
          [target, req.ip]);
        return res.status(401).json({ error: 'PIN actuel incorrect' });
      }
    }

    const hash = await bcrypt.hash(targetPin, 12);
    await query(`UPDATE virtual_cards SET pin_hash=$1, updated_at=NOW() WHERE card_id=$2 AND cardholder_id=$3`,
      [hash, target, chId]);
    await query(`INSERT INTO pin_attempts (card_id, ip_address, success) VALUES ($1,$2,TRUE)`,
      [target, req.ip]);

    res.json({ success: true, message: 'PIN defini', cardId: target });
  } catch (err) {
    console.error('card/pin:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/profile', cardAuth, async (req, res) => {
  const { email, phone, address, city } = req.body;
  if (!email && !phone && !address && !city) return res.status(422).json({ error: 'Aucun champ à modifier' });
  try {
    const sets = []; const params = [];
    const add = (col, val) => { if (val !== undefined) { params.push(val); sets.push(`${col}=$${params.length}`); } };
    add('email', email); add('phone', phone); add('address', address); add('city', city);
    params.push(req.cardholder.sub);
    await query(`UPDATE cardholders SET ${sets.join(',')}, updated_at=NOW() WHERE cardholder_id=$${params.length}`, params);
    await _auditCard(req.cardholder.cardId, req.cardholder.sub, 'PROFILE_UPDATED', req.ip);
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: "Email ou téléphone déjà utilisé" });
    res.status(500).json({ error: err.message });
  }
});

// Changer mot de passe
router.post('/profile/change-password', cardAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(422).json({ error: 'Champs requis' });
  if (newPassword.length < 8) return res.status(422).json({ error: 'Mot de passe trop court (min 8 car.)' });
  try {
    const r = await query(`SELECT password_hash FROM cardholders WHERE cardholder_id=$1`, [req.cardholder.sub]);
    const ok = await bcrypt.compare(currentPassword, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Mot de passe actuel incorrect', code: 'WRONG_PASSWORD' });
    const hash = await bcrypt.hash(newPassword, 12);
    await query(`UPDATE cardholders SET password_hash=$1, updated_at=NOW() WHERE cardholder_id=$2`, [hash, req.cardholder.sub]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── TRANSACTIONS ─────────────────────────────────────────────────

// Historique transactions
router.get('/transactions', cardAuth, async (req, res) => {
  const { type, status } = req.query;
  const { page, limit, offset } = parsePagination(req.query);
  try {
    const conditions = ['card_id = $1'];
    const params     = [req.cardholder.cardId];
    if (type)   { params.push(type);   conditions.push(`type = $${params.length}`); }
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    const r = await query(
      `SELECT * FROM card_transactions WHERE ${conditions.join(' AND ')}
       ORDER BY initiated_at DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`,
      [...params, limit, offset]
    );
    const cnt = await query(`SELECT COUNT(*) FROM card_transactions WHERE ${conditions.join(' AND ')}`, params);
    res.json({ data: r.rows, total: parseInt(cnt.rows[0].count), page, limit });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── PAIEMENT MERCHANT ────────────────────────────────────────────
router.post('/payment', cardAuth, async (req, res) => {
  const { merchantId, amount, description, pin } = req.body;
  if (!amount || amount <= 0) return res.status(422).json({ error: 'Montant invalide' });
  if (!pin) return res.status(422).json({ error: 'PIN requis' });

  try {
    // Réponse envoyée après COMMIT (withTransaction retourne le résultat)
    const out = await withTransaction(async client => {
      // Récupérer la carte (HOTFIX IDOR : scopée au porteur)
      const cardRes = await client.query(`SELECT * FROM virtual_cards WHERE card_id=$1 AND cardholder_id=$2 FOR UPDATE`, [req.cardholder.cardId, req.cardholder.sub]);
      const card = cardRes.rows[0];
      if (!card) throw new Error("Carte introuvable");
      if (card.status !== 'active') throw new Error(`Carte ${card.status === 'frozen' ? 'gelée' : 'inactive'}`);

      // Vérifier PIN
      const pinOk = card.pin_hash ? !!(await bcrypt.compare(pin, card.pin_hash)) : false;
      await client.query(`INSERT INTO pin_attempts (card_id, ip_address, success) VALUES ($1,$2,$3)`, [card.card_id, req.ip, pinOk]);
      if (!pinOk) throw new Error('PIN incorrect');

      // Vérifier solde
      if (parseFloat(card.balance) < amount) throw new Error('Solde insuffisant');

      // Calculer frais (0.5%)
      const fee = Math.round(amount * 0.005);
      const total = amount + fee;
      if (parseFloat(card.balance) < total) throw new Error('Solde insuffisant (frais inclus)');

      // Récupérer info marchand
      let merchantName = 'Marchand inconnu';
      if (merchantId) {
        const mRes = await client.query(`SELECT business_name FROM merchants WHERE merchant_id=$1`, [merchantId]);
        if (mRes.rows.length) merchantName = mRes.rows[0].business_name;
      }

      const balBefore = parseFloat(card.balance);
      const balAfter  = balBefore - total;
      const authCode  = Math.random().toString(36).substr(2, 6).toUpperCase();

      // Débiter la carte
      await client.query(`UPDATE virtual_cards SET balance=$1, updated_at=NOW() WHERE card_id=$2`, [balAfter, card.card_id]);

      // Enregistrer la transaction
      const txnRes = await client.query(
        `INSERT INTO card_transactions (txn_id, card_id, cardholder_id, type, amount, fee, net_amount, balance_before, balance_after, currency, status, description, merchant_name, merchant_id, auth_code, initiated_at, completed_at)
         VALUES ($1,$2,$3,'payment',$4,$5,$6,$7,$8,$9,'completed',$10,$11,$12,$13,NOW(),NOW()) RETURNING *`,
        [uuidv4(), card.card_id, req.cardholder.sub, amount, fee, amount - fee, balBefore, balAfter, card.currency, description || null, merchantName, merchantId || null, authCode]
      );

      return { txn: txnRes.rows[0], newBalance: balAfter, authCode };
    });
    res.json({ success: true, ...out });
  } catch (err) {
    const status = ['PIN incorrect','Solde insuffisant','Carte gelée','Carte inactive','Carte introuvable'].some(m => err.message.includes(m)) ? 422 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── TOP-UP (Mobile Money → Carte) ───────────────────────────────
router.post('/topup', cardAuth, async (req, res) => {
  // HOTFIX P0 : ce flux « Simuler appel Mobile Money » créditait la carte sans
  // débit réel chez l'opérateur. Désactivé (410) jusqu'au branchement provider.
  if (FEATURE_DISABLED) return featureDisabled(res);

  const { amount, operator, phone, pin } = req.body;
  if (!amount || amount <= 0 || amount < 500) return res.status(422).json({ error: 'Montant minimum 500 XAF' });
  if (!operator || !['mtn', 'orange', 'airtel', 'vodacom'].includes(operator)) return res.status(422).json({ error: 'Opérateur invalide' });
  if (!phone) return res.status(422).json({ error: 'Numéro Mobile Money requis' });

  try {
    const out = await withTransaction(async client => {
      const chId = req.cardholder.cardholderId || req.cardholder.sub;
      const targetCardId = req.body.cardId || req.cardholder.cardId;
      const cardRes = await client.query(
        `SELECT * FROM virtual_cards WHERE card_id=$1 AND cardholder_id=$2 FOR UPDATE`,
        [targetCardId, chId]);
      const card = cardRes.rows[0];
      if (!card) throw new Error("Carte introuvable");
      if (card.status === 'cancelled') throw new Error('Carte annulee');

      // Frais topup (1%)
      const fee = Math.round(amount * 0.01);
      const credited = amount - fee;

      const balBefore = parseFloat(card.balance);
      const balAfter  = balBefore + credited;

      // Simuler appel Mobile Money (en production: appel vrai opérateur)
      const mmRef = `MM${operator.toUpperCase()}${Date.now()}`;

      // Créditer la carte
      await client.query(`UPDATE virtual_cards SET balance=$1, updated_at=NOW() WHERE card_id=$2`, [balAfter, card.card_id]);

      const txnRes = await client.query(
        `INSERT INTO card_transactions (txn_id, card_id, cardholder_id, type, amount, fee, net_amount, balance_before, balance_after, currency, status, description, mobile_money_op, mobile_money_phone, mm_reference, initiated_at, completed_at)
         VALUES ($1,$2,$3,'topup',$4,$5,$6,$7,$8,$9,'completed',$10,$11,$12,$13,NOW(),NOW()) RETURNING *`,
        [uuidv4(), card.card_id, req.cardholder.sub, amount, fee, credited, balBefore, balAfter, card.currency, `Top-up via ${operator.toUpperCase()}`, operator, phone, mmRef]
      );

      return { txn: txnRes.rows[0], newBalance: balAfter, credited, fee, mmReference: mmRef };
    });
    res.json({ success: true, ...out });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── UNLOAD (Carte → Mobile Money) ───────────────────────────────
router.post('/unload', cardAuth, async (req, res) => {
  // HOTFIX P0 : déchargement sans transfert réel vers l'opérateur → 410.
  if (FEATURE_DISABLED) return featureDisabled(res);

  const { amount, operator, phone, pin } = req.body;
  if (!amount || amount <= 0 || amount < 500) return res.status(422).json({ error: 'Montant minimum 500 XAF' });
  if (!operator || !['mtn', 'orange', 'airtel', 'vodacom'].includes(operator)) return res.status(422).json({ error: 'Opérateur invalide' });
  if (!phone) return res.status(422).json({ error: 'Numéro Mobile Money requis' });
  if (!pin) return res.status(422).json({ error: 'PIN requis' });

  try {
    const out = await withTransaction(async client => {
      const chId = req.cardholder.cardholderId || req.cardholder.sub;
      const targetCardId = req.body.cardId || req.cardholder.cardId;
      const cardRes = await client.query(
        `SELECT * FROM virtual_cards WHERE card_id=$1 AND cardholder_id=$2 FOR UPDATE`,
        [targetCardId, chId]);
      const card = cardRes.rows[0];
      if (!card) throw new Error("Carte introuvable");
      if (card.status !== 'active') throw new Error('Carte non active');

      // Vérifier PIN
      const pinOk = card.pin_hash && await bcrypt.compare(pin, card.pin_hash);
      if (!pinOk) throw new Error('PIN incorrect');

      // Frais unload (1.5%)
      const fee   = Math.round(amount * 0.015);
      const total = amount + fee;
      if (parseFloat(card.balance) < total) throw new Error('Solde insuffisant (frais inclus)');

      const balBefore = parseFloat(card.balance);
      const balAfter  = balBefore - total;
      const mmRef     = `UNL${operator.toUpperCase()}${Date.now()}`;

      await client.query(`UPDATE virtual_cards SET balance=$1, updated_at=NOW() WHERE card_id=$2`, [balAfter, card.card_id]);

      const txnRes = await client.query(
        `INSERT INTO card_transactions (txn_id, card_id, cardholder_id, type, amount, fee, net_amount, balance_before, balance_after, currency, status, description, mobile_money_op, mobile_money_phone, mm_reference, initiated_at, completed_at)
         VALUES ($1,$2,$3,'unload',$4,$5,$6,$7,$8,$9,'completed',$10,$11,$12,$13,NOW(),NOW()) RETURNING *`,
        [uuidv4(), card.card_id, req.cardholder.sub, amount, fee, amount - fee, balBefore, balAfter, card.currency, `Déchargement vers ${operator.toUpperCase()} ${phone}`, operator, phone, mmRef]
      );

      return { txn: txnRes.rows[0], newBalance: balAfter, sent: amount - fee, fee, mmReference: mmRef };
    });
    res.json({ success: true, ...out });
  } catch (err) {
    const status = err.message.includes('PIN') || err.message.includes('Solde') ? 422 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ─── Dashboard cardholder ─────────────────────────────────────────
router.get('/dashboard', cardAuth, async (req, res) => {
  try {
    const cardRes = await query(`SELECT balance, currency, status, card_masked, cardholder_name, expiry_month, expiry_year, network FROM virtual_cards WHERE card_id=$1`, [req.cardholder.cardId]);
    const card = cardRes.rows[0];

    const stats = await query(
      `SELECT
        COALESCE(SUM(amount) FILTER (WHERE type='payment' AND status='completed' AND initiated_at >= NOW()-INTERVAL '30 days'),0)  as month_spent,
        COALESCE(SUM(amount) FILTER (WHERE type='topup'   AND status='completed' AND initiated_at >= NOW()-INTERVAL '30 days'),0)  as month_topup,
        COALESCE(SUM(amount) FILTER (WHERE type='unload'  AND status='completed' AND initiated_at >= NOW()-INTERVAL '30 days'),0)  as month_unload,
        COUNT(*)            FILTER (WHERE status='completed' AND initiated_at >= NOW()-INTERVAL '30 days')                          as month_count,
        COUNT(*)            FILTER (WHERE status='completed' AND initiated_at >= CURRENT_DATE)                                      as today_count
       FROM card_transactions WHERE card_id=$1`,
      [req.cardholder.cardId]
    );

    const recent = await query(
      `SELECT * FROM card_transactions WHERE card_id=$1 ORDER BY initiated_at DESC LIMIT 5`,
      [req.cardholder.cardId]
    );

    res.json({
      card: { ...card, balance: parseFloat(card.balance) },
      stats: {
        monthSpent:  parseFloat(stats.rows[0].month_spent),
        monthTopup:  parseFloat(stats.rows[0].month_topup),
        monthUnload: parseFloat(stats.rows[0].month_unload),
        monthCount:  parseInt(stats.rows[0].month_count),
        todayCount:  parseInt(stats.rows[0].today_count),
      },
      recentTransactions: recent.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Helper audit
async function _auditCard(cardId, cardholderId, action, ip) {
  try {
    await query(
      `INSERT INTO audit_logs (actor_type, actor_id, action, entity_type, entity_id, ip_address)
       VALUES ('cardholder',$1,$2,'virtual_card',$3,$4)`,
      [cardholderId, action, cardId, ip]
    );
  } catch (_) {}
}


// ================================================================
// CARD ENROLLMENT & TOKENISATION (Option A — Token Interne CPlus)
// ================================================================

// ─── Session Key éphémère ─────────────────────────────────────────
// Le browser appelle d'abord cet endpoint pour obtenir une clé de
// chiffrement à usage unique (10 min). Le PAN est chiffré côté
// client avant d'être transmis.
router.get('/cards/session-key', cardAuth, async (req, res) => {
  try {
    const { keyId, sessionKey, expiresAt } = generateSessionKey(req.cardholder.sub);
    // La session key est retournée UNE SEULE FOIS en clair (HTTPS)
    // Elle sera utilisée par le browser pour chiffrer le PAN (AES-256-GCM)
    res.json({ keyId, sessionKey, expiresAt, algorithm: 'AES-256-GCM' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Enrollment d'une carte ──────────────────────────────────────
router.post('/cards/enroll', cardAuth, async (req, res) => {
  const { v4: uuidv4 } = require('uuid');
  const { cardNumber, expiryMonth, expiryYear, cardholderName, cvv, network } = req.body;

  if (!cardNumber || String(cardNumber).replace(/\s/g,'').length < 13)
    return res.status(422).json({ error: 'Numero de carte invalide' });
  if (!expiryMonth || !expiryYear)
    return res.status(422).json({ error: "Date d'expiration requise" });
  if (!cvv || cvv.length < 3)
    return res.status(422).json({ error: 'CVV requis' });
  if (!cardholderName)
    return res.status(422).json({ error: 'Nom du titulaire requis' });

  try {
    const chId = req.cardholder.cardholderId || req.cardholder.sub;
    const pan = String(cardNumber).replace(/\s/g, '');
    if (!/^[0-9]{13,19}$/.test(pan)) return res.status(422).json({ error: 'Numero de carte invalide' });

    // Luhn
    let sum = 0, alt = false;
    for (let i = pan.length - 1; i >= 0; i--) {
      let d = parseInt(pan[i], 10);
      if (alt) { d *= 2; if (d > 9) d -= 9; }
      sum += d; alt = !alt;
    }
    if (sum % 10 !== 0) return res.status(422).json({ error: 'Numero de carte invalide (Luhn)' });

    const ex = await query(
      `SELECT COUNT(*)::int as n FROM cardholder_enrolled_cards WHERE cardholder_id=$1 AND status='active'`,
      [chId]);
    if (ex.rows[0].n >= 3) return res.status(422).json({ error: 'Maximum 3 cartes enrolees' });

    const last4  = pan.slice(-4);
    const first4 = pan.slice(0, 4);
    const masked = `${first4} **** **** ${last4}`;

    const dup = await query(
      `SELECT 1 FROM cardholder_enrolled_cards WHERE cardholder_id=$1 AND card_masked=$2 AND status='active'`,
      [chId, masked]);
    if (dup.rows.length) return res.status(422).json({ error: 'Carte deja enrolee' });

    const detected = network || (
      pan[0] === '4' ? 'visa' :
      pan[0] === '5' ? 'mastercard' :
      pan.startsWith('34') || pan.startsWith('37') ? 'amex' : 'visa');

    // Token PSP (le PAN n'est jamais stocke)
    const crypto = require('crypto');
    const token = 'TOK-' + crypto.createHash('sha256')
      .update(pan + chId + (process.env.JWT_SECRET || 'salt'))
      .digest('hex').slice(0, 32).toUpperCase();

    const isFirst = ex.rows[0].n === 0;

    const r = await query(
      `INSERT INTO cardholder_enrolled_cards
        (enrollment_id, cardholder_id, card_masked, cardholder_name, network,
         expiry_month, expiry_year, token, psp, is_default, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'cybersource',$9,'active',NOW(),NOW())
       RETURNING enrollment_id, card_masked, cardholder_name, network,
                 expiry_month, expiry_year, is_default, status`,
      [uuidv4(), chId, masked, cardholderName.toUpperCase(), detected,
       parseInt(expiryMonth), parseInt(expiryYear), token, isFirst]
    );
    const e = r.rows[0];
    res.json({
      enrollmentId: e.enrollment_id, cardMasked: e.card_masked,
      cardholderName: e.cardholder_name, network: e.network,
      expiryMonth: e.expiry_month, expiryYear: e.expiry_year,
      isDefault: e.is_default, status: e.status, cardType: 'enrolled'
    });
  } catch(err) {
    console.error('cards/enroll:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/cards/created', cardAuth, async (req, res) => {
  try {
    const chId = req.cardholder.cardholderId || req.cardholder.sub;
    const r = await query(
      `SELECT card_id, card_masked, cardholder_name, balance, currency, status,
              network, expiry_month, expiry_year, daily_limit, monthly_limit, label
       FROM virtual_cards WHERE cardholder_id=$1 AND status != 'cancelled'
       ORDER BY created_at ASC`, [chId]);
    res.json({
      data: r.rows.map(function(c) {
        return {
          cardId: c.card_id, cardMasked: c.card_masked, cardholderName: c.cardholder_name,
          balance: parseFloat(c.balance), currency: c.currency, status: c.status,
          network: c.network, expiryMonth: c.expiry_month, expiryYear: c.expiry_year,
          dailyLimit: parseFloat(c.daily_limit), monthlyLimit: parseFloat(c.monthly_limit),
          label: c.label || 'Carte', cardType: 'created'
        };
      }),
      total: r.rows.length, max: 3
    });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.post('/cards/create', cardAuth, async (req, res) => {
  const uuidv4 = require('uuid').v4;
  const label = req.body.label;

  // Ne pas creer de carte fantome si GTP n'est pas actif
  const gtpClient = require('../services/rails/gtp.client');
  if (!gtpClient.isConfigured()) {
    return res.status(503).json({
      error: "Service cartes en cours d'activation",
      code: 'GTP_NOT_CONFIGURED',
    });
  }

  try {
    const chId = req.cardholder.cardholderId || req.cardholder.sub;
    const gtpService = require('../services/rails/gtp-card.service');
    const result = await gtpService.issueCard(chId, { label: label });
    res.json({
      cardId:     result.gtpCardId,
      gtpCardId:  result.gtpCardId,
      cardMasked: result.cardMasked,
      last4:      result.last4,
      passCode:   result.passCode,
      balance:    0,
      currency:   'XAF',
      status:     'active',
      network:    'visa',
      cardType:   'gtp',
      label:      label || 'Ma carte',
    });
  } catch(err) {
    console.error('cards/create GTP:', err.code || '-', err.message);
    const map = {
      GTP_NOT_CONFIGURED: [503, "Service cartes en cours d'activation"],
      GTP_TIMEOUT:        [504, 'Le service cartes ne repond pas'],
      GTP_NETWORK_ERROR:  [502, 'Erreur reseau service cartes'],
      GTP_SOAP_FAULT:     [502, err.message],
      GTP_HTTP_ERROR:     [502, err.message],
    };
    if (map[err.code]) { const [s, msg] = map[err.code]; return res.status(s).json({ error: msg, code: err.code }); }
    if (err.code === 'GTP_ERROR') return res.status(422).json({ error: err.message, gtpError: err.gtpErrorNumber });
    if (err.gtpCardId) return res.status(422).json({ error: 'Vous avez deja une carte', gtp_card_id: err.gtpCardId });
    res.status(500).json({ error: err.message });
  }
});

router.delete('/cards/created/:cardId', cardAuth, async (req, res) => {
  try {
    const chId = req.cardholder.cardholderId || req.cardholder.sub;
    const card = await query(
      `SELECT balance FROM virtual_cards WHERE card_id=$1 AND cardholder_id=$2`,
      [req.params.cardId, chId]);
    if (!card.rows[0]) return res.status(404).json({ error: 'Carte introuvable' });
    if (parseFloat(card.rows[0].balance) > 0)
      return res.status(422).json({ error: 'Dechargez la carte avant de la supprimer' });
    await query(`UPDATE virtual_cards SET status='cancelled', updated_at=NOW() WHERE card_id=$1`,
      [req.params.cardId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

router.get('/cards', cardAuth, async (req, res) => {
  try {
    const chId = req.cardholder.cardholderId || req.cardholder.sub;
    const r = await query(
      `SELECT enrollment_id, card_masked, cardholder_name, network,
              expiry_month, expiry_year, is_default, status
       FROM cardholder_enrolled_cards
       WHERE cardholder_id=$1 AND status='active'
       ORDER BY is_default DESC, created_at ASC`, [chId]);
    res.json({
      data: r.rows.map(c => ({
        enrollmentId: c.enrollment_id, cardMasked: c.card_masked,
        cardholderName: c.cardholder_name, network: c.network,
        expiryMonth: c.expiry_month, expiryYear: c.expiry_year,
        isDefault: c.is_default, status: c.status, cardType: 'enrolled'
      })),
      total: r.rows.length
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Définir la carte par défaut ─────────────────────────────────
router.patch('/cards/:enrollmentId/default', cardAuth, async (req, res) => {
  try {
    const chId = req.cardholder.cardholderId || req.cardholder.sub;
    await query(`UPDATE cardholder_enrolled_cards SET is_default=FALSE WHERE cardholder_id=$1`, [chId]);
    await query(
      `UPDATE cardholder_enrolled_cards SET is_default=TRUE, updated_at=NOW()
       WHERE enrollment_id=$1 AND cardholder_id=$2`,
      [req.params.enrollmentId, chId]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Révoquer une carte ───────────────────────────────────────────
router.delete('/cards/:enrollmentId', cardAuth, async (req, res) => {
  try {
    const chId = req.cardholder.cardholderId || req.cardholder.sub;
    await query(
      `UPDATE cardholder_enrolled_cards SET status='removed', updated_at=NOW()
       WHERE enrollment_id=$1 AND cardholder_id=$2`,
      [req.params.enrollmentId, chId]);
    res.json({ success:true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Paiement avec token (override du paiement existant) ─────────
// Accepte soit { merchantId, amount, pin } (ancien)
// Soit         { tokenId, amount, pin }    (nouveau — tokenisé)
router.post('/payment/tokenized', cardAuth, async (req, res) => {
  const { v4: uuidv4 } = require('uuid');
  const bcrypt = require('bcryptjs');
  const { cardId, enrollmentId, merchantId, amount, description, pin } = req.body;

  if (!amount || parseFloat(amount) <= 0) return res.status(422).json({ error: 'Montant invalide' });
  if (!pin || pin.length !== 4) return res.status(422).json({ error: 'PIN requis (4 chiffres)' });
  if (!cardId && !enrollmentId) return res.status(422).json({ error: 'cardId ou enrollmentId requis' });

  try {
    const chId = req.cardholder.cardholderId || req.cardholder.sub;
    const amt = parseFloat(amount);

    // ─── Cas 1: paiement depuis une CARTE CREEE (solde interne) ───
    if (cardId) {
      // HOTFIX : débit atomique (SELECT ... FOR UPDATE dans une transaction),
      // carte scopée au porteur (plus de `OR cardholder_id IS NULL`),
      // refus si solde insuffisant, réponse après COMMIT.
      const fail = (status, error) => { const e = new Error(error); e.statusCode = status; return e; };
      let out;
      try {
        out = await withTransaction(async client => {
          const cardRes = await client.query(
            `SELECT * FROM virtual_cards WHERE card_id=$1 AND cardholder_id=$2 FOR UPDATE`,
            [cardId, chId]);
          const card = cardRes.rows[0];
          if (!card) throw fail(404, 'Carte introuvable');
          if (card.status !== 'active')
            throw fail(422, card.status === 'frozen' ? 'Carte gelee' : 'Carte inactive');

          const pinOk = card.pin_hash ? await bcrypt.compare(pin, card.pin_hash) : false;
          await client.query(`INSERT INTO pin_attempts (card_id, ip_address, success) VALUES ($1,$2,$3)`,
            [card.card_id, req.ip, pinOk]).catch(() => {});
          if (!pinOk) throw fail(401, 'PIN incorrect');

          const bal = parseFloat(card.balance);
          if (amt > bal) throw fail(422, `Solde insuffisant (${bal} XAF)`);

          const fee = Math.round(amt * 0.01);
          const total = amt + fee;
          if (total > bal) throw fail(422, `Solde insuffisant avec frais (${total} XAF requis)`);

          const ref = 'PAY-' + Date.now().toString(36).toUpperCase();
          const authCode = 'AUTH' + crypto.randomBytes(4).toString('hex').toUpperCase();

          const upd = await client.query(
            `UPDATE virtual_cards SET balance = balance - $1, updated_at=NOW()
             WHERE card_id=$2 AND cardholder_id=$3 AND balance >= $1 RETURNING balance`,
            [total, cardId, chId]);
          if (!upd.rows.length) throw fail(422, 'Solde insuffisant');

          const txn = await client.query(
            `INSERT INTO card_transactions (txn_id, card_id, cardholder_id, type, amount, currency,
              fee_amount, net_amount, status, auth_code, description, merchant_id, initiated_at, completed_at)
             VALUES ($1,$2,$3,'payment',$4,'XAF',$5,$6,'completed',$7,$8,$9,NOW(),NOW())
             RETURNING txn_id, amount, fee_amount, status, auth_code`,
            [uuidv4(), cardId, chId, amt, fee, amt, authCode,
             description || 'Paiement CPlus', merchantId || null]
          );

          return {
            txnId: txn.rows[0].txn_id,
            reference: ref,
            authCode,
            amount: amt,
            fee,
            newBalance: parseFloat(upd.rows[0].balance),
          };
        });
      } catch (e) {
        if (e.statusCode) return res.status(e.statusCode).json({ error: e.message });
        throw e;
      }

      return res.json({ success: true, ...out, status: 'completed', paymentSource: 'created_card' });
    }

    // ─── Cas 2: paiement depuis une CARTE ENROLEE (via PSP) ───
    // HOTFIX P0 : `const authorized = true` insérait une transaction `authorized`
    // pour un merchantId arbitraire sans appel PSP. Désactivé (410) tant que
    // l'appel CyberSource réel n'est pas branché. Code conservé ci-dessous.
    if (FEATURE_DISABLED) return featureDisabled(res);

    const enr = await query(
      `SELECT * FROM cardholder_enrolled_cards
       WHERE enrollment_id=$1 AND cardholder_id=$2 AND status='active'`,
      [enrollmentId, chId]);
    const card = enr.rows[0];
    if (!card) return res.status(404).json({ error: 'Carte enrolee introuvable' });

    // Verifier le PIN de la carte principale (securite)
    const mainCard = await query(
      `SELECT pin_hash FROM virtual_cards WHERE cardholder_id=$1 AND status='active' LIMIT 1`, [chId]);
    const pinOk = mainCard.rows[0]?.pin_hash
      ? await bcrypt.compare(pin, mainCard.rows[0].pin_hash) : false;
    if (!pinOk) return res.status(401).json({ error: 'PIN incorrect' });

    // Appel PSP (CyberSource) avec le token
    const ref = 'TOK-' + Date.now().toString(36).toUpperCase();
    const fee = Math.round(amt * 0.015);
    const authCode = 'PSP' + Math.random().toString(36).slice(2,8).toUpperCase();

    const pspCfg = await query(
      `SELECT * FROM api_configs WHERE provider_key='cybersource' AND status='active' LIMIT 1`
    ).catch(() => ({ rows: [] }));

    // TODO: appel reel CyberSource /pts/v2/payments avec card.token
    // Simulation en attendant les credentials
    const authorized = true;

    if (!authorized) return res.status(402).json({ error: 'Paiement refuse par la banque' });

    const txn = await query(
      `INSERT INTO transactions (merchant_id, type, amount, currency, fee_amount, net_amount,
        payment_method, status, auth_code, description, initiated_at, completed_at)
       VALUES ($1,'payment',$2,'XAF',$3,$4,'card_nfc','authorized',$5,$6,NOW(),NOW())
       RETURNING transaction_id, amount, fee_amount, status, auth_code`,
      [merchantId || null, amt, fee, amt - fee, authCode,
       description || `Paiement carte ${card.card_masked}`]
    );

    res.json({
      success: true,
      txnId: txn.rows[0].transaction_id,
      reference: ref,
      authCode,
      amount: amt,
      fee,
      status: 'authorized',
      paymentSource: 'enrolled_card',
      cardMasked: card.card_masked,
      psp: pspCfg.rows.length ? 'cybersource' : 'simulation'
    });

  } catch (err) {
    console.error('payment/tokenized:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/logout', cardAuth, async (req, res) => {
  destroySession(req.cardholder.sub);
  await auditLog({ eventType: 'AUTH_LOGOUT', actorType: 'cardholder', actorId: req.cardholder.sub, entityType: 'session', ipAddress: req.ip, success: true });
  res.json({ success: true });
});

// Rapport sécurité cardholder (REQ 10.6)
router.get('/security/events', cardAuth, async (req, res) => {
  const r = await query(
    `SELECT event_type, success, ip_address, created_at FROM pci_audit_logs
     WHERE actor_id=$1 ORDER BY created_at DESC LIMIT 50`,
    [req.cardholder.sub]
  );
  res.json({ events: r.rows });
});

module.exports = router;

// ─── SUPPORT TICKETS CARDHOLDER ──────────────────────────────────
router.get('/support/tickets', cardAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT t.*, tm.message as last_message
       FROM support_tickets t
       LEFT JOIN ticket_messages tm ON tm.message_id = (
         SELECT message_id FROM ticket_messages WHERE ticket_id=t.ticket_id ORDER BY created_at DESC LIMIT 1
       )
       WHERE t.cardholder_id=$1
       ORDER BY t.created_at DESC`,
      [req.cardholder.sub]
    );
    res.json({ data: r.rows, tickets: r.rows });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/support/tickets', cardAuth, async (req, res) => {
  const { subject, message, priority='normal', category='general', cardReference } = req.body;
  if (!subject || !message) return res.status(422).json({error:'Sujet et message requis'});
  try {
    const ticketNum = 'TKT-CH' + Math.random().toString(36).substr(2,6).toUpperCase();
    const fullDescription = cardReference ? '[Carte: ' + cardReference + ']\n' + message : message;
    const t = await query(
      `INSERT INTO support_tickets (ticket_number, cardholder_id, subject, category, priority, status, description)
       VALUES ($1,$2,$3,$4,$5,'open',$6) RETURNING *`,
      [ticketNum, req.cardholder.sub, subject, category, priority, fullDescription || message]
    );
    const ticket = t.rows[0];
    await query(
      `INSERT INTO ticket_messages (ticket_id, sender_type, sender_id, sender_name, message)
       VALUES ($1,'merchant',$2,$3,$4)`,
      [ticket.ticket_id, req.cardholder.sub, req.cardholder.name||'Cardholder', message]
    );
    res.status(201).json(ticket);
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.get('/support/tickets/:id', cardAuth, async (req, res) => {
  try {
    // HOTFIX IDOR : ticket scopé au porteur
    const t = await query(`SELECT * FROM support_tickets WHERE ticket_id=$1 AND cardholder_id=$2`, [req.params.id, req.cardholder.sub]);
    if (!t.rows.length) return res.status(404).json({error:'Ticket introuvable'});
    const msgs = await query(`SELECT * FROM ticket_messages WHERE ticket_id=$1 ORDER BY created_at ASC`, [req.params.id]);
    res.json({ ...t.rows[0], messages: msgs.rows });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/support/tickets/:id/messages', cardAuth, async (req, res) => {
  const { message, attachments } = req.body;
  if (!message) return res.status(422).json({error:'Message requis'});
  try {
    // HOTFIX IDOR : ticket scopé au porteur
    const own = await query(`SELECT 1 FROM support_tickets WHERE ticket_id=$1 AND cardholder_id=$2`, [req.params.id, req.cardholder.sub]);
    if (!own.rows.length) return res.status(404).json({error:'Ticket introuvable'});
    await query(
      `INSERT INTO ticket_messages (ticket_id, sender_type, sender_id, sender_name, message, attachments)
       VALUES ($1,'merchant',$2,$3,$4,$5)`,
      [req.params.id, req.cardholder.sub, req.cardholder.name||'Cardholder', message, JSON.stringify(attachments||[])]
    );
    await query(`UPDATE support_tickets SET status='pending_admin', updated_at=NOW() WHERE ticket_id=$1`, [req.params.id]);
    res.status(201).json({success:true});
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── 2FA CARDHOLDER ───────────────────────────────────────────────
const speakeasy2 = require('speakeasy');
const QRCode2    = require('qrcode');

router.post('/auth/2fa/setup', cardAuth, async (req, res) => {
  try {
    const secret = speakeasy2.generateSecret({ name: `CPlus:${req.cardholder.email}`, length: 20 });
    await query(`UPDATE cardholders SET mfa_secret=$1 WHERE cardholder_id=$2`, [secret.base32, req.cardholder.sub]);
    const qrUrl = await QRCode2.toDataURL(secret.otpauth_url);
    res.json({ secret: secret.base32, qrCode: qrUrl });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/auth/2fa/verify', cardAuth, async (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string') return res.status(400).json({error:'Code requis'});
  try {
    const u = await query(`SELECT mfa_secret FROM cardholders WHERE cardholder_id=$1`, [req.cardholder.sub]);
    if (!u.rows[0]?.mfa_secret) return res.status(400).json({error:'2FA non configuré'});
    const valid = speakeasy2.totp.verify({ secret: u.rows[0].mfa_secret, encoding:'base32', token:token.replace(/\s/g,''), window:2 });
    if (!valid) return res.status(400).json({error:'Code invalide'});
    await query(`UPDATE cardholders SET mfa_enabled=TRUE WHERE cardholder_id=$1`, [req.cardholder.sub]);
    res.json({success:true, message:'2FA activé ✅'});
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.get('/auth/2fa/status', cardAuth, async (req, res) => {
  try {
    const u = await query(
      `SELECT mfa_enabled, mfa_method, first_login_at, created_at FROM cardholders WHERE cardholder_id=$1`,
      [req.cardholder.sub]
    );
    const user = u.rows[0];
    const daysSinceCreation = Math.floor((Date.now() - new Date(user.first_login_at||user.created_at)) / 86400000);
    const daysLeft = Math.max(0, 10 - daysSinceCreation);
    res.json({ mfaEnabled: user.mfa_enabled, mfaMethod: user.mfa_method, daysSinceCreation, daysLeft, required: daysSinceCreation >= 10 });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// ─── KYC CARDHOLDER ───────────────────────────────────────────────
router.get('/kyc', cardAuth, async (req, res) => {
  try {
    const ch = await query(`SELECT kyc_level, first_name, last_name FROM cardholders WHERE cardholder_id=$1`, [req.cardholder.sub]);
    const docs = await query(
      `SELECT doc_id, doc_type, doc_label, file_name, status, rejection_reason, uploaded_at, reviewed_at
       FROM kyb_documents WHERE cardholder_id=$1 ORDER BY uploaded_at DESC`,
      [req.cardholder.sub]
    );
    res.json({ ...ch.rows[0], kyc_level: ch.rows[0]?.kyc_level || 0, documents: docs.rows });
  } catch(err){ res.status(500).json({error:err.message}); }
});

router.post('/kyc/documents', cardAuth, async (req, res) => {
  const { docType, docLabel, fileUrl, fileName, mimeType } = req.body;
  if (!docType || !fileUrl) return res.status(422).json({error:'docType et fileUrl requis'});
  try {
    // Vérifier si kyb_documents a une colonne cardholder_id
    const r = await query(
      `INSERT INTO kyb_documents (cardholder_id, doc_type, doc_label, file_url, file_name, mime_type)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING doc_id, doc_type, doc_label, status, uploaded_at`,
      [req.cardholder.sub, docType, docLabel||docType, fileUrl, fileName||null, mimeType||null]
    );
    const ch = await query(`SELECT first_name, last_name FROM cardholders WHERE cardholder_id=$1`, [req.cardholder.sub]);
    const name = `${ch.rows[0]?.first_name||''} ${ch.rows[0]?.last_name||''}`.trim();
    await notify({
      type: 'kyc_document_submitted',
      title: 'Nouveau document KYC soumis (Cardholder)',
      message: `${name} a soumis un document KYC: ${docLabel||docType}`,
      entityType: 'cardholder',
      entityId: req.cardholder.sub,
      metadata: { docType, docLabel, fileName, cardholderId: req.cardholder.sub }
    });
    res.status(201).json(r.rows[0]);
  } catch(err){ res.status(500).json({error:err.message}); }
});
