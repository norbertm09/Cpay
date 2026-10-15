'use strict';
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockQuery = jest.fn();
const mockClient = { query: jest.fn() };
jest.mock('../config/database', () => ({
  query: (...a) => mockQuery(...a),
  withTransaction: async (fn) => fn(mockClient),
}));
const mockMM = { sendPayout: jest.fn() };
jest.mock('../services/mobilemoney/mobilemoney.router', () => mockMM);

describe('settlement.engine.runSettlement (hotfix v1)', () => {
  const { runSettlement } = require('../services/settlement/settlement.engine');
  beforeEach(() => { mockQuery.mockReset(); mockClient.query.mockReset(); mockMM.sendPayout.mockReset(); });

  test('verrou global : deuxième exécution ignorée', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: false }] });
    expect(await runSettlement()).toMatchObject({ skipped: true, reason: 'already_running' });
  });

  test('groupes par (marchand, devise), items réclamés SKIP LOCKED, payout hors transaction, batch submitted', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ ok: true }] })                                   // lock
      .mockResolvedValueOnce({ rows: [{ merchant_id: 'm1', currency: 'XAF', n: 2 }] })   // groupes
      .mockResolvedValue({ rows: [], rowCount: 1 });                                     // update batch + unlock
    mockClient.query
      .mockResolvedValueOnce({ rows: [
        { id: 1, transaction_id: 't1', amount: '1000', payment_method: 'mobile_money', settlement_type: 'mobile_money', settlement_account: '+242061234567', kyb_level: 1, country: 'CG' },
        { id: 2, transaction_id: 't2', amount: '2001', payment_method: 'mobile_money', settlement_type: 'mobile_money', settlement_account: '+242061234567', kyb_level: 1, country: 'CG' },
      ] })
      .mockResolvedValueOnce({ rows: [{ batch_id: 'B1' }] })
      .mockResolvedValue({ rows: [] });
    mockMM.sendPayout.mockResolvedValue({ approved: true, gatewayRef: 'MM-1' });

    const r = await runSettlement('2026-10-15');
    expect(r).toMatchObject({ batches: 1, settled: 2, errors: 0 });
    expect(mockClient.query.mock.calls[0][0]).toContain('FOR UPDATE OF sq SKIP LOCKED');
    expect(mockClient.query.mock.calls[0][0]).toContain("t.type = 'collect'");
    // frais 1,2 % niveau 1 → arrondis à l'unité en XAF ; net = 3001 - (12 + 24) = 2965
    const batchInsert = mockClient.query.mock.calls[1][1];
    expect(batchInsert[2]).toBe(3001); expect(batchInsert[3]).toBe(36); expect(batchInsert[4]).toBe(2965);
    expect(mockMM.sendPayout).toHaveBeenCalledWith(expect.objectContaining({ amount: 2965, currency: 'XAF', txnId: 'SETTLE-B1' }));
    const statusUpd = mockQuery.mock.calls.find(c => c[0].includes('UPDATE settlement_batches SET status'));
    expect(statusUpd[1][0]).toBe('submitted'); expect(statusUpd[1][2]).toBe('MM-1');
  });

  test('payout refusé → batch failed avec motif (jamais submitted)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] }).mockResolvedValueOnce({ rows: [{ merchant_id: 'm1', currency: 'XAF', n: 1 }] }).mockResolvedValue({ rows: [] });
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ id: 1, transaction_id: 't1', amount: '1000', payment_method: 'card_nfc', settlement_type: 'mobile_money', settlement_account: '+242061234567', kyb_level: 0, country: 'CG' }] })
      .mockResolvedValueOnce({ rows: [{ batch_id: 'B2' }] }).mockResolvedValue({ rows: [] });
    mockMM.sendPayout.mockResolvedValue({ approved: false, pending: false, declineReason: 'Solde insuffisant' });
    await runSettlement('2026-10-15');
    const statusUpd = mockQuery.mock.calls.find(c => c[0].includes('UPDATE settlement_batches SET status'));
    expect(statusUpd[1][0]).toBe('failed'); expect(statusUpd[1][1]).toBe('Solde insuffisant');
  });

  test('banque : batch reste pending, aucun appel réseau', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: true }] }).mockResolvedValueOnce({ rows: [{ merchant_id: 'm1', currency: 'XOF', n: 1 }] }).mockResolvedValue({ rows: [] });
    mockClient.query
      .mockResolvedValueOnce({ rows: [{ id: 1, transaction_id: 't1', amount: '500', payment_method: 'mobile_money', settlement_type: 'bank', settlement_account: 'CG123', kyb_level: 0, country: 'CG' }] })
      .mockResolvedValueOnce({ rows: [{ batch_id: 'B3' }] }).mockResolvedValue({ rows: [] });
    await runSettlement('2026-10-15');
    expect(mockMM.sendPayout).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls.some(c => c[0].includes('UPDATE settlement_batches SET status'))).toBe(false);
  });
});

describe('settlement.service.settleTransaction (hotfix v1)', () => {
  const svc = require('../services/settlement.service');
  beforeEach(() => mockQuery.mockReset());

  test('claim atomique : transaction déjà réclamée → aucune action', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await svc.settleTransaction('t1')).toBeUndefined();
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain("settlement_status = 'en_cours'");
    expect(mockQuery.mock.calls[0][0]).toContain("type = 'collect'");
  });

  test("un 'echec' n'est pas rejoué automatiquement", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await svc.settleTransaction('t1');
    expect(mockQuery.mock.calls[0][0]).not.toContain("'echec'");
  });

  test('externalId stable (pas de Date.now) et payout pending → statut soumis', async () => {
    const airtel = require('../services/mobilemoney/providers/airtel.provider');
    jest.spyOn(airtel, 'sendPayout').mockResolvedValue({ success: false, pending: true, transactionId: 'AT-1' });
    mockQuery
      .mockResolvedValueOnce({ rows: [{ transaction_id: 't1' }] })
      .mockResolvedValueOnce({ rows: [{ transaction_id: '12345678-aaaa-bbbb-cccc-123456789012', amount: '1000', merchant_id: 'm', business_name: 'B',
        settlement_type: 'mobile_money', settlement_provider: 'airtel', settlement_account: '+242051234567', settlement_instant: true, commission_rate: 0.02 }] })
      .mockResolvedValue({ rows: [] });
    const r = await svc.settleTransaction('12345678-aaaa-bbbb-cccc-123456789012');
    expect(r).toMatchObject({ ok: true, pending: true, net: 980 });
    expect(airtel.sendPayout.mock.calls[0][0].txnId).toBe('STL-12345678aaaabbbbcccc-0');
    expect(mockQuery.mock.calls.some(c => c[0].includes("settlement_status='soumis'"))).toBe(true);
    expect(mockQuery.mock.calls.some(c => c[0].includes("settlement_status='regle'"))).toBe(false);
  });
});
