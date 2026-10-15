/**
 * Back office CRM — leads, réclamations, conversations de l'assistant.
 * Monté sur /api/v1/admin/crm ; rôles super_admin, ops_admin, support_agent.
 */
'use strict';

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { requireRole } = require('../middleware/auth');

const crm = requireRole('super_admin', 'ops_admin', 'support_agent');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const page = (q) => { const p = Math.max(1, parseInt(q.page, 10) || 1); const l = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 25)); return { p, l, off: (p - 1) * l }; };
const LEAD_STATUS = ['new', 'contacted', 'qualified', 'converted', 'lost'];
const CLAIM_STATUS = ['open', 'in_progress', 'resolved', 'closed'];

router.get('/stats', crm, async (_req, res) => {
  const [leads, claims, conv] = await Promise.all([
    query(`SELECT COUNT(*) FILTER (WHERE status='new')::int AS new, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS last7d FROM crm_leads`),
    query(`SELECT COUNT(*) FILTER (WHERE status IN ('open','in_progress'))::int AS open, COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS last7d FROM crm_claims`),
    query(`SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS last7d, COUNT(*) FILTER (WHERE handoff_requested)::int AS handoffs FROM assistant_conversations`),
  ]);
  res.json({ leads: leads.rows[0], claims: claims.rows[0], conversations: conv.rows[0] });
});

router.get('/leads', crm, async (req, res) => {
  const { p, l, off } = page(req.query);
  const params = []; let where = 'WHERE 1=1';
  if (LEAD_STATUS.includes(req.query.status)) { params.push(req.query.status); where += ` AND status = $${params.length}`; }
  if (req.query.q) { params.push(`%${String(req.query.q).slice(0, 100)}%`); where += ` AND (name ILIKE $${params.length} OR email ILIKE $${params.length} OR company ILIKE $${params.length})`; }
  const count = [...params]; params.push(l, off);
  const [data, total] = await Promise.all([
    query(`SELECT * FROM crm_leads ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
    query(`SELECT COUNT(*)::int AS n FROM crm_leads ${where}`, count),
  ]);
  res.json({ data: data.rows, total: total.rows[0].n, page: p, limit: l });
});

router.patch('/leads/:id', crm, async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Lead introuvable' });
  const { status, assignedTo, notes } = req.body || {};
  if (status !== undefined && !LEAD_STATUS.includes(status)) return res.status(422).json({ error: 'Statut invalide', code: 'VALIDATION_ERROR' });
  const r = await query(
    `UPDATE crm_leads SET status = COALESCE($1, status), assigned_to = COALESCE($2::uuid, assigned_to), notes = COALESCE($3, notes), updated_at = NOW()
     WHERE lead_id = $4 RETURNING *`,
    [status ?? null, assignedTo && UUID.test(assignedTo) ? assignedTo : null, typeof notes === 'string' ? notes.slice(0, 4000) : null, req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Lead introuvable' });
  res.json(r.rows[0]);
});

router.get('/claims', crm, async (req, res) => {
  const { p, l, off } = page(req.query);
  const params = []; let where = 'WHERE 1=1';
  if (CLAIM_STATUS.includes(req.query.status)) { params.push(req.query.status); where += ` AND status = $${params.length}`; }
  if (['payment', 'settlement', 'account', 'fraud', 'other'].includes(req.query.category)) { params.push(req.query.category); where += ` AND category = $${params.length}`; }
  if (req.query.q) { params.push(`%${String(req.query.q).slice(0, 100)}%`); where += ` AND (reference ILIKE $${params.length} OR name ILIKE $${params.length} OR email ILIKE $${params.length} OR transaction_ref ILIKE $${params.length})`; }
  const count = [...params]; params.push(l, off);
  const [data, total] = await Promise.all([
    query(`SELECT * FROM crm_claims ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
    query(`SELECT COUNT(*)::int AS n FROM crm_claims ${where}`, count),
  ]);
  res.json({ data: data.rows, total: total.rows[0].n, page: p, limit: l });
});

router.patch('/claims/:id', crm, async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Réclamation introuvable' });
  const { status, assignedTo, resolution } = req.body || {};
  if (status !== undefined && !CLAIM_STATUS.includes(status)) return res.status(422).json({ error: 'Statut invalide', code: 'VALIDATION_ERROR' });
  const r = await query(
    `UPDATE crm_claims SET status = COALESCE($1, status), assigned_to = COALESCE($2::uuid, assigned_to), resolution = COALESCE($3, resolution),
       resolved_at = CASE WHEN $1 IN ('resolved','closed') THEN COALESCE(resolved_at, NOW()) ELSE resolved_at END, updated_at = NOW()
     WHERE claim_id = $4 RETURNING *`,
    [status ?? null, assignedTo && UUID.test(assignedTo) ? assignedTo : null, typeof resolution === 'string' ? resolution.slice(0, 4000) : null, req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Réclamation introuvable' });
  res.json(r.rows[0]);
});

router.get('/conversations', crm, async (req, res) => {
  const { p, l, off } = page(req.query);
  const r = await query(
    `SELECT conversation_id, locale, page, message_count, handoff_requested, handoff_team, lead_id, claim_id, created_at, last_message_at
     FROM assistant_conversations ORDER BY last_message_at DESC NULLS LAST, created_at DESC LIMIT $1 OFFSET $2`, [l, off]);
  res.json({ data: r.rows, page: p, limit: l });
});

router.get('/conversations/:id', crm, async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Conversation introuvable' });
  const c = await query('SELECT * FROM assistant_conversations WHERE conversation_id = $1', [req.params.id]);
  if (!c.rows.length) return res.status(404).json({ error: 'Conversation introuvable' });
  const m = await query('SELECT message_id, role, content, tool_calls, usage, created_at FROM assistant_messages WHERE conversation_id = $1 ORDER BY created_at ASC', [req.params.id]);
  res.json({ ...c.rows[0], messages: m.rows });
});

module.exports = router;
