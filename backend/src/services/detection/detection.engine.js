/**
 * Detection Engine — le cerveau de C-Pay 2.6.0
 *
 * Principe : le marchand ne choisit jamais rien.
 * À partir d'un numéro de téléphone (E.164 ou local + pays marchand) ou d'un BIN/AID carte,
 * ce module détermine : pays, devise, opérateur Mobile Money, réseau carte, acquéreur.
 *
 * WAVE-2 (audit prod 2.6.0, 02-§3) : port de la version refonte-2026.
 *   - plans de numérotation corrigés : SN (9), CI (10 chiffres depuis 2021), CM (9), CG (9), CD (9) ;
 *     un numéro de mauvaise longueur est rejeté (PHONE_LENGTH) plutôt que routé au hasard ;
 *   - les wallets non liés à un opérateur (Wave, Express Union) ne sont PAS détectables
 *     par numéro : ils sont proposés dans `alternatives` et sélectionnables via `operatorOverride` ;
 *   - Mastercard : plage 2221xx–2720xx couverte ; AID EMV : UnionPay A000000333, JCB A000000065,
 *     Verve A000000371, GIMAC via GIMAC_AID_PREFIXES ;
 *   - `normalizePhone(phone, defaultCountry)` accepte un numéro local si le pays est fourni
 *     (merchant.routes / settlement passent les numéros locaux Congo avec 'CG').
 *
 * Compatibilité : les valeurs `operator` (MTN_MOMO, AIRTEL_MONEY, ORANGE_MONEY…) sont celles
 * écrites par l'orchestrateur dans transactions.detected_operator — ne pas les renommer.
 * `COUNTRY_PREFIXES` (ancien export) est dérivé de COUNTRIES pour les anciens appelants.
 *
 * Toute entrée marquée `verified:false` doit être confirmée auprès de l'opérateur
 * avant la mise en production du pays concerné.
 *
 * WAVE-6 lot 2 : CF, GA, GQ, TD (périmètre de lancement CEMAC) sont détectés (pays, devise, opérateur) mais
 * marqués `planned:true` : aucun provider n'existe, le registre de capacités refuse l'opération avec un
 * message clair (CAPABILITY_NOT_ACTIVE). La détection ne vaut jamais disponibilité.
 */
'use strict';

// ─── Pays supportés ───────────────────────────────────────────────
// nsnLength = longueur du numéro national (sans indicatif, sans 0 initial sauf CI)
const COUNTRIES = {
  SN: { callingCode: '221', name: 'Sénégal',           currency: 'XOF', region: 'BCEAO',  nsnLength: 9  },
  CI: { callingCode: '225', name: "Côte d'Ivoire",     currency: 'XOF', region: 'BCEAO',  nsnLength: 10 },
  CM: { callingCode: '237', name: 'Cameroun',          currency: 'XAF', region: 'CEMAC',  nsnLength: 9  },
  CG: { callingCode: '242', name: 'Congo Brazzaville', currency: 'XAF', region: 'CEMAC',  nsnLength: 9  },
  CD: { callingCode: '243', name: 'RDC',               currency: 'CDF', region: 'CUSTOM', nsnLength: 9  },
  // WAVE-6 lot 2 : reste du périmètre de lancement CEMAC (docs/LAUNCH-CEMAC-RDC.md). Détection seule :
  // aucun provider branché, le registre de capacités (services/capabilities/registry.js) les marque `planned`.
  // Plans de numérotation à confirmer (docs/OPERATEURS-A-CONFIRMER.md §1) — GA : 8 chiffres avec le 0 initial.
  CF: { callingCode: '236', name: 'Centrafrique',      currency: 'XAF', region: 'CEMAC',  nsnLength: 8, verified: false },
  GA: { callingCode: '241', name: 'Gabon',             currency: 'XAF', region: 'CEMAC',  nsnLength: 8, verified: false },
  GQ: { callingCode: '240', name: 'Guinée équatoriale', currency: 'XAF', region: 'CEMAC', nsnLength: 9, verified: false },
  TD: { callingCode: '235', name: 'Tchad',             currency: 'XAF', region: 'CEMAC',  nsnLength: 8, verified: false },
  // Extensions futures (devise détectée, aucun opérateur branché)
  GH: { callingCode: '233', name: 'Ghana',             currency: 'GHS', region: 'CUSTOM', nsnLength: 9  },
  NG: { callingCode: '234', name: 'Nigeria',           currency: 'NGN', region: 'CUSTOM', nsnLength: 10 },
  KE: { callingCode: '254', name: 'Kenya',             currency: 'KES', region: 'CUSTOM', nsnLength: 9  },
};

