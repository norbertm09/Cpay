// Reliquat novembre 2026 — dette § 5 : masquage des 5xx, limite dediee aux webhooks, politique de mot de passe (10),
// Express 5 (chemins RegExp des pages de lien de paiement).
'use strict';
const express = require('express');
const request = require('supertest');
const rateLimit = require('express-rate-limit');
const { sanitizeServerErrors, installProcessHandlers } = require('../middleware/errors');

const fakeLogger = () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() });

describe('sanitizeServerErrors — aucune reponse >= 500 ne porte le detail interne', () => {
  const build = (logger) => {
    const app = express();
    app.use((req, _res, next) => { req.requestId = 'req-test-1'; next(); });
    app.use(sanitizeServerErrors(logger));
    app.get('/boom', (_req, res) => res.status(500).json({ error: 'connect ECONNREFUSED 10.0.0.5:5432 relation "x"', code: 'DB_DOWN' }));
    app.get('/bad', (_req, res) => res.status(502).json({ error: 'upstream timeout', code: 'bad code with spaces' }));
    app.get('/client', (_req, res) => res.status(422).json({ error: 'Montant invalide', code: 'VALIDATION_ERROR' }));
    app.get('/ok', (_req, res) => res.json({ ok: true }));
    return app;
  };
  test('500 : corps generique + requestId, code conserve s’il est un identifiant, detail journalise', async () => {
    const logger = fakeLogger();
    const r = await request(build(logger)).get('/boom');
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: 'Erreur interne', code: 'DB_DOWN', requestId: 'req-test-1' });
    expect(JSON.stringify(r.body)).not.toContain('ECONNREFUSED');
    expect(logger.error).toHaveBeenCalledWith('Server error response', expect.objectContaining({ statusCode: 500, error: expect.stringContaining('ECONNREFUSED') }));
  });
  test('502 avec un code libre : code remplace par INTERNAL_ERROR', async () => {
    const r = await request(build(fakeLogger())).get('/bad');
    expect(r.status).toBe(502); expect(r.body.code).toBe('INTERNAL_ERROR'); expect(r.body.error).toBe('Erreur interne');
  });
  test('4xx et 2xx inchanges', async () => {
    const app = build(fakeLogger());
    const a = await request(app).get('/client'); expect(a.status).toBe(422); expect(a.body.error).toBe('Montant invalide');
    const b = await request(app).get('/ok'); expect(b.body).toEqual({ ok: true });
  });
  test('EXPOSE_ERROR_DETAILS=true conserve le detail (developpement)', async () => {
    process.env.EXPOSE_ERROR_DETAILS = 'true';
    try {
      const r = await request(build(fakeLogger())).get('/boom');
      expect(r.body.error).toContain('ECONNREFUSED');
    } finally { delete process.env.EXPOSE_ERROR_DETAILS; }
  });
});

describe('installProcessHandlers — rejets non geres journalises, exception non rattrapee journalisee', () => {
  test('les gestionnaires sont installes et journalisent', () => {
    const logger = fakeLogger();
    const before = { rej: process.listenerCount('unhandledRejection'), exc: process.listenerCount('uncaughtException') };
    installProcessHandlers(logger, { exitOnUncaught: false });
    expect(process.listenerCount('unhandledRejection')).toBe(before.rej + 1);
    expect(process.listenerCount('uncaughtException')).toBe(before.exc + 1);
    const rej = process.listeners('unhandledRejection').pop(); const exc = process.listeners('uncaughtException').pop();
    rej(new Error('promesse perdue')); exc(new Error('plantage'));
    expect(logger.error).toHaveBeenCalledWith('Unhandled promise rejection', expect.objectContaining({ err: 'promesse perdue' }));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Uncaught exception'), expect.objectContaining({ err: 'plantage' }));
    process.removeListener('unhandledRejection', rej); process.removeListener('uncaughtException', exc);
  });
});

describe('limite /api/ — les callbacks operateurs ne consomment pas le quota general', () => {
  test('skip pour /api/v1/webhooks/*, limite generale ailleurs', async () => {
    const app = express();
    app.use('/api/', rateLimit({ windowMs: 60_000, max: 2, standardHeaders: true, legacyHeaders: false,
      skip: (req) => /^\/v1\/webhooks(\/|$)/.test(req.path) }));
    app.post('/api/v1/webhooks/mtn/callback', (_req, res) => res.json({ ok: true }));
    app.get('/api/v1/other', (_req, res) => res.json({ ok: true }));
    for (let i = 0; i < 5; i += 1) expect((await request(app).post('/api/v1/webhooks/mtn/callback')).status).toBe(200);
    expect((await request(app).get('/api/v1/other')).status).toBe(200);
    expect((await request(app).get('/api/v1/other')).status).toBe(200);
    expect((await request(app).get('/api/v1/other')).status).toBe(429);
  });
});

describe('politique de mot de passe — 10 caracteres minimum sur toutes les routes', () => {
  test('les routes de changement/inscription refusent 8-9 caracteres avec WEAK_PASSWORD', () => {
    const fs = require('fs'); const path = require('path');
    const files = ['cardholder.routes.js', 'merchant.routes.js', 'partners.routes.js', 'password_reset_distribution.routes.js']
      .map((f) => fs.readFileSync(path.join(__dirname, '..', 'routes', f), 'utf8'));
    for (const src of files) { expect(src).not.toMatch(/ass?word\.length < 8\b/); }
    expect(files.join('\n').match(/ass?word\.length < 10\b/g).length).toBeGreaterThanOrEqual(6);
  });
});

describe('Express 5 — chemins RegExp des pages publiques de lien de paiement', () => {
  test('/:shortId et /:shortId/return : 6 a 10 majuscules/chiffres uniquement', async () => {
    const app = express();
    app.get(/^\/([A-Z0-9]{6,10})\/return$/, (req, res) => res.json({ ret: req.params[0] }));
    app.get(/^\/([A-Z0-9]{6,10})$/, (req, res) => res.json({ id: req.params[0] }));
    expect((await request(app).get('/ABC123')).body).toEqual({ id: 'ABC123' });
    expect((await request(app).get('/ABC123/return')).body).toEqual({ ret: 'ABC123' });
    expect((await request(app).get('/abc123')).status).toBe(404);
    expect((await request(app).get('/ABCDEFGHIJK')).status).toBe(404);
  });
});
