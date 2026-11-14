/**
 * Go-live Congo-Brazzaville — scripts/check-go-live-cg.js : environnement complet → prêt ; environnement incomplet →
 * KO ciblés (jeton MTN, URL de callback, secret Airtel, TLS, enforce) ; assistant activé / désactivé.
 */
'use strict';

jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { runChecks } = require('../../scripts/check-go-live-cg');

const FULL = {
  API_BASE_URL: 'https://api.c-pay.global',
  MTN_ENV: 'production',
  MTN_CG_COLL_API_USER: 'u', MTN_CG_COLL_API_KEY: 'k', MTN_CG_COLL_SUB_KEY_PRIMARY: 's',
  MTN_CG_DISB_API_USER: 'u', MTN_CG_DISB_API_KEY: 'k', MTN_CG_DISB_SUB_KEY_PRIMARY: 's',
  MTN_WEBHOOK_TOKEN: 'tok', MTN_CG_CALLBACK_URL: 'https://api.c-pay.global/api/v1/webhooks/mtn?token=tok',
  AIRTEL_CG_ENV: 'production', AIRTEL_CG_BASE_URL: 'https://openapi.airtel.africa',
  AIRTEL_CG_COLL_CLIENT_ID: 'id', AIRTEL_CG_COLL_CLIENT_SECRET: 'sec', AIRTEL_CG_DISB_CLIENT_ID: 'id', AIRTEL_CG_DISB_CLIENT_SECRET: 'sec',
  AIRTEL_WEBHOOK_SECRET: 'ws', WEBHOOK_PATH_SECRET: 'segment',
  CAPABILITY_ENFORCE: 'enforce', CAPABILITY_FUNDING_XAF: 'true',
  DB_SSL: 'true', ANTHROPIC_API_KEY: 'sk-ant-xxxx',
};
const byKey = (r, k) => r.checks.filter((c) => c.key === k);
const level = (r, k) => byKey(r, k).map((c) => c.level);

test('environnement complet : prêt, encaissement et retrait MTN / Airtel actifs, assistant activé', () => {
  const r = runChecks(FULL, { facts: null });
  expect(r.ready).toBe(true);
  expect(r.ko).toBe(0);
  for (const k of ['cap_collect_mtn_momo', 'cap_withdraw_mtn_momo', 'cap_collect_airtel_money', 'mtn_callback', 'db_tls', 'cap_enforce', 'assistant']) {
    expect(level(r, k)).toEqual(['ok']);
  }
  expect(byKey(r, 'assistant')[0].detail).toMatch(/activé — modèle claude-opus-5-5/);
  // jamais de secret dans la sortie
  const text = JSON.stringify(r);
  expect(text).not.toMatch(/sk-ant-xxxx|"tok"|segment"|\bsec\b/);
  expect(byKey(r, 'mtn_callback')[0].detail).toMatch(/\?token=…/);
});

test('environnement de la 2.7.1 (sandbox, TLS non vérifié, pas de jeton) : KO ciblés et sections indiquées', () => {
  const r = runChecks({ ...FULL, MTN_ENV: 'sandbox', MTN_WEBHOOK_TOKEN: '', DB_SSL_REJECT_UNAUTHORIZED: 'false', AIRTEL_WEBHOOK_SECRET: '', CAPABILITY_ENFORCE: 'off', ANTHROPIC_API_KEY: '' }, { facts: null });
  expect(r.ready).toBe(false);
  expect(level(r, 'mtn_env')).toEqual(['warn']);
  expect(level(r, 'mtn_token')).toEqual(['ko']);
  expect(level(r, 'airtel_webhook')).toEqual(['ko']);
  expect(level(r, 'db_tls')).toEqual(['ko']);
  expect(level(r, 'cap_enforce')).toEqual(['ko']);
  expect(level(r, 'assistant')).toEqual(['warn']);
  expect(byKey(r, 'db_tls')[0].ref).toBe('LOT-0 § 4');
});

test('URL de callback MTN : jeton différent, mauvais chemin, mauvais hôte → KO détaillé', () => {
  const r1 = runChecks({ ...FULL, MTN_CG_CALLBACK_URL: 'https://api.c-pay.global/api/v1/webhooks/mtn?token=autre' }, { facts: null });
  expect(level(r1, 'mtn_callback')).toEqual(['ko']);
  expect(byKey(r1, 'mtn_callback')[0].detail).toMatch(/token=/);
  const r2 = runChecks({ ...FULL, MTN_CG_CALLBACK_URL: 'https://api.c-pay.global/webhooks/mtn?token=tok' }, { facts: null });
  expect(byKey(r2, 'mtn_callback')[0].detail).toMatch(/chemin/);
  const r3 = runChecks({ ...FULL, MTN_CG_CALLBACK_URL: 'https://autre.example/api/v1/momo/webhooks/mtn?token=tok' }, { facts: null });
  expect(byKey(r3, 'mtn_callback')[0].detail).toMatch(/hôte/);
  const r4 = runChecks({ ...FULL, MTN_CG_CALLBACK_URL: 'https://api.c-pay.global/api/v1/momo/webhooks/mtn?token=tok' }, { facts: null });
  expect(level(r4, 'mtn_callback')).toEqual(['ok']);
});

test('identifiants manquants : encaissement MTN « planned/unavailable », rotation en cours signalée', () => {
  const r = runChecks({ ...FULL, MTN_CG_COLL_API_USER: '', MTN_CG_COLL_API_KEY: '', MTN_CG_COLL_SUB_KEY_PRIMARY: '', WEBHOOK_PATH_SECRET_PREVIOUS: 'old', MTN_WEBHOOK_TOKEN_PREVIOUS: 'old' }, { facts: null });
  expect(level(r, 'mtn_coll')).toEqual(['ko']);
  expect(level(r, 'cap_collect_mtn_momo')).toEqual(['ko']);
  expect(level(r, 'webhook_secret_previous')).toEqual(['warn']);
  expect(level(r, 'mtn_token_previous')).toEqual(['warn']);
});

test('pilote : CAPABILITY_PILOT_CG=true et report → statuts pilot acceptés, enforce en avertissement', () => {
  const r = runChecks({ ...FULL, CAPABILITY_PILOT_CG: 'true', CAPABILITY_ENFORCE: 'report' }, { facts: null });
  expect(level(r, 'cap_collect_mtn_momo')).toEqual(['ok']);
  expect(byKey(r, 'cap_collect_mtn_momo')[0].detail).toMatch(/pilot|active/);
  expect(level(r, 'cap_enforce')).toEqual(['warn']);
  expect(r.ready).toBe(true);
});