const COUNTRY_BY_CODE = Object.fromEntries(
  Object.entries(COUNTRIES).map(([iso, c]) => [c.callingCode, { country: iso, ...c }])
);

// Ancien export (clé '+221' → { country, name, currency, region }) conservé pour les appelants legacy.
const COUNTRY_PREFIXES = Object.fromEntries(
  Object.entries(COUNTRIES).map(([iso, c]) => [`+${c.callingCode}`, { country: iso, name: c.name, currency: c.currency, region: c.region }])
);

// ─── Opérateurs Mobile Money par pays ─────────────────────────────
// prefixes : préfixes du numéro national (après l'indicatif). Les préfixes les plus
// longs sont testés d'abord ; le premier match gagne.
const MOBILE_MONEY_OPERATORS = {
  SN: [
    { prefixes: ['77', '78'],      operator: 'ORANGE_MONEY', brand: 'Orange Money', gateway: 'orange_sn',      verified: true  },
    { prefixes: ['76'],            operator: 'FREE_MONEY',   brand: 'Free Money',   gateway: 'free_money_sn',  verified: true  },
    { prefixes: ['70'],            operator: 'EXPRESSO',     brand: 'Expresso',     gateway: null,             verified: true  }, // pas de wallet branché
  ],
  CI: [ // plan à 10 chiffres depuis le 31/01/2021
    { prefixes: ['07'],            operator: 'ORANGE_MONEY', brand: 'Orange Money', gateway: 'orange_ci',      verified: true  },
    { prefixes: ['05'],            operator: 'MTN_MOMO',     brand: 'MTN MoMo',     gateway: 'mtn_ci',         verified: true  },
    { prefixes: ['01'],            operator: 'MOOV_MONEY',   brand: 'Moov Money',   gateway: 'moov_ci',        verified: true  },
  ],
  CM: [
    { prefixes: ['650','651','652','653','654','67','68'], operator: 'MTN_MOMO',     brand: 'MTN MoMo',     gateway: 'mtn_cm',    verified: true },
    { prefixes: ['655','656','657','658','659','69'],      operator: 'ORANGE_MONEY', brand: 'Orange Money', gateway: 'orange_cm', verified: true },
    { prefixes: ['66'],                                    operator: 'NEXTTEL',      brand: 'Nexttel',      gateway: null,        verified: true },
    { prefixes: ['62'],                                    operator: 'CAMTEL',       brand: 'Camtel Blue',  gateway: null,        verified: true },
  ],
  CG: [
    { prefixes: ['06'],            operator: 'MTN_MOMO',     brand: 'MTN MoMo',     gateway: 'mtn_cg',         verified: true  },
    { prefixes: ['05', '04'],      operator: 'AIRTEL_MONEY', brand: 'Airtel Money', gateway: 'airtel_cg',      verified: false }, // 04 : ex-Azur, à confirmer
  ],
  // WAVE-6 lot 2 : opérateurs principaux CF / GA / GQ / TD — préfixes à confirmer (verified:false), aucun
  // provider (gateway présent pour le registre, absent de mobilemoney.router.PROVIDERS → `planned`).
  CF: [
    { prefixes: ['72', '75', '77'], operator: 'ORANGE_MONEY',  brand: 'Orange Money',  gateway: 'orange_cf',  verified: false, planned: true },
    { prefixes: ['70', '71', '78'], operator: 'TELECEL_MONEY', brand: 'Telecel Money', gateway: 'telecel_cf', verified: false, planned: true },
  ],
  GA: [
    { prefixes: ['07'],            operator: 'AIRTEL_MONEY',  brand: 'Airtel Money',  gateway: 'airtel_ga',  verified: false, planned: true },
    { prefixes: ['06'],            operator: 'MOOV_MONEY',    brand: 'Moov Money',    gateway: 'moov_ga',    verified: false, planned: true },
  ],
  GQ: [
    { prefixes: ['222', '223'],    operator: 'GETESA_MONEY',  brand: 'GETESA',        gateway: 'getesa_gq',  verified: false, planned: true },
    { prefixes: ['55'],            operator: 'MUNI_MONEY',    brand: 'Muni',          gateway: 'muni_gq',    verified: false, planned: true },
  ],
  TD: [
    { prefixes: ['62', '63', '65', '69'],                   operator: 'AIRTEL_MONEY', brand: 'Airtel Money', gateway: 'airtel_td', verified: false, planned: true },
    { prefixes: ['66', '90', '91', '92', '93', '95', '99'], operator: 'MOOV_MONEY',   brand: 'Moov Money',   gateway: 'moov_td',   verified: false, planned: true },
  ],
  CD: [
    { prefixes: ['81', '82'],      operator: 'VODACOM_MPESA',  brand: 'M-Pesa',         gateway: 'vodacom_cd',  verified: true  },
    { prefixes: ['97', '98', '99'],operator: 'AIRTEL_MONEY',   brand: 'Airtel Money',   gateway: 'airtel_cd',   verified: true  },
    { prefixes: ['84', '85', '89'],operator: 'ORANGE_MONEY',   brand: 'Orange Money',   gateway: 'orange_cd',   verified: true  },
    { prefixes: ['90', '91'],      operator: 'AFRICELL_MONEY', brand: 'Africell Money', gateway: 'africell_cd', verified: false },
  ],
};

