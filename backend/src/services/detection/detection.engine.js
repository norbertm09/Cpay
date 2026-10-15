/**
 * Detection Engine — Le cerveau de CPlus 2.6.0
 *
 * Principe : le marchand ne choisit jamais rien.
 * À partir d'un numéro de téléphone ou d'un BIN/IIN carte,
 * ce module détermine automatiquement :
 *   - Le pays
 *   - L'opérateur Mobile Money
 *   - La devise
 *   - Le réseau carte (Visa, MC, GIMAC, UnionPay, Verve)
 *   - L'acquéreur
 *   - La route technique optimale
 */

'use strict';
// CPlus 2.6.0

// ─── Table pays → préfixes mobiles ───────────────────────────────

const COUNTRY_PREFIXES = {
  '+221': { country: 'SN', name: 'Sénégal',           currency: 'XOF', region: 'BCEAO' },
  '+225': { country: 'CI', name: "Côte d'Ivoire",      currency: 'XOF', region: 'BCEAO' },
  '+237': { country: 'CM', name: 'Cameroun',            currency: 'XAF', region: 'CEMAC' },
  '+242': { country: 'CG', name: 'Congo Brazzaville',  currency: 'XAF', region: 'CEMAC' },
  '+243': { country: 'CD', name: 'RDC',                 currency: 'CDF', region: 'CUSTOM' },
  // Extensions futures
  '+225': { country: 'CI', name: "Côte d'Ivoire",      currency: 'XOF', region: 'BCEAO' },
  '+233': { country: 'GH', name: 'Ghana',               currency: 'GHS', region: 'CUSTOM' },
  '+234': { country: 'NG', name: 'Nigeria',             currency: 'NGN', region: 'CUSTOM' },
  '+254': { country: 'KE', name: 'Kenya',               currency: 'KES', region: 'CUSTOM' },
};

// ─── Table opérateurs Mobile Money par pays ───────────────────────
//
// Chaque entrée = { pattern: RegExp, operator, brand, gateway }
// Le premier pattern qui matche gagne.

