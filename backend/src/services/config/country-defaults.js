'use strict';

const { query } = require('../../config/database');

const execQuery = (client) => client ? client.query.bind(client) : query;

const normalizeCountry = (country) => String(country || '').trim().toUpperCase();

const getCountryDefaults = async (country, client = null) => {
  const exec = execQuery(client);
  const countryCode = normalizeCountry(country);
  if (!countryCode) return null;

  const result = await exec(
    `SELECT country, currency, mobile_money_providers, default_card_gateway
     FROM country_payment_defaults
     WHERE country = $1`,
    [countryCode]
  );
  return result.rows[0] || null;
};

const assignMerchantCountryDefaults = async ({ merchantId, country, client = null }) => {
  const exec = execQuery(client);
  const defaults = await getCountryDefaults(country, client);
  if (!defaults) return { country: normalizeCountry(country), assignedProviders: [] };

  const providers = [...defaults.mobile_money_providers, defaults.default_card_gateway];
  const result = await exec(
    `INSERT INTO merchant_api_assignments (merchant_id, provider_key, provider_type, is_default)
     SELECT $1, ac.provider_key, ac.provider_type, ac.provider_key = $3
     FROM api_configurations ac
     WHERE ac.provider_key = ANY($2::text[])
     ON CONFLICT (merchant_id, provider_key) DO UPDATE SET
       provider_type = EXCLUDED.provider_type,
       is_default = EXCLUDED.is_default,
       assigned_at = NOW()
     RETURNING provider_key, provider_type, is_default`,
    [merchantId, providers, defaults.default_card_gateway]
  );

  return {
    country: defaults.country,
    currency: defaults.currency,
    defaultCardGateway: defaults.default_card_gateway,
    assignedProviders: result.rows,
  };
};

module.exports = {
  assignMerchantCountryDefaults,
  getCountryDefaults,
  normalizeCountry,
};