// Wallets non détectables par numéro (sélection explicite par le client final ou override)
const WALLET_ALTERNATIVES = {
  SN: [{ operator: 'WAVE', brand: 'Wave', gateway: 'wave_sn' }],
  CI: [{ operator: 'WAVE', brand: 'Wave', gateway: 'wave_ci' }],
  CM: [{ operator: 'EXPRESS_UNION', brand: 'Express Union Mobile', gateway: 'express_union_cm' }],
  CG: [], CD: [], CF: [], GA: [], GQ: [], TD: [],
};

// Migration CI 2021 : anciens numéros à 8 chiffres → nouveau préfixe à 2 chiffres
const CI_LEGACY_MAP = {
  '07': ['07','08','09','47','48','49','57','58','59','77','78','79','87','88','89'],
  '05': ['04','05','06','44','45','46','54','55','56','64','65','66','74','75','76','84','85','86','94','95','96'],
  '01': ['01','02','03','40','41','42','43','50','51','52','53','70','71','72','73'],
};

// ─── Réseaux carte (BIN/IIN) ──────────────────────────────────────
// Les plages (range) priment sur les préfixes. Les entrées verified:false doivent
// être confirmées avec l'acquéreur (GIMAC n'a pas de plage publique documentée ici).
const CARD_NETWORKS = [
  { range:  ['222100', '272099'], network: 'MASTERCARD', name: 'Mastercard', acquirer: 'mpgs',          verified: true  },
  { prefix: '979',                network: 'GIMAC',      name: 'GIMAC',      acquirer: 'gimac_gateway', verified: false },
  { prefix: '506',                network: 'VERVE',      name: 'Verve',      acquirer: 'interswitch',   verified: true  },
  { prefix: '650',                network: 'VERVE',      name: 'Verve',      acquirer: 'interswitch',   verified: true  },
  { prefix: '6304',               network: 'MAESTRO',    name: 'Maestro',    acquirer: 'mpgs',          verified: true  },
  { prefix: '6759',               network: 'MAESTRO',    name: 'Maestro',    acquirer: 'mpgs',          verified: true  },
  { prefix: '6011',               network: 'DISCOVER',   name: 'Discover',   acquirer: 'cybersource',   verified: true  },
  { prefix: '65',                 network: 'DISCOVER',   name: 'Discover',   acquirer: 'cybersource',   verified: true  },
  { prefix: '62',                 network: 'UNIONPAY',   name: 'UnionPay',   acquirer: 'cybersource',   verified: true  },
  { prefix: '34',                 network: 'AMEX',       name: 'Amex',       acquirer: 'cybersource',   verified: true  },
  { prefix: '37',                 network: 'AMEX',       name: 'Amex',       acquirer: 'cybersource',   verified: true  },
  { prefix: '35',                 network: 'JCB',        name: 'JCB',        acquirer: 'cybersource',   verified: true  },
  { prefix: '51',                 network: 'MASTERCARD', name: 'Mastercard', acquirer: 'mpgs',          verified: true  },
  { prefix: '52',                 network: 'MASTERCARD', name: 'Mastercard', acquirer: 'mpgs',          verified: true  },
  { prefix: '53',                 network: 'MASTERCARD', name: 'Mastercard', acquirer: 'mpgs',          verified: true  },
  { prefix: '54',                 network: 'MASTERCARD', name: 'Mastercard', acquirer: 'mpgs',          verified: true  },
  { prefix: '55',                 network: 'MASTERCARD', name: 'Mastercard', acquirer: 'mpgs',          verified: true  },
  { prefix: '4',                  network: 'VISA',       name: 'Visa',       acquirer: 'cybersource',   verified: true  },
];

