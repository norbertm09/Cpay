'use strict';
/**
 * Capacités — vague 6, lot 2.
 *   publicRouter  GET /api/v1/public/capabilities   résumé par pays (sans auth, cache 60 s)
 *   adminRouter   GET /api/v1/admin/capabilities    matrice complète (statuts calculés, requires, pilotes)
 *                 POST /api/v1/admin/capabilities/refresh  recharge les faits base
 * Montés dans server.js (adminAuth appliqué au montage).
 */
const express = require('express');
const registry = require('../services/capabilities/registry');

const CACHE_TTL_MS = 60 * 1000;
let _summary = null;
let _summaryAt = 0;

const cachedSummary = async () => {
  if (_summary && Date.now() - _summaryAt < CACHE_TTL_MS) return _summary;
  await registry.loadFacts().catch(() => null);
  _summary = registry.summary();
  _summaryAt = Date.now();
  return _summary;
};
const invalidate = () => { _summary = null; _summaryAt = 0; };

const publicRouter = express.Router();
publicRouter.get('/', async (_req, res) => {
  const s = await cachedSummary();
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json(s);
});

const adminRouter = express.Router();
adminRouter.get('/', async (req, res) => {
  if (String(req.query.refresh || '') === '1') { await registry.loadFacts({ force: true }).catch(() => null); invalidate(); }
  else await registry.loadFacts().catch(() => null);
  const caps = registry.getCapabilities();
  const pilots = Object.fromEntries(registry.LAUNCH_COUNTRIES.map((cc) => [cc, caps.countries[cc].pilot]));
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ...caps,
    pilots,
    env: {
      legacyAllowed: String(process.env.CAPABILITY_LEGACY_ALLOW ?? 'true').toLowerCase() !== 'false',
      registrationGuard: String(process.env.CAPABILITY_REGISTRATION_GUARD || 'on').toLowerCase() !== 'off',
      pilotFlags: registry.LAUNCH_COUNTRIES.filter((cc) => pilots[cc]).map((cc) => `CAPABILITY_PILOT_${cc}`),
    },
  });
});
adminRouter.post('/refresh', async (_req, res) => {
  await registry.loadFacts({ force: true }).catch(() => null);
  invalidate();
  res.json({ success: true, facts: registry.getCachedFacts() });
});

module.exports = { publicRouter, adminRouter, invalidate, cachedSummary };
