'use strict';

// Service-level scenarios: injected real SQL fixture, simulated operator boundary.
module.exports = ({ sql, first, cash, merchantId, uuid, mockSendPayout, mockMtnCountry }) => {
  const { finalizeTransaction } = require('../../services/mobilemoney/finalize.service');
  const balance = () => cash.computeAvailableBalance(sql, merchantId);
  const collection = async () => {
    const id = uuid();
    await sql(`INSERT INTO transactions(transaction_id,merchant_id,type,status,amount,fee_amount,net_amount,currency)
      VALUES($1,$2,'collect','pending',25000,250,24750,'XAF')`, [id, merchantId]);
    return first('SELECT * FROM transactions WHERE transaction_id=$1', [id]);
  };
  const confirm = txn => finalizeTransaction({ txn, provider: 'mtn', outcome: 'authorized', source: 'webhook' });
  const payout = (amount = 10000) => cash.createPayout({ merchantId, destType: 'wallet', amount,
    wallet: { operator: 'mtn_momo', phone: '+237670000001', country: 'CM' },
    rail: { available: true, kind: 'router', gateway: 'mtn_cm' } });
  beforeEach(async () => {
    mockSendPayout.mockReset();
    await sql("UPDATE merchants SET country='CM' WHERE merchant_id=$1", [merchantId]);
  });

  test('pending collection credits nothing; callback replay persists fees and one settlement entry', async () => {
    const txn = await collection();
    expect((await balance()).available).toBe(0);
    expect(await confirm(txn)).toMatchObject({ applied: true });
    expect(await confirm(txn)).toMatchObject({ applied: false });
    expect((await balance()).available).toBe(24750);
    const row = await first('SELECT * FROM transactions WHERE transaction_id=$1', [txn.transaction_id]);
    expect(Number(row.fee_amount) + Number(row.net_amount)).toBe(Number(row.amount));
    expect((await sql('SELECT * FROM settlement_queue')).rows).toHaveLength(1);
    expect((await sql('SELECT * FROM transaction_events')).rows).toHaveLength(1);
  });

  test('explicit collection refusal followed by late success cannot credit the refused order', async () => {
    const txn = await collection();
    await finalizeTransaction({ txn, provider: 'mtn', outcome: 'failed', reason: 'refused' });
    expect(await confirm(txn)).toMatchObject({ applied: false });
    expect((await balance()).available).toBe(0);
    expect((await sql('SELECT * FROM settlement_queue')).rows).toHaveLength(0);
  });

  test.each(['SUCCESSFUL', 'FAILED'])('uncertain payout then NOT_FOUND then %s preserves balances across repeated reads', async status => {
    await confirm(await collection());
    mockSendPayout.mockResolvedValue({ approved: false, responseCode: '96', gatewayRef: 'original-ref' });
    const created = await payout();
    expect(created.transfer).toMatchObject({ status: 'unknown', amount: 10000, fee: 100, net: 9900 });
    const id = created.transfer.transferId;
    expect(await balance()).toMatchObject({ available: 14750, reserved: 10000 });
    mockMtnCountry.mockResolvedValue({ status: 'NOT_FOUND' });
    expect(await cash.refreshPayoutStatus(await cash.getTransfer(id), { graceMinutes: 0 }))
      .toMatchObject({ _statusCheck: 'not_found_after_grace' });
    expect(await balance()).toMatchObject({ available: 14750, reserved: 10000 });
    mockMtnCountry.mockResolvedValue({ status });
    await cash.refreshPayoutStatus(await cash.getTransfer(id));
    const terminal = await cash.getTransfer(id);
    expect(terminal.status).toBe(status === 'SUCCESSFUL' ? 'completed' : 'failed');
    for (let n = 0; n < 3; n++) await cash.refreshPayoutStatus(await cash.getTransfer(id));
    expect((await cash.getTransfer(id)).events).toHaveLength(terminal.events.length);
    expect(await balance()).toMatchObject({ available: status === 'SUCCESSFUL' ? 14750 : 24750, reserved: 0 });
    expect(mockSendPayout).toHaveBeenCalledTimes(1);
    expect(mockSendPayout).toHaveBeenCalledWith(expect.objectContaining({ txnId: id, amount: 9900 }));
    expect((await sql("SELECT * FROM merchant_transfers WHERE direction='payout'")).rows).toHaveLength(1);
  });

  test('timeout stays reserved and an insufficient new order never reaches the operator', async () => {
    await confirm(await collection());
    mockSendPayout.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    const created = await payout();
    expect(created.transfer.status).toBe('unknown');
    await cash.refreshPayoutStatus(await cash.getTransfer(created.transfer.transferId));
    const second = await payout(20000);
    expect(second.error.body.code).toBe('INSUFFICIENT_BALANCE');
    expect(await balance()).toMatchObject({ available: 14750, reserved: 10000 });
    expect(mockSendPayout).toHaveBeenCalledTimes(1);
  });

  test('verified bank transfer reserves gross, keeps fee/net and completes manually only once', async () => {
    await confirm(await collection());
    const accountId = uuid();
    await sql("INSERT INTO bank_accounts(account_id,owner_id,status,account_number,account_name) VALUES($1,$2,'verified','TEST','Test')", [accountId, merchantId]);
    const out = await cash.createPayout({ merchantId, destType: 'bank', accountId, amount: 5000 });
    expect(out.transfer).toMatchObject({ status: 'pending_manual', fee: 50, net: 4950 });
    expect(await balance()).toMatchObject({ available: 19750, reserved: 5000 });
    const args = { transferId: out.transfer.transferId, from: ['pending_manual'], to: 'completed', patch: { bankReference: 'BANK-TEST' } };
    expect(await cash.transitionTransfer(args)).toMatchObject({ status: 'completed' });
    expect(await cash.transitionTransfer(args)).toBeNull();
    expect(await balance()).toMatchObject({ available: 19750, reserved: 0 });
    expect(mockSendPayout).not.toHaveBeenCalled();
  });

  test('CDF collection and funding cannot increase an XAF merchant balance', async () => {
    await confirm(await collection());
    await sql("INSERT INTO transactions(transaction_id,merchant_id,type,status,amount,net_amount,currency) VALUES($1,$2,'collect','authorized',999999,999999,'CDF')", [uuid(), merchantId]);
    await sql("INSERT INTO merchant_transfers(merchant_id,direction,status,amount,currency) VALUES($1,'funding','completed',999999,'CDF')", [merchantId]);
    expect((await balance()).available).toBe(24750);
  });
};
