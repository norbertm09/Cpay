'use strict';
/**
 * Registre de capacités — vague 6, lot 2 (audit 2026-10-17, P1 n°4).
 *
 * Source de vérité SERVEUR de ce que C-Pay sait réellement faire : pays × devise × famille/opérateur ×
 * opération × statut. Le statut n'est jamais affirmé à la main : il est CALCULÉ à partir de la présence
 * du code d'intégration ET de sa configuration (mêmes règles que le code financier, sans le modifier) :
 *
 *   - encaissement Mobile Money : provider enregistré dans mobilemoney.router (collectPayment) ET clé API
 *     (env `<GATEWAY>_API_KEY` / `<GATEWAY>_CLIENT_ID`, ou ligne api_configurations) ;
 *   - retrait Mobile Money : MTN CG via MTN_CG_DISB_* (rails/mtn-momo.client), sinon provider avec
 *     sendPayout + clé API (cash.service.payoutRail ; Interswitch RDC exclu) ;
 *   - encaissement carte : checkout hébergé (MIGS_* ou MPGS_*, card-link.service) ET passerelle par défaut
 *     du pays (country_payment_defaults.default_card_gateway, ou env CARD_GATEWAY_<CC>) ;
 *   - retrait / transfert carte : non pris en charge par l'orchestrateur → unavailable ;
 *   - transfert wallet → banque : file manuelle des opérations (cash.service.createPayout) ;
 *   - transfert banque → wallet : compte de collecte C-Pay actif pour la devise (platform_bank_accounts) ;
 *   - GIMAC / GIMACPAY : aucun code (gateways/gimac.gateway.js lève GATEWAY_NOT_ACTIVATED) → planned en CEMAC.
 *
 * Statuts :
 *   active      code présent + configuration présente ;
 *   pilot       idem, et CAPABILITY_PILOT_<CC>=true (ouverture restreinte) ;
 *   planned     dans le périmètre de lancement, pas de code ;
 *   unavailable tout le reste (code sans configuration, carte retrait, pays hors périmètre…).
 *
 * SN / CI (connecteurs historiques) : `legacy:true` — aucune nouvelle activation (inscription refusée),
 * la détection et les marchands existants continuent de fonctionner sauf CAPABILITY_LEGACY_ALLOW=false.
 *
 * Les faits dépendant de la base (passerelle carte par pays, clés api_configurations, comptes de
 * collecte) sont chargés par `loadFacts()` (cache 60 s, tolérant aux pannes) et peuvent être injectés
 * dans chaque appel (`facts`) — le registre lui-même est synchrone et sans effet de bord.
 */

const STATUS = Object.freeze({ ACTIVE: 'active', PILOT: 'pilot', PLANNED: 'planned', UNAVAILABLE: 'unavailable' });
const STATUS_RANK = { active: 3, pilot: 2, planned: 1, unavailable: 0 };
const OPERATIONS = Object.freeze(['collect', 'withdraw', 'transfer']);
const TRANSFER_DIRECTIONS = Object.freeze(['wallet_to_bank', 'bank_to_wallet']);
const FACTS_TTL_MS = 60 * 1000;

// ─── Périmètre de lancement (docs/LAUNCH-CEMAC-RDC.md) ────────────
const COUNTRIES = Object.freeze({
  CM: { name: 'Cameroun',                 currency: 'XAF', region: 'CEMAC',    callingCode: '237', launch: true },
  CF: { name: 'République centrafricaine', currency: 'XAF', region: 'CEMAC',    callingCode: '236', launch: true },
  CG: { name: 'République du Congo',      currency: 'XAF', region: 'CEMAC',    callingCode: '242', launch: true },
  GA: { name: 'Gabon',                    currency: 'XAF', region: 'CEMAC',    callingCode: '241', launch: true },
  GQ: { name: 'Guinée équatoriale',       currency: 'XAF', region: 'CEMAC',    callingCode: '240', launch: true },
  TD: { name: 'Tchad',                    currency: 'XAF', region: 'CEMAC',    callingCode: '235', launch: true },
  CD: { name: 'RD Congo',                 currency: 'CDF', region: 'RD Congo', callingCode: '243', launch: true },
  // Connecteurs historiques hors lancement : aucune nouvelle activation
  SN: { name: 'Sénégal',                  currency: 'XOF', region: 'UEMOA',    callingCode: '221', launch: false, legacy: true },
  CI: { name: "Côte d'Ivoire",            currency: 'XOF', region: 'UEMOA',    callingCode: '225', launch: false, legacy: true },
});
const LAUNCH_COUNTRIES = Object.freeze(Object.keys(COUNTRIES).filter((c) => COUNTRIES[c].launch));

