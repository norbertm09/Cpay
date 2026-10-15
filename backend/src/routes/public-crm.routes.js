/**
 * Routes publiques vitrine — assistant conversationnel, leads, réclamations.
 * Montées sur /api/v1/public. Sans authentification, limitées par IP.
 * Contrat : docs/ASSISTANT-API.md
 */
'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { query } = require('../config/database');
const logger = require('../config/logger');
const assistant = require('../services/assistant/assistant.service');

const byIp = (windowMs, max) => rateLimit({ windowMs, max, standardHeaders: true, legacyHeaders: false });
const conversationLimiter = byIp(10 * 60 * 1000, 10);
const messageLimiter      = byIp(10 * 60 * 1000, 30);
const formLimiter         = byIp(60 * 60 * 1000, 10);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v || '');
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const fail = (res, status, error, code, details) => res.status(status).json({ error, code, ...(details ? { details } : {}) });

// ─── Assistant ────────────────────────────────────────────────────
router.post('/assistant/conversations', conversationLimiter, async (req, res) => {
  if (!assistant.isEnabled()) return fail(res, 503, "L'assistant est momentanément indisponible", 'ASSISTANT_DISABLED');
  const locale = ['fr', 'en'].includes(req.body?.locale) ? req.body.locale : 'fr';
  const page = str(req.body?.page, 200) || null;
  const r = await query(
    `INSERT INTO assistant_conversations (locale, page, ip_address, user_agent) VALUES ($1,$2,$3,$4) RETURNING conversation_id`,
    [locale, page, req.ip || null, str(req.headers['user-agent'], 512) || null]);
  res.status(201).json({ conversationId: r.rows[0].conversation_id });
});

router.get('/assistant/conversations/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) return fail(res, 404, 'Conversation introuvable', 'NOT_FOUND');
  const c = await query('SELECT conversation_id FROM assistant_conversations WHERE conversation_id = $1', [req.params.id]);
  if (!c.rows.length) return fail(res, 404, 'Conversation introuvable', 'NOT_FOUND');
  const m = await query(
    `SELECT message_id, role, content, created_at FROM assistant_messages WHERE conversation_id = $1 AND role IN ('user','assistant') ORDER BY created_at ASC LIMIT 200`,
    [req.params.id]);
  res.json({ conversationId: req.params.id, messages: m.rows.map(x => ({ id: x.message_id, role: x.role, text: x.content, at: x.created_at })) });
});

router.post('/assistant/conversations/:id/messages', messageLimiter, async (req, res) => {
  if (!UUID.test(req.params.id)) return fail(res, 404, 'Conversation introuvable', 'NOT_FOUND');
  if (!assistant.isEnabled()) return fail(res, 503, "L'assistant est momentanément indisponible", 'ASSISTANT_DISABLED');
  const message = str(req.body?.message, 4000);
  if (message.length < 1) return fail(res, 422, 'message requis (1 à 4000 caractères)', 'VALIDATION_ERROR');
  const c = await query('SELECT message_count FROM assistant_conversations WHERE conversation_id = $1', [req.params.id]);
  if (!c.rows.length) return fail(res, 404, 'Conversation introuvable', 'NOT_FOUND');
  if (c.rows[0].message_count >= 120) return fail(res, 429, 'Conversation trop longue, ouvrez-en une nouvelle', 'CONVERSATION_LIMIT');

  const streaming = req.query.stream !== '0' && req.query.stream !== 'false';
  const controller = new AbortController();
  req.on('close', () => controller.abort());

  if (!streaming) {
    try {
      const r = await assistant.runTurn({ conversationId: req.params.id, userText: message, ip: req.ip, signal: controller.signal });
      return res.json(r);
    } catch (err) {
      logger.error('assistant turn failed', { err: err.message, code: err.code });
      return fail(res, err.code === 'ASSISTANT_DISABLED' ? 503 : 502, "L'assistant n'a pas pu répondre", err.code || 'ASSISTANT_ERROR');
    }
  }

  res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15000);
  try {
    const r = await assistant.runTurn({
      conversationId: req.params.id, userText: message, ip: req.ip, signal: controller.signal,
      onToken: (text) => send('token', { text }),
      onTool:  (t) => send('tool', t),
    });
    send('done', { messageId: r.messageId, leadId: r.leadId || undefined, claimId: r.claimId || undefined, claimReference: r.claimReference || undefined, handoff: r.handoff || undefined });
  } catch (err) {
    logger.error('assistant stream failed', { err: err.message, code: err.code });
    send('error', { code: err.code || 'ASSISTANT_ERROR', message: "L'assistant n'a pas pu répondre" });
  } finally {
    clearInterval(ping);
    res.end();
  }
});

