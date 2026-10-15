'use strict';

const { decideFeatureAccess, stableBucket } = require('../services/pilot/pilot-control.service');

describe('pilot control decisions', () => {
  test('allows a globally enabled non-pilot feature', () => {
    const decision = decideFeatureAccess({
      merchantId: 'merchant-a',
      flag: { flag_key: 'qr_code', status: 'enabled', default_enabled: true, pilot_only: false, rollout_percent: 100 },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe('default');
  });

  test('blocks pilot-only feature when merchant is not enrolled', () => {
    const decision = decideFeatureAccess({
      merchantId: 'merchant-a',
      flag: { flag_key: 'tap_to_phone', status: 'audit', default_enabled: false, pilot_only: true, rollout_percent: 0 },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe('pilot');
  });

  test('merchant override wins over rollout', () => {
    const decision = decideFeatureAccess({
      merchantId: 'merchant-a',
      flag: { flag_key: 'tokenization', status: 'audit', default_enabled: false, pilot_only: true, rollout_percent: 0 },
      override: { enabled: true },
    });

    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe('merchant_override');
  });

  test('stable bucket is deterministic', () => {
    expect(stableBucket('merchant-a', 'tap_to_phone')).toBe(stableBucket('merchant-a', 'tap_to_phone'));
  });
});
