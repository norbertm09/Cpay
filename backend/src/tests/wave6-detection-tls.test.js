'use strict';
/** WAVE-6 lot 2 — détection CF / GA / GQ / TD (planned) et configuration TLS PostgreSQL. */
process.env.NODE_ENV = 'test';
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() }));

const { detectFromPhone, normalizePhone, COUNTRIES, MOBILE_MONEY_OPERATORS, COUNTRY_PREFIXES } = require('../services/detection/detection.engine');

describe('détection — reste du périmètre CEMAC (vague 6)', () => {
  test('plans de numérotation : CF 8, GA 8, GQ 9, TD 8 (XAF, CEMAC, non vérifiés)', () => {
    expect(COUNTRIES.CF).toMatchObject({ callingCode: '236', currency: 'XAF', region: 'CEMAC', nsnLength: 8, verified: false });
    expect(COUNTRIES.GA).toMatchObject({ callingCode: '241', currency: 'XAF', region: 'CEMAC', nsnLength: 8, verified: false });
    expect(COUNTRIES.GQ).toMatchObject({ callingCode: '240', currency: 'XAF', region: 'CEMAC', nsnLength: 9, verified: false });
    expect(COUNTRIES.TD).toMatchObject({ callingCode: '235', currency: 'XAF', region: 'CEMAC', nsnLength: 8, verified: false });
    expect(COUNTRY_PREFIXES['+241']).toMatchObject({ country: 'GA', currency: 'XAF' });
  });
  test.each([
    ['+23672123456', 'CF', 'ORANGE_MONEY', 'orange_cf'],
    ['+23670123456', 'CF', 'TELECEL_MONEY', 'telecel_cf'],
    ['+24107123456', 'GA', 'AIRTEL_MONEY', 'airtel_ga'],
    ['+24106123456', 'GA', 'MOOV_MONEY', 'moov_ga'],
    ['+240222123456', 'GQ', 'GETESA_MONEY', 'getesa_gq'],
    ['+240551234567', 'GQ', 'MUNI_MONEY', 'muni_gq'],
    ['+23562123456', 'TD', 'AIRTEL_MONEY', 'airtel_td'],
    ['+23590123456', 'TD', 'MOOV_MONEY', 'moov_td'],
  ])('%s → %s %s (planned, non vérifié)', (phone, country, operator, gateway) => {
    const d = detectFromPhone(phone);
    expect(d).toMatchObject({ success: true, country, currency: 'XAF', region: 'CEMAC', operator, gateway, verified: false, planned: true });
  });
  test('la détection ne vaut pas disponibilité : le registre marque collect planned et refuse', () => {
    const registry = require('../services/capabilities/registry');
    for (const phone of ['+23672123456', '+24107123456', '+240222123456', '+23566123456']) {
      const d = detectFromPhone(phone);
      const r = registry.isAllowed({ country: d.country, operation: 'collect', method: 'mobile_money', operator: d.operator }, { env: {}, facts: {}, providers: { getProvider: () => null } });
      expect(r).toMatchObject({ allowed: false, status: 'planned' });
      expect(r.message).toMatch(/intégration en cours/);
    }
  });
  test('longueur invalide → PHONE_LENGTH ; préfixe inconnu → OPERATOR_UNKNOWN ; numéro local avec pays', () => {
    expect(detectFromPhone('+2367212345').code).toBe('PHONE_LENGTH');
    expect(detectFromPhone('+24107123456789').code).toBe('PHONE_LENGTH');
    expect(detectFromPhone('+23612345678').code).toBe('OPERATOR_UNKNOWN');
    expect(normalizePhone('07123456', 'GA')).toBe('+24107123456');
    expect(normalizePhone('72123456', 'CF')).toBe('+23672123456');
    expect(detectFromPhone('66123456', { defaultCountry: 'TD' }).operator).toBe('MOOV_MONEY');
  });
  test('aucun provider mobilemoney.router pour ces gateways (planned = pas de code)', () => {
    const mm = require('../services/mobilemoney/mobilemoney.router');
    for (const cc of ['CF', 'GA', 'GQ', 'TD']) for (const op of MOBILE_MONEY_OPERATORS[cc]) expect(mm.getProvider(op.gateway)).toBeNull();
  });
  test('les pays historiques et existants restent détectés (CM, CG, CD, SN, CI)', () => {
    expect(detectFromPhone('+237670000001')).toMatchObject({ success: true, country: 'CM', operator: 'MTN_MOMO' });
    expect(detectFromPhone('+242061234567')).toMatchObject({ success: true, country: 'CG' });
    expect(detectFromPhone('+243811234567')).toMatchObject({ success: true, country: 'CD', currency: 'CDF' });
    expect(detectFromPhone('+221771234567')).toMatchObject({ success: true, country: 'SN' });
    expect(detectFromPhone('+2250701234567')).toMatchObject({ success: true, country: 'CI' });
  });
});