// ─── AID EMV (RID + PIX) ──────────────────────────────────────────
// RID officiels : Visa A000000003, Mastercard A000000004, UnionPay A000000333,
// JCB A000000065, Amex A000000025, Verve A000000371, Discover A000000152.
const AID_MAP = [
  { aid: 'A0000000031010',   network: 'VISA',       acquirer: 'cybersource' },  // Visa credit/debit
  { aid: 'A0000000032010',   network: 'VISA',       acquirer: 'cybersource' },  // Visa Electron
  { aid: 'A0000000032020',   network: 'VISA',       acquirer: 'cybersource' },  // V PAY
  { aid: 'A0000000033010',   network: 'VISA',       acquirer: 'cybersource' },  // Interlink
  { aid: 'A0000000038010',   network: 'VISA',       acquirer: 'cybersource' },  // Plus
  { aid: 'A0000000041010',   network: 'MASTERCARD', acquirer: 'mpgs' },
  { aid: 'A0000000042203',   network: 'MAESTRO',    acquirer: 'mpgs' },         // Maestro US
  { aid: 'A0000000043060',   network: 'MAESTRO',    acquirer: 'mpgs' },
  { aid: 'A0000000050001',   network: 'MAESTRO',    acquirer: 'mpgs' },         // Maestro UK
  { aid: 'A000000333010101', network: 'UNIONPAY',   acquirer: 'cybersource' },  // UnionPay debit
  { aid: 'A000000333010102', network: 'UNIONPAY',   acquirer: 'cybersource' },  // UnionPay credit
  { aid: 'A000000333010103', network: 'UNIONPAY',   acquirer: 'cybersource' },  // UnionPay quasi-credit
  { aid: 'A0000000651010',   network: 'JCB',        acquirer: 'cybersource' },
  { aid: 'A00000002501',     network: 'AMEX',       acquirer: 'cybersource' },
  { aid: 'A0000001523010',   network: 'DISCOVER',   acquirer: 'cybersource' },
  { aid: 'A0000003710001',   network: 'VERVE',      acquirer: 'interswitch' },
  // GIMAC : AID à obtenir auprès du GIMAC (configurable via GIMAC_AID_PREFIXES="A000...,A000...")
  ...String(process.env.GIMAC_AID_PREFIXES || '').split(',').map(s => s.trim()).filter(Boolean)
      .map(aid => ({ aid: aid.toUpperCase(), network: 'GIMAC', acquirer: 'gimac_gateway' })),
];

// ─── Normalisation téléphone ──────────────────────────────────────

/**
 * Normalise en E.164 ("+2376…"). Accepte :
 *   +237 6xx, 00237 6xx, 237 6xx, et un numéro local (06xx / 6xx) si defaultCountry est fourni.
 * Sans defaultCountry, un numéro local renvoie null (comportement historique de la prod).
 * @param {string} phone
 * @param {string|null} [defaultCountry] ISO-2 (ex. 'CG') pour les numéros locaux
 * @returns {string|null}
 */
