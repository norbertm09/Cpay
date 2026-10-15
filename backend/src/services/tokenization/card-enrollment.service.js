// backend/src/services/tokenization/card-enrollment.service.js
// ================================================================
// CPlus 2.6 — Card Enrollment & Tokenisation Interne (Option A)
//
// Flux sécurisé :
// 1. Browser chiffre le PAN avec AES-256-GCM (SubtleCrypto API)
//    en utilisant une clé éphémère dérivée d'une session key serveur
// 2. Backend déchiffre le PAN dans un bloc isolé
// 3. Validation Luhn + détection réseau
// 4. Génération token UUID v4 préfixé tok_
// 5. Calcul pan_fingerprint SHA-256 (détection doublon)
// 6. PAN détruit immédiatement (jamais persisté)
// 7. Token stocké avec métadonnées non-sensibles
// ================================================================

'use strict';

const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query, withTransaction } = require('../../config/database');
const { auditLog, PCI_EVENTS } = require('../../middleware/pci.middleware');

// ─── Clé de chiffrement AES-256-GCM ─────────────────────────────
// Lue depuis la variable d'environnement CARD_ENCRYPTION_KEY (hex 64 chars = 32 bytes)
const getEncryptionKey = () => {
  const keyHex = process.env.CARD_ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error('CARD_ENCRYPTION_KEY manquante ou invalide (requis: 64 hex chars = 32 bytes)');
  }
  return Buffer.from(keyHex, 'hex');
};

// ─── Chiffrement AES-256-GCM (pour les session keys éphémères) ──
const encrypt = (plaintext) => {
  const key  = getEncryptionKey();
  const iv   = crypto.randomBytes(12); // 96 bits pour GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag(); // 128 bits tag d'authentification
  return {
    iv:        iv.toString('hex'),
    data:      encrypted.toString('hex'),
    tag:       tag.toString('hex'),
  };
};

