/**
 * Mobile Money Router — CPlus 2.6.0
 *
 * Config chargée depuis la table api_configurations (DB).
 * Si la config n'est pas en DB, fallback sur les variables d'environnement.
 * Le démarrage ne bloque JAMAIS même si aucune API n'est configurée.
 *
 * WAVE-2 (audit prod 2.6.0, 02-§4) :
 *   - api_key / api_secret et les valeurs sensibles de extra_params sont déchiffrées
 *     à la lecture (config/secrets.js, AES-256-GCM, valeurs héritées en clair tolérées) ;
 *   - extra_params ne peut plus écraser apiKey / apiSecret / baseUrl (fusion explicite) ;
 *   - webhookUrl() : URL de callback secrète commune aux providers.
 */
'use strict';

const logger  = require('../../config/logger');
const secrets = require('../../config/secrets');

// Registry des providers
const PROVIDERS = {
  mtn_cm:          () => require('./providers/mtn.provider'),
  mtn_ci:          () => require('./providers/mtn.provider'),
  mtn_cg:          () => require('./providers/mtn.provider'),
  orange_sn:       () => require('./providers/orange.provider'),
  orange_ci:       () => require('./providers/orange.provider'),
  orange_cm:       () => require('./providers/orange.provider'),
  orange_cg:       () => require('./providers/orange.provider'),
  orange_cd:       () => require('./providers/orange.provider'),
  airtel_cd:       () => require('./providers/airtel.provider'),
  airtel_cg:       () => require('./providers/airtel.provider'),
  vodacom_cd:      () => require('./providers/vodacom.provider'),
  africell_cd:     () => require('./providers/africell.provider'),
  interswitch_mpesa_cd:   () => require('./providers/interswitch_wallet.provider'),
  interswitch_orange_cd:  () => require('./providers/interswitch_wallet.provider'),
  interswitch_airtel_cd:  () => require('./providers/interswitch_wallet.provider'),
  interswitch_africell_cd:() => require('./providers/interswitch_wallet.provider'),
  paymenthub_mpesa_cd:    () => require('./providers/paymenthub.provider'),
  paymenthub_orange_cd:   () => require('./providers/paymenthub.provider'),
  paymenthub_airtel_cd:   () => require('./providers/paymenthub.provider'),
  paymenthub_africell_cd: () => require('./providers/paymenthub.provider'),
  wave_sn:         () => require('./providers/wave.provider'),
  wave_ci:         () => require('./providers/wave.provider'),
  moov_ci:         () => require('./providers/moov.provider'),
  moov_cm:         () => require('./providers/moov.provider'),
  express_union_cm:() => require('./providers/express_union.provider'),
  free_money_sn:   () => require('./providers/free_money.provider'),
};

// Clés de config réservées : jamais écrasées par extra_params
const RESERVED_CONFIG_KEYS = new Set(['providerKey', 'baseUrl', 'apiKey', 'apiSecret']);

/** Ligne api_configurations → objet config déchiffré (fusion explicite, extra_params ne prime jamais). */
const buildConfigFromRow = (row) => {
  const extra = secrets.decryptExtraParams(row.extra_params && typeof row.extra_params === 'object' ? row.extra_params : {});
  const cfg = {};
  for (const [k, v] of Object.entries(extra)) {
    if (RESERVED_CONFIG_KEYS.has(k)) {
      logger.warn('MM Router: extra_params key ignored (reserved)', { providerKey: row.provider_key, key: k });
      continue;
    }
    cfg[k] = v;
  }
  cfg.providerKey = row.provider_key;
  cfg.baseUrl     = row.base_url;
  cfg.apiKey      = secrets.decrypt(row.api_key);
  cfg.apiSecret   = secrets.decrypt(row.api_secret);
  return cfg;
};

// Cache config DB (5 min)
let _configCache = {};
let _cacheTime   = 0;
const CACHE_TTL  = 5 * 60 * 1000;