const normalizePhone = (phone, defaultCountry = null) => {
  if (phone === null || phone === undefined) return null;
  if (typeof phone !== 'string') phone = String(phone);
  let clean = phone.replace(/[\s\-().]/g, '');
  if (!/^\+?\d{6,16}$/.test(clean)) return null;

  if (clean.startsWith('00')) clean = '+' + clean.slice(2);

  if (!clean.startsWith('+')) {
    const dc = defaultCountry ? String(defaultCountry).toUpperCase() : null;
    // Indicatif connu sans '+' ?
    const code = Object.keys(COUNTRY_BY_CODE).find(c => clean.startsWith(c) && clean.length === c.length + COUNTRY_BY_CODE[c].nsnLength);
    if (code) clean = '+' + clean;
    else if (dc && COUNTRIES[dc]) {
      const c = COUNTRIES[dc];
      // Le 0 initial fait partie du numéro national en CI (10 chiffres) ; ailleurs c'est un préfixe de sortie
      const national = (clean.startsWith('0') && clean.length === c.nsnLength + 1) ? clean.slice(1) : clean;
      clean = `+${c.callingCode}${national}`;
    } else {
      return null; // numéro local sans contexte pays
    }
  }

  // Migration CI 8 → 10 chiffres
  if (clean.startsWith('+225') && clean.length === 4 + 8) {
    const old = clean.slice(4, 6);
    const newPrefix = Object.keys(CI_LEGACY_MAP).find(p => CI_LEGACY_MAP[p].includes(old));
    if (newPrefix) clean = `+225${newPrefix}${clean.slice(4)}`;
  }
  return clean;
};

const detectCountry = (e164) => {
  const digits = e164.replace('+', '');
  const codes = Object.keys(COUNTRY_BY_CODE).sort((a, b) => b.length - a.length);
  for (const code of codes) {
    if (digits.startsWith(code)) return { ...COUNTRY_BY_CODE[code], national: digits.slice(code.length) };
  }
  return null;
};

const detectOperator = (national, countryCode) => {
  const ops = MOBILE_MONEY_OPERATORS[countryCode];
  if (!ops) return null;
  const candidates = ops.flatMap(op => op.prefixes.map(p => ({ prefix: p, op })))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const hit = candidates.find(c => national.startsWith(c.prefix));
  return hit ? hit.op : null;
};

// ─── API principale ───────────────────────────────────────────────

/**
 * @param {string} phone
 * @param {object} [opts]
 * @param {string} [opts.defaultCountry]   ISO-2 du marchand (pour numéros locaux)
 * @param {string} [opts.operatorOverride] ex. 'WAVE' — wallet choisi explicitement
 */
const detectFromPhone = (phone, opts = {}) => {
  opts = opts && typeof opts === 'object' ? opts : {};
  if (!phone) return { success: false, error: 'Numéro de téléphone requis', code: 'PHONE_REQUIRED' };

  const normalized = normalizePhone(String(phone), opts.defaultCountry);
  if (!normalized) return { success: false, error: 'Numéro invalide', code: 'PHONE_INVALID' };

  const countryInfo = detectCountry(normalized);
  if (!countryInfo) return { success: false, error: 'Pays non supporté', code: 'COUNTRY_UNSUPPORTED' };

  if (countryInfo.national.length !== countryInfo.nsnLength) {
    return { success: false, error: `Numéro ${countryInfo.name} invalide (${countryInfo.nsnLength} chiffres attendus)`, code: 'PHONE_LENGTH' };
  }

  const alternatives = WALLET_ALTERNATIVES[countryInfo.country] || [];
  const base = {
    phone: normalized, country: countryInfo.country, countryName: countryInfo.name,
    currency: countryInfo.currency, region: countryInfo.region, alternatives,
  };

  // Override explicite (Wave, Express Union…)
  if (opts.operatorOverride) {
    const wanted = String(opts.operatorOverride).toUpperCase();
    const alt = alternatives.find(a => a.operator === wanted);
    const op  = (MOBILE_MONEY_OPERATORS[countryInfo.country] || []).find(o => o.operator === wanted);
    const chosen = alt || (op && op.gateway ? op : null);
    if (!chosen) return { success: false, error: `Opérateur ${wanted} indisponible pour ${countryInfo.name}`, code: 'OPERATOR_UNAVAILABLE', ...base };
    return { success: true, ...base, operator: chosen.operator, brand: chosen.brand, gateway: chosen.gateway, overridden: true };
  }

  const operatorInfo = detectOperator(countryInfo.national, countryInfo.country);
  if (!operatorInfo) {
    return { success: false, error: `Opérateur non reconnu pour ce numéro ${countryInfo.name}`, code: 'OPERATOR_UNKNOWN', ...base };
  }
  if (!operatorInfo.gateway) {
    return {
      success: false, code: 'OPERATOR_NO_WALLET', ...base,
      operator: operatorInfo.operator, brand: operatorInfo.brand,
      error: `${operatorInfo.brand} n'a pas de service Mobile Money branché${alternatives.length ? ` — alternatives : ${alternatives.map(a => a.brand).join(', ')}` : ''}`,
    };
  }
  return { success: true, ...base, operator: operatorInfo.operator, brand: operatorInfo.brand, gateway: operatorInfo.gateway, verified: operatorInfo.verified, ...(operatorInfo.planned ? { planned: true } : {}) };
};

