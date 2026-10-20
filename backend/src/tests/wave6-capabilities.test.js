'use strict';
/**
 * WAVE-6 lot 2 — registre de capacités (services/capabilities/registry.js) : statuts calculés,
 * transitions, autorisation, résumé public. Aucune base, env / faits / providers injectés.
 */
process.env.NODE_ENV = 'test';
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() }));

const registry = require('../services/capabilities/registry');
const { STATUS, getCapabilities, isAllowed, assertAllowed, CapabilityError, summary, countryOpenForRegistration, computeStatus } = registry;

// Providers simulés : seuls ces gateways « ont du code »
const providers = {
  getProvider: (gw) => ({
    mtn_cm: { collectPayment() {}, sendPayout() {} },
    orange_cm: { collectPayment() {}, sendPayout() {} },
    mtn_cg: { collectPayment() {}, sendPayout() {} },
    airtel_cg: { collectPayment() {}, sendPayout() {} },
    vodacom_cd: { collectPayment() {}, sendPayout() {} },
    interswitch_mpesa_cd: { collectPayment() {} },
    orange_sn: { collectPayment() {}, sendPayout() {} },
    orange_ci: { collectPayment() {}, sendPayout() {} },
    collect_only_cm: { collectPayment() {} },
  }[gw] || null),
};
const noFacts = { cardGatewayByCountry: {}, configuredGateways: [], fundingCurrencies: [] };
const caps = (env = {}, facts = noFacts) => getCapabilities({ env, facts, providers });
const cm = (env, facts) => caps(env, facts).countries.CM;

describe('computeStatus — transitions', () => {
  test('code + config → active', () => expect(computeStatus({ implemented: true, configured: true, launch: true, pilot: false })).toBe('active'));
  test('code + config + pilote → pilot', () => expect(computeStatus({ implemented: true, configured: true, launch: true, pilot: true })).toBe('pilot'));
  test('périmètre sans code → planned (même en pilote)', () => {
    expect(computeStatus({ implemented: false, configured: false, launch: true, pilot: false })).toBe('planned');
    expect(computeStatus({ implemented: false, configured: false, launch: true, pilot: true })).toBe('planned');
  });
  test('code sans config → unavailable', () => expect(computeStatus({ implemented: true, configured: false, launch: true, pilot: false })).toBe('unavailable'));
  test('hors périmètre sans code → unavailable', () => expect(computeStatus({ implemented: false, configured: false, launch: false, pilot: false })).toBe('unavailable'));
});

describe('périmètre de lancement', () => {
  test('7 pays, devises et zones', () => {
    expect(registry.LAUNCH_COUNTRIES).toEqual(['CM', 'CF', 'CG', 'GA', 'GQ', 'TD', 'CD']);
    const c = caps().countries;
    for (const cc of ['CM', 'CF', 'CG', 'GA', 'GQ', 'TD']) expect(c[cc]).toMatchObject({ currency: 'XAF', region: 'CEMAC', launch: true, legacy: false });
    expect(c.CD).toMatchObject({ currency: 'CDF', launch: true, legacy: false });
    expect(c.SN).toMatchObject({ currency: 'XOF', launch: false, legacy: true });
    expect(c.CI).toMatchObject({ currency: 'XOF', launch: false, legacy: true });
  });
  test('CF / GA / GQ / TD : opérateurs principaux planned, non vérifiés', () => {
    const c = caps().countries;
    expect(c.CF.operations.collect.mobile_money.operators.map((o) => o.operator)).toEqual(['ORANGE_MONEY', 'TELECEL_MONEY']);
    expect(c.GA.operations.collect.mobile_money.operators.map((o) => o.operator)).toEqual(['AIRTEL_MONEY', 'MOOV_MONEY']);
    expect(c.GQ.operations.collect.mobile_money.operators.map((o) => o.operator)).toEqual(['GETESA_MONEY', 'MUNI_MONEY']);
    expect(c.TD.operations.collect.mobile_money.operators.map((o) => o.operator)).toEqual(['AIRTEL_MONEY', 'MOOV_MONEY']);
    for (const cc of ['CF', 'GA', 'GQ', 'TD']) {
      for (const op of c[cc].operations.collect.mobile_money.operators) expect(op).toMatchObject({ status: 'planned', verified: false, implemented: false, since: null });
      expect(c[cc].operations.collect.mobile_money.status).toBe('planned');
      expect(c[cc].operations.withdraw.mobile_money.status).toBe('planned');
    }
  });
});