const getConfig = async (providerKey) => {
  // Rafraîchir le cache si expiré
  if (Date.now() - _cacheTime > CACHE_TTL) {
    try {
      const { query } = require('../../config/database');
      const result = await query(
        `SELECT provider_key, base_url, api_key, api_secret, extra_params
         FROM api_configurations WHERE provider_type = 'mobile_money'`,
        []
      );
      const fresh = {};
      for (const row of result.rows) {
        try {
          fresh[row.provider_key] = buildConfigFromRow(row);
        } catch (err) {
          // Clé de chiffrement absente / valeur altérée : le provider reste non configuré (fallback env)
          logger.error('MM Router: config row unreadable (decrypt failed)', { providerKey: row.provider_key, err: err.message });
        }
      }
      _configCache = fresh;
      _cacheTime = Date.now();
    } catch (err) {
      logger.warn('MM Router: could not load config from DB, using env vars', { err: err.message });
    }
  }

  // Config DB en priorité, sinon env vars
  return _configCache[providerKey] || buildConfigFromEnv(providerKey);
};

/** Module provider enregistré pour une clé de gateway (ou null). */
const getProvider = (gateway) => {
  const factory = PROVIDERS[gateway];
  return factory ? factory() : null;
};

/**
 * URL de callback opérateur : segment secret (WEBHOOK_PATH_SECRET) + nom du provider.
 * Sans secret configuré, on retombe sur l'ancien chemin public /webhooks/<provider>
 * (toujours monté, mais fail-closed pour les providers sans signature).
 */
let _warnedNoSecret = false;
const webhookUrl = (provider, suffix = '') => {
  const base   = String(process.env.API_BASE_URL || '').replace(/\/+$/, '');
  const secret = process.env.WEBHOOK_PATH_SECRET;
  if (secret) return `${base}/api/v1/webhooks/${encodeURIComponent(secret)}/${provider}${suffix}`;
  if (!_warnedNoSecret) {
    _warnedNoSecret = true;
    logger.warn('WEBHOOK_PATH_SECRET non configuré : URLs de callback legacy /webhooks/<provider> utilisées');
  }
  return `${base}/webhooks/${provider}${suffix}`;
};

const processPayment = async ({ txnId, amount, currency, phone, operator, gateway, country, description }) => {
  logger.info('MM Router: collect', { txnId, gateway, operator, country, amount });

  const factory = PROVIDERS[gateway];
  if (!factory) {
    return { approved: false, responseCode: '05',
             declineReason: `Opérateur ${gateway} non supporté`, retryable: false };
  }

  try {
    const config = await getConfig(gateway);
    const result = await factory().collectPayment({ txnId, amount, currency, phone, description, config });
    return normalize(result, operator, gateway);
  } catch (err) {
    logger.error('MM Router: collect failed', { txnId, gateway, err: err.message });
    // Ne jamais bloquer — retourner une erreur réseau
    return { approved: false, responseCode: '96', declineReason: 'Service Mobile Money indisponible', retryable: true };
  }
};

const sendPayout = async ({ txnId, amount, currency, phone, operator, gateway, country }) => {
  logger.info('MM Router: payout', { txnId, gateway, operator, country, amount });

  const factory = PROVIDERS[gateway];
  if (!factory) return { approved: false, responseCode: '05', declineReason: `Opérateur ${gateway} non supporté` };

  try {
    const config = await getConfig(gateway);
    const result = await factory().sendPayout({ txnId, amount, currency, phone, config });
    return normalize(result, operator, gateway);
  } catch (err) {
    logger.error('MM Router: payout failed', { txnId, gateway, err: err.message });
    return { approved: false, responseCode: '96', declineReason: 'Service de retrait indisponible', retryable: true };
  }
};

