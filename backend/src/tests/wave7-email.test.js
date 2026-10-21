'use strict';
/**
 * WAVE-7 — e-mails métier sur Nodemailer 10.x, transport mocké (aucun réseau).
 *
 * Couvre : fabrique commune (secure/STARTTLS/TLS vérifié/délais), description d'erreur sans
 * secret (535), service notifications (forme du résultat, erreurs normalisées, bienvenue marchand,
 * réinitialisation), service historique (alertes ops, absence de SMTP_PASS), e-mail de changement
 * de bénéficiaire (cash.service) et envoi de test depuis l'admin.
 * Le test contre un vrai relais local est dans wave7-smtp-fixture.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'wave7-test-secret';
process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');

const mockSendMail = jest.fn();
const mockVerify = jest.fn();
const mockClose = jest.fn();
const mockCreateTransport = jest.fn(() => ({ sendMail: (...a) => mockSendMail(...a), verify: (...a) => mockVerify(...a), close: (...a) => mockClose(...a) }));
jest.mock('nodemailer', () => ({ createTransport: (...a) => mockCreateTransport(...a) }));

const mockDbQuery = jest.fn();
jest.mock('../config/database', () => ({
  query: (...args) => mockDbQuery(...args),
  withTransaction: async (fn) => fn({ query: (...args) => mockDbQuery(...args) }),
  pool: {},
}));
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() };
jest.mock('../config/logger', () => mockLogger);
jest.mock('../services/rails/mtn-momo.client', () => ({}));
jest.mock('../services/mobilemoney/mobilemoney.router', () => ({}));
jest.mock('../services/notifications/smpp.service', () => ({ sendSmsSmpp: jest.fn(), notifyMultiChannel: jest.fn() }));
jest.mock('../services/notifications/whatsapp.service', () => ({ sendWhatsAppText: jest.fn() }));
jest.mock('../services/reconcile.service', () => ({ reconcilePending: jest.fn() }));

const SMTP_ENV = { SMTP_HOST: 'smtp.example.test', SMTP_PORT: '587', SMTP_USER: 'noreply@example.test', SMTP_PASS: 'fixture-secret', SMTP_FROM: 'noreply@example.test' };
const savedEnv = { ...process.env };
const load = (file, env = SMTP_ENV) => {
  process.env = { ...savedEnv, ...env };
  delete process.env.SMTP_TLS_CA; delete process.env.SMTP_TLS_CA_FILE;
  let m; jest.isolateModules(() => { m = require(file); }); return m;
};
const smtpErr = (code, responseCode, response, command) => Object.assign(new Error(response || code), { code, responseCode, response, command });
const okInfo = (to) => ({ messageId: '<id@example.test>', accepted: [to], rejected: [], response: '250 Stored locally', envelope: { from: 'noreply@example.test', to: [to] } });

beforeEach(() => {
  jest.clearAllMocks();
  mockSendMail.mockImplementation(async (msg) => okInfo(msg.to));
  mockVerify.mockResolvedValue(true);
  mockDbQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
});
afterEach(() => { process.env = { ...savedEnv }; });

describe('smtp-transport — fabrique commune', () => {
  const { buildTransportOptions, describeSmtpError, DEFAULT_TIMEOUTS } = require('../services/notifications/smtp-transport');

  test('465 = TLS implicite, autres ports = STARTTLS forcé ; certificat toujours vérifié ; délais bornés', () => {
    const env = {};
    const a = buildTransportOptions({ host: 'h', port: '465', user: 'u', pass: 'p', env });
    expect(a).toMatchObject({ host: 'h', port: 465, secure: true, requireTLS: true, tls: { rejectUnauthorized: true }, auth: { user: 'u', pass: 'p' }, ...DEFAULT_TIMEOUTS });
    const b = buildTransportOptions({ host: 'h', port: 587, user: 'u', pass: 'p', env });
    expect(b).toMatchObject({ port: 587, secure: false, requireTLS: true });
    expect(buildTransportOptions({ host: 'h', port: 2525, secure: true, user: 'u', pass: 'p', env }).secure).toBe(true);
    expect(buildTransportOptions({ host: 'h', port: 'abc', user: 'u', pass: 'p', env })).toMatchObject({ port: 465, secure: true });
    expect(buildTransportOptions({ host: 'h', port: 587, user: 'u', pass: 'p', env: { SMTP_TLS_CA: 'pem' } }).tls).toEqual({ rejectUnauthorized: true, ca: 'pem' });
  });

  test('describeSmtpError : 535 → EAUTH clair, non réessayable, secrets masqués', () => {
    const encoded = Buffer.from('\0noreply@example.test\0fixture-secret').toString('base64');
    const d = describeSmtpError(smtpErr('EAUTH', 535, `535 Authentication failed ${encoded}`, 'AUTH PLAIN'));
    expect(d).toMatchObject({ code: 'EAUTH', responseCode: 535, command: 'AUTH', retryable: false });
    expect(d.message).toMatch(/535/);
    expect(d.message).not.toContain(encoded);
    expect(d.message).not.toContain('fixture-secret');
    // 535 sans code Nodemailer (ex. verify() d'un autre client) reste classé EAUTH
    expect(describeSmtpError(smtpErr(undefined, 535, '535 bad'))).toMatchObject({ code: 'EAUTH', responseCode: 535 });
  });

  test('describeSmtpError : connexion/délais réessayables, TLS et inconnu non réessayables', () => {
    expect(describeSmtpError(smtpErr('ECONNECTION', undefined, undefined, 'CONN'))).toMatchObject({ code: 'ECONNECTION', responseCode: null, retryable: true });
    expect(describeSmtpError(smtpErr('ETIMEDOUT'))).toMatchObject({ code: 'ETIMEDOUT', retryable: true });
    expect(describeSmtpError(new Error('unable to verify the first certificate'))).toMatchObject({ code: 'ETLS', retryable: false });
    expect(describeSmtpError(null)).toMatchObject({ code: 'UNKNOWN' });
    expect(describeSmtpError(new Error('x'.repeat(400))).message.length).toBeLessThan(220);
  });
});

describe('services/notifications/email.service — Nodemailer 10', () => {
  test('send() : options de transport, message et forme du résultat', async () => {
    const svc = load('../services/notifications/email.service');
    const r = await svc.send({ to: 'm@example.test', subject: 'Sujet', html: '<p>corps</p>' });
    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    expect(mockCreateTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.example.test', port: 587, secure: false, requireTLS: true, tls: { rejectUnauthorized: true }, connectionTimeout: 10000 }));
    expect(mockSendMail).toHaveBeenCalledWith({ from: 'noreply@example.test', to: 'm@example.test', subject: 'Sujet', html: '<p>corps</p>', text: 'Sujet' });
    expect(r).toEqual({ success: true, messageId: '<id@example.test>', accepted: ['m@example.test'], rejected: [], response: '250 Stored locally' });
    await svc.send({ to: 'x@example.test', subject: 's', html: 'h' });
    expect(mockCreateTransport).toHaveBeenCalledTimes(1); // transport mis en cache
    svc.resetTransport();
    expect(mockClose).toHaveBeenCalledTimes(1);
    await svc.send({ to: 'x@example.test', subject: 's', html: 'h' });
    expect(mockCreateTransport).toHaveBeenCalledTimes(2);
  });

  test('send() : erreur SMTP normalisée (535) avec cause conservée ; configuration manquante inchangée', async () => {
    const svc = load('../services/notifications/email.service');
    const raw = smtpErr('EAUTH', 535, '535 Authentication failed', 'AUTH PLAIN');
    mockSendMail.mockRejectedValueOnce(raw);
    const err = await svc.send({ to: 'm@example.test', subject: 's', html: 'h' }).catch((e) => e);
    expect(err).toMatchObject({ code: 'EAUTH', responseCode: 535, command: 'AUTH', retryable: false });
    expect(err.cause).toBe(raw);
    expect(err.message).toMatch(/535/);
    mockVerify.mockRejectedValueOnce(smtpErr('ECONNECTION', undefined, undefined, 'CONN'));
    await expect(svc.testConnection()).rejects.toMatchObject({ code: 'ECONNECTION', retryable: true });
    const unconfigured = load('../services/notifications/email.service', { ...SMTP_ENV, SMTP_PASS: '' });
    await expect(unconfigured.send({ to: 'm@example.test', subject: 's', html: 'h' })).rejects.toMatchObject({ code: 'SMTP_NOT_CONFIGURED' });
    expect(mockSendMail).toHaveBeenCalledTimes(1);
  });

  test('bienvenue marchand et réinitialisation de mot de passe', async () => {
    const svc = load('../services/notifications/email.service');
    await svc.sendWelcome({ to: 'm@example.test', firstName: 'Awa', userType: 'merchant' });
    let msg = mockSendMail.mock.calls[0][0];
    expect(msg.to).toBe('m@example.test');
    expect(msg.subject).toBe('Bienvenue sur C-Pay 🎉');
    expect(msg.html).toContain('Bienvenue Awa');
    expect(msg.html).toContain('https://merchant.c-pay.global');
    expect(msg.html).toContain('compte marchand');
    await svc.sendPasswordReset({ to: 'm@example.test', token: 'tok-123', userType: 'merchant' });
    msg = mockSendMail.mock.calls[1][0];
    expect(msg.subject).toBe('C-Pay — Réinitialisation de mot de passe');
    expect(msg.html).toContain('https://merchant.c-pay.global/reset-password?token=tok-123');
    expect(msg.html).toContain('expire dans 1 heure');
  });
});

describe('services/email.service (historique) — alertes ops', () => {
  test('secure suit le port ; alertes ops envoyées ; retour true', async () => {
    const svc = load('../services/email.service', { ...SMTP_ENV, SMTP_PORT: '465' });
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      await expect(svc.sendAlertApiDown({ to: 'ops@example.test', serviceName: 'api' })).resolves.toBe(true);
      await expect(svc.sendAlertIncident({ to: 'ops@example.test', title: 'DB', description: 'd' })).resolves.toBe(true);
      await expect(svc.sendMerchantWelcome({ to: 'm@example.test', contactName: 'Awa' })).resolves.toBe(true);
    } finally { info.mockRestore(); }
    expect(mockCreateTransport).toHaveBeenCalledWith(expect.objectContaining({ port: 465, secure: true, requireTLS: true, tls: { rejectUnauthorized: true } }));
    const subjects = mockSendMail.mock.calls.map(([m]) => m.subject);
    expect(subjects).toEqual(['🔴 API DOWN: api', '🚨 Incident: DB', '🏪 Bienvenue Marchand C-Pay']);
    expect(mockSendMail.mock.calls.every(([m]) => m.from === '"C-Pay | Calculus Plus" <noreply@c-pay.global>')).toBe(true);
  });

  test('port 587 → STARTTLS forcé (plus de TLS implicite figé)', async () => {
    const svc = load('../services/email.service');
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    try { await svc.sendAlertFraud({ to: 'ops@example.test' }); } finally { info.mockRestore(); }
    expect(mockCreateTransport).toHaveBeenCalledWith(expect.objectContaining({ port: 587, secure: false, requireTLS: true }));
  });

  test('sans SMTP_PASS : ignoré (false), aucun transport créé ; erreur SMTP → false avec journal sans secret', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const off = load('../services/email.service', { ...SMTP_ENV, SMTP_PASS: '' });
      await expect(off.sendAlertDbIssue({ to: 'ops@example.test', issueType: 'x' })).resolves.toBe(false);
      expect(mockCreateTransport).not.toHaveBeenCalled();
      expect(mockSendMail).not.toHaveBeenCalled();
      const svc = load('../services/email.service');
      mockSendMail.mockRejectedValueOnce(smtpErr('EAUTH', 535, '535 Authentication failed', 'AUTH PLAIN'));
      await expect(svc.sendAlertHighErrorRate({ to: 'ops@example.test', errorRate: 9 })).resolves.toBe(false);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/EAUTH \(535\)/));
      expect(error.mock.calls.flat().join(' ')).not.toContain('fixture-secret');
    } finally { warn.mockRestore(); error.mockRestore(); }
  });
});

describe('cash.service — e-mail de changement de bénéficiaire', () => {
  test('wallet modifié : e-mail au propriétaire avec résumé masqué ; échec SMTP → false sans lever', async () => {
    process.env = { ...savedEnv, ...SMTP_ENV };
    let cash; jest.isolateModules(() => { cash = require('../services/cash/cash.service'); });
    const merchant = { merchant_id: 'm-1', email: 'owner@example.test', business_name: 'Boutique Awa' };
    await expect(cash.notifyBeneficiaryChange(merchant, { eventType: 'wallet_updated', summary: 'MTN ***123', ip: '10.0.0.1' })).resolves.toBe(true);
    const msg = mockSendMail.mock.calls[0][0];
    expect(msg.to).toBe('owner@example.test');
    expect(msg.subject).toBe('C-Pay — Wallet de retrait modifié');
    expect(msg.html).toContain('Boutique Awa');
    expect(msg.html).toContain('MTN ***123');
    expect(msg.html).toContain('10.0.0.1');
    mockSendMail.mockRejectedValueOnce(smtpErr('ECONNECTION'));
    await expect(cash.notifyBeneficiaryChange(merchant, { eventType: 'bank_account_added', summary: 'BANK ****45' })).resolves.toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith('cash: beneficiary email failed', expect.objectContaining({ err: expect.stringContaining('Connexion au relais SMTP') }));
    await expect(cash.notifyBeneficiaryChange({ merchant_id: 'm-2' }, { eventType: 'wallet_updated', summary: 'x' })).resolves.toBe(false);
    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });
});

describe('admin — test et envoi de test SMTP', () => {
  let app, token;
  const cfg = (extra = {}) => ({ rows: [{ extra_params: { smtp_host: 'smtp.example.test', smtp_port: '587', smtp_secure: 'tls', smtp_user: 'u', smtp_pass: 'fixture-secret', smtp_from: 'noreply@example.test', ...extra } }], rowCount: 1 });
  beforeAll(() => {
    process.env = { ...savedEnv, ...SMTP_ENV };
    token = require('../middleware/auth').signToken({ sub: 'admin-1', type: 'admin', role: 'ops_admin', email: 'admin@test.io' });
    app = express(); app.use(express.json()); app.use('/admin', require('../routes/admin.routes'));
  });
  const post = (url, body) => request(app).post(url).set('Authorization', `Bearer ${token}`).send(body);

  test('POST /notification-configs/test : options durcies, 200 puis 400 EAUTH/535 et 400 ECONNECTION réessayable', async () => {
    mockDbQuery.mockResolvedValueOnce(cfg());
    let res = await post('/admin/notification-configs/test', { section: 'smtp' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockCreateTransport).toHaveBeenLastCalledWith(expect.objectContaining({ host: 'smtp.example.test', port: 587, secure: false, requireTLS: true, tls: { rejectUnauthorized: true }, auth: { user: 'u', pass: 'fixture-secret' } }));
    expect(mockClose).toHaveBeenCalledTimes(1);
    mockDbQuery.mockResolvedValueOnce(cfg({ smtp_secure: 'ssl', smtp_port: '465' }));
    mockVerify.mockRejectedValueOnce(smtpErr('EAUTH', 535, '535 Authentication failed', 'AUTH PLAIN'));
    res = await post('/admin/notification-configs/test', { section: 'smtp' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'EAUTH', responseCode: 535, retryable: false });
    expect(res.body.error).toMatch(/535/);
    expect(JSON.stringify(res.body)).not.toContain('fixture-secret');
    expect(mockCreateTransport).toHaveBeenLastCalledWith(expect.objectContaining({ port: 465, secure: true }));
    mockDbQuery.mockResolvedValueOnce(cfg());
    mockVerify.mockRejectedValueOnce(smtpErr('ECONNECTION', undefined, undefined, 'CONN'));
    res = await post('/admin/notification-configs/test', { section: 'smtp' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'ECONNECTION', responseCode: null, retryable: true });
    expect(mockClose).toHaveBeenCalledTimes(3);
  });

  test('POST /notification-configs/send-test : message de test envoyé, messageId renvoyé ; 535 → 400 sans secret', async () => {
    mockDbQuery.mockResolvedValueOnce(cfg());
    let res = await post('/admin/notification-configs/send-test', { section: 'smtp', to: 'ops@example.test' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, messageId: '<id@example.test>', accepted: ['ops@example.test'] });
    const msg = mockSendMail.mock.calls[0][0];
    expect(msg).toMatchObject({ from: '"C-Pay Admin" <noreply@example.test>', to: 'ops@example.test', subject: 'C-Pay — Test configuration Email' });
    expect(msg.html).toContain('smtp.example.test:587');
    mockDbQuery.mockResolvedValueOnce(cfg());
    mockSendMail.mockRejectedValueOnce(smtpErr('EAUTH', 535, '535 Authentication failed', 'AUTH PLAIN'));
    res = await post('/admin/notification-configs/send-test', { section: 'smtp', to: 'ops@example.test' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'EAUTH', responseCode: 535 });
    expect(JSON.stringify(res.body)).not.toContain('fixture-secret');
    expect(mockClose).toHaveBeenCalledTimes(2);
  });
});
