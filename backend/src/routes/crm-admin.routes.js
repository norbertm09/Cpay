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

// WAVE-3 : sémantique PATCH — champ absent = inchangé ; null (ou "" pour un texte) = effacé ; valeur = remplacée.
// Renvoie { sets, params } ou { error } (422).
const buildPatch = ({ body, statusList, textField }) => {
  const { status, assignedTo } = body;
  const text = body[textField];
  const sets = []; const params = [];
  const add = (sql, v) => { params.push(v); sets.push(sql.replace('?', `$${params.length}`)); };
  if (status !== undefined) {
    if (!statusList.includes(status)) return { error: 'Statut invalide' };
    add('status = ?', status);
  }
  if (assignedTo !== undefined) {
    if (assignedTo === null || assignedTo === '') add('assigned_to = ?::uuid', null);
    else if (typeof assignedTo === 'string' && UUID.test(assignedTo)) add('assigned_to = ?::uuid', assignedTo);
    else return { error: 'assignedTo invalide (uuid ou null)' };
  }
  if (text !== undefined) {
    if (text === null || text === '') add(`${textField} = ?`, null);
    else if (typeof text === 'string') add(`${textField} = ?`, text.slice(0, 4000));
    else return { error: `${textField} invalide` };
  }
  return { sets, params };
};

router.patch('/leads/:id', crm, async (req, res) => {
  if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Lead introuvable' });
  const patch = buildPatch({ body: req.body || {}, statusList: LEAD_STATUS, textField: 'notes' });
  if (patch.error) return res.status(422).json({ error: patch.error, code: 'VALIDATION_ERROR' });
  if (!patch.sets.length) return res.status(422).json({ error: 'Aucun champ à mettre à jour', code: 'VALIDATION_ERROR' });
  patch.params.push(req.params.id);
  const r = await query(
    `UPDATE crm_leads SET ${patch.sets.join(', ')}, updated_at = NOW() WHERE lead_id = $${patch.params.length} RETURNING *`, patch.params);
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
  const patch = buildPatch({ body: req.body || {}, statusList: CLAIM_STATUS, textField: 'resolution' });
  if (patch.error) return res.status(422).json({ error: patch.error, code: 'VALIDATION_ERROR' });
  if (!patch.sets.length) return res.status(422).json({ error: 'Aucun champ à mettre à jour', code: 'VALIDATION_ERROR' });
  const { status } = req.body || {};
  if (status === 'resolved' || status === 'closed') patch.sets.push('resolved_at = COALESCE(resolved_at, NOW())');
  patch.params.push(req.params.id);
  const r = await query(
    `UPDATE crm_claims SET ${patch.sets.join(', ')}, updated_at = NOW() WHERE claim_id = $${patch.params.length} RETURNING *`, patch.params);
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