// Tester la connectivité d'un provider (pour l'admin)
const testProvider = async (providerKey) => {
  const config = await getConfig(providerKey);
  if (!config.apiKey) return { ok: false, reason: 'API key not configured' };
  // Test léger : vérifier que le provider peut obtenir un token ou répondre
  try {
    const factory = PROVIDERS[providerKey];
    if (!factory) return { ok: false, reason: 'Provider not registered' };
    // On tente juste de charger le module (pas d'appel réseau)
    factory();
    return { ok: true, configured: true, hasKey: !!config.apiKey, hasSecret: !!config.apiSecret };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
};

// Invalider le cache (après mise à jour config admin)
const invalidateCache = () => { _cacheTime = 0; _configCache = {}; };

// pending:true (push accepte, PIN non saisi, timeout de polling) est propage tel quel :
// l'orchestrateur laisse alors la transaction `pending` (jamais `failed`).
// gatewayRef est persisté dans transactions.gateway_payment_id : pour Orange c'est le
// notif_token (comparé au callback notif_url), pour Wave l'id de session checkout.
// WAVE-3 : _gateway (clé orange_cg, wave_sn…) est persisté dans transactions.gateway_name
// (comme les gateways carte) — la réconciliation et les webhooks retrouvent ainsi la config.
const normalize = (raw, operator, gateway = null) => {
  const pending  = raw.pending === true;
  const approved = !pending && raw.success === true;
  return {
    approved,
    pending,
    authCode:      raw.transactionId || raw.financialTransactionId || raw.sessionId || null,
    responseCode:  raw.responseCode || (approved ? '00' : (pending ? '09' : '05')),
    declineReason: raw.errorMessage || raw.reason || null,
    gatewayRef:    raw.notifToken   || raw.sessionId || raw.externalId || raw.transactionId || null,
    retryable:     raw.retryable    ?? false,
    _operator:     operator,
    _gateway:      gateway || null,
  };
};

// Fallback env vars si pas de config DB
// MTN : les variables documentees (docs/GO-LIVE-CG.md) sont MTN_<CC>_COLL_API_USER / _COLL_API_KEY / _COLL_SUB_KEY_PRIMARY
// (collection) et MTN_<CC>_DISB_* (disbursement). Elles alimentent ici la config du provider mtn_<cc> :
// apiKey = API user, apiSecret = API key, subscriptionKey = cle d'abonnement du produit.
const mtnEnvBlock = (K, product) => {
  const P = product === 'disbursement' ? 'DISB' : 'COLL';
  const apiKey = process.env[`${K}_${P}_API_USER`], apiSecret = process.env[`${K}_${P}_API_KEY`];
  const subscriptionKey = process.env[`${K}_${P}_SUB_KEY_PRIMARY`] || process.env[`${K}_${P}_SUBSCRIPTION_KEY`];
  return (apiKey || apiSecret || subscriptionKey) ? { apiKey, apiSecret, subscriptionKey } : null;
};
const buildConfigFromEnv = (key) => {
  const K = key.toUpperCase();
  const mtn = K.startsWith('MTN_') ? mtnEnvBlock(K, 'collection') : null;
  const mtnDisb = K.startsWith('MTN_') ? mtnEnvBlock(K, 'disbursement') : null;
  return {
  providerKey:key,
  baseUrl:   process.env[`${K}_BASE_URL`]    || process.env[`${K}_URL`],
  apiKey:    process.env[`${K}_API_KEY`]     || process.env[`${K}_CLIENT_ID`] || (mtn ? mtn.apiKey : undefined),
  apiSecret: process.env[`${K}_SECRET`]      || process.env[`${K}_CLIENT_SECRET`] || (mtn ? mtn.apiSecret : undefined),
  subscriptionKey: process.env[`${K}_SUBSCRIPTION_KEY`] || process.env[`${K}_SUB_KEY_PRIMARY`] || (mtn ? mtn.subscriptionKey : undefined),
  targetEnvironment: process.env[`${K}_TARGET_ENV`],
  ...(mtnDisb ? { disbursement: mtnDisb } : {}),
  merchantId:process.env[`${K}_MERCHANT_ID`],
  serviceCode:process.env[`${K}_SERVICE_CODE`],
  merchantCode:process.env[`${K}_MERCHANT_CODE`],
  payItemId:process.env[`${K}_PAY_ITEM_ID`],
  authBaseUrl:process.env[`${K}_AUTH_BASE_URL`],
  walletProvider:process.env[`${K}_WALLET_PROVIDER`],
  companyCode:process.env[`${K}_COMPANY_CODE`],
  debitAccountNo:process.env[`${K}_DEBIT_ACCOUNT_NO`],
  callbackUrl:process.env[`${K}_CALLBACK_URL`],
  webhookSecret:process.env[`${K}_WEBHOOK_SECRET`],
  webhookToken:process.env[`${K}_WEBHOOK_TOKEN`],
  statusPath:process.env[`${K}_STATUS_PATH`],
  };
};

module.exports = {
  processPayment, sendPayout, testProvider, invalidateCache, getConfig, getProvider, webhookUrl,
  normalize, buildConfigFromRow, PROVIDERS,
};
