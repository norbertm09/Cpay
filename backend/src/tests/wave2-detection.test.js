/**
 * Tests du Detection Engine — le cœur de l'automatisation C-Pay 2.6.0
 * WAVE-2 : plans de numérotation corrigés (SN 9, CI 10, CM 9, CG 9, CD 9),
 * alternatives Wave / Express Union, plage Mastercard 2-series, AID EMV corrigés.
 */
'use strict';

const {
  detectFromPhone, detectFromCard, detectFromAid, getBestRoute, normalizePhone,
  COUNTRY_PREFIXES, COUNTRIES, MOBILE_MONEY_OPERATORS, CARD_NETWORKS,
} = require('../services/detection/detection.engine');

// ─── Normalisation ────────────────────────────────────────────────

describe('normalizePhone', () => {
  test('E.164 déjà normalisé',           () => expect(normalizePhone('+237699000001')).toBe('+237699000001'));
  test('avec espaces',                   () => expect(normalizePhone('+237 699 000 001')).toBe('+237699000001'));
  test('avec tirets',                    () => expect(normalizePhone('+237-699-000-001')).toBe('+237699000001'));
  test('format 00XXXX',                  () => expect(normalizePhone('00237699000001')).toBe('+237699000001'));
  test('indicatif sans +',               () => expect(normalizePhone('237699000001')).toBe('+237699000001'));
  test('local sans pays → null (historique prod)', () => expect(normalizePhone('0699000001')).toBeNull());
  test('local avec pays CM (0 initial)', () => expect(normalizePhone('0699000001', 'CM')).toBe('+237699000001'));
  test('local avec pays CM (sans 0)',    () => expect(normalizePhone('699000001', 'CM')).toBe('+237699000001'));
  test('local Congo avec pays CG (merchant.routes)', () => {
    expect(normalizePhone('061234567', 'CG')).toBe('+242061234567');
    expect(normalizePhone('06 123 45 67', 'cg')).toBe('+242061234567');
  });
  test('CI local 10 chiffres garde le 0',() => expect(normalizePhone('0701020304', 'CI')).toBe('+2250701020304'));
  test('CI ancien 8 chiffres migré',     () => expect(normalizePhone('+22507123456')).toBe('+2250707123456'));
  test('CI ancien MTN 05 migré',         () => expect(normalizePhone('+22505123456')).toBe('+2250505123456'));
  test('caractères invalides → null',    () => expect(normalizePhone('+237abc')).toBeNull());
  test('non-string → null',              () => { expect(normalizePhone(null)).toBeNull(); expect(normalizePhone(undefined)).toBeNull(); });
});

// ─── Détection Mobile Money ────────────────────────────────────────

describe('detectFromPhone — Cameroun (CM, XAF)', () => {
  test('MTN 67',          () => expect(detectFromPhone('+237670000001')).toMatchObject({ success: true, country: 'CM', currency: 'XAF', operator: 'MTN_MOMO', gateway: 'mtn_cm' }));
  test('MTN 650',         () => expect(detectFromPhone('+237650000001').gateway).toBe('mtn_cm'));
  test('Orange 69 (et non MTN — bug historique)', () => expect(detectFromPhone('+237699000001')).toMatchObject({ operator: 'ORANGE_MONEY', gateway: 'orange_cm' }));
  test('Orange 655',      () => expect(detectFromPhone('+237655000001').gateway).toBe('orange_cm'));
  test('Nexttel 66 → pas de wallet, alternative Express Union', () => {
    const r = detectFromPhone('+237660000001');
    expect(r.success).toBe(false); expect(r.code).toBe('OPERATOR_NO_WALLET');
    expect(r.alternatives.map(a => a.operator)).toContain('EXPRESS_UNION');
  });
  test('8 chiffres → longueur invalide', () => expect(detectFromPhone('+23769900000').code).toBe('PHONE_LENGTH'));
  test('numéro trop court',               () => expect(detectFromPhone('+237123').success).toBe(false));
  test('override Express Union',          () => expect(detectFromPhone('+237660000001', { operatorOverride: 'express_union' }).gateway).toBe('express_union_cm'));
});

describe('detectFromPhone — Sénégal (SN, XOF)', () => {
  test('Orange 77',   () => expect(detectFromPhone('+221771234567')).toMatchObject({ success: true, country: 'SN', currency: 'XOF', region: 'BCEAO', gateway: 'orange_sn' }));
  test('Orange 78',   () => expect(detectFromPhone('+221781234567').gateway).toBe('orange_sn'));
  test('Free 76',     () => expect(detectFromPhone('+221761234567')).toMatchObject({ success: true, operator: 'FREE_MONEY', gateway: 'free_money_sn' }));
  test('Expresso 70 → pas de wallet', () => expect(detectFromPhone('+221701234567').code).toBe('OPERATOR_NO_WALLET'));
  test('Wave par override sur un numéro Orange', () => expect(detectFromPhone('+221771234567', { operatorOverride: 'WAVE' })).toMatchObject({ success: true, gateway: 'wave_sn', overridden: true }));
  test('override inconnu → OPERATOR_UNAVAILABLE', () => expect(detectFromPhone('+221771234567', { operatorOverride: 'MPESA' }).code).toBe('OPERATOR_UNAVAILABLE'));
});

