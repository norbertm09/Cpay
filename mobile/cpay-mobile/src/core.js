// Refonte Expo (2026-11-13) : logique pure de l'application, sans dependance React Native — testable avec
// `node --test` (test/core.test.js). App.js ne garde que les ecrans. Module CommonJS : Metro l'importe tel quel.
'use strict';

// ─── Configuration ───────────────────────────────────────────────
const API_BASE = process.env.EXPO_PUBLIC_API_BASE_URL || 'https://api.c-pay.global';
const API = `${API_BASE}/api/v1`;

// Message affiche pour toute fonction desactivee cote serveur (410 FEATURE_DISABLED).
const FEATURE_PENDING = 'Fonctionnalité en cours d’intégration';
const PENDING_CONFIRMATION = 'En attente de confirmation';

// Rafraichissement proactif : 60 s avant l'expiration de l'access token (15 min).
const REFRESH_MARGIN_MS = 60 * 1000;
const DEFAULT_EXPIRES_IN = 900;

// Suivi d'un encaissement en attente : toutes les 3 s pendant 90 s maximum.
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_MS = 90 * 1000;

// Confirmation forte (caisse) : nombre de saisies avant abandon.
const STEP_UP_ATTEMPTS = 3;

// ─── Helpers ─────────────────────────────────────────────────────
const money = (v, currency = '') => `${Number(v || 0).toLocaleString('fr-FR')} ${currency || ''}`.trim();
const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// Cle d'idempotence : 8 a 128 caracteres exiges par l'API (docs/CAISSE-API.md), une par intention.
const newIdempotencyKey = () => `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
const fmtDate = (iso) => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '');
const parseAmount = (v) => Number(String(v || '').replace(/\s/g, '').replace(',', '.'));

// ─── Erreurs API ─────────────────────────────────────────────────
class ApiError extends Error {
  constructor(message, { status = 0, code = null, data = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

class AuthError extends Error {
  constructor(message = 'Session expirée, veuillez vous reconnecter') {
    super(message);
    this.name = 'AuthError';
  }
}

// 410 FEATURE_DISABLED uniquement (lot 5, audit 2026-11-02 mobile P1-7) : un 404 est une vraie erreur
// (route mal configuree) et ne doit plus etre maquille en « en cours d'intégration ».
const isFeatureUnavailable = (err) => !!err && (err.code === 'FEATURE_DISABLED' || err.status === 410);
const userMessage = (err) => (isFeatureUnavailable(err) ? FEATURE_PENDING : err?.message || 'Erreur inattendue');

// ─── Caisse : types, operateurs, libelles ────────────────────────
const CASH_TYPES = [['', 'Tous'], ['collect', 'Encaissements'], ['withdraw', 'Retraits'], ['transfer_out', 'Vers banque'], ['transfer_in', 'Approvisionnements']];
const OPERATORS = [['mtn_momo', 'MTN MoMo'], ['orange_money', 'Orange Money'], ['airtel_money', 'Airtel Money'], ['moov_money', 'Moov Money'], ['wave', 'Wave'], ['express_union', 'Express Union'], ['mpesa', 'M-Pesa'], ['free_money', 'Free Money']];
const QUICK_AMOUNTS = [1000, 2000, 5000, 10000, 25000];

const operatorLabel = (code) => {
  if (!code) return 'Mobile Money';
  const key = String(code).toLowerCase();
  const hit = OPERATORS.find(([k]) => k === key) || OPERATORS.find(([k]) => k.startsWith(`${key}_`));
  return hit ? hit[1] : String(code).replace(/_/g, ' ');
};
// Opérateur du wallet déduit d'une détection /detect/phone (codes MTN, ORANGE, WAVE…).
const operatorCodeFor = (d) => {
  const op = String(d?.operator || '').toLowerCase();
  const brand = String(d?.brand || '§').toLowerCase();
  const hit = OPERATORS.find(([k, l]) => k === op || k.startsWith(`${op}_`) || l.toLowerCase().includes(brand));
  return hit ? hit[0] : null;
};
const TRANSFER_STATUS_LABELS = {
  pending: 'En attente', sending: 'Envoi en cours', processing: 'En cours', pending_manual: 'Traitement J+1', awaiting_funds: 'Virement attendu',
  completed: 'Effectué', failed: 'Échoué', cancelled: 'Annulé', rejected: 'Rejeté', authorized: 'Autorisé', expired: 'Expiré',
  unknown: 'Résultat incertain', // lot 5 (P1-2) : operateur muet, fonds reserves — jamais un succes
};
const transferStatusLabel = (st) => TRANSFER_STATUS_LABELS[st] || st || '—';
// Statuts pour lesquels les fonds sont reserves sans issue connue : aucune nouvelle intention tant que l'ordre n'est pas resolu
const UNCERTAIN_STATUSES = ['pending', 'sending', 'processing', 'unknown'];
const isUncertainStatus = (st) => UNCERTAIN_STATUSES.includes(String(st || '').toLowerCase());

module.exports = {
  API_BASE, API, FEATURE_PENDING, PENDING_CONFIRMATION, REFRESH_MARGIN_MS, DEFAULT_EXPIRES_IN, POLL_INTERVAL_MS, POLL_MAX_MS, STEP_UP_ATTEMPTS,
  money, compact, newIdempotencyKey, fmtDate, parseAmount,
  ApiError, AuthError, isFeatureUnavailable, userMessage,
  CASH_TYPES, OPERATORS, QUICK_AMOUNTS, operatorLabel, operatorCodeFor, TRANSFER_STATUS_LABELS, transferStatusLabel, UNCERTAIN_STATUSES, isUncertainStatus,
};