const MOBILE_MONEY_OPERATORS = {

  // ─── Sénégal (+221) ────────────────────────────────────────────
  SN: [
    { pattern: /^221(76|77|78)\d{7}$/, operator: 'ORANGE_MONEY',  brand: 'Orange Money',  gateway: 'orange_senegal' },
    { pattern: /^221(70|75|76)\d{7}$/, operator: 'FREE_MONEY',    brand: 'Free Money',    gateway: 'free_money_sn' },
    { pattern: /^221(70|75|76)\d{7}$/, operator: 'WAVE',          brand: 'Wave',          gateway: 'wave_sn' },
    { pattern: /^221\d{9}$/,           operator: 'ORANGE_MONEY',  brand: 'Orange Money',  gateway: 'orange_senegal' }, // fallback
  ],

  // ─── Côte d'Ivoire (+225) ───────────────────────────────────────
  CI: [
    { pattern: /^225(07|08|09|77|78|79|01|02)\d{7,9}$/, operator: 'ORANGE_MONEY', brand: 'Orange Money', gateway: 'orange_ci' },
    { pattern: /^225(05|06|55|56|57|58)\d{7,9}$/,       operator: 'MTN_MOMO',    brand: 'MTN Mobile Money', gateway: 'mtn_ci' },
    { pattern: /^225(01|02|03)\d{7,9}$/,                operator: 'MOOV_MONEY',  brand: 'Moov Money',   gateway: 'moov_ci' },
    { pattern: /^225(22|23|24|25)\d{7,9}$/,             operator: 'WAVE',        brand: 'Wave',          gateway: 'wave_ci' },
    { pattern: /^225\d{9,11}$/,                         operator: 'ORANGE_MONEY', brand: 'Orange Money', gateway: 'orange_ci' },
  ],

  // ─── Cameroun (+237) ────────────────────────────────────────────
  CM: [
    { pattern: /^237(67|68|69)\d{6}$/,  operator: 'MTN_MOMO',    brand: 'MTN Mobile Money', gateway: 'mtn_cm' },
    { pattern: /^237(69)\d{6}$/,         operator: 'ORANGE_MONEY', brand: 'Orange Money',    gateway: 'orange_cm' },
    { pattern: /^237(24|33|22)\d{6}$/,  operator: 'EXPRESS_UNION', brand: 'Express Union',  gateway: 'express_union_cm' },
    { pattern: /^237(55|56|57)\d{6}$/,  operator: 'MOOV_MONEY',   brand: 'Moov Money',      gateway: 'moov_cm' },
    { pattern: /^237\d{9}$/,            operator: 'MTN_MOMO',    brand: 'MTN Mobile Money', gateway: 'mtn_cm' },
  ],

  // ─── Congo Brazzaville (+242) ───────────────────────────────────
  CG: [
    { pattern: /^242(06|05|04)\d{6}$/,  operator: 'MTN_MOMO',    brand: 'MTN Mobile Money', gateway: 'mtn_cg' },
    { pattern: /^242(05|55|06)\d{6}$/,  operator: 'AIRTEL_MONEY', brand: 'Airtel Money',    gateway: 'airtel_cg' },
    { pattern: /^242(04|03|02)\d{6}$/,  operator: 'ORANGE_MONEY', brand: 'Orange Money',    gateway: 'orange_cg' },
    { pattern: /^242\d{9}$/,            operator: 'MTN_MOMO',    brand: 'MTN Mobile Money', gateway: 'mtn_cg' },
  ],

  // ─── RDC (+243) ─────────────────────────────────────────────────
  CD: [
    { pattern: /^243(81|82|83|84|85|89|90|97|98|99)\d{7}$/, operator: 'VODACOM_MPESA', brand: 'M-Pesa (Vodacom)', gateway: 'vodacom_cd' },
    { pattern: /^243(97|98|99|90|91|92)\d{7}$/,             operator: 'AIRTEL_MONEY',  brand: 'Airtel Money',    gateway: 'airtel_cd' },
    { pattern: /^243(85|86|87|88)\d{7}$/,                   operator: 'ORANGE_MONEY',  brand: 'Orange Money',    gateway: 'orange_cd' },
    { pattern: /^243(80|81|82|83)\d{7}$/,                   operator: 'AFRICELL_MONEY', brand: 'Africell Money', gateway: 'africell_cd' },
    { pattern: /^243\d{10}$/,                               operator: 'VODACOM_MPESA', brand: 'M-Pesa (Vodacom)', gateway: 'vodacom_cd' },
  ],
};

// ─── Table BIN/IIN → réseau carte ────────────────────────────────
//
// Résolution par préfixe numérique (longueur décroissante pour la précision)

