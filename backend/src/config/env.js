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
  // Vague 6 lot 2 : TLS PostgreSQL vérifié (docs/WAVE-6-LOT2.md §4) — DB_SSL=true + CA (ou magasin système)
  postgresTls: ['DB_SSL'],
};

// Vague 6 lot 2 : variables du registre de capacités (toutes optionnelles, lues à chaque appel)
//   CAPABILITY_PILOT_<CC>=true        ouverture restreinte (statut `pilot`) pour le pays CC (CM, CF, CG, GA, GQ, TD, CD)
//   CAPABILITY_LEGACY_ALLOW=false     bloque aussi les marchands SN / CI existants (défaut : tolérés, inscription refusée)
//   CAPABILITY_REGISTRATION_GUARD=off désactive le contrôle pays à l'inscription (environnements de test)
//   CARD_GATEWAY_<CC>=migs|mpgs       passerelle carte du pays si country_payment_defaults est absent
//   CAPABILITY_FUNDING_<CUR>=true     déclare un compte de collecte pour la devise sans platform_bank_accounts
//   DB_SSL_CA / DB_SSL_CA_FILE / DB_SSL_REJECT_UNAUTHORIZED / DB_SSL_SERVERNAME : voir config/database.js
const capabilityEnvVars = Object.freeze({
  pilotPrefix: 'CAPABILITY_PILOT_',
  optional: ['CAPABILITY_LEGACY_ALLOW', 'CAPABILITY_REGISTRATION_GUARD', 'DB_SSL_CA', 'DB_SSL_CA_FILE', 'DB_SSL_REJECT_UNAUTHORIZED', 'DB_SSL_SERVERNAME'],
});

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

  // Vague 6 lot 2 : TLS PostgreSQL non vérifié = avertissement explicite (jamais bloquant)
  if (String(process.env.DB_SSL || '').toLowerCase() === 'true' && String(process.env.DB_SSL_REJECT_UNAUTHORIZED || '').toLowerCase() === 'false') {
    warnings.push({ provider: 'postgresTls', missing: ['DB_SSL_REJECT_UNAUTHORIZED=false : certificat serveur non vérifié — fournir DB_SSL_CA ou DB_SSL_CA_FILE'] });
  }

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
  capabilityEnvVars,
};