// ─── Opérateurs Mobile Money par pays ─────────────────────────────
// gateway = clé mobilemoney.router / detection.engine ; verified = plan de numérotation confirmé.
// since = première version où l'intégration (code) existe ; null = aucune.
const OPERATORS = Object.freeze({
  CM: [
    { operator: 'MTN_MOMO',       brand: 'MTN MoMo',             gateway: 'mtn_cm',           verified: true,  since: '2.6.0' },
    { operator: 'ORANGE_MONEY',   brand: 'Orange Money',         gateway: 'orange_cm',        verified: true,  since: '2.6.0' },
    { operator: 'EXPRESS_UNION',  brand: 'Express Union Mobile', gateway: 'express_union_cm', verified: true,  since: '2.7.0', alternative: true },
  ],
  CF: [
    { operator: 'ORANGE_MONEY',   brand: 'Orange Money',         gateway: 'orange_cf',        verified: false, since: null },
    { operator: 'TELECEL_MONEY',  brand: 'Telecel Money',        gateway: 'telecel_cf',       verified: false, since: null },
  ],
  CG: [
    { operator: 'MTN_MOMO',       brand: 'MTN MoMo',             gateway: 'mtn_cg',           verified: true,  since: '2.6.0' },
    { operator: 'AIRTEL_MONEY',   brand: 'Airtel Money',         gateway: 'airtel_cg',        verified: false, since: '2.6.0' },
  ],
  GA: [
    { operator: 'AIRTEL_MONEY',   brand: 'Airtel Money',         gateway: 'airtel_ga',        verified: false, since: null },
    { operator: 'MOOV_MONEY',     brand: 'Moov Money',           gateway: 'moov_ga',          verified: false, since: null },
  ],
  GQ: [
    { operator: 'GETESA_MONEY',   brand: 'GETESA',               gateway: 'getesa_gq',        verified: false, since: null },
    { operator: 'MUNI_MONEY',     brand: 'Muni',                 gateway: 'muni_gq',          verified: false, since: null },
  ],
  TD: [
    { operator: 'AIRTEL_MONEY',   brand: 'Airtel Money',         gateway: 'airtel_td',        verified: false, since: null },
    { operator: 'MOOV_MONEY',     brand: 'Moov Money',           gateway: 'moov_td',          verified: false, since: null },
  ],
  CD: [
    { operator: 'VODACOM_MPESA',  brand: 'M-Pesa',               gateway: 'vodacom_cd',       verified: true,  since: '2.6.0' },
    { operator: 'AIRTEL_MONEY',   brand: 'Airtel Money',         gateway: 'airtel_cd',        verified: true,  since: '2.6.0' },
    { operator: 'ORANGE_MONEY',   brand: 'Orange Money',         gateway: 'orange_cd',        verified: true,  since: '2.6.0' },
    { operator: 'AFRICELL_MONEY', brand: 'Africell Money',       gateway: 'africell_cd',      verified: false, since: '2.7.0' },
  ],
  SN: [
    { operator: 'ORANGE_MONEY',   brand: 'Orange Money',         gateway: 'orange_sn',        verified: true,  since: '2.6.0' },
    { operator: 'FREE_MONEY',     brand: 'Free Money',           gateway: 'free_money_sn',    verified: true,  since: '2.7.0' },
    { operator: 'WAVE',           brand: 'Wave',                 gateway: 'wave_sn',          verified: true,  since: '2.7.0', alternative: true },
  ],
  CI: [
    { operator: 'ORANGE_MONEY',   brand: 'Orange Money',         gateway: 'orange_ci',        verified: true,  since: '2.6.0' },
    { operator: 'MTN_MOMO',       brand: 'MTN MoMo',             gateway: 'mtn_ci',           verified: true,  since: '2.6.0' },
    { operator: 'MOOV_MONEY',     brand: 'Moov Money',           gateway: 'moov_ci',          verified: true,  since: '2.7.0' },
    { operator: 'WAVE',           brand: 'Wave',                 gateway: 'wave_ci',          verified: true,  since: '2.7.0', alternative: true },
  ],
});

