'use strict';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE_RE = /^\+?[1-9]\d{7,14}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const CHANNEL_RE = /^(whatsapp|sms)$/;

const cleanString = (value, max = 255) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : null;
};

const parseAmount = (value) => {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 100) / 100;
};

const validatePaymentRequest = (req, res, next) => {
  const amount = parseAmount(req.body.amount);
  if (amount === null) {
    return res.status(422).json({ error: 'Montant invalide', code: 'INVALID_AMOUNT' });
  }

  const customerPhone = cleanString(req.body.customerPhone, 32);
  const emvPayload = cleanString(req.body.emvPayload, 4096);
  const aidDetected = cleanString(req.body.aidDetected, 64);
  const description = cleanString(req.body.description, 500);
  const deviceId = cleanString(req.body.deviceId, 128);

  if (customerPhone === null || emvPayload === null || aidDetected === null || description === null || deviceId === null) {
    return res.status(422).json({ error: 'Parametre invalide', code: 'INVALID_FIELD' });
  }
  if (customerPhone && !PHONE_RE.test(customerPhone.replace(/[\s\-().]/g, ''))) {
    return res.status(422).json({ error: 'Numero client invalide', code: 'INVALID_PHONE' });
  }
  if (!customerPhone && !emvPayload && !aidDetected) {
    return res.status(422).json({ error: 'Numero client ou donnees carte requis', code: 'PAYMENT_SOURCE_REQUIRED' });
  }

  req.body.amount = amount;
  req.body.customerPhone = customerPhone;
  req.body.emvPayload = emvPayload;
  req.body.aidDetected = aidDetected;
  req.body.description = description;
  req.body.deviceId = deviceId;
  next();
};

const validateLinkRequest = (req, res, next) => {
  const amount = parseAmount(req.body.amount);
  const description = cleanString(req.body.description, 500);
  const currency = cleanString(req.body.currency, 3);
  if (amount === null) return res.status(422).json({ error: 'Montant invalide', code: 'INVALID_AMOUNT' });
  if (description === null) return res.status(422).json({ error: 'Description invalide', code: 'INVALID_DESCRIPTION' });
  if (currency && !CURRENCY_RE.test(currency)) return res.status(422).json({ error: 'Devise invalide', code: 'INVALID_CURRENCY' });
  req.body.amount = amount;
  req.body.description = description;
  next();
};

const validatePayLinkSendRequest = (req, res, next) => {
  const channel = cleanString(req.body.channel, 16);
  const phone = cleanString(req.body.phone, 32);

  if (!channel || !CHANNEL_RE.test(channel)) {
    return res.status(422).json({ error: 'channel doit etre whatsapp ou sms', code: 'INVALID_CHANNEL' });
  }
  if (!phone) {
    return res.status(422).json({ error: 'phone requis', code: 'PHONE_REQUIRED' });
  }

  const normalizedPhone = phone.replace(/[\s\-().]/g, '');
  if (!PHONE_RE.test(normalizedPhone)) {
    return res.status(422).json({ error: 'Numero destinataire invalide', code: 'INVALID_PHONE' });
  }

  req.body.channel = channel;
  req.body.phone = normalizedPhone;
  next();
};

const validateUuidParam = (name) => (req, res, next) => {
  if (!UUID_RE.test(req.params[name] || '')) {
    return res.status(400).json({ error: 'Identifiant invalide', code: 'INVALID_ID' });
  }
  next();
};

module.exports = {
  validatePaymentRequest,
  validateLinkRequest,
  validatePayLinkSendRequest,
  validateUuidParam,
  parseAmount,
  cleanString,
};
