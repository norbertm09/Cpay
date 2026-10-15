/**
 * WAVE-2 — middleware idempotence : 5xx jamais persistées, clé libérée si le handler plante,
 * purge paresseuse IDEMPOTENCY_TTL_HOURS, 409 conservés.
 */
'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockQuery = jest.fn();
jest.mock('../config/database', () => ({ query: (...a) => mockQuery(...a), withTransaction: jest.fn(), pool: {} }));

const { idempotency, _resetPurgeClock, _ttlHours } = require('../middleware/idempotency');

const calls = (re) => mockQuery.mock.calls.filter(([sql]) => re.test(sql));
const SELECT = /SELECT status_code, response_body, request_hash/;
const INSERT = /INSERT INTO idempotency_keys/;
const UPDATE = /UPDATE idempotency_keys/;
const DELETE_KEY = /DELETE FROM idempotency_keys WHERE merchant_id/;
const PURGE  = /DELETE FROM idempotency_keys WHERE created_at </;

const flush = () => new Promise((r) => setImmediate(r));

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { merchantId: 'M-1' }; next(); });
  app.post('/ok',    idempotency, (req, res) => res.status(201).json({ ok: true, n: req.body.n }));
  app.post('/bad',   idempotency, (_req, res) => res.status(422).json({ error: 'invalid' }));
  app.post('/boom',  idempotency, (_req, res) => res.status(500).json({ error: 'db down' }));
  app.post('/throw', idempotency, () => { throw new Error('unexpected'); });
  app.post('/send',  idempotency, (_req, res) => res.status(200).send('text'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
};
const app = buildApp();
const KEY = 'idem-key-0001';

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  _resetPurgeClock();
  delete process.env.IDEMPOTENCY_TTL_HOURS;
});

describe('persistance des réponses', () => {
  test('2xx : persistée (status + body)', async () => {
    const r = await request(app).post('/ok').set('Idempotency-Key', KEY).send({ n: 1 });
    expect(r.status).toBe(201); await flush();
    expect(calls(INSERT)).toHaveLength(1);
    const upd = calls(UPDATE); expect(upd).toHaveLength(1);
    expect(upd[0][1][0]).toBe(201); expect(upd[0][1][1]).toEqual({ ok: true, n: 1 });
    expect(calls(DELETE_KEY)).toHaveLength(0);
  });
  test('4xx : persistée', async () => {
    await request(app).post('/bad').set('Idempotency-Key', KEY).send({}); await flush();
    expect(calls(UPDATE)).toHaveLength(1); expect(calls(UPDATE)[0][1][0]).toBe(422);
  });
  test('5xx : NON persistée, clé supprimée pour permettre le retry', async () => {
    const r = await request(app).post('/boom').set('Idempotency-Key', KEY).send({}); await flush();
    expect(r.status).toBe(500);
    expect(calls(UPDATE)).toHaveLength(0);
    expect(calls(DELETE_KEY)).toHaveLength(1);
    expect(calls(DELETE_KEY)[0][1]).toEqual(['M-1', 'POST /boom', KEY]);
  });
  test('handler qui lève avant de répondre : clé supprimée', async () => {
    const r = await request(app).post('/throw').set('Idempotency-Key', KEY).send({}); await flush();
    expect(r.status).toBe(500);
    expect(calls(UPDATE)).toHaveLength(0); expect(calls(DELETE_KEY)).toHaveLength(1);
  });
  test('réponse sans res.json (send) : clé libérée à la fin de la réponse', async () => {
    await request(app).post('/send').set('Idempotency-Key', KEY).send({}); await flush();
    expect(calls(UPDATE)).toHaveLength(0); expect(calls(DELETE_KEY)).toHaveLength(1);
  });
  test('sans en-tête : aucun accès base', async () => {
    await request(app).post('/ok').send({ n: 1 });
    expect(mockQuery).not.toHaveBeenCalled();
  });
  test('clé trop courte → 400', async () => {
    expect((await request(app).post('/ok').set('Idempotency-Key', 'abc').send({})).status).toBe(400);
  });
});

