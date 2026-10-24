'use strict';
/**
 * Environnement MTN MoMo — resolution unique pour tout le backend (go-live CG).
 *
 * Avant : l'encaissement (providers/mtn.provider.js) lisait MTN_ENV, le rail de retrait
 * (rails/mtn-momo.client.js) lisait MTN_CG_TARGET_ENV / MTN_CG_ENV / MTN_CG_BASE_URL, chacun
 * avec « sandbox » par defaut. Oublier une variable faisait tourner la collecte en production
 * et le retrait en bac a sable (ou l'inverse). Ce module centralise la regle :
 *
 *   MTN_ENV = sandbox | production        (interrupteur unique, par defaut sandbox)
 *   MTN_CG_TARGET_ENV / MTN_<CC>_TARGET_ENV   valeur brute de l'en-tete X-Target-Environment
 *                                         (optionnel : derive du pays en production, ex. mtncongo)
 *   MTN_CG_BASE_URL / MTN_MOMO_BASE_URL   URL de base (optionnel : derive de l'environnement)
 *
 * Les anciens MTN_CG_ENV restent acceptes (priorite : MTN_<CC>_ENV > MTN_ENV).
 * En production, l'API MTN attend un X-Target-Environment par pays (mtncongo, mtncameroon,
 * mtnivorycoast…) et l'hote https://momoapi.momo.africa (octobre 2026 ; l'ancien
 * proxy.momoapi.mtn.com n'est plus a utiliser) ; en sandbox la valeur « sandbox » et l'hote
 * https://sandbox.momodeveloper.mtn.com. La cle d'abonnement (Ocp-Apim-Subscription-Key) reste
 * obligatoire sur chaque requete, verifie le 2026-10-24 (401 « missing subscription key »).
 */

const SANDBOX_BASE_URL    = 'https://sandbox.momodeveloper.mtn.com';
// Production : depuis octobre 2026 MTN sert l'API sur momoapi.momo.africa (remplace proxy.momoapi.mtn.com,
// qui reste accepte en surcharge explicite via MTN_<CC>_BASE_URL).
const PRODUCTION_BASE_URL = 'https://momoapi.momo.africa';
const LEGACY_PRODUCTION_HOST = 'proxy.momoapi.mtn.com';

const PRODUCTION_TARGETS = Object.freeze({
  CG: 'mtncongo',
  CM: 'mtncameroon',
  CI: 'mtnivorycoast',
  GH: 'mtnghana',
  UG: 'mtnuganda',
  ZM: 'mtnzambia',
  BJ: 'mtnbenin',
  GN: 'mtnguineaconakry',
  LR: 'mtnliberia',
  SZ: 'mtnswaziland',
});

const PRODUCTION_WORDS = new Set(['production', 'prod', 'live']);
const SANDBOX_WORDS    = new Set(['sandbox', 'sand', 'test', 'dev', '']);

const normalizeCountry = (cc) => String(cc || 'CG').trim().toUpperCase().slice(0, 2);
const normalizeWord    = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * @param {object} [opts]
 * @param {string} [opts.country='CG']           code pays ISO-2 (derive le X-Target-Environment de production)
 * @param {string} [opts.targetEnvironment]      valeur explicite (api_configurations.extra_params.targetEnvironment)
 * @param {string} [opts.baseUrl]                URL de base explicite (api_configurations.base_url)
 * @param {object} [opts.env=process.env]
 * @returns {{ mode:'sandbox'|'production', isSandbox:boolean, targetEnvironment:string, baseUrl:string, host:string, warnings:string[] }}
 */
function resolveMtnEnv(opts = {}) {
  const env     = opts.env || process.env;
  const country = normalizeCountry(opts.country);
  const warnings = [];

  // 1. Mode : MTN_<CC>_ENV (historique) > MTN_ENV > sandbox
  const rawMode = normalizeWord(env[`MTN_${country}_ENV`] || env.MTN_ENV);
  let mode;
  if (PRODUCTION_WORDS.has(rawMode)) mode = 'production';
  else if (SANDBOX_WORDS.has(rawMode)) mode = 'sandbox';
  else { mode = 'sandbox'; warnings.push(`MTN_ENV="${rawMode}" inconnu : sandbox applique`); }

  // 2. X-Target-Environment : explicite (config gateway, puis MTN_<CC>_TARGET_ENV), sinon derive du mode
  const explicitTarget = normalizeWord(opts.targetEnvironment || env[`MTN_${country}_TARGET_ENV`]);
  let targetEnvironment;
  if (explicitTarget) {
    targetEnvironment = explicitTarget;
    if (mode === 'production' && explicitTarget === 'sandbox') {
      warnings.push(`MTN_ENV=production mais X-Target-Environment=sandbox (MTN_${country}_TARGET_ENV) : incoherent`);
    }
    if (mode === 'sandbox' && explicitTarget !== 'sandbox') {
      warnings.push(`MTN_ENV=sandbox mais X-Target-Environment="${explicitTarget}" : incoherent`);
    }
  } else if (mode === 'production') {
    targetEnvironment = PRODUCTION_TARGETS[country];
    if (!targetEnvironment) {
      targetEnvironment = 'production';
      warnings.push(`aucun X-Target-Environment MTN connu pour ${country} : renseigner MTN_${country}_TARGET_ENV`);
    }
  } else {
    targetEnvironment = 'sandbox';
  }

  // 3. URL de base : explicite (config gateway, MTN_<CC>_BASE_URL, MTN_MOMO_BASE_URL), sinon derivee du mode
  let baseUrl = String(opts.baseUrl || env[`MTN_${country}_BASE_URL`] || env.MTN_MOMO_BASE_URL || '').trim();
  if (!baseUrl) baseUrl = mode === 'production' ? PRODUCTION_BASE_URL : SANDBOX_BASE_URL;
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = 'https://' + baseUrl;
  baseUrl = baseUrl.replace(/\/+$/, '');
  const looksSandbox = /sandbox/i.test(baseUrl);
  if (mode === 'production' && looksSandbox) warnings.push(`MTN_ENV=production mais URL de base sandbox (${baseUrl})`);
  if (mode === 'sandbox' && !looksSandbox && /momoapi\.mtn\.com|momoapi\.momo\.africa/i.test(baseUrl)) warnings.push(`MTN_ENV=sandbox mais URL de base de production (${baseUrl})`);
  if (mode === 'production' && new RegExp(LEGACY_PRODUCTION_HOST.replace(/\./g, '\\.'), 'i').test(baseUrl)) warnings.push(`URL de base ${LEGACY_PRODUCTION_HOST} obsolete depuis octobre 2026 : utiliser ${PRODUCTION_BASE_URL}`);

  const host = baseUrl.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  return { mode, isSandbox: mode === 'sandbox', targetEnvironment, baseUrl, host, country, warnings };
}

/** Journalise une fois les incoherences (au chargement d'un client MTN). */
function warnOnce(resolved, logger = console) {
  if (!resolved || !resolved.warnings || !resolved.warnings.length) return;
  for (const w of resolved.warnings) {
    try { (logger.warn || logger.error || console.warn).call(logger, `[MTN-ENV] ${w}`); } catch (_) { /* no-op */ }
  }
}

module.exports = { resolveMtnEnv, warnOnce, SANDBOX_BASE_URL, PRODUCTION_BASE_URL, LEGACY_PRODUCTION_HOST, PRODUCTION_TARGETS };
