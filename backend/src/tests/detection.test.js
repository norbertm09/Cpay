/**
 * Tests du Detection Engine — le cœur de l'automatisation CPlus 2.6.0
 * Suite historique (prod). WAVE-2 : trois tests encodaient des bugs du moteur et ont été corrigés
 * (CM 69 = Orange, CI = 10 chiffres, AID A000000333 = UnionPay). Voir wave2-detection.test.js.
 */

'use strict';

const {
  detectFromPhone,
  detectFromCard,
  detectFromAid,
  getBestRoute,
  normalizePhone,
} = require('../../src/services/detection/detection.engine');

// ─── Normalisation ────────────────────────────────────────────────

describe('normalizePhone', () => {
  test('format E.164 déjà normalisé', () => {
    expect(normalizePhone('+237699000001')).toBe('+237699000001');
  });
  test('avec espaces', () => {
    expect(normalizePhone('+237 699 000 001')).toBe('+237699000001');
  });
  test('avec tirets', () => {
    expect(normalizePhone('+237-699-000-001')).toBe('+237699000001');
  });
  test('format 00XXXX', () => {
    expect(normalizePhone('00237699000001')).toBe('+237699000001');
  });
  test('numéro local sans indicatif → null', () => {
    expect(normalizePhone('0699000001')).toBeNull();
  });
});

// ─── Détection Mobile Money ────────────────────────────────────────

describe('detectFromPhone — Cameroun (CM, XAF)', () => {
  test('MTN CM +23767XXXXXXX', () => {
    const r = detectFromPhone('+237670000001'); // 67 = MTN (69 est Orange — ancien test erroné)
    expect(r.success).toBe(true);
    expect(r.country).toBe('CM');
    expect(r.currency).toBe('XAF');
    expect(r.operator).toBe('MTN_MOMO');
    expect(r.gateway).toBe('mtn_cm');
  });

  test('Orange CM +23769XXXXXXX', () => {
    const r = detectFromPhone('+237695000001');
    expect(r.success).toBe(true);
    expect(r.country).toBe('CM');
    expect(r.operator).toBe('ORANGE_MONEY');
  });

  test('Numéro invalide CM', () => {
    const r = detectFromPhone('+237123');
    expect(r.success).toBe(false);
  });
});

describe('detectFromPhone — Sénégal (SN, XOF)', () => {
  test('Orange SN +22176XXXXXXX', () => {
    const r = detectFromPhone('+221761234567');
    expect(r.success).toBe(true);
    expect(r.country).toBe('SN');
    expect(r.currency).toBe('XOF');
    expect(r.region).toBe('BCEAO');
  });
});

describe('detectFromPhone — Côte d\'Ivoire (CI, XOF)', () => {
  test('Orange CI +22507XXXXXXXX (10 chiffres)', () => {
    const r = detectFromPhone('+2250712345678'); // l'ancien test utilisait 11 chiffres (bug \d{7,9})
    expect(r.success).toBe(true);
    expect(r.country).toBe('CI');
    expect(r.currency).toBe('XOF');
    expect(r.operator).toBe('ORANGE_MONEY');
  });

  test('CI 11 chiffres → rejeté', () => {
    expect(detectFromPhone('+22507123456789').success).toBe(false);
  });
});

describe('detectFromPhone — Congo Brazzaville (CG, XAF)', () => {
  test('MTN CG +24206XXXXXXX', () => {
    const r = detectFromPhone('+242061234567');
    expect(r.success).toBe(true);
    expect(r.country).toBe('CG');
    expect(r.currency).toBe('XAF');
  });
});

describe('detectFromPhone — RDC (CD, CDF)', () => {
  test('Vodacom M-Pesa RDC +24381XXXXXXXX', () => {
    const r = detectFromPhone('+243811234567');
    expect(r.success).toBe(true);
    expect(r.country).toBe('CD');
    expect(r.currency).toBe('CDF');
    expect(r.operator).toBe('VODACOM_MPESA');
  });

  test('Airtel Money RDC +24397XXXXXXXX', () => {
    const r = detectFromPhone('+243971234567');
    expect(r.success).toBe(true);
    expect(r.country).toBe('CD');
    expect(r.currency).toBe('CDF');
  });
});