/**
 * Détecte le réseau carte depuis un BIN (6 à 8 chiffres).
 * Ne jamais passer un PAN complet : seuls les 8 premiers chiffres sont conservés.
 */
const detectFromCard = (bin) => {
  if (!bin) return { success: false, error: 'BIN carte requis', code: 'BIN_REQUIRED' };
  const cleanBin = String(bin).replace(/\D/g, '').slice(0, 8);
  if (cleanBin.length < 6) return { success: false, error: 'BIN trop court (6 chiffres minimum)', code: 'BIN_INVALID' };

  const six = cleanBin.slice(0, 6);
  // 1) plages
  for (const e of CARD_NETWORKS) {
    if (e.range && six >= e.range[0] && six <= e.range[1]) return { success: true, network: e.network, name: e.name, acquirer: e.acquirer, bin: cleanBin, verified: e.verified };
  }
  // 2) préfixes, du plus long au plus court
  const byLen = CARD_NETWORKS.filter(e => e.prefix).sort((a, b) => b.prefix.length - a.prefix.length);
  for (const e of byLen) {
    if (cleanBin.startsWith(e.prefix)) return { success: true, network: e.network, name: e.name, acquirer: e.acquirer, bin: cleanBin, verified: e.verified };
  }
  return { success: false, error: 'Réseau carte non reconnu', code: 'NETWORK_UNKNOWN' };
};

/** Détecte depuis un AID EMV (préfixe le plus long d'abord). */
const detectFromAid = (aid) => {
  const upper = String(aid || '').replace(/\s/g, '').toUpperCase();
  if (!/^A[0-9A-F]{9,31}$/.test(upper)) return { success: false, error: 'AID invalide', code: 'AID_INVALID' };
  const sorted = [...AID_MAP].sort((a, b) => b.aid.length - a.aid.length);
  const hit = sorted.find(e => upper.startsWith(e.aid));
  if (!hit) return { success: false, error: 'AID non reconnu', code: 'AID_UNKNOWN' };
  return { success: true, network: hit.network, acquirer: hit.acquirer, aid: upper };
};

/** Combine détection + règles de routage. */
const getBestRoute = ({ phone, bin, aid, defaultCountry, operatorOverride } = {}) => {
  if (phone && !bin && !aid) {
    const d = detectFromPhone(phone, { defaultCountry, operatorOverride });
    return d.success ? { ...d, paymentMethod: 'mobile_money', routeType: 'direct' } : d;
  }
  if (aid) {
    const c = detectFromAid(aid);
    return c.success ? { ...c, paymentMethod: 'card_nfc', routeType: 'emv' } : c;
  }
  if (bin) {
    const c = detectFromCard(bin);
    return c.success ? { ...c, paymentMethod: 'card', routeType: 'emv' } : c;
  }
  return { success: false, error: 'Paramètres insuffisants pour la détection de route', code: 'INSUFFICIENT_PARAMS' };
};

module.exports = {
  detectFromPhone, detectFromCard, detectFromAid, getBestRoute, normalizePhone,
  COUNTRIES, COUNTRY_PREFIXES, MOBILE_MONEY_OPERATORS, WALLET_ALTERNATIVES, CARD_NETWORKS, AID_MAP,
};