describe('Mobile Money — encaissement', () => {
  test('code sans configuration → unavailable (jamais affirmé)', () => {
    const op = cm().operations.collect.mobile_money.operators.find((o) => o.operator === 'MTN_MOMO');
    expect(op).toMatchObject({ status: 'unavailable', implemented: true, configured: false, gateway: 'mtn_cm' });
    expect(op.requires).toEqual(expect.arrayContaining(['MTN_CM_API_KEY', 'api_configurations[mtn_cm]']));
  });
  test('clé API env → active (API_KEY ou CLIENT_ID)', () => {
    expect(cm({ MTN_CM_API_KEY: 'k' }).operations.collect.mobile_money.operators[0].status).toBe('active');
    expect(cm({ MTN_CM_CLIENT_ID: 'id' }).operations.collect.mobile_money.operators[0].status).toBe('active');
    expect(cm({ MTN_CM_API_KEY: 'k' }).operations.collect.mobile_money.status).toBe('active');
  });
  test('ligne api_configurations (fait base) → active', () => {
    const op = cm({}, { ...noFacts, configuredGateways: ['orange_cm'] }).operations.collect.mobile_money.operators.find((o) => o.operator === 'ORANGE_MONEY');
    expect(op.status).toBe('active');
  });
  test('CAPABILITY_PILOT_CM=true → pilot (seulement si actif par ailleurs)', () => {
    const ops = cm({ MTN_CM_API_KEY: 'k', CAPABILITY_PILOT_CM: 'true' }).operations.collect.mobile_money.operators;
    expect(ops.find((o) => o.operator === 'MTN_MOMO').status).toBe('pilot');
    expect(ops.find((o) => o.operator === 'ORANGE_MONEY').status).toBe('unavailable');
    expect(cm({ MTN_CM_API_KEY: 'k', CAPABILITY_PILOT_CM: 'true' }).pilot).toBe(true);
  });
  test('statut agrégé = meilleur statut des opérateurs', () => {
    const m = cm({ MTN_CM_API_KEY: 'k', CAPABILITY_PILOT_CM: 'true' }).operations.collect.mobile_money;
    expect(m.status).toBe('pilot');
    expect(cm({ ORANGE_CM_API_KEY: 'k' }).operations.collect.mobile_money.status).toBe('active');
  });
});

describe('Mobile Money — retrait', () => {
  test('MTN CG : MTN_CG_DISB_* → active, sinon via provider + clé', () => {
    const disb = { MTN_CG_DISB_API_USER: 'u', MTN_CG_DISB_API_KEY: 'k', MTN_CG_DISB_SUB_KEY_PRIMARY: 'p' };
    const cg = (env) => caps(env).countries.CG.operations.withdraw.mobile_money.operators.find((o) => o.operator === 'MTN_MOMO');
    expect(cg({}).status).toBe('unavailable');
    expect(cg({}).requires).toEqual(expect.arrayContaining(['MTN_CG_DISB_API_USER', 'MTN_CG_DISB_SUB_KEY_PRIMARY']));
    expect(cg(disb).status).toBe('active');
    expect(cg({ MTN_CG_API_KEY: 'k' }).status).toBe('active');
    expect(cg({ MTN_CG_DISB_API_USER: 'u' }).status).toBe('unavailable'); // config partielle
  });
  test('provider sans sendPayout → planned en périmètre', () => {
    const custom = { getProvider: (gw) => (gw === 'mtn_cm' ? { collectPayment() {} } : null) };
    const c = getCapabilities({ env: { MTN_CM_API_KEY: 'k' }, facts: noFacts, providers: custom }).countries.CM;
    expect(c.operations.collect.mobile_money.operators[0].status).toBe('active');
    expect(c.operations.withdraw.mobile_money.operators[0].status).toBe('planned');
  });
});

