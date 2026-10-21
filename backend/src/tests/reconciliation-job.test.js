'use strict';
const { createReconciliationJob } = require('../services/reconciliation-job');
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
let locked, clients, pool, stages;
const flush = () => new Promise(resolve => setImmediate(resolve));
beforeEach(() => {
 locked=false; clients=[];
 pool={options:{max:4},connect:jest.fn(async()=>{
  const client={release:jest.fn(),query:jest.fn(async sql=>{
   if(sql.includes('pg_try_advisory_lock')){const acquired=!locked; if(acquired)locked=true;return{rows:[{acquired}]};}
   if(sql.includes('pg_advisory_unlock')){locked=false;return{rows:[{released:true}]};}
   throw new Error('Unexpected query');
  })};clients.push(client);return client;
 })};
 stages={pending:jest.fn(async()=>({summary:{scanned:2,errors:0}})),payouts:jest.fn(async()=>({transfers:{summary:{scanned:3,errors:0}},transactions:{scanned:1,results:[]}})),repair:jest.fn(async()=>({scanned:1,repaired:1,errors:0}))};
});
test('each run covers pending, uncertain payouts and settlement repair and exposes a successful timestamp',async()=>{
 const job=createReconciliationJob({pool,stages,logger});
 const r=await job.run();
 expect(Object.keys(r.stages)).toEqual(['pending','payouts','repair']);
 expect(stages.pending).toHaveBeenCalledTimes(1);expect(stages.payouts).toHaveBeenCalledTimes(1);expect(stages.repair).toHaveBeenCalledTimes(1);
 expect(job.getStatus()).toMatchObject({running:false,lastOutcome:'success',consecutiveFailures:0});expect(job.getStatus().lastSuccessfulAt).toBeTruthy();
 expect(clients[0].release).toHaveBeenCalledTimes(1);expect(locked).toBe(false);
});
test('failed stage does not prevent remaining repairs and is visible, with no false success',async()=>{
 stages.pending.mockRejectedValue(new Error('contains sensitive operator detail'));
 const job=createReconciliationJob({pool,stages,logger});const r=await job.run();
 expect(r.outcome).toBe('partial_failure');expect(stages.payouts).toHaveBeenCalled();expect(stages.repair).toHaveBeenCalled();
 expect(job.getStatus()).toMatchObject({lastSuccessfulAt:null,consecutiveFailures:1});
 expect(JSON.stringify(job.getStatus())).not.toContain('sensitive');expect(locked).toBe(false);
});
test('reported item errors also prevent a false healthy run',async()=>{
 stages.repair.mockResolvedValue({scanned:1,repaired:0,errors:1});
 const job=createReconciliationJob({pool,stages,logger});expect((await job.run()).outcome).toBe('partial_failure');expect(job.getStatus().lastSuccessfulAt).toBeNull();
});
test('same process overlap and another process holding the advisory lock cannot run stages twice',async()=>{
 let release;stages.pending.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
 const a=createReconciliationJob({pool,stages,logger});const b=createReconciliationJob({pool,stages,logger});
 const first=a.run();await flush();
 expect((await a.run()).skipped).toBe('overlap');expect((await b.run()).skipped).toBe('locked_elsewhere');
 expect(stages.pending).toHaveBeenCalledTimes(1);release({summary:{errors:0}});await first;expect(locked).toBe(false);
});
test('lock acquisition failure releases connection and does not run monetary services',async()=>{
 pool.connect.mockResolvedValueOnce({query:jest.fn(async()=>{throw new Error('db down');}),release:jest.fn()});
 const job=createReconciliationJob({pool,stages,logger});expect((await job.run()).outcome).toBe('error');expect(stages.pending).not.toHaveBeenCalled();
});
test('stop drains in-flight work before returning and prevents subsequent runs',async()=>{
 let release;stages.pending.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
 const job=createReconciliationJob({pool,stages,logger});const run=job.run();await flush();let stopped=false;
 const stopping=job.stop().then(()=>{stopped=true;});await flush();expect(stopped).toBe(false);
 release({summary:{errors:0}});await run;await stopping;expect(locked).toBe(false);expect((await job.run()).skipped).toBe('stopped');
});
test('scheduler runs once at startup and periodically, disabled scheduler runs nothing',async()=>{
 jest.useFakeTimers();
 try{
  const off=createReconciliationJob({pool,stages,logger,enabled:false});off.start();await Promise.resolve();expect(stages.pending).not.toHaveBeenCalled();await off.stop();
  const job=createReconciliationJob({pool,stages,logger,intervalSeconds:30});job.start();await jest.advanceTimersByTimeAsync(0);expect(stages.pending).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(30000);expect(stages.pending).toHaveBeenCalledTimes(2);await job.stop();await jest.advanceTimersByTimeAsync(30000);expect(stages.pending).toHaveBeenCalledTimes(2);
 }finally{jest.useRealTimers();}
});

test('failed unlock discards the connection rather than returning a held lock to the pool',async()=>{
 const release=jest.fn();
 pool.connect.mockResolvedValueOnce({release,query:jest.fn(async sql=>{
   if(sql.includes('pg_try_advisory_lock'))return{rows:[{acquired:true}]};
   throw new Error('unlock failed');
 })});
 await createReconciliationJob({pool,stages,logger}).run();expect(release).toHaveBeenCalledWith(true);
});
test('a one-connection pool fails visibly before occupying the only application connection',async()=>{
 pool.options.max=1;const job=createReconciliationJob({pool,stages,logger});
 expect((await job.run()).outcome).toBe('error');expect(pool.connect).not.toHaveBeenCalled();expect(stages.pending).not.toHaveBeenCalled();expect(job.getStatus().consecutiveFailures).toBe(1);
});
test('a later failure retains the time of the last actually successful run',async()=>{
 const job=createReconciliationJob({pool,stages,logger});await job.run();const last=job.getStatus().lastSuccessfulAt;
 stages.pending.mockRejectedValue(new Error('operator down'));await job.run();
 expect(job.getStatus()).toMatchObject({lastSuccessfulAt:last,lastOutcome:'partial_failure',consecutiveFailures:1});
});

test('failed review notification makes the recovery cycle visibly incomplete',async()=>{
 stages.payouts.mockResolvedValue({transfers:{summary:{errors:0},results:[{alerted:false}]},transactions:{scanned:0,results:[]}});
 const job=createReconciliationJob({pool,stages,logger});expect((await job.run()).outcome).toBe('partial_failure');expect(job.getStatus().lastSuccessfulAt).toBeNull();
});
