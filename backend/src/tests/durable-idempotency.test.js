'use strict';
const express = require('express');
const request = require('supertest');
const crypto = require('crypto');
const { PGlite } = require('@electric-sql/pglite');
let mockPg;
const mockQuery = async (...args) => { const r = await mockPg.query(...args); return { ...r, rowCount: r.affectedRows ?? r.rows.length }; };
jest.mock('../config/database', () => ({ query: (...a) => mockQuery(...a) }));
jest.mock('../config/logger', () => ({ warn: jest.fn(), error: jest.fn() }));
const { idempotency, MONEY_ENDPOINTS, _resetPurgeClock } = require('../middleware/idempotency');
const KEY = 'durable-intent-0001';
let effects;
let gate;
let entered;
const app = express();
app.use(express.json());
app.use((req, res, next) => { req.user = { merchantId: 'merchant-1' }; next(); });
for (const path of [...MONEY_ENDPOINTS, '/ordinary']) {
 app.post(path, idempotency, async (req, res) => {
  if (req.body.requireConfirmation && req.body.confirm?.password !== 'valid') return res.status(428).json({ code: 'STEP_UP_REQUIRED' });
  effects++; if (entered) entered(); if (gate) await gate; return res.status(201).json({ order: effects });
 });
}
const post = (path = '/cash/withdraw', body = { amount: 100 }, key = KEY) => {
 const r = request(app).post(path); if (key) r.set('Idempotency-Key', key); return r.send(body);
};
const flush = () => new Promise(r => setTimeout(r, 20));
beforeAll(async () => {
 mockPg = new PGlite();
 await mockPg.exec(`CREATE TABLE idempotency_keys (
 merchant_id TEXT, endpoint TEXT, key TEXT, request_hash TEXT, status_code INT, response_body JSONB,
 in_progress BOOLEAN DEFAULT TRUE, resource_type TEXT, resource_id TEXT, last_error TEXT, failed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ DEFAULT NOW(), completed_at TIMESTAMPTZ, PRIMARY KEY(merchant_id,endpoint,key));`);
});
beforeEach(async () => { await mockPg.exec('TRUNCATE idempotency_keys'); effects=0; gate=null; entered=null; _resetPurgeClock(); });
afterAll(async () => { await flush(); await mockPg.close(); });
test.each(MONEY_ENDPOINTS)('%s requires a key before effects', async path => {
 const r=await post(path,{},null); expect(r.status).toBe(400); expect(r.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED'); expect(effects).toBe(0);
});
test('ordinary requests accept no key', async () => { expect((await post('/ordinary',{},null)).status).toBe(201); });
test('confirmation can renew under same financial intent', async () => {
 const body={amount:100,requireConfirmation:true};
 expect((await post('/cash/withdraw',body)).status).toBe(428); await flush();
 expect((await post('/cash/withdraw',{...body,confirm:{password:'invalid'}})).status).toBe(428); await flush();
 const r=await post('/cash/withdraw',{...body,confirm:{password:'valid'}}); expect(r.status).toBe(201); await flush();
 expect((await post('/cash/withdraw',{...body,confirm:{password:'renewed'}})).body).toEqual(r.body); expect(effects).toBe(1);
});
test('object order does not change financial intent, business changes do', async () => {
 const body={amount:100,beneficiary:{phone:'123',currency:'XAF'}};
 const r=await post('/cash/withdraw',body); await flush();
 expect((await post('/cash/withdraw',{beneficiary:{currency:'XAF',phone:'123'},amount:100})).body).toEqual(r.body);
 expect((await post('/cash/withdraw',{...body,amount:101})).body.code).toBe('IDEMPOTENCY_CONFLICT'); expect(effects).toBe(1);
});
test.each([{status:null,progress:true},{status:null,progress:false},{status:201,progress:false}])('financial key survives TTL: %j',async row=>{
 await post(); await flush();
 await mockPg.query(`UPDATE idempotency_keys SET created_at=NOW()-INTERVAL '48 hours',status_code=$1,in_progress=$2`,[row.status,row.progress]);
 _resetPurgeClock(); await post('/ordinary',{},'trigger-purge-001'); await flush();
 expect([200,201,409]).toContain((await post()).status); expect(effects).toBe(2);
 expect((await mockPg.query(`SELECT * FROM idempotency_keys WHERE endpoint='POST /cash/withdraw'`)).rows).toHaveLength(1);
});
test('completed ordinary keys expire',async()=>{
 await post('/ordinary'); await flush(); await mockPg.exec(`UPDATE idempotency_keys SET created_at=NOW()-INTERVAL '48 hours'`);
 _resetPurgeClock(); await post('/ordinary',{},'trigger-purge-001'); await flush();
 expect((await mockPg.query('SELECT * FROM idempotency_keys WHERE key=$1',[KEY])).rows).toHaveLength(0);
});
test('legacy hashes replay exact requests and reject changed amount',async()=>{
 const body={amount:100,confirm:{password:'old'}};
 const hash=crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
 await mockPg.query(`INSERT INTO idempotency_keys(merchant_id,endpoint,key,request_hash,status_code,response_body,in_progress) VALUES ('merchant-1','POST /cash/withdraw',$1,$2,201,'{"order":42}',FALSE)`,[KEY,hash]);
 expect((await post('/cash/withdraw',body)).body.order).toBe(42);
 expect((await post('/cash/withdraw',{...body,amount:101})).status).toBe(409); expect(effects).toBe(0);
});

test('a challenge retains its business payload even before authentication', async () => {
 await post('/cash/withdraw',{amount:100,requireConfirmation:true});
 expect((await post('/cash/withdraw',{amount:101,requireConfirmation:true,confirm:{password:'valid'}})).body.code).toBe('IDEMPOTENCY_CONFLICT');
 expect(effects).toBe(0);
});
test.each([false,true])('concurrent submissions create one effect (renewed challenge=%s)', async challenge => {
 const body={amount:100,requireConfirmation:challenge};
 if(challenge) await post('/cash/withdraw',body);
 let release; gate=new Promise(resolve=>{release=resolve;});
 const started=new Promise(resolve=>{entered=resolve;});
 const first=post('/cash/withdraw',{...body,confirm:{password:'valid'}}).then(r=>r);
 await started;
 try {
   const second=await post('/cash/withdraw',{...body,confirm:{password:'valid'}});
   expect(second.status).toBe(409); expect(second.body.code).toBe('IDEMPOTENCY_IN_PROGRESS'); expect(effects).toBe(1);
 } finally { release(); }
 expect((await first).status).toBe(201); await flush();
 expect((await post('/cash/withdraw',{...body,confirm:{password:'new'}})).status).toBe(201); expect(effects).toBe(1);
});