describe('Carte', () => {
  const migs = { MIGS_MERCHANT_ID: 'm', MIGS_ACCESS_CODE: 'a', MIGS_SECURE_HASH: 'h' };
  test('sans passerelle pays → unavailable même si MIGS configuré', () => {
    expect(cm(migs).operations.collect.card.status).toBe('unavailable');
    expect(cm(migs).operations.collect.card.note).toMatch(/Aucune passerelle carte/);
  });
  test('passerelle pays (fait base) + MIGS → active ; MPGS non configuré → unavailable', () => {
    expect(cm(migs, { ...noFacts, cardGatewayByCountry: { CM: 'migs' } }).operations.collect.card).toMatchObject({ status: 'active', gateway: 'migs' });
    expect(cm(migs, { ...noFacts, cardGatewayByCountry: { CM: 'mpgs' } }).operations.collect.card.status).toBe('unavailable');
    expect(cm({ MPGS_MERCHANT_ID: 'x', MPGS_API_PASSWORD: 'y' }, { ...noFacts, cardGatewayByCountry: { CM: 'mpgs' } }).operations.collect.card.status).toBe('active');
  });
  test('CARD_GATEWAY_<CC> remplace le fait base ; pilote → pilot', () => {
    expect(cm({ ...migs, CARD_GATEWAY_CM: 'migs' }).operations.collect.card.status).toBe('active');
    expect(cm({ ...migs, CARD_GATEWAY_CM: 'migs', CAPABILITY_PILOT_CM: 'true' }).operations.collect.card.status).toBe('pilot');
  });
  test('retrait et transfert carte : unavailable partout', () => {
    for (const cc of registry.LAUNCH_COUNTRIES) {
      const c = cm(migs, { ...noFacts, cardGatewayByCountry: { [cc]: 'migs' } });
      expect(caps(migs).countries[cc].operations.withdraw.card.status).toBe('unavailable');
      expect(caps(migs).countries[cc].operations.transfer.card.status).toBe('unavailable');
      expect(c).toBeTruthy();
    }
  });
});

describe('GIMAC / GIMACPAY', () => {
  test('planned dans les six pays CEMAC, avec prérequis ; unavailable en RDC et pays historiques', () => {
    const c = caps().countries;
    for (const cc of ['CM', 'CF', 'CG', 'GA', 'GQ', 'TD']) {
      for (const op of ['collect', 'withdraw', 'transfer']) {
        expect(c[cc].operations[op].gimac.status).toBe('planned');
        expect(c[cc].operations[op].gimac.requires).toEqual(expect.arrayContaining(['GIMAC_MERCHANT_ID', expect.stringMatching(/contrat/i), expect.stringMatching(/tests partenaires/i)]));
      }
    }
    expect(c.CD.operations.collect.gimac.status).toBe('unavailable');
    expect(c.SN.operations.collect.gimac.status).toBe('unavailable');
  });
  test('la passerelle gimac lève GATEWAY_NOT_ACTIVATED (503)', async () => {
    const gimac = require('../services/gateways/gimac.gateway');
    expect(gimac.isActivated()).toBe(false);
    await expect(gimac.processPayment({ txnId: 't', amount: 10 })).rejects.toMatchObject({ code: 'GATEWAY_NOT_ACTIVATED', statusCode: 503, name: 'GatewayNotActivatedError' });
    const err = await gimac.processPayment({}).catch((e) => e);
    expect(err).toBeInstanceOf(gimac.GatewayNotActivatedError);
    expect(err.toJSON()).toMatchObject({ code: 'GATEWAY_NOT_ACTIVATED', status: 'planned' });
  });
});

describe('Transferts', () => {
  test('wallet → banque : active (file manuelle) ; banque → wallet selon compte de collecte', () => {
    const c = cm();
    expect(c.operations.transfer.wallet_to_bank.status).toBe('active');
    expect(c.operations.transfer.bank_to_wallet.status).toBe('unavailable');
    expect(cm({}, { ...noFacts, fundingCurrencies: ['XAF'] }).operations.transfer.bank_to_wallet.status).toBe('active');
    expect(cm({ CAPABILITY_FUNDING_XAF: 'true' }).operations.transfer.bank_to_wallet.status).toBe('active');
    expect(caps({}, { ...noFacts, fundingCurrencies: ['XAF'] }).countries.CD.operations.transfer.bank_to_wallet.status).toBe('unavailable');
    expect(cm({ CAPABILITY_PILOT_CM: 'true' }).operations.transfer.wallet_to_bank.status).toBe('pilot');
  });
});

describe('Pays historiques (SN / CI)', () => {
  test('legacy:true, calcul normal, hors résumé public, inscription fermée', () => {
    const sn = caps({ ORANGE_SN_API_KEY: 'k' }).countries.SN;
    expect(sn.legacy).toBe(true);
    expect(sn.operations.collect.mobile_money.operators[0].status).toBe('active');
    expect(summary({ env: { ORANGE_SN_API_KEY: 'k' }, facts: noFacts, providers }).countries.map((c) => c.code)).not.toContain('SN');
    expect(countryOpenForRegistration('SN', { env: { ORANGE_SN_API_KEY: 'k' }, facts: noFacts, providers })).toMatchObject({ open: false, reason: 'legacy' });
  });
  test('marchands existants tolérés par défaut, bloqués avec CAPABILITY_LEGACY_ALLOW=false', () => {
    const o = { facts: noFacts, providers };
    expect(isAllowed({ country: 'SN', operation: 'collect', method: 'mobile_money' }, { ...o, env: { ORANGE_SN_API_KEY: 'k' } })).toMatchObject({ allowed: true, legacy: true, status: 'active' });
    const r = isAllowed({ country: 'SN', operation: 'collect', method: 'mobile_money' }, { ...o, env: { ORANGE_SN_API_KEY: 'k', CAPABILITY_LEGACY_ALLOW: 'false' } });
    expect(r).toMatchObject({ allowed: false, legacy: true });
    expect(r.message).toMatch(/hors périmètre/);
  });
});

