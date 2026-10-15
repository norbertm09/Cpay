/**
 * Chiffrement des secrets au repos (clés API opérateurs/gateways) — AES-256-GCM.
 *
 * WAVE-2 (audit prod 2.6.0, 02-§4) : les colonnes api_configurations.api_key / api_secret
 * et les valeurs sensibles de extra_params sont stockées chiffrées.
 *
 * Format stocké : enc:v1:<iv_b64>:<tag_b64>:<cipher_b64>
 * Les valeurs non préfixées (héritage) sont renvoyées telles quelles par decrypt()
 * afin de permettre une migration progressive (scripts/encrypt-api-configs.js).
 *
 * Clé : CONFIG_ENCRYPTION_KEY = 32 octets, en hex (64 caractères) ou base64 (44 caractères).
 *   - production sans clé : encrypt() et decrypt() d'une valeur chiffrée lèvent une erreur ;
 *   - hors production sans clé : encrypt() renvoie le clair (stockage en clair toléré en dev),
 *     decrypt() d'une valeur chiffrée lève toujours.
 */
'use strict';

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const ALGO   = 'aes-256-gcm';

/** Clés d'extra_params considérées comme sensibles (chiffrées au repos). */
const SENSITIVE_KEY_RE = /secret|pass|token|key|pin|private/i;

const isProd = () => process.env.NODE_ENV === 'production';

const loadKey = () => {
  const raw = process.env.CONFIG_ENCRYPTION_KEY;
  if (!raw || !String(raw).trim()) return null;
  const s = String(raw).trim();
  const buf = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
  if (buf.length !== 32) throw new Error('CONFIG_ENCRYPTION_KEY doit faire 32 octets (64 hex ou 44 base64)');
  return buf;
};

const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);

/**
 * Chiffre une valeur (string). null/undefined/'' sont renvoyés tels quels.
 * Une valeur déjà chiffrée n'est pas re-chiffrée (idempotent).
 */
const encrypt = (plain) => {
  if (plain === null || plain === undefined || plain === '') return plain;
  if (isEncrypted(plain)) return plain;
  const key = loadKey();
  if (!key) {
    if (isProd()) throw new Error('CONFIG_ENCRYPTION_KEY manquante : impossible de chiffrer un secret en production');
    return plain; // dev / test : stockage en clair toléré
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, enc].map(b => b.toString('base64')).join(':');
};

/**
 * Déchiffre une valeur stockée. Une valeur non préfixée (héritage) est renvoyée telle quelle.
 * Lève si la clé est absente ou si l'authentification GCM échoue (valeur altérée / mauvaise clé).
 */
const decrypt = (stored) => {
  if (!isEncrypted(stored)) return stored;
  const key = loadKey();
  if (!key) throw new Error('CONFIG_ENCRYPTION_KEY manquante pour déchiffrer une valeur chiffrée');
  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Valeur chiffrée malformée');
  const [iv, tag, enc] = parts.map(s => Buffer.from(s, 'base64'));
  if (iv.length !== 12 || tag.length !== 16) throw new Error('Valeur chiffrée malformée');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
};

const isSensitiveKey = (k) => SENSITIVE_KEY_RE.test(String(k || ''));

/**
 * Chiffre les valeurs sensibles (string) d'un objet extra_params. Les autres clés sont
 * conservées telles quelles. Renvoie un nouvel objet (ou la valeur d'origine si non-objet).
 */
const encryptExtraParams = (extra) => {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra;
  const out = {};
  for (const [k, v] of Object.entries(extra)) {
    out[k] = (isSensitiveKey(k) && typeof v === 'string') ? encrypt(v) : v;
  }
  return out;
};

/** Inverse de encryptExtraParams : déchiffre toute valeur string préfixée enc:v1:. */
const decryptExtraParams = (extra) => {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return extra;
  const out = {};
  for (const [k, v] of Object.entries(extra)) out[k] = isEncrypted(v) ? decrypt(v) : v;
  return out;
};

/**
 * Helper pour admin.routes PUT /api-configs : prépare le patch à écrire en base.
 *
 * @param {object} patch
 * @param {string|null} [patch.apiKey]      clair (ou déjà chiffré) → chiffré
 * @param {string|null} [patch.apiSecret]   clair (ou déjà chiffré) → chiffré
 * @param {object|null} [patch.extraParams] objet JSON ; seules les clés /secret|pass|token|key|pin|private/i sont chiffrées
 * @returns {{ apiKey?: string|null, apiSecret?: string|null, extraParams?: object|null }}
 *   Seules les propriétés présentes dans `patch` (même null) figurent dans le résultat,
 *   de sorte qu'un PUT partiel ne touche pas les colonnes absentes.
 */
const encryptConfigPatch = (patch = {}) => {
  const out = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'apiKey'))      out.apiKey      = encrypt(patch.apiKey);
  if (Object.prototype.hasOwnProperty.call(patch, 'apiSecret'))   out.apiSecret   = encrypt(patch.apiSecret);
  if (Object.prototype.hasOwnProperty.call(patch, 'extraParams')) out.extraParams = encryptExtraParams(patch.extraParams);
  return out;
};

module.exports = {
  PREFIX, SENSITIVE_KEY_RE,
  encrypt, decrypt, isEncrypted, isSensitiveKey,
  encryptExtraParams, decryptExtraParams, encryptConfigPatch,
  _loadKey: loadKey,
};