describe("detectFromPhone — Côte d'Ivoire (CI, XOF, 10 chiffres)", () => {
  test('Orange 07', () => expect(detectFromPhone('+2250701020304')).toMatchObject({ success: true, country: 'CI', currency: 'XOF', gateway: 'orange_ci' }));
  test('MTN 05',    () => expect(detectFromPhone('+2250501020304')).toMatchObject({ operator: 'MTN_MOMO', gateway: 'mtn_ci' }));
  test('Moov 01 (inatteignable dans l’ancien moteur)', () => expect(detectFromPhone('+2250101020304').gateway).toBe('moov_ci'));
  test('11 chiffres → rejeté (ancien test encodait le bug)', () => expect(detectFromPhone('+22507123456789').code).toBe('PHONE_LENGTH'));
  test('local avec pays marchand', () => expect(detectFromPhone('05 01 02 03 04', { defaultCountry: 'CI' }).gateway).toBe('mtn_ci'));
  test('Wave CI alternative', () => expect(detectFromPhone('+2250701020304').alternatives[0].gateway).toBe('wave_ci'));
});

describe('detectFromPhone — Congo Brazzaville (CG, XAF)', () => {
  test('MTN 06',    () => expect(detectFromPhone('+242061234567')).toMatchObject({ success: true, country: 'CG', currency: 'XAF', operator: 'MTN_MOMO', gateway: 'mtn_cg' }));
  test('Airtel 05', () => expect(detectFromPhone('+242051234567')).toMatchObject({ operator: 'AIRTEL_MONEY', gateway: 'airtel_cg' }));
  test('local Congo via defaultCountry', () => expect(detectFromPhone('061234567', { defaultCountry: 'CG' })).toMatchObject({ success: true, phone: '+242061234567', gateway: 'mtn_cg' }));
  test('8 chiffres → PHONE_LENGTH (plus de routage par défaut vers MTN)', () => expect(detectFromPhone('+24206123456').code).toBe('PHONE_LENGTH'));
});

describe('detectFromPhone — RDC (CD, CDF)', () => {
  test('Vodacom 81',  () => expect(detectFromPhone('+243811234567')).toMatchObject({ success: true, country: 'CD', currency: 'CDF', operator: 'VODACOM_MPESA' }));
  test('Airtel 97',   () => expect(detectFromPhone('+243971234567')).toMatchObject({ operator: 'AIRTEL_MONEY', gateway: 'airtel_cd' }));
  test('Orange 85',   () => expect(detectFromPhone('+243851234567').gateway).toBe('orange_cd'));
  test('Africell 90', () => expect(detectFromPhone('+243901234567').gateway).toBe('africell_cd'));
});

describe('detectFromPhone — cas limites', () => {
  test('pays non supporté (UK)', () => expect(detectFromPhone('+447911123456')).toMatchObject({ success: false, code: 'COUNTRY_UNSUPPORTED' }));
  test('message « non supporté » conservé', () => expect(detectFromPhone('+447911123456').error).toMatch(/non supporté/i));
  test('pays connu sans opérateur (Ghana)', () => expect(detectFromPhone('+233241234567').code).toBe('OPERATOR_UNKNOWN'));
  test('vide', () => expect(detectFromPhone('').code).toBe('PHONE_REQUIRED'));
  test('opts non-objet toléré', () => expect(detectFromPhone('+237670000001', null).success).toBe(true));
  test('devise détectée ≠ devise marchand est signalée en amont par l’orchestrateur (ici : XOF)', () => expect(detectFromPhone('+221771234567').currency).toBe('XOF'));
});

// ─── Détection carte BIN ──────────────────────────────────────────

describe('detectFromCard — BIN/IIN', () => {
  test('Visa 4',            () => expect(detectFromCard('411111')).toMatchObject({ success: true, network: 'VISA', acquirer: 'cybersource' }));
  test('Mastercard 51',     () => expect(detectFromCard('512345')).toMatchObject({ network: 'MASTERCARD', acquirer: 'mpgs' }));
  test('Mastercard 2221 (plage 2-series)', () => expect(detectFromCard('222100').network).toBe('MASTERCARD'));
  test('Mastercard 2720',   () => expect(detectFromCard('272099').network).toBe('MASTERCARD'));
  test('2721 hors plage → inconnu', () => expect(detectFromCard('272100').success).toBe(false));
  test('GIMAC 979 (non vérifié)', () => expect(detectFromCard('979200')).toMatchObject({ network: 'GIMAC', acquirer: 'gimac_gateway', verified: false }));
  test('UnionPay 62',       () => expect(detectFromCard('620000').network).toBe('UNIONPAY'));
  test('Verve 650 prioritaire sur Discover 65', () => expect(detectFromCard('650000').network).toBe('VERVE'));
  test('Discover 6511',     () => expect(detectFromCard('651123').network).toBe('DISCOVER'));
  test('Maestro 6304',      () => expect(detectFromCard('630412').network).toBe('MAESTRO'));
  test('JCB 35',            () => expect(detectFromCard('353011').network).toBe('JCB'));
  test('BIN inconnu',       () => expect(detectFromCard('000000').success).toBe(false));
  test('BIN trop court',    () => expect(detectFromCard('4111').code).toBe('BIN_INVALID'));
  test('PAN complet tronqué à 8', () => expect(detectFromCard('4111111111111111').bin).toBe('41111111'));
});