describe('isAllowed / assertAllowed', () => {
  const o = (env = {}, facts = noFacts) => ({ env, facts, providers });
  test('planned → refus avec message « intégration en cours »', () => {
    const r = isAllowed({ country: 'CF', operation: 'collect', method: 'mobile_money' }, o());
    expect(r).toMatchObject({ allowed: false, status: 'planned', country: 'CF', operation: 'collect', method: 'mobile_money' });
    expect(r.message).toMatch(/Centrafricaine|centrafricaine/);
    expect(r.message).toMatch(/intégration en cours/);
  });
  test('active et pilot → autorisé', () => {
    expect(isAllowed({ country: 'CM', operation: 'collect', method: 'mobile_money' }, o({ MTN_CM_API_KEY: 'k' })).allowed).toBe(true);
    expect(isAllowed({ country: 'CM', operation: 'collect', method: 'mobile_money' }, o({ MTN_CM_API_KEY: 'k', CAPABILITY_PILOT_CM: 'true' })).status).toBe('pilot');
    expect(isAllowed({ country: 'CM', operation: 'collect', method: 'mobile_money' }, o({ MTN_CM_API_KEY: 'k', CAPABILITY_PILOT_CM: 'true' })).allowed).toBe(true);
  });
  test('opérateur précis : alias normalisés, opérateur non configuré refusé, inconnu refusé', () => {
    const env = { MTN_CM_API_KEY: 'k' };
    expect(isAllowed({ country: 'CM', operation: 'collect', method: 'mobile_money', operator: 'mtn' }, o(env)).allowed).toBe(true);
    expect(isAllowed({ country: 'CM', operation: 'collect', method: 'mobile_money', operator: 'mtn_momo' }, o(env)).allowed).toBe(true);
    expect(isAllowed({ country: 'CM', operation: 'collect', method: 'mobile_money', operator: 'orange' }, o(env))).toMatchObject({ allowed: false, status: 'unavailable', operator: 'ORANGE_MONEY' });
    expect(isAllowed({ country: 'CM', operation: 'collect', method: 'mobile_money', operator: 'wave' }, o(env)).message).toMatch(/indisponible/);
  });
  test('méthodes : card / card_nfc → card ; direction de transfert ; GIMAC', () => {
    const facts = { ...noFacts, cardGatewayByCountry: { CM: 'migs' } };
    const env = { MIGS_MERCHANT_ID: 'm', MIGS_ACCESS_CODE: 'a', MIGS_SECURE_HASH: 'h' };
    expect(isAllowed({ country: 'CM', operation: 'collect', method: 'card_nfc' }, o(env, facts)).allowed).toBe(true);
    expect(isAllowed({ country: 'CM', operation: 'withdraw', method: 'card' }, o(env, facts)).allowed).toBe(false);
    expect(isAllowed({ country: 'CM', operation: 'transfer', direction: 'wallet_to_bank' }, o()).allowed).toBe(true);
    expect(isAllowed({ country: 'CM', operation: 'transfer', method: 'bank_to_wallet' }, o())).toMatchObject({ allowed: false, method: 'bank_to_wallet' });
    expect(isAllowed({ country: 'CM', operation: 'collect', method: 'gimac' }, o())).toMatchObject({ allowed: false, status: 'planned' });
  });
  test('pays inconnu / opération inconnue → refus', () => {
    expect(isAllowed({ country: 'FR', operation: 'collect' }, o()).allowed).toBe(false);
    expect(isAllowed({ country: 'CM', operation: 'refund' }, o()).allowed).toBe(false);
  });
  test('assertAllowed lève CapabilityError 403 CAPABILITY_NOT_ACTIVE avec la charge utile', () => {
    expect(() => assertAllowed({ country: 'GA', operation: 'withdraw', method: 'mobile_money' }, o())).toThrow(CapabilityError);
    const err = (() => { try { assertAllowed({ country: 'GA', operation: 'withdraw', method: 'mobile_money' }, o()); } catch (e) { return e; } return null; })();
    expect(err).toMatchObject({ statusCode: 403, code: 'CAPABILITY_NOT_ACTIVE', country: 'GA', operation: 'withdraw', method: 'mobile_money', status: 'planned' });
    expect(err.toJSON()).toMatchObject({ error: expect.any(String), code: 'CAPABILITY_NOT_ACTIVE', country: 'GA', operation: 'withdraw', method: 'mobile_money', status: 'planned', message: expect.stringMatching(/Gabon/) });
    expect(assertAllowed({ country: 'CM', operation: 'collect', method: 'mobile_money' }, o({ MTN_CM_API_KEY: 'k' })).allowed).toBe(true);
  });
});