const MTN_CG_DISB_VARS = ['MTN_CG_DISB_API_USER', 'MTN_CG_DISB_API_KEY', 'MTN_CG_DISB_SUB_KEY_PRIMARY'];
const MIGS_VARS = ['MIGS_MERCHANT_ID', 'MIGS_ACCESS_CODE', 'MIGS_SECURE_HASH'];
const MPGS_VARS = ['MPGS_MERCHANT_ID', 'MPGS_API_PASSWORD'];
const PAYOUT_UNSUPPORTED_PREFIXES = ['interswitch_']; // cash.service.PAYOUT_UNSUPPORTED_PREFIXES
const GIMAC_REQUIRES = Object.freeze([
  'contrat de participation GIMAC (Calculus Plus SAS)',
  'spécifications techniques GIMAC / GIMACPAY (API, callbacks, rapprochement)',
  'tests partenaires encaissement, retrait, transfert et rapprochement',
  'GIMAC_MERCHANT_ID', 'GIMAC_AID_PREFIXES',
]);

// ─── Erreur métier ────────────────────────────────────────────────
class CapabilityError extends Error {
  constructor({ country, operation, method, status, message, operator = null }) {
    super(message);
    this.name = 'CapabilityError';
    this.statusCode = 403;
    this.code = 'CAPABILITY_NOT_ACTIVE';
    this.country = country; this.operation = operation; this.method = method; this.status = status; this.operator = operator;
    this.details = { country, operation, method, status, ...(operator ? { operator } : {}) };
  }
  toJSON() {
    return { error: this.message, code: this.code, country: this.country, operation: this.operation, method: this.method, status: this.status, ...(this.operator ? { operator: this.operator } : {}), message: this.message };
  }
}

// ─── Faits dépendant de la base (cache 60 s) ───────────────────────
const emptyFacts = () => ({ cardGatewayByCountry: {}, configuredGateways: [], fundingCurrencies: [], loadedAt: null, source: 'none' });
let _facts = emptyFacts();
let _factsAt = 0;
let _factsPromise = null;

const normalizeFacts = (f) => {
  const src = f && typeof f === 'object' ? f : {};
  return {
    cardGatewayByCountry: Object.fromEntries(Object.entries(src.cardGatewayByCountry || {}).map(([k, v]) => [String(k).toUpperCase(), String(v || '').toLowerCase()])),
    configuredGateways: Array.from(src.configuredGateways || []).map((g) => String(g).toLowerCase()),
    fundingCurrencies: Array.from(src.fundingCurrencies || []).map((c) => String(c).toUpperCase()),
    loadedAt: src.loadedAt || null,
    source: src.source || 'injected',
  };
};

/** Charge (ou relit du cache) les faits base : passerelle carte / pays, clés MM, devises de collecte. */
async function loadFacts({ force = false } = {}) {
  if (!force && _factsAt && Date.now() - _factsAt < FACTS_TTL_MS) return _facts;
  if (_factsPromise) return _factsPromise;
  _factsPromise = (async () => {
    const facts = emptyFacts();
    try {
      const { query } = require('../../config/database');
      const [cpd, cfg, pba] = await Promise.all([
        query(`SELECT country, default_card_gateway FROM country_payment_defaults`, []).catch(() => ({ rows: [] })),
        query(`SELECT provider_key FROM api_configurations WHERE provider_type='mobile_money' AND api_key IS NOT NULL AND api_key <> ''`, []).catch(() => ({ rows: [] })),
        query(`SELECT DISTINCT currency FROM platform_bank_accounts WHERE active = TRUE`, []).catch(() => ({ rows: [] })),
      ]);
      for (const r of (cpd && cpd.rows) || []) if (r.country && r.default_card_gateway) facts.cardGatewayByCountry[String(r.country).toUpperCase()] = String(r.default_card_gateway).toLowerCase();
      facts.configuredGateways = ((cfg && cfg.rows) || []).map((r) => String(r.provider_key).toLowerCase());
      facts.fundingCurrencies = ((pba && pba.rows) || []).map((r) => String(r.currency).toUpperCase());
      facts.source = 'database';
    } catch (e) {
      try { require('../../config/logger').warn('capabilities: facts unavailable (database)', { err: e.message }); } catch (_) { /* no-op */ }
    }
    facts.loadedAt = new Date().toISOString();
    _facts = facts; _factsAt = Date.now();
    return facts;
  })().finally(() => { _factsPromise = null; });
  return _factsPromise;
}
const getCachedFacts = () => _facts;
const invalidateFacts = () => { _facts = emptyFacts(); _factsAt = 0; };

