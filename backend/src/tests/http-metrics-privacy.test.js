'use strict';
const express = require('express');
const request = require('supertest');
jest.mock('../services/reconciliation-job', () => ({ getStatus: () => ({}) }));
const { httpMetrics, metricsHandler } = require('../config/metrics');
const app = express();
app.use(httpMetrics);
app.post('/api/v1/webhooks/:secret/:provider', (req, res) => res.sendStatus(204));
const merchant = express.Router();
merchant.get('/transfers/:id', (req, res) => res.sendStatus(200));
app.use('/api/v1/merchant', merchant);
app.get('/metrics', metricsHandler);
beforeAll(() => { process.env.METRICS_TOKEN = 'privacy-test'; });
afterAll(() => { delete process.env.METRICS_TOKEN; });
const metrics = () => request(app).get('/metrics').set('Authorization', 'Bearer privacy-test');

test('secret webhook segments, arbitrary IDs and query strings never appear in metrics', async () => {
  for (const secret of ['secret_alpha_fixture', 'secret_beta_fixture']) await request(app).post(`/api/v1/webhooks/${secret}/provider`);
  for (const id of ['free-form-fixture', 'special%22value', 'aaaa1111-bbbb-4ccc-8ddd-eeeeffff0000']) await request(app).get(`/api/v1/merchant/transfers/${id}?sensitive=fixture_query`);
  const r = await metrics();
  expect(r.status).toBe(200);
  expect(r.text).not.toMatch(/secret_alpha|secret_beta|free-form|special|fixture_query|aaaa1111|sensitive/);
  expect(r.text).toContain('path="webhooks"');
  expect(r.text).toContain('path="merchant"');
});

test('one hundred unknown paths produce a single bounded request series', async () => {
  for (let n = 0; n < 100; n++) await request(app).get(`/arbitrary-${n}-fixture`);
  const { text } = await metrics();
  expect(text).not.toContain('arbitrary-');
  const lines = text.split('\n').filter(l => l.startsWith('api_requests_total') && l.includes('status="404"'));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('path="unmatched"');
});