describe('detectFromPhone — pays non supporté', () => {
  test('Numéro UK non supporté', () => {
    const r = detectFromPhone('+447911123456');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/non supporté/i);
  });
});

// ─── Détection carte BIN ──────────────────────────────────────────

describe('detectFromCard — BIN/IIN', () => {
  test('Visa (préfixe 4)', () => {
    const r = detectFromCard('411111');
    expect(r.success).toBe(true);
    expect(r.network).toBe('VISA');
    expect(r.acquirer).toBe('cybersource');
  });

  test('Mastercard (préfixe 51)', () => {
    const r = detectFromCard('512345');
    expect(r.success).toBe(true);
    expect(r.network).toBe('MASTERCARD');
    expect(r.acquirer).toBe('mpgs');
  });

  test('GIMAC (préfixe 979)', () => {
    const r = detectFromCard('979200');
    expect(r.success).toBe(true);
    expect(r.network).toBe('GIMAC');
    expect(r.acquirer).toBe('gimac_gateway');
  });

  test('GIMAC prioritaire sur Visa pour 9792', () => {
    const r = detectFromCard('979200');
    expect(r.network).toBe('GIMAC');  // pas Visa
  });

  test('UnionPay (préfixe 62)', () => {
    const r = detectFromCard('620000');
    expect(r.success).toBe(true);
    expect(r.network).toBe('UNIONPAY');
  });

  test('Verve (préfixe 650)', () => {
    const r = detectFromCard('650000');
    expect(r.success).toBe(true);
    expect(r.network).toBe('VERVE');
  });

  test('BIN inconnu', () => {
    const r = detectFromCard('000000');
    expect(r.success).toBe(false);
  });
});

// ─── Détection AID NFC ────────────────────────────────────────────

describe('detectFromAid — AID EMV', () => {
  test('AID Visa Credit', () => {
    const r = detectFromAid('A0000000031010');
    expect(r.success).toBe(true);
    expect(r.network).toBe('VISA');
    expect(r.acquirer).toBe('cybersource');
  });

  test('AID Mastercard', () => {
    const r = detectFromAid('A0000000041010');
    expect(r.success).toBe(true);
    expect(r.network).toBe('MASTERCARD');
    expect(r.acquirer).toBe('mpgs');
  });

  test('AID A000000333 = UnionPay (RID officiel), pas GIMAC', () => {
    const r = detectFromAid('A000000333010101');
    expect(r.success).toBe(true);
    expect(r.network).toBe('UNIONPAY');
  });

  test('AID Maestro', () => {
    const r = detectFromAid('A0000000043060');
    expect(r.success).toBe(true);
    expect(r.network).toBe('MAESTRO');
    expect(r.acquirer).toBe('mpgs');
  });

  test('AID insensible à la casse', () => {
    const r = detectFromAid('a0000000031010');
    expect(r.success).toBe(true);
    expect(r.network).toBe('VISA');
  });

  test('AID inconnu', () => {
    const r = detectFromAid('DEADBEEF1234');
    expect(r.success).toBe(false);
  });
});

// ─── getBestRoute ─────────────────────────────────────────────────

describe('getBestRoute', () => {
  test('Mobile Money depuis numéro téléphone', () => {
    const r = getBestRoute({ phone: '+237699000001' });
    expect(r.success).toBe(true);
    expect(r.paymentMethod).toBe('mobile_money');
    expect(r.routeType).toBe('direct');
  });

  test('Carte via AID', () => {
    const r = getBestRoute({ aid: 'A0000000031010' });
    expect(r.success).toBe(true);
    expect(r.paymentMethod).toBe('card_nfc');
    expect(r.routeType).toBe('emv');
  });

  test('Carte via BIN', () => {
    const r = getBestRoute({ bin: '411111' });
    expect(r.success).toBe(true);
    expect(r.paymentMethod).toBe('card');
    expect(r.network).toBe('VISA');
  });

  test('Erreur si aucun paramètre', () => {
    const r = getBestRoute({});
    expect(r.success).toBe(false);
  });
});
