'use strict';
// PostgreSQL engine (WASM), real SQL/transactions. No remote DB or financial network calls.
process.env.NODE_ENV = 'test';
const fs = require('fs');
const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const bcrypt = require('bcryptjs');
let mockPg;
const mockSql = async (sql, params) => {
  const r = await mockPg.query(sql, params);
  return { ...r, rowCount: r.affectedRows ?? r.rows.length };
};
jest.mock('../config/database', () => ({
  query: (...args) => mockSql(...args),
  pool: { connect: async () => ({ query: (...args) => mockSql(...args), release: () => {} }) },
  withTransaction: async fn => mockPg.transaction(async tx => fn({ query: async (...args) => {
    const r = await tx.query(...args); return { ...r, rowCount: r.affectedRows ?? r.rows.length };
  } })),
}));
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/mobilemoney/mobilemoney.router', () => ({ sendPayout: jest.fn(), processPayment: jest.fn() }));
jest.mock('../services/integrations/integration.service', () => ({ deliverEvent: jest.fn(async () => {}) }));
jest.mock('../services/fraud/fraud.engine', () => ({ evaluate: jest.fn(async () => ({ action: 'allow' })) }));
const payments = require('../services/cardholder-payment.service');
const cash = require('../services/cash/cash.service');
const { runSettlement } = require('../services/settlement/settlement.engine');
const { settleTransaction } = require('../services/settlement.service');
const orchestrator = require('../services/orchestration/orchestrator');
const mm = require('../services/mobilemoney/mobilemoney.router');
const M = '11111111-1111-4111-8111-111111111111';
const CH = '22222222-2222-4222-8222-222222222222';
const CARD = '33333333-3333-4333-8333-333333333333';
const LINK = '44444444-4444-4444-8444-444444444444';
const pay = extra => payments.pay({ cardholderId: CH, cardId: CARD, merchantId: M, amount: 1000, pin: '1234', key: 'audit-payment-key', ip: '127.0.0.1', ...extra });
const migration = fs.readFileSync(path.resolve(__dirname,'../../database/010_audit_financial_integrity.sql'),'utf8');
beforeAll(async () => {
  mockPg = new PGlite();
  await mockPg.exec(`
    CREATE TABLE merchants (merchant_id uuid PRIMARY KEY, business_name text, currency text, country text, kyb_level int DEFAULT 0, merchant_status text DEFAULT 'active', settlement_type text DEFAULT 'bank', settlement_account text DEFAULT 'BANK', settlement_provider text);
    CREATE TABLE settlement_batches (batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid, batch_date date, total_gross numeric,total_fees numeric,total_net numeric,currency text,txn_count int,settlement_type text,settlement_account text,settlement_provider text,status text,completed_at timestamptz,submitted_at timestamptz,failure_reason text,payout_ref text);
    CREATE TABLE transactions (transaction_id uuid PRIMARY KEY,merchant_id uuid,type text,amount numeric,currency text,payment_method text,status text,fee_amount numeric,net_amount numeric,gateway_name text,gateway_payment_id text,gateway_order_id text,auth_code text,description text,initiated_at timestamptz DEFAULT NOW(),completed_at timestamptz,settlement_status text,settlement_batch_id uuid REFERENCES settlement_batches(batch_id),pay_link_id uuid,detected_operator text,detected_network text,detected_country text,device_id text,response_code text,response_message text);
    CREATE TABLE settlement_queue (id serial PRIMARY KEY,transaction_id uuid UNIQUE REFERENCES transactions(transaction_id),merchant_id uuid,amount numeric,currency text,queued_at timestamptz DEFAULT NOW(),settled boolean DEFAULT false,batch_id uuid REFERENCES settlement_batches(batch_id),settled_at timestamptz,fee_amount numeric,net_amount numeric);
    CREATE TABLE merchant_transfers (merchant_id uuid,direction text,status text,amount numeric,currency text DEFAULT 'XAF');
    CREATE TABLE merchant_fees (merchant_id uuid,txn_type text,operator text,fee_rate numeric);
    CREATE TABLE virtual_cards (card_id uuid PRIMARY KEY,cardholder_id uuid,status text,balance numeric,currency text,pin_hash text,updated_at timestamptz,daily_limit numeric,monthly_limit numeric);
    CREATE TABLE card_transactions (txn_id uuid PRIMARY KEY,card_id uuid,cardholder_id uuid,type text,amount numeric,fee numeric,net_amount numeric,balance_before numeric,balance_after numeric,currency text,status text,description text,merchant_name text,merchant_id uuid,auth_code text,initiated_at timestamptz,completed_at timestamptz);
    CREATE TABLE pin_attempts (card_id uuid,ip_address text,success boolean);
    CREATE TABLE transaction_events (transaction_id uuid,merchant_id uuid,event_type text,payload jsonb);
  `);
  await mockPg.exec(migration);
}, 60000);
afterAll(async () => { if (mockPg) await mockPg.close(); });
beforeEach(async () => {
  jest.clearAllMocks();
  await mockPg.exec('TRUNCATE cardholder_payment_requests,card_transactions,pin_attempts,virtual_cards,transaction_events,settlement_queue,transactions,settlement_batches,merchant_transfers,merchant_fees,merchants CASCADE');
  await mockPg.query("INSERT INTO merchants (merchant_id,business_name,currency,country) VALUES ($1,'Boutique','XAF','CG')", [M]);
  await mockPg.query("INSERT INTO virtual_cards VALUES ($1,$2,'active',10000,'XAF',$3,NULL,50000,500000)", [CARD,CH,bcrypt.hashSync('1234',4)]);
});
test('migration is replayable and rejects duplicate active pay-link attempts', async () => {
  await mockPg.exec(migration);
  const insert = id => mockPg.query("INSERT INTO transactions (transaction_id,merchant_id,type,amount,currency,status,pay_link_id) VALUES ($1,$2,'collect',1000,'XAF','pending',$3)", [id,M,LINK]);
  await insert(CARD);
  await expect(insert(CH)).rejects.toMatchObject({ code: '23505' });
  await mockPg.query("UPDATE transactions SET status='failed' WHERE transaction_id=$1",[CARD]);
  await expect(insert(CH)).resolves.toBeDefined();
});
test('atomic wallet payment credits merchant, charges numeric fee once, and replays concurrently', async () => {
  const [first, replay] = await Promise.all([pay(),pay()]);
  expect(first.merchantTxnId).toBe(replay.merchantTxnId);
  expect(first.newBalance).toBe(8995);
  expect((await mockSql('SELECT COUNT(*)::int AS n FROM card_transactions')).rows[0].n).toBe(1);
  expect((await cash.computeAvailableBalance(mockSql,M)).available).toBe(1000);
  await expect(pay({ amount: 1001 })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
});
test.each(['1000',NaN,Infinity,-1,0,{},[1000]])('rejects nonnumeric or invalid amount %p without debit', async amount => {
  await expect(pay({ amount })).rejects.toMatchObject({ statusCode: 422 });
  expect((await mockSql('SELECT balance FROM virtual_cards')).rows[0].balance).toBe('10000');
});
test('foreign merchant currency and inactive merchant never debit the payer', async () => {
  await mockPg.query("UPDATE merchants SET currency='XOF' WHERE merchant_id=$1",[M]);
  await expect(pay()).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });
  await mockPg.query("UPDATE merchants SET currency='XAF',merchant_status='suspended' WHERE merchant_id=$1",[M]);
  await expect(pay()).rejects.toMatchObject({ code: 'MERCHANT_INACTIVE' });
  expect((await mockSql('SELECT COUNT(*)::int AS n FROM cardholder_payment_requests')).rows[0].n).toBe(0);
});
test('failure to credit the merchant rolls back payer debit and the retry key', async () => {
  await mockPg.exec("ALTER TABLE transactions ADD CONSTRAINT test_refuse_credit CHECK (gateway_name <> 'cpay_wallet')");
  try {
    await expect(pay()).rejects.toBeDefined();
    expect((await mockSql('SELECT balance FROM virtual_cards')).rows[0].balance).toBe('10000');
    expect((await mockSql('SELECT COUNT(*)::int AS n FROM card_transactions')).rows[0].n).toBe(0);
    expect((await mockSql('SELECT COUNT(*)::int AS n FROM cardholder_payment_requests')).rows[0].n).toBe(0);
  } finally { await mockPg.exec('ALTER TABLE transactions DROP CONSTRAINT test_refuse_credit'); }
});
test('withdrawal before J+1 is offset; the same collection cannot be paid twice', async () => {
  await pay();
  await mockPg.query("INSERT INTO merchant_transfers (merchant_id,direction,status,amount) VALUES ($1,'payout','pending_manual',700)",[M]);
  expect((await cash.computeAvailableBalance(mockSql,M)).available).toBe(300);
  const result = await runSettlement('2099-01-01');
  expect(result).toMatchObject({ batches: 1, errors: 0 });
  const batch = (await mockSql('SELECT * FROM settlement_batches')).rows[0];
  expect(Number(batch.total_net)).toBe(300); expect(Number(batch.cash_offset_amount)).toBe(700);
  expect((await cash.computeAvailableBalance(mockSql,M)).available).toBe(0);
  expect(await runSettlement('2099-01-01')).toMatchObject({ batches: 0 });
  expect(mm.sendPayout).not.toHaveBeenCalled(); // bank processing is manual
});
test('J+1 before withdrawal reserves the entire net, even if its bank batch is later rejected', async () => {
  await pay(); await runSettlement('2099-01-01');
  expect((await cash.computeAvailableBalance(mockSql,M)).available).toBe(0);
  await mockPg.exec("UPDATE settlement_batches SET status='failed'");
  expect((await cash.computeAvailableBalance(mockSql,M)).available).toBe(0);
});
test('legacy instant entry point only enqueues once and never sends a second payout', async () => {
  const out = await pay();
  await settleTransaction(out.merchantTxnId); await settleTransaction(out.merchantTxnId);
  expect((await mockSql('SELECT COUNT(*)::int AS n FROM settlement_queue')).rows[0].n).toBe(1);
  expect(mm.sendPayout).not.toHaveBeenCalled();
});
test('orchestrated authorization persists fees/net and pending never masquerades as success', async () => {
  mm.processPayment.mockResolvedValueOnce({ approved: true, authCode: 'OK' });
  const a = await orchestrator.processTransaction({ merchantId: M,type:'collect',amount:1000,customerPhone:'+242061234567' });
  expect(a).toMatchObject({ success:true,pending:false,status:'authorized' });
  const t = (await mockPg.query('SELECT fee_amount,net_amount FROM transactions WHERE transaction_id=$1',[a.txnId])).rows[0];
  expect(Number(t.fee_amount)).toBe(15); expect(Number(t.net_amount)).toBe(985);
  mm.processPayment.mockResolvedValueOnce({ pending: true, approved:false });
  expect(await orchestrator.processTransaction({ merchantId:M,type:'collect',amount:1000,customerPhone:'+242061234567' })).toMatchObject({ success:false,pending:true,status:'pending' });
});
test('configured merchant fee takes precedence and null historical nets are not repriced by migration', async () => {
  await mockPg.query("INSERT INTO merchant_fees VALUES ($1,'collect','test',0.02)",[M]);
  expect(Number((await mockPg.query("SELECT cpay_calculate_fee($1,'collect','test',1000) AS fee",[M])).rows[0].fee)).toBe(20);
  await mockPg.query("INSERT INTO transactions (transaction_id,merchant_id,type,amount,status,currency) VALUES ($1,$2,'collect',1000,'authorized','XAF')",[CARD,M]);
  await mockPg.exec(migration);
  expect((await mockPg.query('SELECT net_amount FROM transactions WHERE transaction_id=$1',[CARD])).rows[0].net_amount).toBeNull();
});

test('invalid merchant tariff is refused before any provider debit', async () => {
  await mockPg.query("INSERT INTO merchant_fees VALUES ($1,'collect',NULL,1.5)",[M]);
  await expect(orchestrator.processTransaction({merchantId:M,type:'collect',amount:1000,customerPhone:'+242061234567'})).rejects.toBeDefined();
  expect(mm.processPayment).not.toHaveBeenCalled();
});
test('a concurrent active link attempt is refused before a second provider request', async () => {
  mm.processPayment.mockResolvedValue({pending:true,approved:false});
  const params={merchantId:M,type:'collect',amount:1000,customerPhone:'+242061234567',payLinkId:LINK};
  expect(await orchestrator.processTransaction(params)).toMatchObject({pending:true});
  await expect(orchestrator.processTransaction(params)).rejects.toMatchObject({statusCode:409,code:'PAYMENT_IN_PROGRESS'});
  expect(mm.processPayment).toHaveBeenCalledTimes(1);
});
