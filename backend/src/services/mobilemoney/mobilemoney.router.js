/**
 * Mobile Money Router — CPlus 2.6.0
 *
 * Config chargée depuis la table api_configurations (DB).
 * Si la config n'est pas en DB, fallback sur les variables d'environnement.
 * Le démarrage ne bloque JAMAIS même si aucune API n'est configurée.
 */
'use strict';

const logger = require('../../config/logger');

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
      _configCache = {};
      for (const row of result.rows) {
        _configCache[row.provider_key] = {
          providerKey:  row.provider_key,
          baseUrl:     row.base_url,
          apiKey:      row.api_key,
          apiSecret:   row.api_secret,
          ...row.extra_params,
        };
      }
      _cacheTime = Date.now();
    } catch (err) {
      logger.warn('MM Router: could not load config from DB, using env vars', { err: err.message });
    }
  }

  // Config DB en priorité, sinon env vars
  return _configCache[providerKey] || buildConfigFromEnv(providerKey);
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
    return normalize(result, operator);
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
    return normalize(result, operator);
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
const invalidateCache = () => { _cacheTime = 0; };

// pending:true (push accepte, PIN non saisi, timeout de polling) est propage tel quel :
// l'orchestrateur laisse alors la transaction `pending` (jamais `failed`).
const normalize = (raw, operator) => {
  const pending  = raw.pending === true;
  const approved = !pending && raw.success === true;
  return {
    approved,
    pending,
    authCode:      raw.transactionId || raw.financialTransactionId || raw.sessionId || null,
    responseCode:  raw.responseCode || (approved ? '00' : (pending ? '09' : '05')),
    declineReason: raw.errorMessage || raw.reason || null,
    gatewayRef:    raw.externalId   || raw.transactionId || null,
    retryable:     raw.retryable    ?? false,
    _operator:     operator,
  };
};

// Fallback env vars si pas de config DB
const buildConfigFromEnv = (key) => ({
  providerKey:key,
  baseUrl:   process.env[`${key.toUpperCase()}_BASE_URL`]    || process.env[`${key.toUpperCase()}_URL`],
  apiKey:    process.env[`${key.toUpperCase()}_API_KEY`]     || process.env[`${key.toUpperCase()}_CLIENT_ID`],
  apiSecret: process.env[`${key.toUpperCase()}_SECRET`]      || process.env[`${key.toUpperCase()}_CLIENT_SECRET`],
  merchantId:process.env[`${key.toUpperCase()}_MERCHANT_ID`],
  serviceCode:process.env[`${key.toUpperCase()}_SERVICE_CODE`],
  merchantCode:process.env[`${key.toUpperCase()}_MERCHANT_CODE`],
  payItemId:process.env[`${key.toUpperCase()}_PAY_ITEM_ID`],
  authBaseUrl:process.env[`${key.toUpperCase()}_AUTH_BASE_URL`],
  walletProvider:process.env[`${key.toUpperCase()}_WALLET_PROVIDER`],
  companyCode:process.env[`${key.toUpperCase()}_COMPANY_CODE`],
  debitAccountNo:process.env[`${key.toUpperCase()}_DEBIT_ACCOUNT_NO`],
  callbackUrl:process.env[`${key.toUpperCase()}_CALLBACK_URL`],
});

module.exports = { processPayment, sendPayout, testProvider, invalidateCache, getConfig, normalize, PROVIDERS };