describe('rejeu et 409', () => {
  const crypto = require('crypto');
  const hashOf = (b) => crypto.createHash('sha256').update(JSON.stringify(b)).digest('hex');

  test('même clé + même corps → réponse stockée rejouée', async () => {
    mockQuery.mockImplementation(async (sql) => SELECT.test(sql)
      ? { rows: [{ status_code: 201, response_body: { ok: true, n: 1 }, request_hash: hashOf({ n: 1 }) }], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    const r = await request(app).post('/ok').set('Idempotency-Key', KEY).send({ n: 1 });
    expect(r.status).toBe(201); expect(r.body).toEqual({ ok: true, n: 1 });
    expect(calls(INSERT)).toHaveLength(0);
  });
  test('même clé + corps différent → 409 IDEMPOTENCY_CONFLICT', async () => {
    mockQuery.mockImplementation(async (sql) => SELECT.test(sql)
      ? { rows: [{ status_code: 201, response_body: {}, request_hash: hashOf({ n: 1 }) }], rowCount: 1 } : { rows: [], rowCount: 0 });
    const r = await request(app).post('/ok').set('Idempotency-Key', KEY).send({ n: 2 });
    expect(r.status).toBe(409); expect(r.body.code).toBe('IDEMPOTENCY_CONFLICT');
  });
  test('ligne réservée sans réponse (en cours) → 409 IDEMPOTENCY_IN_PROGRESS', async () => {
    mockQuery.mockImplementation(async (sql) => SELECT.test(sql)
      ? { rows: [{ status_code: null, response_body: null, request_hash: hashOf({ n: 1 }) }], rowCount: 1 } : { rows: [], rowCount: 0 });
    const r = await request(app).post('/ok').set('Idempotency-Key', KEY).send({ n: 1 });
    expect(r.status).toBe(409); expect(r.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
  });
  test('INSERT en conflit (course) → 409 IDEMPOTENCY_IN_PROGRESS', async () => {
    mockQuery.mockImplementation(async (sql) => {
      if (INSERT.test(sql)) { const e = new Error('dup'); e.code = '23505'; throw e; }
      return { rows: [], rowCount: 0 };
    });
    const r = await request(app).post('/ok').set('Idempotency-Key', KEY).send({ n: 1 });
    expect(r.status).toBe(409); expect(r.body.code).toBe('IDEMPOTENCY_IN_PROGRESS');
  });
  test('base indisponible → 503', async () => {
    mockQuery.mockRejectedValue(new Error('down'));
    const r = await request(app).post('/ok').set('Idempotency-Key', KEY).send({ n: 1 });
    expect(r.status).toBe(503);
  });
});

describe('purge paresseuse (IDEMPOTENCY_TTL_HOURS)', () => {
  test('défaut 24 h, lancée une fois puis pas avant 10 min', async () => {
    await request(app).post('/ok').set('Idempotency-Key', KEY).send({ n: 1 });
    await request(app).post('/ok').set('Idempotency-Key', 'idem-key-0002').send({ n: 1 });
    await flush();
    const purges = calls(PURGE);
    expect(purges).toHaveLength(1);
    expect(purges[0][1]).toEqual(['24']);
    expect(_ttlHours()).toBe(24);
  });
  test('TTL configurable', async () => {
    process.env.IDEMPOTENCY_TTL_HOURS = '72';
    await request(app).post('/ok').set('Idempotency-Key', KEY).send({ n: 1 }); await flush();
    expect(calls(PURGE)[0][1]).toEqual(['72']);
    process.env.IDEMPOTENCY_TTL_HOURS = 'abc';
    expect(_ttlHours()).toBe(24);
  });
  test('échec de purge non bloquant', async () => {
    mockQuery.mockImplementation(async (sql) => { if (PURGE.test(sql)) throw new Error('purge failed'); return { rows: [], rowCount: 0 }; });
    const r = await request(app).post('/ok').set('Idempotency-Key', KEY).send({ n: 1 });
    expect(r.status).toBe(201);
  });
});
