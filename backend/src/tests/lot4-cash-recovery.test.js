'use strict';
// Real cash/reconciliation services and PostgreSQL SQL; only operator/SMTP boundaries are fake.
const { PGlite } = require('@electric-sql/pglite');
let mockPg;
const sql = async (...args) => { const r = await mockPg.query(...args); return { ...r, rowCount: r.affectedRows ?? r.rows.length }; };
jest.mock('../config/database', () => ({
  query: (...args) => sql(...args),
  withTransaction: fn => mockPg.transaction(tx => fn({ query: async (...args) => { const r = await tx.query(...args); return { ...r, rowCount: r.affectedRows ?? r.rows.length }; } })),
}));
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/auth', () => ({ verifyTotp: jest.fn() }));
const mockStatus = jest.fn();
const mockMtnCountry = jest.fn();
const mockAirtel = jest.fn();
const mockEmail = jest.fn();
let mockProvider, mockConfig;
jest.mock('../services/mobilemoney/mobilemoney.router', () => ({
  getProvider: () => mockProvider, getConfig: (...a) => mockConfig(...a),
  PROVIDERS: { orange_cm: true, moov_ci: true, airtel_cg: true, airtel_cd: true, mtn_cm: true, mtn_cg: true },
}));
jest.mock('../services/rails/mtn-momo.client', () => ({ getDisbursementStatus: (...a) => mockStatus(...a), getCollectionStatus: jest.fn() }));
jest.mock('../services/mobilemoney/providers/mtn.provider', () => ({ getTransferStatus: (...a) => mockMtnCountry(...a) }));
jest.mock('../services/mobilemoney/providers/airtel.provider', () => ({ queryDisbursement: (...a) => mockAirtel(...a) }));
jest.mock('../services/notifications/email.service', () => ({ send: (...a) => mockEmail(...a) }));
const cash = require('../services/cash/cash.service');
const reconcile = require('../services/reconcile.service');
const M = '11111111-1111-4111-8111-111111111111';
const uuid = () => require('crypto').randomUUID();
const first = async (...a) => (await sql(...a)).rows[0];
beforeAll(async () => {
  mockPg = new PGlite();
  await mockPg.exec(`
    CREATE TABLE merchants(merchant_id uuid PRIMARY KEY, country text, currency text, business_name text, email text, cash_wallet_phone text, cash_wallet_operator text, cash_wallet_verified_at timestamptz, updated_at timestamptz);
    CREATE TABLE financial_institutions(institution_id uuid PRIMARY KEY, name text);
    CREATE TABLE bank_accounts(account_id uuid PRIMARY KEY, institution_id uuid, account_number text, account_name text);
    CREATE TABLE merchant_transfers(transfer_id uuid PRIMARY KEY, merchant_id uuid, direction text DEFAULT 'payout', dest_type text DEFAULT 'wallet', bank_account_id uuid, wallet_operator text, wallet_phone text, status text DEFAULT 'unknown', amount numeric DEFAULT 50000, fee numeric DEFAULT 500, net_amount numeric DEFAULT 49500, currency text DEFAULT 'XAF', reference text, created_at timestamptz DEFAULT NOW() - INTERVAL '3 hours', updated_at timestamptz, completed_at timestamptz, cancelled_at timestamptz, settled_at timestamptz, events jsonb DEFAULT '[]', gateway_reference text, bank_reference text, settlement_ref text, error_message text, executed_by uuid, settled_by uuid, admin_note text, amount_requested numeric, request_payload jsonb, unknown_since timestamptz, needs_review boolean DEFAULT false, last_status_check_at timestamptz, review_alerted_at timestamptz);
    CREATE TABLE transactions(transaction_id uuid PRIMARY KEY, merchant_id uuid, type text, amount numeric DEFAULT 10000, currency text DEFAULT 'XAF', detected_operator text, detected_country text, gateway_name text, gateway_payment_id text, pay_link_id uuid, status text DEFAULT 'pending', initiated_at timestamptz DEFAULT NOW() - INTERVAL '3 hours', response_message text DEFAULT 'pending_unknown', gateway_order_id text, auth_code text, fee_amount numeric, net_amount numeric, completed_at timestamptz, settlement_batch_id uuid, settlement_status text, response_code text, payment_method text);
    CREATE TABLE transaction_events(event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), transaction_id uuid, merchant_id uuid, event_type text, payload jsonb, created_at timestamptz DEFAULT NOW());
    CREATE TABLE settlement_batches(merchant_id uuid, currency text, total_net numeric);
    CREATE FUNCTION calc_fee(uuid,text,text,numeric) RETURNS numeric LANGUAGE SQL AS $$ SELECT 0::numeric $$;
    CREATE FUNCTION cpay_calculate_fee(uuid,text,text,numeric,text) RETURNS numeric LANGUAGE SQL AS $$ SELECT 0::numeric $$;
  `);
}, 60000);
afterAll(async () => { await mockPg.close(); });
beforeEach(async () => {
  jest.clearAllMocks();
  mockProvider = { getStatus: (...args) => mockStatus(...args) };
  mockConfig = jest.fn(async () => ({ apiKey: 'key', apiSecret: 'secret', baseUrl: 'https://operator.invalid' }));
  mockStatus.mockReset().mockResolvedValue({ available: true, status: 'PENDING' });
  mockMtnCountry.mockReset().mockResolvedValue({ status: 'PENDING' });
  mockAirtel.mockReset().mockResolvedValue({ success: false, failed: false, pending: true, rawStatus: 'TIP' });
  mockEmail.mockReset().mockResolvedValue({ success: true });
  await mockPg.exec('TRUNCATE merchant_transfers, merchants, transactions, transaction_events, settlement_batches');
  await sql('INSERT INTO merchants(merchant_id,country,currency,business_name,email) VALUES($1,\'CG\',\'XAF\',\'Shop\',\'ops@example.test\')', [M]);
});
const transfer = async (extra = {}) => {
  const id = uuid();
  await sql(`INSERT INTO merchant_transfers(transfer_id,merchant_id,wallet_operator,wallet_phone,gateway_reference,reference) VALUES($1,$2,'mtn_momo','+242060000001','provider-ref',$3)`, [id, M, id]);
  for (const [key, value] of Object.entries(extra)) await sql(`UPDATE merchant_transfers SET ${key}=$2 WHERE transfer_id=$1`, [id, value]);
  return cash.getTransfer(id);
};
const balance = () => cash.computeAvailableBalance(sql, M);
test('NOT_FOUND after grace retains funds and requests review rather than declaring a refusal', async () => {
  const t = await transfer();
  mockStatus.mockResolvedValue({ status: 'NOT_FOUND' });
  const out = await cash.refreshPayoutStatus(t, { graceMinutes: 0 });
  expect(out).toMatchObject({ status: 'unknown', needs_review: true, _statusCheck: 'not_found_after_grace' });
  expect((await cash.getTransfer(t.transfer_id)).status).toBe('unknown');
  expect((await balance()).reserved).toBe(50000);
});
test.each(['SUCCESSFUL','FAILED'])('Airtel queryDisbursement %s resolves a real reserved order', async status => {
  const t = await transfer({ wallet_operator: 'airtel_money', wallet_phone: '+242050000001' });
  mockProvider = { queryDisbursement: (...a) => mockAirtel(...a) };
  mockAirtel.mockResolvedValue({ success: status === 'SUCCESSFUL', failed: status === 'FAILED', rawStatus: status === 'FAILED' ? 'TF' : 'TS', airtelMoneyId: 'airtel-final', message: 'operator refusal' });
  const out = await cash.refreshPayoutStatus(t);
  expect(out.status).toBe(status === 'FAILED' ? 'failed' : 'completed');
  expect((await balance()).reserved).toBe(0);
  expect((await cash.getTransfer(t.transfer_id)).events).toHaveLength(1);
  expect(mockAirtel.mock.calls[0][0]).toMatchObject({ txId: 'provider-ref', currency: 'XAF' });
});
test('Airtel without its generated operator reference cannot be queried using the internal transfer id', async () => {
  const t = await transfer({ wallet_operator: 'airtel_money', wallet_phone: '+242050000001', gateway_reference: null });
  mockProvider = { queryDisbursement: (...a) => mockAirtel(...a) };
  const out = await cash.refreshPayoutStatus(t);
  expect(out._statusCheck).toBe('no_reference');
  expect(mockAirtel).not.toHaveBeenCalled();
  expect((await cash.getTransfer(t.transfer_id)).last_status_check_at).toBeTruthy();
});
test('SMTP unsuccessful response releases the claim for another sweep', async () => {
  const t = await transfer({ gateway_reference: null });
  mockEmail.mockResolvedValueOnce({ success: false });
  await cash.sweepUncertainPayouts({ alertHours: 0 });
  expect((await cash.getTransfer(t.transfer_id)).review_alerted_at).toBeNull();
  await cash.sweepUncertainPayouts({ alertHours: 0 });
  expect(mockEmail).toHaveBeenCalledTimes(2);
});
test('SMTP failure releases the exact database claim even with PostgreSQL microsecond timestamps', async () => {
  const t = await transfer({ gateway_reference: null });
  // PostgreSQL NOW() has microseconds, whereas the JS Date returned by pg only has milliseconds.
  await mockPg.exec(`CREATE FUNCTION precise_alert_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.review_alerted_at IS NOT NULL THEN NEW.review_alerted_at := date_trunc('milliseconds',NEW.review_alerted_at) + INTERVAL '123 microseconds'; END IF;
    RETURN NEW; END $$;
    CREATE TRIGGER precise_alert_claim BEFORE UPDATE ON merchant_transfers FOR EACH ROW EXECUTE FUNCTION precise_alert_claim();`);
  try {
    mockEmail.mockRejectedValueOnce(new Error('SMTP down'));
    await cash.sweepUncertainPayouts({ alertHours: 0 });
    expect((await cash.getTransfer(t.transfer_id)).review_alerted_at).toBeNull();
    await cash.sweepUncertainPayouts({ alertHours: 0 });
    expect(mockEmail).toHaveBeenCalledTimes(2);
    expect((await cash.getTransfer(t.transfer_id)).events.filter(e => e.type === 'needs_review')).toHaveLength(1);
  } finally { await mockPg.exec('DROP TRIGGER precise_alert_claim ON merchant_transfers; DROP FUNCTION precise_alert_claim()'); }
});
test.each(['no_status_endpoint','no_reference','error'])('unresolved %s attempts record a check and remain reserved', async check => {
  const t = await transfer(check === 'no_reference' ? { gateway_reference: null } : { wallet_operator: 'orange_money', wallet_phone: '+237690000001' });
  if (check === 'no_status_endpoint') mockProvider = { sendPayout() {} };
  if (check === 'error') mockStatus.mockRejectedValue(new Error('ECONNRESET'));
  const out = await cash.refreshPayoutStatus(t);
  expect(out._statusCheck).toBe(check);
  expect((await cash.getTransfer(t.transfer_id)).last_status_check_at).toBeTruthy();
  expect((await balance()).reserved).toBe(50000);
});
test.each(['missing','error','not_found'])('foreign MTN %s never uses Congo credentials or releases its reservation', async kind => {
  await sql("UPDATE merchants SET country='CM' WHERE merchant_id=$1", [M]);
  const t = await transfer({ wallet_phone: '+237670000001' });
  if (kind === 'missing') mockConfig.mockResolvedValue({});
  if (kind === 'error') mockMtnCountry.mockRejectedValue(new Error('network'));
  if (kind === 'not_found') mockMtnCountry.mockRejectedValue(Object.assign(new Error('404'), { statusCode: 404 }));
  // The wrong rail answers FAILED, so a fallback visibly and incorrectly releases funds.
  mockStatus.mockResolvedValue({ status: 'FAILED' });
  await cash.refreshPayoutStatus(t, { graceMinutes: 0 });
  expect((await cash.getTransfer(t.transfer_id)).status).toBe('unknown');
  expect((await balance()).reserved).toBe(50000);
  expect(mockStatus).not.toHaveBeenCalled();
});
test('cash recovery includes old processing rows, deduplicates simultaneous alerts and retries SMTP failures without duplicate review events', async () => {
  const t = await transfer({ status: 'processing', created_at: '2025-01-01T00:00:00Z', gateway_reference: null });
  mockEmail.mockRejectedValueOnce(new Error('SMTP down'));
  const one = await cash.sweepUncertainPayouts({ alertHours: 0 });
  expect(one.summary.scanned).toBe(1);
  expect((await cash.getTransfer(t.transfer_id))).toMatchObject({ needs_review: true, review_alerted_at: null });
  await Promise.all([cash.sweepUncertainPayouts({ alertHours: 0 }), cash.sweepUncertainPayouts({ alertHours: 0 })]);
  const row = await cash.getTransfer(t.transfer_id);
  expect(row.review_alerted_at).toBeTruthy();
  expect(row.events.filter(e => e.type === 'needs_review')).toHaveLength(1);
  expect(mockEmail).toHaveBeenCalledTimes(2); // one failed send, one successful retry
});
test('late provider result cannot reflag a concurrently completed transfer or send an obsolete alert', async () => {
  const t = await transfer();
  mockStatus.mockImplementation(async () => {
    await cash.transitionTransfer({ transferId: t.transfer_id, from: ['unknown'], to: 'completed' });
    return { status: 'PENDING' };
  });
  await cash.sweepUncertainPayouts({ alertHours: 0 });
  const row = await cash.getTransfer(t.transfer_id);
  expect(row).toMatchObject({ status: 'completed', needs_review: false });
  expect(row.events.filter(e => e.type === 'needs_review')).toHaveLength(0);
  expect(mockEmail).not.toHaveBeenCalled();
});
test('bounded sweeps rotate past checked stuck rows instead of starving the next payout', async () => {
  const a = await transfer({ created_at: '2025-01-01T00:00:00Z', gateway_reference: null });
  const b = await transfer({ created_at: '2025-01-02T00:00:00Z', gateway_reference: null });
  await cash.sweepUncertainPayouts({ limit: 1 });
  await cash.sweepUncertainPayouts({ limit: 1 });
  expect((await cash.getTransfer(a.transfer_id)).last_status_check_at).toBeTruthy();
  expect((await cash.getTransfer(b.transfer_id)).last_status_check_at).toBeTruthy();
});
const pendingTxn = async (ref = 'operator-ref') => {
  const id = uuid();
  await sql(`INSERT INTO transactions(transaction_id,merchant_id,type,detected_operator,detected_country,gateway_payment_id,initiated_at) VALUES($1,$2,'payout','MTN_MOMO','CG',$3,NOW()-INTERVAL '60 days')`, [id,M,ref]);
  return id;
};
test('already alerted old pending_unknown payouts continue polling until definitive provider completion', async () => {
  const id = await pendingTxn();
  await sql(`INSERT INTO transaction_events(transaction_id,merchant_id,event_type,payload) VALUES($1,$2,'PAYOUT_NEEDS_REVIEW','{}')`, [id,M]);
  mockStatus.mockResolvedValue({ status: 'SUCCESSFUL', amount: 10000, currency: 'XAF' });
  mockMtnCountry.mockResolvedValue({ status: 'SUCCESSFUL', amount: 10000, currency: 'XAF' });
  const r = await reconcile.reconcileUncertainPayouts();
  expect(r.transactions.scanned).toBe(1);
  expect((await first('SELECT status FROM transactions WHERE transaction_id=$1',[id])).status).toBe('authorized');
  expect(mockEmail).not.toHaveBeenCalled();
});
test('transaction review notification claims are deduplicated and SMTP failure can retry the same event', async () => {
  const id = await pendingTxn(null);
  mockEmail.mockRejectedValueOnce(new Error('SMTP down'));
  await reconcile.reconcileUncertainPayouts({ alertHours: 0 });
  await Promise.all([reconcile.reconcileUncertainPayouts({ alertHours: 0 }), reconcile.reconcileUncertainPayouts({ alertHours: 0 })]);
  expect((await first(`SELECT COUNT(*)::int AS n FROM transaction_events WHERE transaction_id=$1 AND event_type='PAYOUT_NEEDS_REVIEW'`,[id])).n).toBe(1);
  expect(mockEmail).toHaveBeenCalledTimes(2);
});
test('transaction alert guard sees concurrent provider finalization before recording review', async () => {
  const id = await pendingTxn();
  mockStatus.mockImplementation(async () => { await sql("UPDATE transactions SET status='authorized' WHERE transaction_id=$1",[id]); return { status: 'PENDING' }; });
  mockMtnCountry.mockImplementation(async () => { await sql("UPDATE transactions SET status='authorized' WHERE transaction_id=$1",[id]); return { status: 'PENDING' }; });
  await reconcile.reconcileUncertainPayouts({ alertHours: 0 });
  expect((await first(`SELECT COUNT(*)::int AS n FROM transaction_events WHERE transaction_id=$1 AND event_type='PAYOUT_NEEDS_REVIEW'`,[id])).n).toBe(0);
  expect(mockEmail).not.toHaveBeenCalled();
});
test('foreign transaction status network errors do not consult the Congo rail', async () => {
  const id = await pendingTxn();
  await sql("UPDATE transactions SET detected_country='CM', initiated_at=NOW()-INTERVAL '3 hours' WHERE transaction_id=$1",[id]);
  mockMtnCountry.mockRejectedValue(new Error('ECONNRESET'));
  mockStatus.mockResolvedValue({ status: 'FAILED' });
  await reconcile.reconcileUncertainPayouts();
  expect((await first('SELECT status FROM transactions WHERE transaction_id=$1',[id])).status).toBe('pending');
  expect(mockStatus).not.toHaveBeenCalled();
});
test.each(['SUCCESSFUL','FAILED'])('terminal cash poll %s advances its durable check time and clears review', async status => {
  const t = await transfer({ needs_review: true, last_status_check_at: '2025-01-01T00:00:00Z' });
  mockStatus.mockResolvedValue({ status });
  await cash.refreshPayoutStatus(t);
  const row = await cash.getTransfer(t.transfer_id);
  expect(row.needs_review).toBe(false);
  expect(new Date(row.last_status_check_at).getTime()).toBeGreaterThan(Date.parse('2025-01-01T00:00:00Z'));
});
test.each([
  ['expired', 'sending', '2025-01-01T00:00:00Z', 1],
  ['active', 'sending', null, 0],
  ['delivered', 'sent', '2025-01-01T00:00:00Z', 0],
  ['legacy', null, '2025-01-01T00:00:00Z', 0],
])('cash %s notification claim recovers without resending active or delivered alerts', async (_name, state, attemptAt, sends) => {
  const events = [{ type: 'needs_review', reason: 'old unresolved payout' }];
  if (state) events.push({ type: 'review_notification', state, attemptAt: attemptAt || new Date().toISOString(), token: 'previous-worker' });
  const t = await transfer({ gateway_reference: null, needs_review: true, review_alerted_at: attemptAt || new Date().toISOString(), events: JSON.stringify(events) });
  await Promise.all([cash.sweepUncertainPayouts({ alertHours: 0 }),cash.sweepUncertainPayouts({ alertHours: 0 })]);
  const row = await cash.getTransfer(t.transfer_id);
  expect(mockEmail).toHaveBeenCalledTimes(sends);
  expect(row.events.filter(e => e.type === 'needs_review')).toHaveLength(1);
  if (sends) {
    expect(row.events.filter(e => e.type === 'review_notification')).toHaveLength(1);
    expect(row.events.find(e => e.type === 'review_notification').state).toBe('sent');
  }
});
test('Congo-Kinshasa Airtel payout status uses original-country config rather than Congo-Brazzaville credentials', async () => {
  const id = await pendingTxn();
  await sql("UPDATE transactions SET detected_operator='AIRTEL_MONEY', detected_country='CD',gateway_name='airtel_cd',currency='CDF' WHERE transaction_id=$1",[id]);
  mockConfig.mockImplementation(async key => ({ providerKey: key, apiKey: 'key', apiSecret: 'secret', baseUrl: 'https://operator.invalid' }));
  mockAirtel.mockImplementation(async ({ config }) => ({ success: config.providerKey === 'airtel_cd', failed: config.providerKey !== 'airtel_cd', airtelMoneyId: 'airtel-final' }));
  await reconcile.reconcileUncertainPayouts();
  expect((await first('SELECT status FROM transactions WHERE transaction_id=$1',[id])).status).toBe('authorized');
  expect(mockAirtel.mock.calls[0][0]).toMatchObject({ currency: 'CDF', config: { providerKey: 'airtel_cd' } });
});
test('bounded transaction recovery rotates past a previously checked unqueryable order', async () => {
  const a = await pendingTxn(null);
  const b = await pendingTxn(null);
  await reconcile.reconcileUncertainPayouts({ limit: 1 });
  await reconcile.reconcileUncertainPayouts({ limit: 1 });
  const r = await sql("SELECT transaction_id FROM transaction_events WHERE event_type='PAYOUT_RECOVERY_CHECK'");
  expect(r.rows.map(t => t.transaction_id).sort()).toEqual([a,b].sort());
});
test('merchant serialization exposes recovery metadata without operator request, event history or full bank number', async () => {
  const t = await transfer({ needs_review: true, unknown_since: '2025-01-01T00:00:00Z',last_status_check_at: '2025-01-02T00:00:00Z',request_payload: JSON.stringify({ private: 'operator-request' }) });
  const bank = { ...t, dest_type: 'bank', account_number: '123456789012345', account_name: 'Shop', inst_name: 'Bank', events: [{ private: 'history' }] };
  const merchant = cash.serializeTransfer(bank);
  expect(merchant).toMatchObject({ needsReview: true, unknownSince: t.unknown_since, lastStatusCheckAt: t.last_status_check_at });
  expect(merchant).not.toHaveProperty('requestPayload');
  expect(merchant).not.toHaveProperty('events');
  expect(merchant.bankAccount).not.toHaveProperty('accountNumber');
  expect(merchant.bankAccount.accountMasked.endsWith('2345')).toBe(true);
  expect(cash.serializeTransfer(bank,{admin:true})).toMatchObject({requestPayload:{private:'operator-request'},events:[{private:'history'}],bankAccount:{accountNumber:'123456789012345'}});
});
test.each([['GA','XAF'],['CG','CDF'],['CD','XAF']])('unsupported Airtel cash country/currency %s/%s never queries a different country account', async (country,currency) => {
  const t = await transfer({ wallet_operator: 'airtel_money', wallet_phone: '+242050000001',currency,request_payload:JSON.stringify({gateway:`airtel_${country.toLowerCase()}`}) });
  mockProvider = { queryDisbursement: (...a) => mockAirtel(...a) };
  mockAirtel.mockResolvedValue({success:false,failed:true});
  const out = await cash.refreshPayoutStatus(t);
  expect(out).toMatchObject({status:'unknown',_statusCheck:'status_unavailable'});
  expect(mockAirtel).not.toHaveBeenCalled();
});
test.each([['GA','XAF'],['CG','CDF'],['CD','XAF']])('unsupported Airtel transaction country/currency %s/%s never queries a different country account', async (country,currency) => {
  const id = await pendingTxn();
  await sql("UPDATE transactions SET detected_operator='AIRTEL_MONEY',detected_country=$2,gateway_name=$3,currency=$4 WHERE transaction_id=$1",[id,country,`airtel_${country.toLowerCase()}`,currency]);
  mockAirtel.mockResolvedValue({success:false,failed:true});
  await reconcile.reconcileUncertainPayouts({alertHours:0});
  expect((await first('SELECT status FROM transactions WHERE transaction_id=$1',[id])).status).toBe('pending');
  expect(mockAirtel).not.toHaveBeenCalled();
});
test.each(['mtn','airtel'])('cash original paymenthub_%s reference never reaches direct operator credentials', async operator => {
  const t = await transfer({ wallet_operator: operator === 'mtn' ? 'mtn_momo' : 'airtel_money',wallet_phone:operator === 'mtn' ? '+242060000001' : '+242050000001',request_payload:JSON.stringify({gateway:`paymenthub_${operator}_cg`,rail:'router'}) });
  mockStatus.mockResolvedValue({status:'FAILED'});
  mockMtnCountry.mockResolvedValue({status:'FAILED'});
  mockProvider = { queryDisbursement:(...a)=>mockAirtel(...a) };
  mockAirtel.mockResolvedValue({success:false,failed:true});
  const out = await cash.refreshPayoutStatus(t);
  expect(out).toMatchObject({status:'unknown',_statusCheck:'original_gateway_unsupported'});
  expect((await balance()).reserved).toBe(50000);
  expect(mockStatus).not.toHaveBeenCalled(); expect(mockMtnCountry).not.toHaveBeenCalled(); expect(mockAirtel).not.toHaveBeenCalled();
});
test.each(['mtn','airtel'])('transaction original paymenthub_%s reference never reaches direct operator credentials', async operator => {
  const id = await pendingTxn();
  await sql('UPDATE transactions SET detected_operator=$2,gateway_name=$3 WHERE transaction_id=$1',[id,operator === 'mtn' ? 'MTN_MOMO':'AIRTEL_MONEY',`paymenthub_${operator}_cg`]);
  mockStatus.mockResolvedValue({status:'FAILED'}); mockMtnCountry.mockResolvedValue({status:'FAILED'});mockAirtel.mockResolvedValue({success:false,failed:true});
  const r = await reconcile.reconcileUncertainPayouts({alertHours:0});
  expect((await first('SELECT status FROM transactions WHERE transaction_id=$1',[id])).status).toBe('pending');
  expect(r.transactions.results[0]).toMatchObject({skipped:'original_gateway_unsupported',needsReview:true});
  expect(mockStatus).not.toHaveBeenCalled(); expect(mockMtnCountry).not.toHaveBeenCalled(); expect(mockAirtel).not.toHaveBeenCalled();
});
test('explicit saved mtn_client rail retains the Congo status path for legacy orders', async () => {
  const t = await transfer({request_payload:JSON.stringify({rail:'mtn_client',gateway:'legacy_gateway'})});
  mockStatus.mockResolvedValue({status:'SUCCESSFUL'});
  expect((await cash.refreshPayoutStatus(t)).status).toBe('completed');
});
test.each(['mtn','mtn_momo','MTN_MOMO'])('known direct legacy gateway %s remains queryable', async gateway => {
  const id = await pendingTxn();
  await sql('UPDATE transactions SET gateway_name=$2 WHERE transaction_id=$1',[id,gateway]);
  mockMtnCountry.mockResolvedValue({status:'SUCCESSFUL',amount:10000,currency:'XAF'});
  await reconcile.reconcileUncertainPayouts();
  expect((await first('SELECT status FROM transactions WHERE transaction_id=$1',[id])).status).toBe('authorized');
});
test.each(['airtel','airtel_money','AIRTEL_MONEY'])('known direct legacy Airtel gateway %s remains queryable', async gateway => {
  const id = await pendingTxn();
  await sql("UPDATE transactions SET detected_operator='AIRTEL_MONEY',gateway_name=$2 WHERE transaction_id=$1",[id,gateway]);
  mockAirtel.mockResolvedValue({success:true,failed:false,airtelMoneyId:'airtel-final'});
  await reconcile.reconcileUncertainPayouts();
  expect((await first('SELECT status FROM transactions WHERE transaction_id=$1',[id])).status).toBe('authorized');
});
test('MTN transaction without original country or gateway remains reserved rather than assuming Congo', async () => {
  const id = await pendingTxn();
  await sql('UPDATE transactions SET detected_country=NULL,gateway_name=NULL WHERE transaction_id=$1',[id]);
  mockStatus.mockResolvedValue({status:'SUCCESSFUL',amount:10000,currency:'XAF'});
  mockMtnCountry.mockResolvedValue({status:'SUCCESSFUL',amount:10000,currency:'XAF'});
  await reconcile.reconcileUncertainPayouts();
  expect((await first('SELECT status FROM transactions WHERE transaction_id=$1',[id])).status).toBe('pending');
  expect(mockStatus).not.toHaveBeenCalled(); expect(mockMtnCountry).not.toHaveBeenCalled();
});
test.each([
  ['paymenthub_moov_ci','CI','original_gateway_unsupported'],
  ['moov_money','GA','country_unavailable'],
])('wave2 original %s/%s cannot fall back to the first direct country account', async (gateway,country,skipped) => {
  const id = await pendingTxn();
  await sql("UPDATE transactions SET detected_operator='MOOV_MONEY',detected_country=$2,gateway_name=$3 WHERE transaction_id=$1",[id,country,gateway]);
  mockStatus.mockResolvedValue({available:true,status:'FAILED'});
  const r = await reconcile.reconcileUncertainPayouts({alertHours:0});
  expect((await first('SELECT status FROM transactions WHERE transaction_id=$1',[id])).status).toBe('pending');
  expect(r.transactions.results[0]).toMatchObject({skipped,needsReview:true});
  expect(mockStatus).not.toHaveBeenCalled();
});
test('wave2 legacy direct Moov alias with a registered country remains queryable', async () => {
  const id = await pendingTxn();
  await sql("UPDATE transactions SET detected_operator='MOOV_MONEY',detected_country='CI',gateway_name='moov_money' WHERE transaction_id=$1",[id]);
  const r = await reconcile.reconcileUncertainPayouts();
  expect(r.transactions.results[0]).toMatchObject({still:'pending',providerStatus:'PENDING'});
  expect(mockStatus).toHaveBeenCalledTimes(1);
});
test('cash original paymenthub Moov reference never uses an unsupported aggregator status contract', async () => {
  const t = await transfer({wallet_operator:'moov_money',wallet_phone:'+2250100000000',currency:'XOF',request_payload:JSON.stringify({gateway:'paymenthub_moov_ci',rail:'router'})});
  mockStatus.mockResolvedValue({available:true,status:'FAILED'});
  const out = await cash.refreshPayoutStatus(t);
  expect(out).toMatchObject({status:'unknown',_statusCheck:'original_gateway_unsupported'});
  expect(mockStatus).not.toHaveBeenCalled();
});
