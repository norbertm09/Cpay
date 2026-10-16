'use strict';
jest.mock('../config/logger', () => ({ info:jest.fn(),warn:jest.fn(),error:jest.fn(),debug:jest.fn() }));
const mockQuery=jest.fn(); const mockClient={query:jest.fn()}; const mockRelease=jest.fn();
jest.mock('../config/database',()=>({query:(...a)=>mockQuery(...a),pool:{connect:async()=>({query:(...a)=>mockQuery(...a),release:(...a)=>mockRelease(...a)})},withTransaction:async fn=>fn(mockClient)}));
const mockMM={sendPayout:jest.fn()};
jest.mock('../services/mobilemoney/mobilemoney.router',()=>mockMM);
const {runSettlement}=require('../services/settlement/settlement.engine');
const svc=require('../services/settlement.service');
const rows=r=>({rows:r,rowCount:r.length});
const fixture=(over={})=>({id:1,transaction_id:'t1',amount:'1000',fee_amount:'15',net_amount:'985',payment_method:'mobile_money',settlement_type:'mobile_money',settlement_account:'+242061234567',country:'CG',...over});
function setup(items=[fixture()],available=10000){
 mockQuery.mockImplementation(async sql=>sql.includes('pg_try_advisory_lock')?rows([{ok:true}]):sql.includes('GROUP BY')?rows([{merchant_id:'m1',currency:'XAF'}]):rows([]));
 mockClient.query.mockImplementation(async sql=>{
  if(sql.includes('FROM settlement_queue'))return rows(items);
  if(sql.includes('AS collected'))return rows([{collected:available,settled:0}]);
  if(sql.includes('INSERT INTO settlement_batches'))return rows([{batch_id:'B1'}]);
  return rows([]);
 });
}
beforeEach(()=>{mockQuery.mockReset();mockClient.query.mockReset();mockMM.sendPayout.mockReset();mockRelease.mockReset();});
test('global lock acquisition and unlock stay on the same reserved connection',async()=>{
 setup();mockMM.sendPayout.mockResolvedValue({pending:true,gatewayRef:'MM-1'});
 expect(await runSettlement('2026-10-15')).toMatchObject({batches:1,settled:1,errors:0});
 expect(mockQuery.mock.calls[0][0]).toContain('pg_try_advisory_lock');
 expect(mockQuery.mock.calls.at(-1)[0]).toContain('pg_advisory_unlock');
 expect(mockRelease).toHaveBeenCalledWith(false);
 const insert=mockClient.query.mock.calls.find(([s])=>s.includes('INSERT INTO settlement_batches'));
 expect(insert[1].slice(2,5)).toEqual([1000,15,985]);
 expect(mockMM.sendPayout).toHaveBeenCalledWith(expect.objectContaining({amount:985,txnId:'SETTLE-B1'}));
 expect(mockClient.query.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
 expect(mockClient.query.mock.calls.some(([s])=>s.includes('UPDATE transactions SET settlement_batch_id'))).toBe(true);
});
test('busy global lock releases its connection without unlocking another run',async()=>{
 mockQuery.mockResolvedValue(rows([{ok:false}]));
 expect(await runSettlement()).toMatchObject({skipped:true});expect(mockQuery).toHaveBeenCalledTimes(1);expect(mockRelease).toHaveBeenCalledWith(false);
});
test('unlock failure destroys the connection instead of returning a held session lock to the pool',async()=>{
 setup([]);mockQuery.mockImplementation(async sql=>{if(sql.includes('pg_advisory_unlock'))throw new Error('disconnect');return sql.includes('pg_try')?rows([{ok:true}]):rows([]);});
 await runSettlement();expect(mockRelease).toHaveBeenCalledWith(true);
});
test('explicit provider rejection reserves a failed batch for manual reconciliation',async()=>{
 setup();mockMM.sendPayout.mockResolvedValue({approved:false,declineReason:'Refus'});await runSettlement();
 expect(mockQuery.mock.calls.find(([s])=>s.includes('UPDATE settlement_batches SET status'))[1].slice(0,2)).toEqual(['failed','Refus']);
});
test('bank batch stays pending and provider is never called',async()=>{
 setup([fixture({settlement_type:'bank'})]);await runSettlement();expect(mockMM.sendPayout).not.toHaveBeenCalled();
});
test('already withdrawn net is offset and never sent to a rail',async()=>{
 setup([fixture()],0);await runSettlement();expect(mockMM.sendPayout).not.toHaveBeenCalled();
 const insert=mockClient.query.mock.calls.find(([s])=>s.includes('INSERT INTO settlement_batches'));
 expect(insert[1][4]).toBe(0);expect(insert[1][10]).toBe(985);
});
test('legacy entry point excludes all historical uncertain/sent settlements',async()=>{
 mockQuery.mockResolvedValue(rows([]));expect(await svc.settleTransaction('t1')).toBeUndefined();
 expect(mockQuery.mock.calls[0][0]).toContain("NOT IN ('regle','soumis','en_cours','echec')");expect(mockMM.sendPayout).not.toHaveBeenCalled();
});
test('legacy entry point only enqueues, with a stable transaction identity',async()=>{
 mockQuery.mockResolvedValueOnce(rows([{transaction_id:'t1',merchant_id:'m1',amount:1000,currency:'XAF'}])).mockResolvedValue(rows([]));
 expect(await svc.settleTransaction('t1')).toMatchObject({ok:true,pending:true,mode:'j1_queue'});
 expect(mockQuery.mock.calls[1][0]).toContain('ON CONFLICT');expect(mockQuery.mock.calls[1][1]).toEqual(['t1','m1',1000,'XAF']);expect(mockMM.sendPayout).not.toHaveBeenCalled();
});