// ─── Résolution « code présent ? » ────────────────────────────────
const defaultProviders = () => {
  try { return require('../mobilemoney/mobilemoney.router'); } catch (e) { return null; }
};
const providerSupports = (providers, gateway, fn) => {
  if (!providers || typeof providers.getProvider !== 'function') return false;
  try {
    const p = providers.getProvider(gateway);
    return !!(p && typeof p[fn] === 'function');
  } catch (e) { return false; }
};

// ─── Règles de configuration (mêmes variables que le code financier) ─
const has = (env, name) => !!(env[name] && String(env[name]).trim());
const hasAll = (env, names) => names.every((n) => has(env, n));
const isTrue = (v) => ['true', '1', 'yes', 'on'].includes(String(v || '').trim().toLowerCase());
// Variables d'environnement qui rendent une gateway « configuree » (voir mobilemoney.router.buildConfigFromEnv) ;
// pour MTN, les variables documentees MTN_<CC>_COLL_API_USER (+ _COLL_API_KEY, _COLL_SUB_KEY_PRIMARY) suffisent.
const gatewayEnvVars = (gateway) => {
  const K = gateway.toUpperCase();
  return K.startsWith('MTN_') ? [`${K}_API_KEY`, `${K}_CLIENT_ID`, `${K}_COLL_API_USER`] : [`${K}_API_KEY`, `${K}_CLIENT_ID`, `${K}_COLL_CLIENT_ID`];
};
const gatewayConfigured = (gateway, env, facts) =>
  gatewayEnvVars(gateway).some((n) => has(env, n)) || facts.configuredGateways.includes(gateway);
const hostedCardGateways = (env) => ({ migs: hasAll(env, MIGS_VARS), mpgs: hasAll(env, MPGS_VARS) });
const cardGatewayFor = (cc, env, facts) => {
  const fromEnv = env[`CARD_GATEWAY_${cc}`] || env[`CAPABILITY_CARD_GATEWAY_${cc}`];
  return String(fromEnv || facts.cardGatewayByCountry[cc] || '').toLowerCase() || null;
};

const pilotFor = (cc, env) => isTrue(env[`CAPABILITY_PILOT_${cc}`]);
const legacyAllowed = (env) => String(env.CAPABILITY_LEGACY_ALLOW ?? 'true').toLowerCase() !== 'false';

/** Statut d'une cellule à partir de (code présent, configuré, pays en périmètre, pilote). */
const computeStatus = ({ implemented, configured, launch, pilot }) => {
  if (implemented && configured) return pilot ? STATUS.PILOT : STATUS.ACTIVE;
  if (!implemented && launch) return STATUS.PLANNED;
  return STATUS.UNAVAILABLE;
};
const cell = (p) => {
  const status = computeStatus(p);
  return {
    status, implemented: !!p.implemented, configured: !!p.configured,
    since: p.implemented ? (p.since || null) : null,
    note: p.note || defaultNote(status, p),
    requires: p.requires || [],
  };
};
const defaultNote = (status, p) => {
  if (status === STATUS.ACTIVE) return 'Intégration présente et configurée.';
  if (status === STATUS.PILOT) return 'Ouverture restreinte (pilote) : intégration présente et configurée.';
  if (status === STATUS.PLANNED) return 'Dans le périmètre de lancement : intégration à réaliser et à valider avec le partenaire.';
  if (p.implemented && !p.configured) return 'Intégration présente mais configuration absente.';
  return 'Non disponible.';
};
const bestStatus = (statuses) => statuses.reduce((best, s) => (STATUS_RANK[s] > STATUS_RANK[best] ? s : best), STATUS.UNAVAILABLE);

// ─── Matrice ──────────────────────────────────────────────────────
/**
 * @param {object} [opts]
 * @param {object} [opts.env]       variables d'environnement (défaut process.env)
 * @param {object} [opts.facts]     faits base (défaut : cache de loadFacts)
 * @param {object} [opts.providers] { getProvider(gateway) } (défaut : mobilemoney.router)
 */
