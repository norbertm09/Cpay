-- ================================================================
-- CPlus 2.6.0 - Integrations comptabilite / CRM
-- ================================================================

DO $$ BEGIN CREATE TYPE integration_type AS ENUM ('accounting','crm','erp','webhook'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE integration_status AS ENUM ('inactive','active','error'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS merchant_integrations (
  integration_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id    UUID NOT NULL REFERENCES merchants(merchant_id),
  integration_type integration_type NOT NULL,
  provider       VARCHAR(64) NOT NULL,
  display_name   VARCHAR(160) NOT NULL,
  endpoint_url   VARCHAR(512),
  auth_type      VARCHAR(32) NOT NULL DEFAULT 'none',
  auth_config    JSONB NOT NULL DEFAULT '{}',
  event_types    TEXT[] NOT NULL DEFAULT ARRAY['transaction.authorized','transaction.failed','settlement.completed'],
  signing_secret VARCHAR(128) NOT NULL DEFAULT substr(md5(random()::text) || md5(random()::text), 1, 64),
  status         integration_status NOT NULL DEFAULT 'inactive',
  last_sync_at   TIMESTAMPTZ,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS integration_delivery_logs (
  delivery_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id UUID REFERENCES merchant_integrations(integration_id) ON DELETE SET NULL,
  merchant_id    UUID NOT NULL REFERENCES merchants(merchant_id),
  event_type     VARCHAR(80) NOT NULL,
  payload        JSONB NOT NULL,
  status_code    INTEGER,
  success        BOOLEAN NOT NULL DEFAULT FALSE,
  response_body  TEXT,
  error_message  TEXT,
  delivered_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integrations_merchant ON merchant_integrations(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_delivery_merchant ON integration_delivery_logs(merchant_id, delivered_at DESC);
