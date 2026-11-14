#!/usr/bin/env node
'use strict';
/**
 * Go / no-go du lancement Congo-Brazzaville (docs/GO-LIVE-CG.md) et de l'assistant virtuel (docs/ASSISTANT-API.md).
 *
 * Lit la configuration effective (process.env, donc backend/.env dans l'image API) et le registre de capacités, puis
 * imprime un tableau OK / KO / AVERT / INFO avec la section de la procédure à consulter. Ne touche pas aux opérateurs,
 * n'écrit rien, n'affiche aucun secret.
 *
 *   node scripts/check-go-live-cg.js            # tableau ; code de sortie 1 s'il reste un KO
 *   node scripts/check-go-live-cg.js --json     # résultat structuré
 *   node scripts/check-go-live-cg.js --no-db    # sans lecture de la base (faits du registre non chargés)
 *
 * Depuis l'hôte de production : scripts/check-go-live-cg.sh (lance ce script dans l'image API, comme deploy.sh).
 */
const fs = require('fs');

const LEVEL = { OK: 'ok', KO: 'ko', WARN: 'warn', INFO: 'info' };
const has = (env, n) => !!(env[n] && String(env[n]).trim() && !/^(change_me|REQUIRED|\.\.\.)/i.test(String(env[n]).trim()));
const low = (v) => String(v == null ? '' : v).trim().toLowerCase();
const isTrue = (v) => ['true', '1', 'yes', 'on'].includes(low(v));

/**
 * @param {object} [env=process.env]
 * @param {object} [opts]  { facts, providers } transmis au registre ; facts=null -> registre sans base
 * @returns {{ checks: Array<{key,level,label,detail,ref}>, ko: number, warn: number, ready: boolean }}
 */
