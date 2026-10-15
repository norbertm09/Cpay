-- ================================================================
-- CPlus 2.6.0 - Tokenisation moyens de paiement
-- Aucun PAN brut ne doit etre stocke dans cette table.
-- ================================================================

DO $$ BEGIN CREATE TYPE payment_token_status AS ENUM ('active','suspended','revoked','expired'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS payment_tokens (
  token_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id    UUID NOT NULL REFERENCES merchants(merchant_id),
  customer_ref   VARCHAR(128),
  token_type     VARCHAR(32) NOT NULL DEFAULT 'card',
  provider       VARCHAR(64) NOT NULL,
  token_ref      VARCHAR(256) NOT NULL,
  token_hash     CHAR(64) NOT NULL,
  fingerprint    CHAR(64),
  network        VARCHAR(32),
  last4          CHAR(4),
  expiry_month   SMALLINT,
  expiry_year    SMALLINT,
  status         payment_token_status NOT NULL DEFAULT 'active',
  metadata       JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at     TIMESTAMPTZ,
  UNIQUE (merchant_id, token_hash)
);

CREATE INDEX IF NOT EXISTS idx_payment_tokens_merchant ON payment_tokens(merchant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_tokens_customer ON payment_tokens(merchant_id, customer_ref);