// ─── Formulaires directs ──────────────────────────────────────────
router.post('/leads', formLimiter, async (req, res) => {
  const b = req.body || {};
  const errors = [];
  const name = str(b.name, 120); if (name.length < 2) errors.push({ path: 'name', message: 'Nom requis' });
  const email = str(b.email, 160).toLowerCase(); if (!isEmail(email)) errors.push({ path: 'email', message: 'E-mail invalide' });
  const phone = str(b.phone, 32) || null;
  const interest = ['merchant', 'partner', 'developer', 'other'].includes(b.interest) ? b.interest : 'other';
  const country = /^[A-Za-z]{2}$/.test(str(b.country, 2)) ? str(b.country, 2).toUpperCase() : null;
  if (b.consent !== true) errors.push({ path: 'consent', message: 'Consentement requis' });
  if (b.website) return res.status(201).json({ leadId: null }); // honeypot anti-bot
  if (errors.length) return fail(res, 422, 'Données invalides', 'VALIDATION_ERROR', errors);
  const r = await query(
    `INSERT INTO crm_leads (name, email, phone, company, country, interest, message, source, ip_address, consent_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW()) RETURNING lead_id`,
    [name, email, phone, str(b.company, 160) || null, country, interest, str(b.message, 2000) || null, str(b.source, 64) || 'website', req.ip || null]);
  res.status(201).json({ leadId: r.rows[0].lead_id });
});

router.post('/claims', formLimiter, async (req, res) => {
  const b = req.body || {};
  const errors = [];
  const name = str(b.name, 120); if (name.length < 2) errors.push({ path: 'name', message: 'Nom requis' });
  const email = str(b.email, 160).toLowerCase(); const phone = str(b.phone, 32) || null;
  if (!isEmail(email) && !phone) errors.push({ path: 'email', message: 'E-mail valide ou téléphone requis' });
  const category = ['payment', 'settlement', 'account', 'fraud', 'other'].includes(b.category) ? b.category : null;
  if (!category) errors.push({ path: 'category', message: 'Catégorie invalide' });
  const description = str(b.description, 4000); if (description.length < 10) errors.push({ path: 'description', message: 'Description trop courte' });
  if (b.consent !== true) errors.push({ path: 'consent', message: 'Consentement requis' });
  if (b.website) return res.status(201).json({ claimId: null, reference: null });
  if (errors.length) return fail(res, 422, 'Données invalides', 'VALIDATION_ERROR', errors);
  for (let i = 0; i < 5; i++) {
    const reference = assistant.newReference();
    try {
      const r = await query(
        `INSERT INTO crm_claims (reference, name, email, phone, category, description, merchant_ref, transaction_ref, source, ip_address, consent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'website',$9,NOW()) RETURNING claim_id`,
        [reference, name, isEmail(email) ? email : null, phone, category, description, str(b.merchantRef, 120) || null, str(b.transactionRef, 120) || null, req.ip || null]);
      return res.status(201).json({ claimId: r.rows[0].claim_id, reference });
    } catch (err) { if (err.code !== '23505') throw err; }
  }
  return fail(res, 500, 'Référence indisponible, réessayez', 'REFERENCE_COLLISION');
});

module.exports = router;
