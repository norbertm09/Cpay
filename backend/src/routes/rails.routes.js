'use strict';

const express = require('express');
const router = express.Router();
const { merchantAuth, requireRole } = require('../middleware/auth');
const visa = require('../services/rails/visa-direct.service');
const mastercardDevelopers = require('../services/rails/mastercard-developers.service');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.post('/visa-direct/push-funds', merchantAuth, asyncHandler(async (req, res) => {
  const result = await visa.pushFunds(req.body);
  res.json({ success: true, data: result });
}));

router.post('/visa-direct/pull-funds', merchantAuth, asyncHandler(async (req, res) => {
  const result = await visa.pullFunds(req.body);
  res.json({ success: true, data: result });
}));

router.get('/visa-direct/transaction-query', merchantAuth, asyncHandler(async (req, res) => {
  const result = await visa.queryTransaction(req.query);
  res.json({ success: true, data: result });
}));

router.post('/visa-payouts/v3/payouts', merchantAuth, asyncHandler(async (req, res) => {
  const result = await visa.accountWalletPayout(req.body);
  res.json({ success: true, data: result });
}));

router.post('/visa-payouts/v3/payouts/validate', merchantAuth, asyncHandler(async (req, res) => {
  const result = await visa.validateAccountWalletPayout(req.body);
  res.json({ success: true, data: result });
}));

router.get('/visa-payouts/v3/payouts', merchantAuth, asyncHandler(async (req, res) => {
  const result = await visa.queryPayout(req.query);
  res.json({ success: true, data: result });
}));

router.get('/visa-payouts/v3/account-balance', merchantAuth, asyncHandler(async (req, res) => {
  const result = await visa.getAccountBalance(req.query);
  res.json({ success: true, data: result });
}));

router.get('/mastercard-developers/services', requireRole('super_admin', 'ops_admin'), asyncHandler(async (req, res) => {
  const result = await mastercardDevelopers.getServices(req.query);
  res.json({ success: true, data: result });
}));

router.get('/mastercard-developers/services/:id', requireRole('super_admin', 'ops_admin'), asyncHandler(async (req, res) => {
  const result = await mastercardDevelopers.getService(req.params.id);
  res.json({ success: true, data: result });
}));

router.get('/mastercard-developers/projects', requireRole('super_admin', 'ops_admin'), asyncHandler(async (req, res) => {
  const result = await mastercardDevelopers.getProjects(req.query);
  res.json({ success: true, data: result });
}));

router.post('/mastercard-developers/projects', requireRole('super_admin'), asyncHandler(async (req, res) => {
  const result = await mastercardDevelopers.createProject(req.body);
  res.status(201).json({ success: true, data: result });
}));

router.get('/mastercard-developers/projects/:id', requireRole('super_admin', 'ops_admin'), asyncHandler(async (req, res) => {
  const result = await mastercardDevelopers.getProject(req.params.id);
  res.json({ success: true, data: result });
}));

router.post('/mastercard-developers/projects/:id/services', requireRole('super_admin'), asyncHandler(async (req, res) => {
  const result = await mastercardDevelopers.addServiceToProject(req.params.id, req.body);
  res.status(201).json({ success: true, data: result });
}));

router.post('/mastercard-developers/projects/:id/credentials', requireRole('super_admin'), asyncHandler(async (req, res) => {
  const result = await mastercardDevelopers.addCredential(req.params.id, req.body);
  res.status(201).json({ success: true, data: result });
}));

module.exports = router;
