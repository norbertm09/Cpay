'use strict';
// Refonte Expo (2026-11-13) : tests des modules purs avec le lanceur integre de Node (`node --test`), sans React Native.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core');

test('money, compact, fmtDate, parseAmount', () => {
  assert.equal(core.money(12500, 'XAF').replace(/ | /g, ' '), '12 500 XAF');
  assert.equal(core.money(null), '0');
  assert.equal(core.compact('  a   b \n c '), 'a b c');
  assert.equal(core.fmtDate('2026-11-13T07:05:00.000Z'), '2026-11-13 07:05');
  assert.equal(core.fmtDate(null), '');
  assert.equal(core.parseAmount('12 500,50'), 12500.5);
  assert.ok(Number.isNaN(core.parseAmount('abc')));
});

test('cle d’idempotence : 8 a 128 caracteres, unique a chaque intention', () => {
  const keys = new Set(Array.from({ length: 200 }, () => core.newIdempotencyKey()));
  assert.equal(keys.size, 200);
  for (const k of keys) assert.ok(k.length >= 8 && k.length <= 128, k);
});

test('erreurs : 410 FEATURE_DISABLED masque en « en cours d’intégration », 404 reste une erreur', () => {
  const disabled = new core.ApiError('x', { status: 410, code: 'FEATURE_DISABLED' });
  assert.equal(core.isFeatureUnavailable(disabled), true);
  assert.equal(core.userMessage(disabled), core.FEATURE_PENDING);
  assert.equal(core.isFeatureUnavailable(new core.ApiError('Introuvable', { status: 404 })), false);
  assert.equal(core.userMessage(new core.ApiError('Introuvable', { status: 404 })), 'Introuvable');
  assert.equal(core.userMessage(null), 'Erreur inattendue');
  assert.equal(new core.AuthError().message, 'Session expirée, veuillez vous reconnecter');
});

test('operateurs : libelle, code deduit d’une detection, statuts de transfert', () => {
  assert.equal(core.operatorLabel('mtn_momo'), 'MTN MoMo');
  assert.equal(core.operatorLabel('MTN'), 'MTN MoMo');
  assert.equal(core.operatorLabel(''), 'Mobile Money');
  assert.equal(core.operatorLabel('inconnu_x'), 'inconnu x');
  assert.equal(core.operatorCodeFor({ operator: 'ORANGE' }), 'orange_money');
  assert.equal(core.operatorCodeFor({ brand: 'M-Pesa' }), 'mpesa');
  assert.equal(core.operatorCodeFor({ operator: 'ZZZ' }), null);
  assert.equal(core.transferStatusLabel('sending'), 'Envoi en cours');
  assert.equal(core.transferStatusLabel('unknown'), 'Résultat incertain');
  assert.equal(core.transferStatusLabel(undefined), '—');
  for (const st of ['pending', 'sending', 'processing', 'unknown']) assert.equal(core.isUncertainStatus(st), true, st);
  assert.equal(core.isUncertainStatus('completed'), false);
});
