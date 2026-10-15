'use strict';

const PLACEHOLDER_PATTERN = /^(REQUIRED|change_me|changeme|your_|sk_test_|\.\.\.)/i;

const requiredInProduction = [
  'DB_HOST',
  'DB_NAME',
  'DB_USER',
  'DB_PASSWORD',
  'JWT_SECRET',
  'INTERNAL_TOKEN',
  'API_BASE_URL',
  'PAY_LINK_BASE_URL',
  'ALLOWED_ORIGINS',
  'METRICS_TOKEN',
  'GRAFANA_PASSWORD',
  'CERTBOT_EMAIL',
  // Vague 2
  'CONFIG_ENCRYPTION_KEY', // chiffrement AES-256-GCM des api_configs (secrets.js)
  'WEBHOOK_PATH_SECRET',   // segment secret des URLs de webhooks Mobile Money
];

const recommendedProviders = {
  whatsapp: ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN'],
  smpp: ['SMPP_HOST', 'SMPP_SYSTEM_ID', 'SMPP_PASSWORD'],
  migs: ['MIGS_MERCHANT_ID', 'MIGS_ACCESS_CODE', 'MIGS_SECURE_HASH'],
  cybersource: ['CS_MERCHANT_ID', 'CS_API_KEY_ID', 'CS_SECRET_KEY'],
  mpgs: ['MPGS_MERCHANT_ID', 'MPGS_API_PASSWORD'],
  visa: ['VISA_BASE_URL', 'VISA_USER_ID', 'VISA_PASSWORD'],
  mastercardDevelopers: ['MASTERCARD_DEVELOPERS_CONSUMER_KEY', 'MASTERCARD_DEVELOPERS_PRIVATE_KEY_PATH'],
  paymenthub: ['PAYMENTHUB_BASE_URL', 'PAYMENTHUB_WEBHOOK_TOKEN'],
  interswitchDrc: ['INTERSWITCH_AUTH_BASE_URL', 'INTERSWITCH_WALLET_BASE_URL'],
  assistant: ['ANTHROPIC_API_KEY'],
  wave: ['WAVE_WEBHOOK_SECRET'],
};

const valueLooksMissing = (name) => {
  const value = process.env[name];
  return !value || PLACEHOLDER_PATTERN.test(String(value).trim());
};

const validateEnv = ({ strict = process.env.NODE_ENV === 'production' } = {}) => {
  const missing = requiredInProduction.filter(valueLooksMissing);
  const warnings = [];

  if (process.env.JWT_SECRET && process.env.JWT_SECRET.length < 32) {
    missing.push('JWT_SECRET must be at least 32 characters');
  }

  Object.entries(recommendedProviders).forEach(([provider, keys]) => {
    const absent = keys.filter(valueLooksMissing);
    if (absent.length) warnings.push({ provider, missing: absent });
  });

  if (strict && missing.length) {
    const err = new Error(`Production environment invalid: ${missing.join(', ')}`);
    err.code = 'ENV_VALIDATION_FAILED';
    err.missing = missing;
    err.warnings = warnings;
    throw err;
  }

  return { ok: missing.length === 0, missing, warnings };
};

module.exports = {
  validateEnv,
  requiredInProduction,
  recommendedProviders,
};