// ─── Détection AID NFC ────────────────────────────────────────────

describe('detectFromAid — AID EMV', () => {
  test('Visa credit',          () => expect(detectFromAid('A0000000031010')).toMatchObject({ success: true, network: 'VISA', acquirer: 'cybersource' }));
  test('Mastercard',           () => expect(detectFromAid('A0000000041010')).toMatchObject({ network: 'MASTERCARD', acquirer: 'mpgs' }));
  test('Maestro',              () => expect(detectFromAid('A0000000043060')).toMatchObject({ network: 'MAESTRO', acquirer: 'mpgs' }));
  test('UnionPay (RID A000000333 — était mappé GIMAC)', () => expect(detectFromAid('A000000333010101').network).toBe('UNIONPAY'));
  test('JCB (RID A000000065 — était mappé Verve)', () => expect(detectFromAid('A0000000651010').network).toBe('JCB'));
  test('Verve (RID A000000371)', () => expect(detectFromAid('A0000003710001').network).toBe('VERVE'));
  test('insensible à la casse', () => expect(detectFromAid('a0000000041010').network).toBe('MASTERCARD'));
  test('AID inconnu',          () => expect(detectFromAid('A0000009999999').code).toBe('AID_UNKNOWN'));
  test('AID invalide',         () => { expect(detectFromAid('xyz').code).toBe('AID_INVALID'); expect(detectFromAid('DEADBEEF1234').success).toBe(false); });
});

// ─── getBestRoute ─────────────────────────────────────────────────

describe('getBestRoute', () => {
  test('Mobile Money depuis téléphone', () => expect(getBestRoute({ phone: '+237670000001' })).toMatchObject({ paymentMethod: 'mobile_money', routeType: 'direct', gateway: 'mtn_cm' }));
  test('Carte via AID', () => expect(getBestRoute({ aid: 'A0000000031010' })).toMatchObject({ paymentMethod: 'card_nfc', routeType: 'emv', network: 'VISA' }));
  test('Carte via BIN', () => expect(getBestRoute({ bin: '510000' })).toMatchObject({ paymentMethod: 'card', network: 'MASTERCARD' }));
  test('aucun paramètre', () => expect(getBestRoute({}).code).toBe('INSUFFICIENT_PARAMS'));
});

// ─── Compatibilité des exports historiques ────────────────────────

describe('exports de compatibilité', () => {
  test('COUNTRY_PREFIXES dérivé de COUNTRIES', () => {
    expect(COUNTRY_PREFIXES['+242']).toMatchObject({ country: 'CG', currency: 'XAF', region: 'CEMAC' });
    expect(Object.keys(COUNTRY_PREFIXES).length).toBe(Object.keys(COUNTRIES).length);
  });
  test('MOBILE_MONEY_OPERATORS / CARD_NETWORKS exportés', () => {
    expect(Array.isArray(MOBILE_MONEY_OPERATORS.CG)).toBe(true);
    expect(Array.isArray(CARD_NETWORKS)).toBe(true);
  });
  test('valeurs operator orchestrateur conservées (MTN_MOMO / AIRTEL_MONEY)', () => {
    expect(detectFromPhone('+242061234567').operator).toBe('MTN_MOMO');
    expect(detectFromPhone('+242051234567').operator).toBe('AIRTEL_MONEY');
  });
});

describe('detection : numéro local avec pays par défaut (saisie caisse sans indicatif)', () => {
  const { detectFromPhone } = require('../services/detection/detection.engine');
  test('CG : 06 612 34 56 → +242066123456 MTN ; 05… → Airtel ; sans pays → refus', () => {
    const mtn = detectFromPhone('06 612 34 56', { defaultCountry: 'CG' });
    expect(mtn.success).toBe(true); expect(mtn.country).toBe('CG'); expect(mtn.phone).toBe('+242066123456');
    expect(String(mtn.operator).toUpperCase()).toBe('MTN_MOMO');
    const airtel = detectFromPhone('056123456', { defaultCountry: 'CG' });
    expect(airtel.success).toBe(true); expect(String(airtel.operator).toUpperCase()).toBe('AIRTEL_MONEY');
    const none = detectFromPhone('066123456');
    expect(none.success).toBe(false);
  });
  test('un numéro international reste accepté quel que soit le pays par défaut', () => {
    const r = detectFromPhone('+242 06 612 34 56', { defaultCountry: 'CM' });
    expect(r.success).toBe(true); expect(r.country).toBe('CG');
  });
});
