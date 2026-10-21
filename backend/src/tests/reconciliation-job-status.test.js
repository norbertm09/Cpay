'use strict';
process.env.JWT_SECRET='lot4-status-test-secret-at-least-32-characters';
const express=require('express');const request=require('supertest');
jest.mock('../config/logger',()=>({info:jest.fn(),warn:jest.fn(),error:jest.fn(),debug:jest.fn()}));
const mockQuery=jest.fn();
jest.mock('../config/database',()=>({query:(...a)=>mockQuery(...a),pool:{options:{max:4}},withTransaction:jest.fn()}));
const {signToken}=require('../middleware/auth');
const app=express();app.use('/cash',require('../routes/cash-admin.routes'));
const headers=role=>({Authorization:`Bearer ${signToken({sub:'11111111-1111-4111-8111-111111111111',type:'admin',role})}`});
test('scheduler status is operations-only and reveals no provider data',async()=>{
 expect((await request(app).get('/cash/reconcile/status')).status).toBe(401);
 expect((await request(app).get('/cash/reconcile/status').set(headers('support_agent'))).status).toBe(403);
 const r=await request(app).get('/cash/reconcile/status').set(headers('ops_admin'));
 expect(r.status).toBe(200);expect(r.body).toMatchObject({running:false,lastOutcome:'never_run',lastSuccessfulAt:null,consecutiveFailures:0});expect(mockQuery).not.toHaveBeenCalled();
});
test('protected metrics include bounded recovery health fields',async()=>{
 const {metricsHandler,recordReconciliationOutcome}=require('../config/metrics');
 app.get('/metrics',metricsHandler);process.env.METRICS_TOKEN='lot4-test-metrics';
 try{
  expect((await request(app).get('/metrics')).status).toBe(403);
  recordReconciliationOutcome('success');recordReconciliationOutcome('unbounded-transfer-identifier');
  const r=await request(app).get('/metrics').set('Authorization','Bearer lot4-test-metrics');
  expect(r.status).toBe(200);expect(r.text).toContain('reconciliation_runs_total{outcome="success"} 1');expect(r.text).toContain('reconciliation_last_success_timestamp_seconds 0');expect(r.text).not.toContain('unbounded-transfer-identifier');
 }finally{delete process.env.METRICS_TOKEN;}
});
