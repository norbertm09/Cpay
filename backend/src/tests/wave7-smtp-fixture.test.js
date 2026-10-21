'use strict';
/**
 * WAVE-7 — Nodemailer 10.x contre un vrai serveur SMTP local (monitoring/tests/smtp-fixture.cjs).
 *
 * Le fixture écoute en loopback uniquement, exige STARTTLS avant AUTH, accepte un seul couple
 * d'identifiants (fixture / local-fixture-password), répond 535 sinon, et ne transfère rien.
 * Une clé et un certificat temporaires sont générés avec OpenSSL ; aucun secret n'est versionné.
 *
 * Scénarios : STARTTLS + AUTH OK (livraison), identifiants refusés (535 : erreur claire, zéro
 * nouvelle tentative), certificat non reconnu (refus, jamais de repli en clair), et le test SMTP
 * de l'admin (`POST /admin/notification-configs/test`) sur ce même relais.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wave7-test-secret';
process.env.NODE_ENV = 'test';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { execFileSync } = require('child_process');
const { startSmtpFixture } = require('../../../monitoring/tests/smtp-fixture.cjs');

const mockDbQuery = jest.fn();
jest.mock('../config/database', () => ({
  query: (...args) => mockDbQuery(...args),
  withTransaction: async (fn) => fn({ query: (...args) => mockDbQuery(...args) }),
  pool: {},
}));
jest.mock('../services/notifications/smpp.service', () => ({ sendSmsSmpp: jest.fn(), notifyMultiChannel: jest.fn() }));
jest.mock('../services/notifications/whatsapp.service', () => ({ sendWhatsAppText: jest.fn() }));
jest.mock('../services/reconcile.service', () => ({ reconcilePending: jest.fn() }));

const openssl = process.env.OPENSSL_BIN || (process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
const GOOD = { user: 'fixture', pass: 'local-fixture-password' };
const savedEnv = { ...process.env };
let dir, certFile, smtp;

const loadService = (file, env) => {
  process.env = { ...savedEnv, ...env };
  let service;
  jest.isolateModules(() => { service = require(file); });
  return service;
};
const envFor = (overrides = {}) => ({
  SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_USER: GOOD.user, SMTP_PASS: GOOD.pass,
  SMTP_FROM: 'noreply@example.test', SMTP_TLS_CA_FILE: certFile, ...overrides,
});

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpay-wave7-smtp-'));
  certFile = path.join(dir, 'local.crt');
  const keyFile = path.join(dir, 'local.key');
  const opensslConfig = path.join(dir, 'openssl.cnf');
  fs.writeFileSync(opensslConfig, '[req]\ndistinguished_name=dn\n[dn]\n');
  execFileSync(openssl, ['req', '-config', opensslConfig, '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'pipe', windowsHide: true });
  smtp = await startSmtpFixture({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) });
});

afterAll(async () => {
  process.env = savedEnv;
  if (smtp) await smtp.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

afterEach(() => { process.env = { ...savedEnv }; });

describe('Nodemailer 10 — STARTTLS + AUTH sur le fixture local', () => {
  test('e-mail métier livré après STARTTLS et authentification (service notifications)', async () => {
    const svc = loadService('../services/notifications/email.service', envFor());
    const before = { messages: smtp.messages.length, tls: smtp.tlsConnections };
    const r = await svc.sendWelcome({ to: 'merchant@example.test', firstName: 'Awa', userType: 'merchant' });
    expect(r).toMatchObject({ success: true, accepted: ['merchant@example.test'], rejected: [] });
    expect(typeof r.messageId).toBe('string');
    expect(r.response).toMatch(/^250/);
    expect(smtp.messages).toHaveLength(before.messages + 1);
    expect(smtp.tlsConnections).toBe(before.tls + 1);
    expect(smtp.authFailures).toBe(0);
    const raw = smtp.messages.at(-1);
    expect(raw).toMatch(/^To: merchant@example\.test$/m);
    expect(raw).toMatch(/^From: noreply@example\.test$/m);
    expect(raw).toMatch(/^Subject: /m);
    expect(raw).not.toContain(GOOD.pass);
    svc.resetTransport();
  });

  test('alerte ops livrée par le service historique (secure suit le port, STARTTLS sur un port non 465)', async () => {
    const svc = loadService('../services/email.service', envFor());
    const before = smtp.messages.length;
    await expect(svc.sendAlertApiDown({ to: 'ops@example.test', serviceName: 'api' })).resolves.toBe(true);
    expect(smtp.messages).toHaveLength(before + 1);
    expect(smtp.messages.at(-1)).toMatch(/^To: ops@example\.test$/m);
  });

  test('identifiants refusés : erreur 535 claire, sans secret, aucune nouvelle tentative, rien de livré', async () => {
    const svc = loadService('../services/notifications/email.service', envFor({ SMTP_PASS: 'wrong-password' }));
    const before = { messages: smtp.messages.length, tls: smtp.tlsConnections, auth: smtp.authFailures };
    let err;
    try { await svc.send({ to: 'merchant@example.test', subject: 'x', html: '<p>x</p>' }); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err).toMatchObject({ code: 'EAUTH', responseCode: 535, retryable: false });
    expect(err.message).toMatch(/535/);
    expect(err.message).not.toContain('wrong-password');
    expect(err.message).not.toContain(Buffer.from(`\0${GOOD.user}\0wrong-password`).toString('base64'));
    expect(smtp.authFailures).toBe(before.auth + 1);       // exactement un AUTH, pas de boucle
    expect(smtp.tlsConnections).toBe(before.tls + 1);      // AUTH seulement après STARTTLS
    expect(smtp.messages).toHaveLength(before.messages);   // rien de livré
    // testConnection() remonte la même description
    await expect(svc.testConnection()).rejects.toMatchObject({ code: 'EAUTH', responseCode: 535 });
    expect(smtp.authFailures).toBe(before.auth + 2);
    svc.resetTransport();
  });

  test('identifiants refusés : le service historique renvoie false sans lever', async () => {
    const svc = loadService('../services/email.service', envFor({ SMTP_PASS: 'wrong-password' }));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const before = smtp.messages.length;
      await expect(svc.sendMerchantWelcome({ to: 'merchant@example.test', contactName: 'Awa' })).resolves.toBe(false);
      expect(smtp.messages).toHaveLength(before);
      expect(spy).toHaveBeenCalledWith(expect.stringMatching(/EAUTH \(535\)/));
      expect(spy.mock.calls.flat().join(' ')).not.toContain('wrong-password');
    } finally { spy.mockRestore(); }
  });

  test('certificat non reconnu : refus TLS, jamais de repli en clair', async () => {
    const svc = loadService('../services/notifications/email.service', envFor({ SMTP_TLS_CA_FILE: undefined }));
    delete process.env.SMTP_TLS_CA_FILE;
    const before = { messages: smtp.messages.length, auth: smtp.authFailures };
    let err;
    try { await svc.send({ to: 'merchant@example.test', subject: 'x', html: '<p>x</p>' }); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.code).not.toBe('EAUTH');
    expect(err.responseCode).toBeNull();
    expect(err.message).toMatch(/TLS|certificat|certificate|socket/i);
    expect(smtp.messages).toHaveLength(before.messages);
    expect(smtp.authFailures).toBe(before.auth); // aucun AUTH envoyé sur un canal non vérifié
    svc.resetTransport();
  });
});

describe('Admin — POST /admin/notification-configs/test (section smtp) sur le fixture', () => {
  let app, token;
  const cfgRow = (overrides = {}) => ({ rows: [{ extra_params: {
    smtp_host: '127.0.0.1', smtp_port: String(smtp.port), smtp_secure: 'tls', smtp_user: GOOD.user, smtp_pass: GOOD.pass, ...overrides,
  } }], rowCount: 1 });

  beforeAll(() => {
    process.env = { ...savedEnv, SMTP_TLS_CA_FILE: certFile };
    const { signToken } = require('../middleware/auth');
    token = signToken({ sub: 'admin-1', type: 'admin', role: 'super_admin', email: 'admin@test.io' });
    app = express();
    app.use(express.json());
    app.use('/admin', require('../routes/admin.routes'));
  });
  beforeEach(() => { process.env.SMTP_TLS_CA_FILE = certFile; mockDbQuery.mockReset(); mockDbQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 })); });

  test('identifiants corrects : 200 connexion établie', async () => {
    mockDbQuery.mockResolvedValueOnce(cfgRow());
    const res = await request(app).post('/admin/notification-configs/test').set('Authorization', `Bearer ${token}`).send({ section: 'smtp' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(res.body.message).toContain('127.0.0.1');
  });

  test('identifiants refusés : 400, code EAUTH / 535, message sans mot de passe', async () => {
    mockDbQuery.mockResolvedValueOnce(cfgRow({ smtp_pass: 'wrong-password' }));
    const before = smtp.authFailures;
    const res = await request(app).post('/admin/notification-configs/test').set('Authorization', `Bearer ${token}`).send({ section: 'smtp' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'EAUTH', responseCode: 535, retryable: false });
    expect(res.body.error).toMatch(/535/);
    expect(JSON.stringify(res.body)).not.toContain('wrong-password');
    expect(smtp.authFailures).toBe(before + 1);
  });

  test('certificat non reconnu : 400 sans AUTH ni repli en clair', async () => {
    delete process.env.SMTP_TLS_CA_FILE;
    mockDbQuery.mockResolvedValueOnce(cfgRow());
    const before = smtp.authFailures;
    const res = await request(app).post('/admin/notification-configs/test').set('Authorization', `Bearer ${token}`).send({ section: 'smtp' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).not.toBe('EAUTH');
    expect(smtp.authFailures).toBe(before);
  });
});