function getCapabilities(opts = {}) {
  const env = opts.env || process.env;
  const facts = normalizeFacts(opts.facts || getCachedFacts());
  const providers = opts.providers === undefined ? defaultProviders() : opts.providers;
  const hosted = hostedCardGateways(env);
  const countries = {};

  for (const [cc, c] of Object.entries(COUNTRIES)) {
    const launch = !!c.launch;
    const pilot = pilotFor(cc, env);
    const legacy = !!c.legacy;
    const inCemac = c.region === 'CEMAC';

    // Mobile Money par opérateur
    const mmCollect = []; const mmWithdraw = [];
    for (const op of OPERATORS[cc] || []) {
      const gw = op.gateway;
      const collectImpl = providerSupports(providers, gw, 'collectPayment');
      const configured = gatewayConfigured(gw, env, facts);
      const base = { operator: op.operator, brand: op.brand, gateway: gw, verified: op.verified, alternative: !!op.alternative };
      mmCollect.push({ ...base, ...cell({ implemented: collectImpl, configured, launch, pilot, since: op.since,
        requires: [...gatewayEnvVars(gw), `api_configurations[${gw}]`, ...(op.verified ? [] : ['confirmation du plan de numérotation (docs/OPERATEURS-A-CONFIRMER.md)'])] }) });

      let withdrawImpl = false; let withdrawCfg = false; let requires = [];
      if (gw === 'mtn_cg') {
        withdrawImpl = true; withdrawCfg = hasAll(env, MTN_CG_DISB_VARS); requires = [...MTN_CG_DISB_VARS];
      }
      if (!withdrawCfg && !PAYOUT_UNSUPPORTED_PREFIXES.some((p) => gw.startsWith(p)) && providerSupports(providers, gw, 'sendPayout')) {
        withdrawImpl = true; withdrawCfg = configured; requires = [...requires, ...gatewayEnvVars(gw), `api_configurations[${gw}]`];
      }
      if (!withdrawImpl) requires = launch ? ['implémentation sendPayout du provider'] : [];
      mmWithdraw.push({ ...base, ...cell({ implemented: withdrawImpl, configured: withdrawCfg, launch, pilot, since: op.since, requires }) });
    }

    // Carte : checkout hébergé + passerelle par défaut du pays
    const cardGw = cardGatewayFor(cc, env, facts);
    const cardImpl = true; // card-link.service (MIGS VPC 3-Party / MPGS Hosted Checkout)
    const cardCfg = !!(cardGw && hosted[cardGw]);
    const cardCollect = { gateway: cardGw, ...cell({ implemented: cardImpl, configured: cardCfg, launch, pilot, since: '2.7.0',
      requires: [`country_payment_defaults[${cc}].default_card_gateway (ou CARD_GATEWAY_${cc})`, `MIGS : ${MIGS_VARS.join(', ')}`, `MPGS : ${MPGS_VARS.join(', ')}`],
      note: cardCfg ? undefined : (cardGw ? `Passerelle ${cardGw} non configurée pour ${c.name}.` : `Aucune passerelle carte par défaut pour ${c.name}.`) }) };
    const cardWithdraw = { ...cell({ implemented: false, configured: false, launch: false, pilot }), note: 'Retrait carte non pris en charge par l’orchestrateur (ne pas annoncer).' , requires: ['acquéreur / schéma : OCT ou crédit carte', 'certification'] };
    const cardTransfer = { ...cell({ implemented: false, configured: false, launch: false, pilot }), note: 'Transfert par carte non pris en charge.', requires: [] };

    // GIMAC / GIMACPAY : aucun code (planned en CEMAC, hors CEMAC selon partenaires)
    const gimac = {
      ...cell({ implemented: false, configured: false, launch: launch && inCemac, pilot, requires: [...GIMAC_REQUIRES] }),
      note: inCemac ? 'Connexion GIMAC en cours d’intégration : ouverture après contrat, spécifications et tests partenaires.'
                    : 'Hors CEMAC : corridor GIMAC uniquement via un partenaire, non prévu au lancement.',
    };

    // Transferts
    const walletToBank = cell({ implemented: true, configured: true, launch, pilot, since: '2.7.0',
      requires: ['compte bancaire vérifié du marchand', 'exécution manuelle J+1 ouvré par les opérations (file /admin/cash)'],
      note: 'Virement exécuté par les opérations C-Pay à J+1 ouvré (file manuelle).' });
    const fundingCfg = facts.fundingCurrencies.includes(c.currency) || isTrue(env[`CAPABILITY_FUNDING_${c.currency}`]);
    const bankToWallet = cell({ implemented: true, configured: fundingCfg, launch, pilot, since: '2.7.0',
      requires: [`platform_bank_accounts actif en ${c.currency} (ou CAPABILITY_FUNDING_${c.currency}=true)`],
      note: fundingCfg ? undefined : `Aucun compte de collecte C-Pay actif en ${c.currency}.` });

    countries[cc] = {
      code: cc, name: c.name, currency: c.currency, region: c.region, callingCode: c.callingCode,
      launch, legacy, pilot,
      operations: {
        collect:  { mobile_money: { status: bestStatus(mmCollect.map((o) => o.status)), operators: mmCollect }, card: cardCollect, gimac },
        withdraw: { mobile_money: { status: bestStatus(mmWithdraw.map((o) => o.status)), operators: mmWithdraw }, card: cardWithdraw, gimac },
        transfer: { wallet_to_bank: walletToBank, bank_to_wallet: bankToWallet, card: cardTransfer, gimac },
      },
    };
  }
  return { generatedAt: new Date().toISOString(), launchCountries: [...LAUNCH_COUNTRIES], facts: { source: facts.source, loadedAt: facts.loadedAt }, countries };
}