describe('countryOpenForRegistration', () => {
  const o = (env = {}, facts = noFacts) => ({ env, facts, providers });
  test('ouvert dès qu’un encaissement est active|pilot ; fermé sinon', () => {
    expect(countryOpenForRegistration('CM', o())).toMatchObject({ open: false, status: 'planned' }); // GIMAC planned, MM non configuré
    expect(countryOpenForRegistration('CM', o({ MTN_CM_API_KEY: 'k' })).open).toBe(true);
    expect(countryOpenForRegistration('CM', o({ MTN_CM_API_KEY: 'k', CAPABILITY_PILOT_CM: 'true' }))).toMatchObject({ open: true, status: 'pilot' });
    expect(countryOpenForRegistration('TD', o())).toMatchObject({ open: false, status: 'planned' });
    expect(countryOpenForRegistration('GH', o())).toMatchObject({ open: false, reason: 'unknown' });
  });
});

describe('summary (UI)', () => {
  test('forme publique : 7 pays, statuts seulement, sans requires ni variables', () => {
    const s = summary({ env: { MTN_CM_API_KEY: 'k' }, facts: noFacts, providers });
    expect(s.countries).toHaveLength(7);
    expect(s.generatedAt).toEqual(expect.any(String));
    const c = s.countries.find((x) => x.code === 'CM');
    expect(c).toMatchObject({ name: 'Cameroun', currency: 'XAF', region: 'CEMAC', callingCode: '237' });
    expect(c.operations.collect.mobile_money.status).toBe('active');
    expect(c.operations.collect.mobile_money.operators[0]).toEqual({ operator: 'MTN_MOMO', brand: 'MTN MoMo', status: 'active' });
    expect(c.operations.collect.card).toEqual({ status: 'unavailable' });
    expect(c.operations.transfer).toEqual({ wallet_to_bank: { status: 'active' }, bank_to_wallet: { status: 'unavailable' }, gimac: { status: 'planned' } });
    expect(JSON.stringify(s)).not.toMatch(/API_KEY|requires|api_configurations/);
    expect(s.countries.find((x) => x.code === 'TD').operations.collect.mobile_money.status).toBe('planned');
  });
});

describe('faits base', () => {
  test('loadFacts tolère une base absente et met en cache', async () => {
    jest.resetModules();
    jest.doMock('../config/database', () => ({ query: jest.fn().mockRejectedValue(new Error('no db')) }));
    const r = require('../services/capabilities/registry');
    r.invalidateFacts();
    const f = await r.loadFacts();
    expect(f).toMatchObject({ cardGatewayByCountry: {}, configuredGateways: [], fundingCurrencies: [] });
    expect(f.loadedAt).toEqual(expect.any(String));
    expect(await r.loadFacts()).toBe(f);
  });
  test('loadFacts lit country_payment_defaults, api_configurations et platform_bank_accounts', async () => {
    jest.resetModules();
    const query = jest.fn(async (sql) => {
      if (/country_payment_defaults/.test(sql)) return { rows: [{ country: 'cm', default_card_gateway: 'MIGS' }] };
      if (/api_configurations/.test(sql)) return { rows: [{ provider_key: 'mtn_cm' }] };
      if (/platform_bank_accounts/.test(sql)) return { rows: [{ currency: 'xaf' }] };
      return { rows: [] };
    });
    jest.doMock('../config/database', () => ({ query }));
    const r = require('../services/capabilities/registry');
    r.invalidateFacts();
    const f = await r.loadFacts({ force: true });
    expect(f).toMatchObject({ cardGatewayByCountry: { CM: 'migs' }, configuredGateways: ['mtn_cm'], fundingCurrencies: ['XAF'], source: 'database' });
    const c = r.getCapabilities({ env: { MIGS_MERCHANT_ID: 'm', MIGS_ACCESS_CODE: 'a', MIGS_SECURE_HASH: 'h' }, providers }).countries.CM;
    expect(c.operations.collect.card.status).toBe('active');
    expect(c.operations.collect.mobile_money.operators[0].status).toBe('active');
    expect(c.operations.transfer.bank_to_wallet.status).toBe('active');
  });
});