// ─── Déchiffrement AES-256-GCM ───────────────────────────────────
const decrypt = ({ iv, data, tag }) => {
  const key    = getEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(data, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
};

// ─── Algorithme de Luhn ──────────────────────────────────────────
const luhnCheck = (pan) => {
  const digits = pan.replace(/\D/g, '').split('').map(Number).reverse();
  const sum = digits.reduce((acc, digit, i) => {
    if (i % 2 === 1) {
      const doubled = digit * 2;
      return acc + (doubled > 9 ? doubled - 9 : doubled);
    }
    return acc + digit;
  }, 0);
  return sum % 10 === 0;
};

// ─── Détection réseau carte ───────────────────────────────────────
const detectNetwork = (pan) => {
  const p = pan.replace(/\D/g, '');
  if (/^4/.test(p)) return 'visa';
  if (/^5[1-5]/.test(p) || /^2[2-7]/.test(p)) return 'mastercard';
  if (/^3[47]/.test(p)) return 'amex';
  if (/^6(?:011|5)/.test(p)) return 'discover';
  if (/^(?:2131|1800|35)/.test(p)) return 'jcb';
  return 'unknown';
};

// ─── Masquage PAN ─────────────────────────────────────────────────
const maskPan = (pan) => {
  const clean = pan.replace(/\D/g, '');
  const first4 = clean.slice(0, 4);
  const last4  = clean.slice(-4);
  const stars  = '*'.repeat(clean.length - 8);
  return (first4 + stars + last4).match(/.{1,4}/g).join(' ');
};

// ─── Génération session key éphémère ─────────────────────────────
// Le browser utilise cette clé pour chiffrer le PAN côté client
// Elle expire après 10 minutes et est à usage unique
const sessionKeys = new Map();

const generateSessionKey = (cardholderId) => {
  const sessionKey = crypto.randomBytes(32).toString('hex'); // 256 bits
  const keyId      = uuidv4();
  const expiresAt  = Date.now() + 10 * 60 * 1000; // 10 minutes

  sessionKeys.set(keyId, {
    key:          sessionKey,
    cardholderId,
    expiresAt,
    used:         false,
  });

  // Nettoyage automatique (unref : ne retient pas le process / les tests)
  const t = setTimeout(() => sessionKeys.delete(keyId), 11 * 60 * 1000);
  if (typeof t.unref === 'function') t.unref();

  return { keyId, sessionKey, expiresAt };
};

const consumeSessionKey = (keyId, cardholderId) => {
  const entry = sessionKeys.get(keyId);
  if (!entry) throw new Error('Clé de session introuvable ou expirée');
  if (entry.used) throw new Error('Clé de session déjà utilisée');
  if (entry.cardholderId !== cardholderId) throw new Error('Clé de session invalide');
  if (Date.now() > entry.expiresAt) {
    sessionKeys.delete(keyId);
    throw new Error('Clé de session expirée');
  }
  entry.used = true; // Usage unique
  const key = entry.key;
  sessionKeys.delete(keyId);
  return key;
};

// ─── ENROLLMENT ──────────────────────────────────────────────────

/**
 * Enroller une carte :
 * - Déchiffrer le PAN (AES-256-GCM, session key éphémère)
 * - Valider (Luhn, expiry, CVV format)
 * - Générer token tok_xxxxxx
 * - Stocker sans le PAN
 * - PAN zeroisé immédiatement
 */
const enrollCard = async ({
  cardholderId,
  encryptedPan,   // { keyId, iv, data, tag } — PAN chiffré avec session key
  cvvProvided,    // booléen uniquement — on ne stocke pas le CVV
  expiryMonth,
  expiryYear,
  cardholderName,
  enrollmentIp,
  enrollmentUa,
}) => {
  // 1. Déchiffrer le PAN
  let pan;
  try {
    const sessionKey = consumeSessionKey(encryptedPan.keyId, cardholderId);
    // Déchiffrer avec la session key (AES-256-GCM)
    const keyBuf  = Buffer.from(sessionKey, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, Buffer.from(encryptedPan.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(encryptedPan.tag, 'hex'));
    pan = Buffer.concat([
      decipher.update(Buffer.from(encryptedPan.data, 'hex')),
      decipher.final(),
    ]).toString('utf8').replace(/\D/g, '');
  } catch (err) {
    throw Object.assign(new Error('Déchiffrement échoué : ' + err.message), { statusCode: 422, code: 'DECRYPTION_FAILED' });
  }

  try {
    // 2. Validations
    if (pan.length < 13 || pan.length > 19) {
      throw Object.assign(new Error('Numéro de carte invalide'), { statusCode: 422, code: 'INVALID_PAN_LENGTH' });
    }
    if (!luhnCheck(pan)) {
      throw Object.assign(new Error('Numéro de carte invalide (Luhn)'), { statusCode: 422, code: 'LUHN_FAILED' });
    }
    const now = new Date();
    const exp = new Date(expiryYear, expiryMonth - 1, 1);
    if (exp < now) {
      throw Object.assign(new Error('Carte expirée'), { statusCode: 422, code: 'CARD_EXPIRED' });
    }

    // 3. Métadonnées (non-sensibles)
    const network    = detectNetwork(pan);
    const last4      = pan.slice(-4);
    const masked     = maskPan(pan);
    const panFp      = crypto.createHash('sha256').update(pan).digest('hex');

    // 4. Vérifier doublons (même PAN, même cardholder)
    const existing = await query(
      `SELECT enrollment_id, status FROM enrolled_cards
       WHERE cardholder_id=$1 AND pan_fingerprint=$2`,
      [cardholderId, panFp]
    );
    if (existing.rows.length > 0) {
      if (existing.rows[0].status === 'active') {
        throw Object.assign(new Error('Cette carte est déjà enregistrée'), { statusCode: 409, code: 'CARD_ALREADY_ENROLLED' });
      }
      // Réactiver si révoquée
      const re = await query(
        `UPDATE enrolled_cards SET status='active', revoked_at=NULL, revocation_reason=NULL, enrolled_at=NOW(), enrollment_ip=$1
         WHERE enrollment_id=$2 RETURNING *`,
        [enrollmentIp, existing.rows[0].enrollment_id]
      );
      await _auditEnrollment(re.rows[0].enrollment_id, cardholderId, 'RE_ENROLLED', enrollmentIp, enrollmentUa, { network, last4 });
      return _safeCardData(re.rows[0]);
    }

    // 5. Générer le token
    const tokenId    = `tok_${uuidv4().replace(/-/g, '')}`;
    const tokenHash  = crypto.createHash('sha256').update(tokenId).digest('hex');

    // 6. Vérifier si c'est la première carte (devient défaut)
    const countRes = await query(
      `SELECT COUNT(*) FROM enrolled_cards WHERE cardholder_id=$1 AND status='active'`,
      [cardholderId]
    );
    const isDefault = parseInt(countRes.rows[0].count) === 0;

    // 7. Persister le token (PAN JAMAIS stocké)
    const result = await query(
      `INSERT INTO enrolled_cards
         (cardholder_id, token_id, token_hash, card_masked, last4, expiry_month, expiry_year,
          network, cardholder_name, pan_fingerprint, is_default, enrollment_ip, enrollment_ua)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [cardholderId, tokenId, tokenHash, masked, last4, expiryMonth, expiryYear,
       network, cardholderName || '', panFp, isDefault, enrollmentIp, enrollmentUa]
    );

    // 8. Audit PCI
    await _auditEnrollment(result.rows[0].enrollment_id, cardholderId, 'ENROLLED', enrollmentIp, enrollmentUa, { network, last4, isDefault });

    return _safeCardData(result.rows[0]);

  } finally {
    // 9. Zéroïser le PAN en mémoire (best-effort JS)
    if (pan) pan = '0'.repeat(pan.length);
    pan = null;
  }
};

// ─── Lister les cartes enrollées ─────────────────────────────────
const listEnrolledCards = async (cardholderId) => {
  const r = await query(
    `SELECT * FROM cardholder_enrolled_cards WHERE cardholder_id=$1`,
    [cardholderId]
  );
  return r.rows.map(_safeCardData);
};

// ─── Définir carte par défaut ────────────────────────────────────
const setDefaultCard = async (cardholderId, enrollmentId) => {
  await withTransaction(async client => {
    await client.query(
      `UPDATE enrolled_cards SET is_default=FALSE WHERE cardholder_id=$1`,
      [cardholderId]
    );
    const r = await client.query(
      `UPDATE enrolled_cards SET is_default=TRUE
       WHERE enrollment_id=$1 AND cardholder_id=$2 AND status='active'
       RETURNING enrollment_id`,
      [enrollmentId, cardholderId]
    );
    if (!r.rows.length) throw new Error('Carte introuvable');
  });
};

// ─── Révoquer une carte ───────────────────────────────────────────
const revokeCard = async (cardholderId, enrollmentId, reason = 'USER_REQUEST', ip, ua) => {
  const r = await query(
    `UPDATE enrolled_cards
     SET status='revoked', revoked_at=NOW(), revocation_reason=$1
     WHERE enrollment_id=$2 AND cardholder_id=$3 AND status='active'
     RETURNING enrollment_id, last4, network`,
    [reason, enrollmentId, cardholderId]
  );
  if (!r.rows.length) throw Object.assign(new Error('Carte introuvable'), { statusCode: 404 });
  await _auditEnrollment(enrollmentId, cardholderId, 'REVOKED', ip, ua, { reason });

  // Si c'était la carte par défaut, promouvoir la plus récente
  const remaining = await query(
    `SELECT enrollment_id FROM enrolled_cards WHERE cardholder_id=$1 AND status='active' ORDER BY enrolled_at DESC LIMIT 1`,
    [cardholderId]
  );
  if (remaining.rows.length > 0) {
    await query(`UPDATE enrolled_cards SET is_default=TRUE WHERE enrollment_id=$1`, [remaining.rows[0].enrollment_id]);
  }

  return { success: true, revoked: r.rows[0] };
};

// ─── Résolution token → enrollment ───────────────────────────────
const resolveToken = async (tokenId, cardholderId) => {
  const tokenHash = crypto.createHash('sha256').update(tokenId).digest('hex');
  const r = await query(
    `SELECT * FROM enrolled_cards
     WHERE token_hash=$1 AND cardholder_id=$2 AND status='active'`,
    [tokenHash, cardholderId]
  );
  if (!r.rows.length) {
    throw Object.assign(new Error('Token invalide ou révoqué'), { statusCode: 422, code: 'INVALID_TOKEN' });
  }
  // Incrémenter usage
  await query(
    `UPDATE enrolled_cards SET usage_count=usage_count+1, last_used_at=NOW() WHERE enrollment_id=$1`,
    [r.rows[0].enrollment_id]
  );
  return r.rows[0];
};

// ─── Helpers ─────────────────────────────────────────────────────
const _safeCardData = (row) => ({
  enrollmentId:  row.enrollment_id,
  tokenId:       row.token_id,
  cardMasked:    row.card_masked,
  last4:         row.last4,
  expiryMonth:   row.expiry_month,
  expiryYear:    row.expiry_year,
  network:       row.network,
  cardholderName: row.cardholder_name,
  status:        row.status,
  isDefault:     row.is_default,
  usageCount:    row.usage_count,
  enrolledAt:    row.enrolled_at,
  lastUsedAt:    row.last_used_at,
});

const _auditEnrollment = async (enrollmentId, cardholderId, action, ip, ua, details = {}) => {
  try {
    await query(
      `INSERT INTO enrollment_audit (enrollment_id, cardholder_id, action, ip_address, user_agent, details)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [enrollmentId, cardholderId, action, ip, ua, JSON.stringify(details)]
    );
    await auditLog({
      eventType:  `CARD_${action}`,
      actorType:  'cardholder',
      actorId:    cardholderId,
      entityType: 'enrolled_card',
      entityId:   enrollmentId,
      ipAddress:  ip,
      userAgent:  ua,
      success:    true,
      details,
    });
  } catch (_) {}
};

module.exports = {
  enrollCard,
  listEnrolledCards,
  setDefaultCard,
  revokeCard,
  resolveToken,
  generateSessionKey,
  luhnCheck,
  detectNetwork,
  maskPan,
};
