'use strict';
const express = require('express');
const { query, withTransaction } = require('../config/database');
// WAVE-2 : auth unique (audit §1.1) — cardholderAuth pose req.cardholder,
// adminAuth + aliasUser('admin') conserve req.admin pour les routes existantes.
const { cardholderAuth, adminAuth: adminJwt, aliasUser } = require('../middleware/auth');

const cardAuth  = cardholderAuth;
const adminAuth = [adminJwt, aliasUser('admin')];

const cardholderRouter = express.Router();
const adminRouter = express.Router();

// POST /cardholder/claims
cardholderRouter.post('/claims', cardAuth, async (req, res) => {
  const { claimType, description, txnId, txnAmount, txnDate } = req.body;
  if (!claimType || !description) return res.status(422).json({ error: 'claimType et description requis' });
  try {
    const r = await query(
      `INSERT INTO claims (cardholder_id, txn_id, txn_amount, txn_date, claim_type, description, priority)
       VALUES ($1,$2,$3,$4,$5,$6,'normal') RETURNING claim_id, claim_ref, status, opened_at`,
      [req.cardholder.sub, txnId||null, txnAmount||null, txnDate||null, claimType, description]
    );
    res.status(201).json({ success:true, ...r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /cardholder/claims
cardholderRouter.get('/claims', cardAuth, async (req, res) => {
  try {
    const r = await query(`SELECT * FROM claims WHERE cardholder_id=$1 ORDER BY opened_at DESC LIMIT 20`, [req.cardholder.sub]);
    res.json({ data: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /admin/claims
adminRouter.get('/claims', adminAuth, async (req, res) => {
  try {
    const r = await query(`SELECT c.*, ch.first_name, ch.last_name, ch.email FROM claims c LEFT JOIN cardholders ch ON ch.cardholder_id=c.cardholder_id ORDER BY c.opened_at DESC LIMIT 50`);
    res.json({ data: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /admin/incidents
adminRouter.get('/incidents', adminAuth, async (req, res) => {
  try {
    const r = await query(`SELECT * FROM incidents ORDER BY detected_at DESC LIMIT 50`);
    res.json({ data: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = { cardholderRouter, adminRouter };
