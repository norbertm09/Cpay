'use strict';
/**
 * Lot « alertes retraits incertains » (2026-11) : statistiques des ordres sortants incertains exposees par /metrics
 * (cash_payouts_*), etat du balayage, robustesse de /metrics quand la base ne repond pas.
 * Donnees fictives, operateurs simules, PostgreSQL reel (PGlite).
 */
process.env.NODE_ENV = 'test';
const express = require('express');
const request = require('supertest');
const { PGlite } = require('@electric-sql/pglite');
let mockPg; let dbDown = false;
const sql = async (...args) => { if (dbDown) throw new Error('connect ECONNREFUSED 10.0.0.5:5432'); const r = await mockPg.query(...args); return { ...r, rowCount: r.affectedRows ?? r.rows.length }; };
jest.mock('../config/database', () => ({
  query: (...a) => sql(...a),
  withTransaction: (fn) => mockPg.transaction((tx) => fn({ query: async (...a) => { const r = await tx.query(...a); return { ...r, rowCount: r.affectedRows ?? r.rows.length }; } })),
  pool: {},
}));
jest.mock('../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/auth', () => ({ verifyTotp: jest.fn() }));
jest.mock('../services/mobilemoney/mobilemoney.router', () => ({ getProvider: () => ({}), getConfig: async () => ({}), sendPayout: jest.fn(), webhookUrl: jest.fn(), PROVIDERS: {} }));
jest.mock('../services/rails/mtn-momo.client', () => ({ getDisbursementStatus: jest.fn(), getCollectionStatus: jest.fn() }));
jest.mock('../services/notifications/email.service', () => ({ send: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock('../services/settlement/settlement.queue', () => ({ enqueue: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/reconciliation-job', () => ({ getStatus: () => ({ enabled: true, scheduled: true, running: false, lastSuccessfulAt: null, lastFinishedAt: null, consecutiveFailures: 0 }) }));
const cash = require('../services/cash/cash.service');
const { renderMetrics, metricsHandler } = require('../config/metrics');
const M = '11111111-1111-4111-8111-111111111111';
const insert = (status, age, extra = {}) => sql(
  `INSERT INTO merchant_transfers(merchant_id,wallet_operator,wallet_phone,status,reference,created_at,unknown_since,needs_review,direction,dest_type)
   VALUES($1,'mtn_momo','+242060000001',$2,$3,NOW() - ($4 || ' minutes')::interval,$5,$6,$7,$8)`,
  [M, status, `REF-${status}-${age}`, String(age), extra.unknownSinceMinutes ? new Date(Date.now() - extra.unknownSinceMinutes * 60000).toISOString() : null,
    !!extra.needsReview, extra.direction || 'payout', extra.destType || 'wallet']);

beforeAll(async () => {
  mockPg = new PGlite();
  await mockPg.exec(`
    CREATE TABLE merchants(merchant_id uuid PRIMARY KEY, country text, currency text, business_name text, email text);
    CREATE TABLE merchant_transfers(transfer_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid, direction text DEFAULT 'payout',
      dest_type text DEFAULT 'wallet', bank_account_id uuid, wallet_operator text, wallet_phone text, status text DEFAULT 'pending',
      amount numeric DEFAULT 50000, fee numeric DEFAULT 500, net_amount numeric DEFAULT 49500, currency text DEFAULT 'XAF', reference text,
      description text, created_at timestamptz DEFAULT NOW(), updated_at timestamptz, completed_at timestamptz, events jsonb DEFAULT '[]',
      gateway_reference text, error_message text, request_payload jsonb, unknown_since timestamptz, needs_review boolean DEFAULT false,
      last_status_check_at timestamptz, review_alerted_at timestamptz, settlement_method text, bank_reference text, settlement_ref text,
      executed_by uuid, settled_by uuid, admin_note text, amount_requested numeric, cancelled_at timestamptz, settled_at timestamptz);
    CREATE TABLE financial_institutions(institution_id uuid PRIMARY KEY, name text);
    CREATE TABLE bank_accounts(account_id uuid PRIMARY KEY, institution_id uuid, account_number text, account_name text, owner_id uuid, status text DEFAULT 'verified');
    CREATE TABLE transactions(transaction_id uuid PRIMARY KEY, merchant_id uuid, type text, status text, response_message text, initiated_at timestamptz DEFAULT NOW());
    CREATE TABLE transaction_events(event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), transaction_id uuid, merchant_id uuid, event_type text, payload jsonb, created_at timestamptz DEFAULT NOW());
  `);
  await sql(`INSERT INTO merchants(merchant_id,country,currency,business_name,email) VALUES($1,'CG','XAF','Boutique Test','m@example.test')`, [M]);
  process.env.CASH_UNKNOWN_GRACE_MINUTES = '30';
});
afterAll(async () => { delete process.env.CASH_UNKNOWN_GRACE_MINUTES; delete process.env.METRICS_TOKEN; await mockPg.close(); });

describe('getUncertainPayoutStats — comptes par statut, age du plus ancien, ordres a revoir', () => {
  test('base vide : tout a zero, les quatre statuts presents', async () => {
    const s = await cash.getUncertainPayoutStats();
    expect(s).toEqual({ byStatus: { pending: 0, sending: 0, unknown: 0, processing: 0 }, total: 0, oldestAgeSeconds: 0, needsReview: 0, graceMinutes: 30 });
  });
  test('reservations recentes ignorees, anciennes comptees ; age depuis unknown_since ; revue comptee', async () => {
    await insert('sending', 1);                                        // sous la grace : envoi en cours normal
    await insert('pending', 5);                                        // idem
    await insert('sending', 120);                                      // envoi interrompu
    await insert('pending', 60);                                       // reservation orpheline
    await insert('processing', 180, { unknownSinceMinutes: 60, needsReview: true });
    await insert('unknown', 300);                                      // le plus ancien : 5 h
    await insert('completed', 600);                                    // final : ignore
    await insert('unknown', 900, { destType: 'bank' });                // virement bancaire : hors perimetre
    await insert('unknown', 900, { direction: 'collect' });            // encaissement : hors perimetre
    const s = await cash.getUncertainPayoutStats();
    expect(s.byStatus).toEqual({ pending: 1, sending: 1, processing: 1, unknown: 1 });
    expect(s.total).toBe(4); expect(s.needsReview).toBe(1);
    expect(s.oldestAgeSeconds).toBeGreaterThanOrEqual(300 * 60 - 5); expect(s.oldestAgeSeconds).toBeLessThan(300 * 60 + 60);
  });
  test('la grace est parametrable', async () => {
    const s = await cash.getUncertainPayoutStats({ graceMinutes: 0 });
    expect(s.byStatus.sending).toBe(2); expect(s.byStatus.pending).toBe(2);
  });
});

describe('/metrics — lignes cash_payouts_* et robustesse', () => {
  const app = () => { const a = express(); a.get('/metrics', metricsHandler); return a; };
  test('rendu : une serie par statut, total, age, revue, cash_metrics_up 1, etat du balayage', async () => {
    const body = await renderMetrics();
    expect(body).toContain('cash_metrics_up 1');
    expect(body).toContain('cash_payouts_uncertain{status="pending"} 1');
    expect(body).toContain('cash_payouts_uncertain{status="sending"} 1');
    expect(body).toContain('cash_payouts_uncertain{status="processing"} 1');
    expect(body).toContain('cash_payouts_uncertain{status="unknown"} 1');
    expect(body).toContain('cash_payouts_uncertain_total 4');
    expect(body).toContain('cash_payouts_needs_review 1');
    expect(body).toMatch(/cash_payouts_uncertain_oldest_age_seconds 1[78]\d{3}\n/);
    expect(body).toContain('cash_payouts_sweep_last_success_timestamp_seconds 0');
    expect(body).toContain('# TYPE cash_payouts_uncertain gauge');
    expect(body).toContain('process_uptime_seconds');   // les jauges historiques restent
  });
  test('handler : jeton requis, texte Prometheus', async () => {
    process.env.METRICS_TOKEN = 'mtok-test';
    const r = await request(app()).get('/metrics').set('Authorization', 'Bearer mtok-test');
    expect(r.status).toBe(200); expect(r.headers['content-type']).toMatch(/text\/plain/);
    expect(r.text).toContain('cash_payouts_uncertain_total 4');
    expect((await request(app()).get('/metrics')).status).toBe(403);
  });
  test('base injoignable : cash_metrics_up 0, aucune serie caisse, le reste de /metrics reste servi', async () => {
    dbDown = true;
    try {
      const body = await renderMetrics();
      expect(body).toContain('cash_metrics_up 0');
      expect(body).not.toContain('cash_payouts_uncertain_total');
      expect(body).toContain('cash_payouts_sweep_last_success_timestamp_seconds');
      expect(body).toContain('process_uptime_seconds');
      expect(body).not.toContain('ECONNREFUSED');
    } finally { dbDown = false; }
  });
  test('apres un balayage reussi, cash_payouts_sweep_last_success_timestamp_seconds est pose', async () => {
    const before = Math.floor(Date.now() / 1000);
    const out = await cash.sweepUncertainPayouts({ graceMinutes: 30, alertHours: 2 });
    expect(out.summary.scanned).toBe(4);
    const st = cash.getSweepState();
    expect(Math.floor(st.lastSuccessAt / 1000)).toBeGreaterThanOrEqual(before);
    expect(st.lastFinishedAt).toBeGreaterThanOrEqual(st.lastSuccessAt);
    const body = await renderMetrics();
    expect(body).toMatch(new RegExp(`cash_payouts_sweep_last_success_timestamp_seconds ${Math.floor(st.lastSuccessAt / 1000)}\\n`));
  });
});
