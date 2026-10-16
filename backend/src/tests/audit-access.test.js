'use strict';
process.env.NODE_ENV='test';process.env.JWT_SECRET='audit-access-secret-at-least-32-characters';
const mockQuery=jest.fn();const mockTxQuery=jest.fn();
jest.mock('../config/database',()=>({query:(...a)=>mockQuery(...a),withTransaction:async fn=>fn({query:(...a)=>mockTxQuery(...a)}),pool:{}}));
jest.mock('../config/logger',()=>({info:jest.fn(),warn:jest.fn(),error:jest.fn(),debug:jest.fn()}));
const express=require('express');const request=require('supertest');const bcrypt=require('bcryptjs');
const {signToken}=require('../middleware/auth');
const cash=require('../services/cash/cash.service');
const app=express();app.use(express.json());app.use('/admin',require('../routes/admin.routes'));app.use('/merchant',require('../routes/merchant.routes'));
const token=(type,role)=>'Bearer '+signToken({type,role,sub:'11111111-1111-4111-8111-111111111111',merchantId:'22222222-2222-4222-8222-222222222222',email:'audit@test.io'});
const rows=r=>({rows:r,rowCount:r.length});
beforeEach(()=>{mockQuery.mockReset();mockTxQuery.mockReset();mockQuery.mockResolvedValue(rows([]));mockTxQuery.mockResolvedValue(rows([]));cash._resetStepUp();});
const routes=[['post','/merchants/m/kyb/documents'],['patch','/merchants/m/kyb/documents/d'],['patch','/cardholders/c/kyc/documents/d'],['post','/notification-configs'],['post','/notification-configs/test'],['post','/notification-configs/send-test']];
test.each(routes)('support cannot mutate privileged configuration: %s %s',async(method,url)=>{
 const r=await request(app)[method]('/admin'+url).set('Authorization',token('admin','support_agent')).send({status:'approved',section:'smtp'});
 expect(r.status).toBe(403);expect(mockQuery).not.toHaveBeenCalled();expect(mockTxQuery).not.toHaveBeenCalled();
});
test.each(['cashier','viewer'])('%s cannot change legacy settlement destinations',async role=>{
 const r=await request(app).put('/merchant/account').set('Authorization',token('merchant',role)).send({settlementAccount:'+242061234567'});
 expect(r.status).toBe(403);expect(mockQuery).not.toHaveBeenCalled();expect(mockTxQuery).not.toHaveBeenCalled();
});
test('owner must step up before changing a destination',async()=>{
 mockQuery.mockResolvedValue(rows([{user_id:'u',password_hash:bcrypt.hashSync('Correct1!',4),mfa_enabled:false}]));
 const r=await request(app).put('/merchant/account').set('Authorization',token('merchant','owner')).send({bankName:'New bank'});
 expect(r.status).toBe(428);expect(mockTxQuery).not.toHaveBeenCalled();
});
test('verified owner destination update uses a merchant lock and mandatory audit',async()=>{
 mockQuery.mockResolvedValue(rows([{user_id:'u',password_hash:bcrypt.hashSync('Correct1!',4),mfa_enabled:false}]));
 const r=await request(app).put('/merchant/account').set('Authorization',token('merchant','owner')).send({bankName:'New bank',confirm:{password:'Correct1!'}});
 expect(r.status).toBe(200);expect(mockTxQuery.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
 expect(mockTxQuery.mock.calls.some(([s])=>s.includes('INSERT INTO audit_logs'))).toBe(true);
});
test('finance validation rejects missing reference, unknown batch, and completed batch',async()=>{
 const post=body=>request(app).patch('/admin/finance/settlements/b/validate').set('Authorization',token('admin','finance_admin')).send(body);
 expect((await post({})).status).toBe(422);
 expect((await post({reference:'BANK-1'})).status).toBe(404);
 mockTxQuery.mockResolvedValue(rows([{status:'completed'}]));
 expect((await post({reference:'BANK-1'})).status).toBe(409);
 expect(mockTxQuery.mock.calls.some(([s])=>s.includes('UPDATE settlement_batches'))).toBe(false);
});
test('submitted provider payout cannot be manually rejected',async()=>{
 mockTxQuery.mockResolvedValue(rows([{status:'submitted'}]));
 const r=await request(app).patch('/admin/finance/settlements/b/reject').set('Authorization',token('admin','finance_admin')).send({reason:'Not paid'});
 expect(r.status).toBe(409);expect(mockTxQuery.mock.calls.some(([s])=>s.includes('UPDATE settlement_batches'))).toBe(false);
});
test('audit failure prevents successful financial transition response',async()=>{
 mockTxQuery.mockImplementation(async sql=>{if(sql.includes('INSERT INTO audit_logs'))throw new Error('DB audit failure');return rows([{status:'pending'}]);});
 const r=await request(app).patch('/admin/finance/settlements/b/validate').set('Authorization',token('admin','finance_admin')).send({reference:'BANK-1'});
 expect(r.status).toBe(500);expect(r.body.success).toBeUndefined();
});