describe('TLS PostgreSQL — config/database.buildSslConfig', () => {
  jest.mock('pg', () => ({ Pool: class { on() {} query() {} connect() {} end() {} } }));
  const { buildSslConfig } = require('../config/database');
  const PEM = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
  test('DB_SSL absent / faux → pas de TLS', () => {
    expect(buildSslConfig({})).toEqual({ ssl: false, mode: 'off' });
    expect(buildSslConfig({ DB_SSL: 'false' }).ssl).toBe(false);
  });
  test('DB_SSL=true seul → certificat vérifié via le magasin système', () => {
    expect(buildSslConfig({ DB_SSL: 'true' })).toEqual({ ssl: { rejectUnauthorized: true }, mode: 'verify-system' });
  });
  test('DB_SSL_CA (PEM, \\n échappés acceptés) → vérifié avec cette CA', () => {
    const r = buildSslConfig({ DB_SSL: 'true', DB_SSL_CA: PEM.replace(/\n/g, '\\n') });
    expect(r.mode).toBe('verify-ca'); expect(r.ssl.rejectUnauthorized).toBe(true); expect(r.ssl.ca).toBe(PEM);
  });
  test('DB_SSL_CA_FILE → lu sur disque ; fichier absent → magasin système', () => {
    const fs = require('fs'); const os = require('os'); const path = require('path');
    const f = path.join(os.tmpdir(), `cpay-ca-${process.pid}.pem`); fs.writeFileSync(f, PEM);
    try {
      const r = buildSslConfig({ DB_SSL: 'true', DB_SSL_CA_FILE: f, DB_SSL_SERVERNAME: 'db.example' });
      expect(r).toEqual({ ssl: { rejectUnauthorized: true, ca: PEM, servername: 'db.example' }, mode: 'verify-ca' });
    } finally { fs.unlinkSync(f); }
    expect(buildSslConfig({ DB_SSL: 'true', DB_SSL_CA_FILE: '/nope/ca.pem' }).mode).toBe('verify-system');
  });
  test('CA non PEM ignorée', () => {
    expect(buildSslConfig({ DB_SSL: 'true', DB_SSL_CA: 'garbage' })).toEqual({ ssl: { rejectUnauthorized: true }, mode: 'verify-system' });
  });
  test('DB_SSL_REJECT_UNAUTHORIZED=false → ancien mode non sûr, avec avertissement', () => {
    const logger = require('../config/logger');
    logger.warn.mockClear();
    const r = buildSslConfig({ DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: 'false' });
    expect(r).toEqual({ ssl: { rejectUnauthorized: false }, mode: 'insecure' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/NON vérifié/));
    expect(buildSslConfig({ DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: 'true' }).ssl.rejectUnauthorized).toBe(true);
  });
  test('validateEnv signale le mode non sûr', () => {
    const saved = { ...process.env };
    process.env.DB_SSL = 'true'; process.env.DB_SSL_REJECT_UNAUTHORIZED = 'false';
    const { validateEnv } = require('../config/env');
    const rep = validateEnv({ strict: false });
    expect(rep.warnings.some((w) => w.provider === 'postgresTls' && /non vérifié/.test(w.missing[0]))).toBe(true);
    process.env = saved;
  });
});