const CARD_NETWORKS = [
  // GIMAC — réseau CEMAC, Afrique Centrale (prioritaire pour nos marchés)
  { prefix: '9792', network: 'GIMAC',    name: 'GIMAC',    acquirer: 'gimac_gateway' },
  { prefix: '979',  network: 'GIMAC',    name: 'GIMAC',    acquirer: 'gimac_gateway' },
  // Verve — Afrique de l'Ouest
  { prefix: '650',  network: 'VERVE',    name: 'Verve',    acquirer: 'interswitch' },
  { prefix: '506',  network: 'VERVE',    name: 'Verve',    acquirer: 'interswitch' },
  // UnionPay
  { prefix: '62',   network: 'UNIONPAY', name: 'UnionPay', acquirer: 'cybersource' },
  // American Express
  { prefix: '34',   network: 'AMEX',     name: 'Amex',     acquirer: 'cybersource' },
  { prefix: '37',   network: 'AMEX',     name: 'Amex',     acquirer: 'cybersource' },
  // Mastercard
  { prefix: '51',   network: 'MASTERCARD', name: 'Mastercard', acquirer: 'mpgs' },
  { prefix: '52',   network: 'MASTERCARD', name: 'Mastercard', acquirer: 'mpgs' },
  { prefix: '53',   network: 'MASTERCARD', name: 'Mastercard', acquirer: 'mpgs' },
  { prefix: '54',   network: 'MASTERCARD', name: 'Mastercard', acquirer: 'mpgs' },
  { prefix: '55',   network: 'MASTERCARD', name: 'Mastercard', acquirer: 'mpgs' },
  { prefix: '2221', network: 'MASTERCARD', name: 'Mastercard', acquirer: 'mpgs' },
  { prefix: '2720', network: 'MASTERCARD', name: 'Mastercard', acquirer: 'mpgs' },
  // Visa
  { prefix: '4',    network: 'VISA',     name: 'Visa',     acquirer: 'cybersource' },
  // Maestro (Mastercard)
  { prefix: '6304', network: 'MAESTRO',  name: 'Maestro',  acquirer: 'mpgs' },
  { prefix: '6759', network: 'MAESTRO',  name: 'Maestro',  acquirer: 'mpgs' },
  // Discover
  { prefix: '6011', network: 'DISCOVER', name: 'Discover', acquirer: 'cybersource' },
  { prefix: '65',   network: 'DISCOVER', name: 'Discover', acquirer: 'cybersource' },
];

// ─── API principale ───────────────────────────────────────────────

/**
 * Détecter automatiquement toutes les informations à partir d'un numéro de téléphone.
 *
 * @param {string} phone  Numéro avec indicatif (+221XXXXXXXXX)
 * @returns {DetectionResult}
 */
const detectFromPhone = (phone) => {
  if (!phone) return { success: false, error: 'Numéro de téléphone requis' };

  // Normaliser le numéro
  const normalized = normalizePhone(phone);
  if (!normalized) return { success: false, error: `Numéro invalide : ${phone}` };

  // Détecter le pays par préfixe
  const countryInfo = detectCountry(normalized);
  if (!countryInfo) {
    return { success: false, error: `Pays non supporté pour le numéro ${phone}` };
  }

  // Détecter l'opérateur
  const operatorInfo = detectOperator(normalized, countryInfo.country);
  if (!operatorInfo) {
    return {
      success: false,
      error: `Opérateur non supporté pour ${phone}`,
      countryInfo,
    };
  }

  return {
    success:  true,
    phone:    normalized,
    country:  countryInfo.country,
    countryName: countryInfo.name,
    currency: countryInfo.currency,
    region:   countryInfo.region,
    operator: operatorInfo.operator,
    brand:    operatorInfo.brand,
    gateway:  operatorInfo.gateway,
  };
};

/**
 * Détecter le réseau et l'acquéreur à partir d'un BIN/IIN carte.
 *
 * @param {string} bin  6 à 8 premiers chiffres du PAN (ou PAN masqué)
 * @returns {CardDetectionResult}
 */
const detectFromCard = (bin) => {
  if (!bin) return { success: false, error: 'BIN carte requis' };

  const cleanBin = bin.replace(/\D/g, '').slice(0, 8);

  // Chercher du plus précis (plus long préfixe) au moins précis
  const sorted = [...CARD_NETWORKS].sort((a, b) => b.prefix.length - a.prefix.length);

  for (const entry of sorted) {
    if (cleanBin.startsWith(entry.prefix)) {
      return {
        success:  true,
        network:  entry.network,
        name:     entry.name,
        acquirer: entry.acquirer,
        bin:      cleanBin,
      };
    }
  }

  return { success: false, error: `Réseau carte non reconnu pour BIN ${cleanBin}` };
};

/**
 * Détecter depuis un AID NFC (Application Identifier EMV).
 * Utilisé quand le SDK NFC retourne l'AID avant le BIN.
 */