// ─── Autorisation ─────────────────────────────────────────────────
const norm = (v) => (v === undefined || v === null ? '' : String(v).trim());
const normalizeMethod = (operation, method, direction) => {
  const m = norm(method || direction).toLowerCase();
  if (operation === 'transfer') return TRANSFER_DIRECTIONS.includes(m) ? m : (m || 'wallet_to_bank');
  if (['card', 'card_nfc', 'pay_link'].includes(m)) return 'card';
  if (m === 'gimac' || m === 'gimacpay') return 'gimac';
  return 'mobile_money';
};
const OPERATOR_ALIASES = { mtn: 'MTN_MOMO', momo: 'MTN_MOMO', mtn_momo: 'MTN_MOMO', airtel: 'AIRTEL_MONEY', airtel_money: 'AIRTEL_MONEY', orange: 'ORANGE_MONEY', om: 'ORANGE_MONEY', orange_money: 'ORANGE_MONEY', moov: 'MOOV_MONEY', moov_money: 'MOOV_MONEY', mpesa: 'VODACOM_MPESA', vodacom: 'VODACOM_MPESA', vodacom_mpesa: 'VODACOM_MPESA', africell: 'AFRICELL_MONEY', africell_money: 'AFRICELL_MONEY', express_union: 'EXPRESS_UNION', eu: 'EXPRESS_UNION', wave: 'WAVE', free: 'FREE_MONEY', free_money: 'FREE_MONEY' };
const normalizeOperator = (v) => { const s = norm(v).toLowerCase().replace(/[\s-]+/g, '_'); return s ? (OPERATOR_ALIASES[s] || s.toUpperCase()) : null; };

const LABELS = { collect: 'Encaissement', withdraw: 'Retrait', transfer: 'Transfert' };
const METHOD_LABELS = { mobile_money: 'Mobile Money', card: 'par carte', gimac: 'GIMAC', wallet_to_bank: 'wallet → banque', bank_to_wallet: 'banque → wallet' };
const messageFor = ({ status, country, operation, method, countryName, brand }) => {
  const what = `${LABELS[operation] || operation} ${brand || METHOD_LABELS[method] || method}`;
  const where = countryName ? ` en ${countryName}` : country ? ` (${country})` : '';
  if (status === STATUS.PLANNED) return `${what} non disponible${where} pour le moment : intégration en cours.`;
  if (status === STATUS.UNAVAILABLE) return `${what} non disponible${where} pour le moment.`;
  return `${what} non disponible${where}.`;
};

/**
 * @param {object} p { country, operation, method|direction, operator }
 * @returns {{ allowed:boolean, status:string, country, operation, method, operator, message, cell, legacy }}
 */
