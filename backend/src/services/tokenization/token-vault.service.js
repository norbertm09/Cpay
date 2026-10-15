'use strict';

const crypto = require('crypto');
const { query } = require('../../config/database');

const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

const assertNoPan = (value) => {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length >= 13 && digits.length <= 19) {
    const err = new Error('PAN brut refuse: utilisez un token reseau, PSP ou SDK certifie');
    err.statusCode = 422;
    err.code = 'RAW_PAN_NOT_ALLOWED';
    throw err;
  }
};

const createToken = async ({ merchantId, customerRef, provider, tokenRef, network, last4, expiryMonth, expiryYear, metadata = {} }) => {
  if (!provider || !tokenRef) {
    const err = new Error('provider et tokenRef requis');
    err.statusCode = 422;
    throw err;
  }
  assertNoPan(tokenRef);
  const result = await query(
    `INSERT INTO payment_tokens
      (merchant_id, customer_ref, provider, token_ref, token_hash, fingerprint, network, last4, expiry_month, expiry_year, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (merchant_id, token_hash) DO UPDATE SET
       customer_ref=EXCLUDED.customer_ref, status='active', updated_at=NOW()
     RETURNING token_id, customer_ref, token_type, provider, network, last4, expiry_month, expiry_year, status, metadata, created_at`,
    [merchantId, customerRef || null, provider, tokenRef, hash(tokenRef), hash(`${provider}:${tokenRef}`), network || null, last4 || null, expiryMonth || null, expiryYear || null, JSON.stringify(metadata || {})]
  );
  return result.rows[0];
};

const listTokens = async ({ merchantId, customerRef }) => {
  const params = [merchantId];
  let where = 'WHERE merchant_id=$1';
  if (customerRef) { params.push(customerRef); where += ` AND customer_ref=$${params.length}`; }
  const result = await query(
    `SELECT token_id, customer_ref, token_type, provider, network, last4, expiry_month, expiry_year, status, metadata, created_at, updated_at
     FROM payment_tokens ${where} ORDER BY created_at DESC`,
    params
  );
  return result.rows;
};

const revokeToken = async ({ merchantId, tokenId }) => {
  const result = await query(
    `UPDATE payment_tokens SET status='revoked', revoked_at=NOW(), updated_at=NOW()
     WHERE merchant_id=$1 AND token_id=$2 RETURNING token_id, status`,
    [merchantId, tokenId]
  );
  return result.rows[0] || null;
};

module.exports = { createToken, listTokens, revokeToken, assertNoPan };