const detectFromAid = (aid) => {
  const AID_MAP = {
    'A0000000031010': { network: 'VISA',        acquirer: 'cybersource' },
    'A0000000032010': { network: 'VISA',        acquirer: 'cybersource' },
    'A0000000033010': { network: 'VISA',        acquirer: 'cybersource' },
    'A0000000038010': { network: 'VISA',        acquirer: 'cybersource' },
    'A0000000041010': { network: 'MASTERCARD',  acquirer: 'mpgs' },
    'A0000000043060': { network: 'MAESTRO',     acquirer: 'mpgs' },
    'A0000000050001': { network: 'MAESTRO',     acquirer: 'mpgs' },
    'A000000333010101': { network: 'GIMAC',     acquirer: 'gimac_gateway' },
    'A000000333010102': { network: 'GIMAC',     acquirer: 'gimac_gateway' },
    'A000000065101001': { network: 'VERVE',     acquirer: 'interswitch' },
    'A000000626': { network: 'UNIONPAY', acquirer: 'cybersource' },
  };

  const upper = aid?.toUpperCase() || '';
  for (const [aidPrefix, info] of Object.entries(AID_MAP)) {
    if (upper.startsWith(aidPrefix.toUpperCase())) {
      return { success: true, ...info, aid };
    }
  }
  return { success: false, error: `AID non reconnu : ${aid}` };
};

/**
 * Obtenir la meilleure route pour une transaction.
 * Combine détection + règles métier (frais, disponibilité, priorité).
 */
const getBestRoute = ({ phone, bin, aid, amount, currency, country }) => {
  // Mobile Money
  if (phone && !bin) {
    const detection = detectFromPhone(phone);
    if (!detection.success) return detection;
    return {
      ...detection,
      paymentMethod: 'mobile_money',
      routeType:     'direct',
    };
  }

  // Carte NFC via AID
  if (aid) {
    const cardInfo = detectFromAid(aid);
    if (!cardInfo.success) return cardInfo;
    return {
      ...cardInfo,
      paymentMethod: 'card_nfc',
      routeType:     'emv',
    };
  }

  // Carte via BIN
  if (bin) {
    const cardInfo = detectFromCard(bin);
    if (!cardInfo.success) return cardInfo;
    return {
      ...cardInfo,
      paymentMethod: 'card',
      routeType:     'emv',
    };
  }

  return { success: false, error: 'Paramètres insuffisants pour la détection de route' };
};

// ─── Helpers ──────────────────────────────────────────────────────

const normalizePhone = (phone) => {
  let clean = phone.replace(/[\s\-().]/g, '');
  // Convertir les formats locaux en E.164
  if (clean.startsWith('00')) clean = '+' + clean.slice(2);
  if (clean.startsWith('0') && clean.length <= 10) {
    // Numéro local sans préfixe — impossible à normaliser sans contexte pays
    return null;
  }
  if (!clean.startsWith('+')) clean = '+' + clean;
  return clean;
};

const detectCountry = (normalizedPhone) => {
  // Chercher le préfixe le plus long en premier
  const prefixes = Object.keys(COUNTRY_PREFIXES).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (normalizedPhone.startsWith(prefix)) {
      return COUNTRY_PREFIXES[prefix];
    }
  }
  return null;
};

const detectOperator = (normalizedPhone, countryCode) => {
  const operators = MOBILE_MONEY_OPERATORS[countryCode];
  if (!operators) return null;

  // Retirer le + pour le matching
  const digits = normalizedPhone.replace('+', '');

  for (const entry of operators) {
    if (entry.pattern.test(digits)) {
      return entry;
    }
  }
  return null;
};

module.exports = {
  detectFromPhone,
  detectFromCard,
  detectFromAid,
  getBestRoute,
  normalizePhone,
  COUNTRY_PREFIXES,
  MOBILE_MONEY_OPERATORS,
  CARD_NETWORKS,
};