function runChecks(env = process.env, opts = {}) {
  const checks = [];
  const add = (key, level, label, detail, ref) => checks.push({ key, level, label, detail, ref });
  const ok = (k, l, d, r) => add(k, LEVEL.OK, l, d, r);
  const ko = (k, l, d, r) => add(k, LEVEL.KO, l, d, r);
  const warn = (k, l, d, r) => add(k, LEVEL.WARN, l, d, r);
  const info = (k, l, d, r) => add(k, LEVEL.INFO, l, d, r);

  // ── 1. MTN MoMo Congo ──
  const { resolveMtnEnv } = require('../src/config/mtn-env');
  const mtn = resolveMtnEnv({ country: 'CG', env });
  if (mtn.mode === 'production') ok('mtn_env', 'MTN_ENV', `production (X-Target-Environment ${mtn.targetEnvironment}, ${mtn.baseUrl})`, '§ 3.3');
  else warn('mtn_env', 'MTN_ENV', `${mtn.mode} : encaissement et retrait MTN en bac à sable — passer à production après les tests § 3.2`, '§ 3.3');
  for (const w of mtn.warnings || []) ko('mtn_env_warning', 'MTN environnement', w, '§ 3.3');
  const coll = ['MTN_CG_COLL_API_USER', 'MTN_CG_COLL_API_KEY', 'MTN_CG_COLL_SUB_KEY_PRIMARY'];
  const disb = ['MTN_CG_DISB_API_USER', 'MTN_CG_DISB_API_KEY', 'MTN_CG_DISB_SUB_KEY_PRIMARY'];
  const missColl = coll.filter((n) => !has(env, n)); const missDisb = disb.filter((n) => !has(env, n));
  if (!missColl.length) ok('mtn_coll', 'MTN collection (encaissement)', 'API user, API key et clé d’abonnement renseignés', '§ 1.4');
  else ko('mtn_coll', 'MTN collection (encaissement)', `manquant : ${missColl.join(', ')}`, '§ 1.4');
  if (!missDisb.length) ok('mtn_disb', 'MTN disbursement (retrait)', 'API user, API key et clé d’abonnement renseignés', '§ 1.4');
  else ko('mtn_disb', 'MTN disbursement (retrait)', `manquant : ${missDisb.join(', ')}`, '§ 1.4');
  if (has(env, 'MTN_WEBHOOK_TOKEN')) {
    ok('mtn_token', 'MTN_WEBHOOK_TOKEN', 'renseigné (callback fail-closed sans lui)', '§ 1.4');
    const cb = String(env.MTN_CG_CALLBACK_URL || '');
    let u = null; try { u = new URL(cb); } catch { u = null; }
    const api = (() => { try { return new URL(String(env.API_BASE_URL || '')); } catch { return null; } })();
    if (!u) ko('mtn_callback', 'MTN_CG_CALLBACK_URL', cb ? 'URL invalide' : 'absente (le client rails utiliserait l’URL par défaut sans jeton)', '§ 1.4');
    else {
      const pathOk = /^\/api\/v1\/(momo\/)?webhooks\/mtn$/.test(u.pathname);
      const tokenOk = u.searchParams.get('token') === env.MTN_WEBHOOK_TOKEN;
      const hostOk = !api || u.host === api.host;
      if (pathOk && tokenOk && hostOk && u.protocol === 'https:') ok('mtn_callback', 'MTN_CG_CALLBACK_URL', `${u.origin}${u.pathname}?token=… (jeton identique à MTN_WEBHOOK_TOKEN)`, '§ 1.4');
      else ko('mtn_callback', 'MTN_CG_CALLBACK_URL', [
        !pathOk && `chemin ${u.pathname} attendu /api/v1/webhooks/mtn ou /api/v1/momo/webhooks/mtn`,
        !tokenOk && 'paramètre ?token= différent de MTN_WEBHOOK_TOKEN (scripts/rotate-secrets.sh mtn-token les resynchronise)',
        !hostOk && `hôte ${u.host} différent de API_BASE_URL`,
        u.protocol !== 'https:' && 'https obligatoire',
      ].filter(Boolean).join(' ; '), '§ 1.4');
    }
  } else ko('mtn_token', 'MTN_WEBHOOK_TOKEN', 'absent : les callbacks MTN sont refusés (503) et seule la réconciliation finalise', '§ 1.4');
  if (has(env, 'MTN_WEBHOOK_TOKEN_PREVIOUS')) warn('mtn_token_previous', 'MTN_WEBHOOK_TOKEN_PREVIOUS', 'ancien jeton encore accepté : rotate-secrets.sh mtn-token --clear-previous une fois les paiements antérieurs terminés', 'LOT-0 § 3');
  if (isTrue(env.MTN_TLS_INSECURE)) ko('mtn_tls', 'MTN_TLS_INSECURE', 'true : certificat MTN non vérifié — interdit en production', '§ 1.4');
  else ok('mtn_tls', 'MTN_TLS_INSECURE', 'non positionné / false', '§ 1.4');

  // ── 2. Airtel Money Congo ──
  const aEnv = low(env.AIRTEL_CG_ENV || 'sandbox');
  const aBase = String(env.AIRTEL_CG_BASE_URL || 'https://openapi.airtel.africa');
  if (aEnv === 'production' && /^https:\/\/openapi\.airtel\.africa\/?$/.test(aBase)) ok('airtel_env', 'AIRTEL_CG_ENV', `production (${aBase})`, '§ 3.3');
  else if (aEnv === 'production') ko('airtel_env', 'AIRTEL_CG_ENV', `production mais AIRTEL_CG_BASE_URL=${aBase} (attendu https://openapi.airtel.africa)`, '§ 3.3');
  else if (/openapiuat/.test(aBase) || aEnv !== 'production') warn('airtel_env', 'AIRTEL_CG_ENV', `${aEnv} (${aBase}) : passer à production après les tests § 3.2`, '§ 3.3');
  const aColl = ['AIRTEL_CG_COLL_CLIENT_ID', 'AIRTEL_CG_COLL_CLIENT_SECRET'].filter((n) => !has(env, n));
  const aDisb = ['AIRTEL_CG_DISB_CLIENT_ID', 'AIRTEL_CG_DISB_CLIENT_SECRET'].filter((n) => !has(env, n));
  if (!aColl.length) ok('airtel_coll', 'Airtel collection (encaissement)', 'client id / secret renseignés (lus aussi par le provider airtel_cg)', '§ 1.4');
  else ko('airtel_coll', 'Airtel collection (encaissement)', `manquant : ${aColl.join(', ')}`, '§ 1.4');
  if (!aDisb.length) ok('airtel_disb', 'Airtel disbursement (retrait)', 'client id / secret renseignés', '§ 1.4');
  else warn('airtel_disb', 'Airtel disbursement (retrait)', `manquant : ${aDisb.join(', ')} (retrait Airtel indisponible)`, '§ 1.4');
  if (has(env, 'AIRTEL_WEBHOOK_SECRET') || has(env, 'AIRTEL_CG_WEBHOOK_SECRET')) ok('airtel_webhook', 'AIRTEL_WEBHOOK_SECRET', 'renseigné (callbacks Airtel signés)', '§ 1.4');
  else ko('airtel_webhook', 'AIRTEL_WEBHOOK_SECRET', 'absent : les callbacks Airtel sont refusés (fail-closed)', '§ 1.4');
  info('airtel_prefix_04', 'Plan de numérotation Airtel', 'préfixe 04 (ex-Azur) toujours « à confirmer » par Airtel (docs/OPERATEURS-A-CONFIRMER.md § 1 ligne 1) : confirmation écrite puis verified:true dans detection.engine.js', '§ 3.1');

  // ── 3. Webhooks (chemin secret, allowlist) ──
  if (has(env, 'WEBHOOK_PATH_SECRET')) ok('webhook_secret', 'WEBHOOK_PATH_SECRET', 'renseigné', 'LOT-0 § 3');
  else ko('webhook_secret', 'WEBHOOK_PATH_SECRET', 'absent : webhooks secrets refusés', 'LOT-0 § 3');
  if (has(env, 'WEBHOOK_PATH_SECRET_PREVIOUS')) warn('webhook_secret_previous', 'WEBHOOK_PATH_SECRET_PREVIOUS', 'ancien segment encore accepté : --clear-previous après déclaration des nouvelles URL', 'LOT-0 § 3');
  info('webhook_allowlist', 'Allowlist nginx des callbacks', 'snippets/cpay-webhook-allowlist.conf : passer « default 1 » dès réception des plages MTN et Airtel (vérifier sur l’hôte : grep default /etc/nginx/snippets/cpay-webhook-allowlist.conf)', '§ 3.1');

  // ── 4. Registre de capacités ──
  let caps = null;
  try {
    const registry = require('../src/services/capabilities/registry');
    caps = registry.getCapabilities({ env, ...(opts.facts !== undefined ? { facts: opts.facts } : {}), ...(opts.providers !== undefined ? { providers: opts.providers } : {}) });
  } catch (e) { ko('capabilities', 'Registre de capacités', `erreur : ${e.message}`, '§ 1.4'); }
  if (caps) {
    const cg = caps.countries.CG;
    const want = { MTN_MOMO: 'MTN MoMo', AIRTEL_MONEY: 'Airtel Money' };
    for (const op of ['collect', 'withdraw']) {
      for (const [code, brand] of Object.entries(want)) {
        const cell = (cg.operations[op].mobile_money.operators || []).find((o) => o.operator === code);
        const st = cell ? cell.status : 'absent';
        const label = `${op === 'collect' ? 'Encaissement' : 'Retrait'} ${brand} (CG)`;
        if (st === 'active') ok(`cap_${op}_${code.toLowerCase()}`, label, 'active', '§ 1.4');
        else if (st === 'pilot') ok(`cap_${op}_${code.toLowerCase()}`, label, 'pilot (CAPABILITY_PILOT_CG=true : ouverture restreinte)', '§ 3.4');
        else ko(`cap_${op}_${code.toLowerCase()}`, label, `${st}${cell && cell.requires ? ` — requis : ${cell.requires.join(', ')}` : ''}`, '§ 1.4');
      }
    }
    const b2w = cg.operations.transfer.bank_to_wallet;
    if (['active', 'pilot'].includes(b2w.status)) ok('cap_funding_xaf', 'Approvisionnement banque → wallet (XAF)', b2w.status, '§ 5');
    else warn('cap_funding_xaf', 'Approvisionnement banque → wallet (XAF)', `${b2w.status} : aucun compte de collecte C-Pay actif en XAF (platform_bank_accounts) ou CAPABILITY_FUNDING_XAF=true`, '§ 5');
    info('cap_facts', 'Faits du registre', `source ${caps.facts.source}${caps.facts.loadedAt ? ` (${caps.facts.loadedAt})` : ''}`, '');
  }
  const enforce = low(env.CAPABILITY_ENFORCE || 'enforce');
  if (enforce === 'enforce') ok('cap_enforce', 'CAPABILITY_ENFORCE', 'enforce (gardes actives)', '§ 3.4');
  else if (enforce === 'report') warn('cap_enforce', 'CAPABILITY_ENFORCE', 'report : gardes en observation seule — passer à enforce après 48 h de pilote', '§ 3.4');
  else ko('cap_enforce', 'CAPABILITY_ENFORCE', `${enforce} : gardes désactivées`, '§ 3.4');
  if (isTrue(env.CAPABILITY_PILOT_CG)) info('cap_pilot', 'CAPABILITY_PILOT_CG', 'true : pays en pilote (ouverture restreinte)', '§ 3.4');
  else info('cap_pilot', 'CAPABILITY_PILOT_CG', 'non positionné : ouverture normale', '§ 3.4');

  // ── 5. Hygiène TLS / base ──
  if (isTrue(env.DB_SSL) && low(env.DB_SSL_REJECT_UNAUTHORIZED) !== 'false') {
    if (env.DB_SSL_CA_FILE) {
      let readable = false; try { readable = /-----BEGIN CERTIFICATE-----/.test(fs.readFileSync(env.DB_SSL_CA_FILE, 'utf8')); } catch { readable = false; }
      if (readable) ok('db_tls', 'TLS PostgreSQL', `vérifié avec la CA ${env.DB_SSL_CA_FILE}`, 'LOT-0 § 4');
      else ko('db_tls', 'TLS PostgreSQL', `DB_SSL_CA_FILE=${env.DB_SSL_CA_FILE} illisible ou sans certificat PEM`, 'LOT-0 § 4');
    } else ok('db_tls', 'TLS PostgreSQL', 'vérifié avec le magasin système (déposer la CA OVH pour un contrôle strict)', 'LOT-0 § 4');
  } else if (isTrue(env.DB_SSL)) ko('db_tls', 'TLS PostgreSQL', 'DB_SSL_REJECT_UNAUTHORIZED=false : certificat serveur non vérifié', 'LOT-0 § 4');
  else ko('db_tls', 'TLS PostgreSQL', 'DB_SSL absent ou false', 'LOT-0 § 4');
  if (String(env.NODE_TLS_REJECT_UNAUTHORIZED || '') === '0') ko('node_tls', 'NODE_TLS_REJECT_UNAUTHORIZED', '0 : toute vérification TLS désactivée — à supprimer', '§ 1.4');
  else ok('node_tls', 'NODE_TLS_REJECT_UNAUTHORIZED', 'non positionné', '§ 1.4');

  // ── 6. Assistant virtuel ──
  if (has(env, 'ANTHROPIC_API_KEY')) {
    const k = String(env.ANTHROPIC_API_KEY);
    if (/^sk-ant-/.test(k)) ok('assistant', 'Assistant virtuel (vitrine)', `activé — modèle ${env.ASSISTANT_MODEL || 'claude-opus-5-5'}, repli serveur ${low(env.ASSISTANT_FALLBACKS || 'default') === 'off' ? 'désactivé' : 'activé'}`, 'ASSISTANT-API § 5');
    else warn('assistant', 'Assistant virtuel (vitrine)', 'ANTHROPIC_API_KEY présente mais ne ressemble pas à une clé API (sk-ant-…)', 'ASSISTANT-API § 5');
  } else warn('assistant', 'Assistant virtuel (vitrine)', 'désactivé (503 ASSISTANT_DISABLED) : renseigner ANTHROPIC_API_KEY', 'ASSISTANT-API § 5');

  const koN = checks.filter((c) => c.level === LEVEL.KO).length;
  const warnN = checks.filter((c) => c.level === LEVEL.WARN).length;
  return { checks, ko: koN, warn: warnN, ready: koN === 0 };
}