function isAllowed(p = {}, opts = {}) {
  const env = opts.env || process.env;
  const country = norm(p.country).toUpperCase();
  const operation = norm(p.operation).toLowerCase();
  const method = normalizeMethod(operation, p.method, p.direction);
  const operator = normalizeOperator(p.operator);
  const base = { country, operation, method, operator };
  if (!OPERATIONS.includes(operation)) return { ...base, allowed: false, status: STATUS.UNAVAILABLE, message: `Opération inconnue : ${operation || '(vide)'}`, cell: null };
  const caps = getCapabilities(opts);
  const c = caps.countries[country];
  if (!c) return { ...base, allowed: false, status: STATUS.UNAVAILABLE, legacy: false, message: `Pays ${country || '(inconnu)'} hors du périmètre C-Pay.`, cell: null };
  const ops = c.operations[operation] || {};
  let target = ops[method];
  if (!target) return { ...base, allowed: false, status: STATUS.UNAVAILABLE, legacy: c.legacy, message: messageFor({ status: STATUS.UNAVAILABLE, country, operation, method, countryName: c.name }), cell: null };
  let brand = null;
  if (method === 'mobile_money' && operator) {
    const opCell = (target.operators || []).find((o) => o.operator === operator);
    if (!opCell) return { ...base, allowed: false, status: STATUS.UNAVAILABLE, legacy: c.legacy, message: `Opérateur ${operator} indisponible pour ${c.name}.`, cell: null };
    target = opCell; brand = opCell.brand;
  }
  const status = target.status;
  const ok = (status === STATUS.ACTIVE || status === STATUS.PILOT) && (!c.legacy || legacyAllowed(env));
  const message = ok ? null : (c.legacy && !legacyAllowed(env)
    ? `${c.name} : connecteur historique hors périmètre de lancement (nouvelles opérations refusées).`
    : messageFor({ status, country, operation, method, countryName: c.name, brand }));
  return { ...base, allowed: ok, status, legacy: c.legacy, message, cell: target };
}

function assertAllowed(p = {}, opts = {}) {
  const r = isAllowed(p, opts);
  if (!r.allowed) throw new CapabilityError({ country: r.country, operation: r.operation, method: r.method, status: r.status, message: r.message, operator: r.operator });
  return r;
}

/** Pays ouverts à l'inscription : périmètre de lancement avec au moins un encaissement active|pilot. */
function countryOpenForRegistration(country, opts = {}) {
  const cc = norm(country).toUpperCase();
  const caps = getCapabilities(opts);
  const c = caps.countries[cc];
  if (!c || !c.launch) return { open: false, country: cc, status: STATUS.UNAVAILABLE, reason: c ? 'legacy' : 'unknown' };
  const statuses = [c.operations.collect.mobile_money.status, c.operations.collect.card.status, c.operations.collect.gimac.status];
  const best = bestStatus(statuses);
  return { open: best === STATUS.ACTIVE || best === STATUS.PILOT, country: cc, status: best, reason: best };
}

// ─── Résumé public (UI) ───────────────────────────────────────────
const pub = (x) => ({ status: x.status });
function summary(opts = {}) {
  const caps = getCapabilities(opts);
  const countries = LAUNCH_COUNTRIES.map((cc) => {
    const c = caps.countries[cc];
    const ops = c.operations;
    const mm = (m) => ({ status: m.status, operators: m.operators.map((o) => ({ operator: o.operator, brand: o.brand, status: o.status, ...(o.alternative ? { alternative: true } : {}) })) });
    return {
      code: cc, name: c.name, currency: c.currency, region: c.region, callingCode: c.callingCode, pilot: c.pilot,
      operations: {
        collect:  { mobile_money: mm(ops.collect.mobile_money), card: pub(ops.collect.card), gimac: pub(ops.collect.gimac) },
        withdraw: { mobile_money: mm(ops.withdraw.mobile_money), card: pub(ops.withdraw.card), gimac: pub(ops.withdraw.gimac) },
        transfer: { wallet_to_bank: pub(ops.transfer.wallet_to_bank), bank_to_wallet: pub(ops.transfer.bank_to_wallet), gimac: pub(ops.transfer.gimac) },
      },
    };
  });
  return { countries, statuses: Object.values(STATUS), generatedAt: caps.generatedAt };
}

module.exports = {
  STATUS, OPERATIONS, TRANSFER_DIRECTIONS, COUNTRIES, LAUNCH_COUNTRIES, OPERATORS, GIMAC_REQUIRES,
  CapabilityError, getCapabilities, isAllowed, assertAllowed, countryOpenForRegistration, summary,
  loadFacts, getCachedFacts, invalidateFacts, computeStatus, normalizeOperator, normalizeMethod,
};
