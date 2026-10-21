'use strict';
const { PGlite } = require('@electric-sql/pglite');
let mockPg;
const mockSql = async (...args) => {const r=await mockPg.query(...args);return{...r,rowCount:r.affectedRows??r.rows.length};};
jest.mock('../config/database',()=>({query:(...a)=>mockSql(...a),pool:{},withTransaction:fn=>mockPg.transaction(tx=>fn({query:async(...a)=>{const r=await tx.query(...a);return{...r,rowCount:r.affectedRows??r.rows.length};}}))}));
jest.mock('../config/logger',()=>({info:jest.fn(),warn:jest.fn(),error:jest.fn(),debug:jest.fn()}));
const { sweepAuthorizedWithoutQueue } = require('../services/settlement/settlement.repair');
const ID='11111111-1111-4111-8111-111111111111';
beforeAll(async()=>{mockPg=new PGlite();await mockPg.exec(`
CREATE TABLE transactions(transaction_id UUID PRIMARY KEY,merchant_id UUID,type TEXT,amount NUMERIC,currency TEXT,status TEXT,settlement_batch_id UUID,settlement_status TEXT,completed_at TIMESTAMPTZ,initiated_at TIMESTAMPTZ);
CREATE TABLE settlement_queue(id SERIAL PRIMARY KEY,transaction_id UUID UNIQUE,merchant_id UUID,amount NUMERIC,currency TEXT,queued_at TIMESTAMPTZ);
CREATE TABLE transaction_events(event_id SERIAL PRIMARY KEY,transaction_id UUID,merchant_id UUID,event_type TEXT,payload JSONB);`);},60000);
beforeEach(async()=>{await mockPg.exec('TRUNCATE transactions,settlement_queue,transaction_events');await mockPg.query(`INSERT INTO transactions VALUES($1,$1,'collect',1000,'XAF','authorized',NULL,NULL,NOW()-INTERVAL '1 hour',NOW()-INTERVAL '1 hour')`,[ID]);});
afterAll(async()=>{await mockPg.close();});
test('repair rolls back queue insertion if its audit event cannot commit',async()=>{
 await mockPg.exec(`CREATE FUNCTION deny_repair_trace() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'trace unavailable'; END $$; CREATE TRIGGER deny_repair_trace BEFORE INSERT ON transaction_events FOR EACH ROW EXECUTE FUNCTION deny_repair_trace();`);
 try {expect((await sweepAuthorizedWithoutQueue()).errors).toBe(1);expect((await mockPg.query('SELECT * FROM settlement_queue')).rows).toHaveLength(0);}
 finally{await mockPg.exec('DROP TRIGGER deny_repair_trace ON transaction_events; DROP FUNCTION deny_repair_trace()');}
 expect((await sweepAuthorizedWithoutQueue()).repaired).toBe(1);expect((await mockPg.query('SELECT * FROM transaction_events')).rows).toHaveLength(1);
});
test('concurrent repairs enqueue once with one trace, and repeated runs change nothing',async()=>{
 const runs=await Promise.all([sweepAuthorizedWithoutQueue(),sweepAuthorizedWithoutQueue()]);
 expect(runs.reduce((n,r)=>n+r.repaired,0)).toBe(1);expect((await mockPg.query('SELECT * FROM settlement_queue')).rows).toHaveLength(1);expect((await mockPg.query('SELECT * FROM transaction_events')).rows).toHaveLength(1);
 expect((await sweepAuthorizedWithoutQueue()).repaired).toBe(0);
});