const TAG = { ok: 'OK   ', ko: 'KO   ', warn: 'AVERT', info: 'INFO ' };
const render = (r) => {
  const lines = ['Go-live Congo-Brazzaville — contrôle de préparation (docs/GO-LIVE-CG.md)', ''];
  for (const c of r.checks) lines.push(`${TAG[c.level]} ${c.label.padEnd(44)} ${c.detail}${c.ref ? `  [${c.ref}]` : ''}`);
  lines.push('', r.ready ? `Prêt : aucun KO (${r.warn} avertissement(s)).` : `${r.ko} KO, ${r.warn} avertissement(s) — voir les sections indiquées.`);
  return lines.join('\n');
};

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  (async () => {
    const args = process.argv.slice(2);
    let facts;
    if (args.includes('--no-db')) facts = null;
    else {
      try {
        const registry = require('../src/services/capabilities/registry');
        facts = await Promise.race([registry.loadFacts({ force: true }), new Promise((res) => setTimeout(() => res(null), 8000))]);
      } catch { facts = null; }
    }
    const r = runChecks(process.env, { facts: facts || undefined });
    if (args.includes('--json')) console.log(JSON.stringify(r, null, 2)); else console.log(render(r));
    try { const { pool } = require('../src/config/database'); await pool.end(); } catch { /* sans base */ }
    process.exit(r.ready || args.includes('--no-fail') ? 0 : 1);
  })();
}

module.exports = { runChecks, render, LEVEL };
