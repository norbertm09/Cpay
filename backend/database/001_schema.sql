-- ================================================================
-- Calculus Plus — Schéma PostgreSQL
-- Principe : toute la complexité est dans la plateforme, pas dans le schéma
-- ================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Enum types ───────────────────────────────────────────────────

DO $$ BEGIN CREATE TYPE merchant_status    AS ENUM ('pending','active','suspended','closed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE kyb_status         AS ENUM ('not_started','in_progress','verified','rejected'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE txn_type           AS ENUM ('collect','payout','qr_payment','pay_link'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE txn_status         AS ENUM ('pending','authorized','failed','reversed','refunded','expired'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE payment_method     AS ENUM ('mobile_money','card_nfc','qr','pay_link'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE settlement_status  AS ENUM ('pending','submitted','completed','failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE settlement_type    AS ENUM ('bank','mobile_money'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Marchands ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS merchants (
  merchant_id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  business_name     VARCHAR(255)  NOT NULL,
  rccm              VARCHAR(100),
  nif               VARCHAR(100),
  phone             VARCHAR(32)   UNIQUE NOT NULL,
  email             VARCHAR(255)  UNIQUE NOT NULL,
  country           CHAR(2)       NOT NULL,            -- ISO 3166-1
  currency          VARCHAR(3)    NOT NULL DEFAULT 'XOF',
  -- Settlement
  settlement_type   settlement_type NOT NULL DEFAULT 'mobile_money',
  settlement_account VARCHAR(100),                      -- IBAN ou numéro téléphone
  settlement_provider VARCHAR(64),                      -- nom banque ou opérateur
  -- KYB & niveaux
  kyb_status        kyb_status    NOT NULL DEFAULT 'not_started',
  kyb_level         SMALLINT      NOT NULL DEFAULT 0,   -- 0, 1, 2
  merchant_status   merchant_status NOT NULL DEFAULT 'active',
  -- Métadonnées
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ─── Utilisateurs marchands ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS merchant_users (
  user_id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id   UUID NOT NULL REFERENCES merchants(merchant_id),
  email         VARCHAR(255) UNIQUE NOT NULL,
  phone         VARCHAR(32)  UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  first_name    VARCHAR(100),
  last_name     VARCHAR(100),
  role          VARCHAR(32)  NOT NULL DEFAULT 'owner',   -- owner | cashier | viewer
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  mfa_secret    VARCHAR(64),                              -- TOTP secret
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ─── Transactions ─────────────────────────────────────────────────
-- Le schéma stocke les infos détectées pour l'audit, pas pour l'affichage marchand

CREATE TABLE IF NOT EXISTS transactions (
  transaction_id      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id         UUID NOT NULL REFERENCES merchants(merchant_id),
  type                txn_type       NOT NULL,
  amount              NUMERIC(15,2)  NOT NULL,
  currency            CHAR(3)        NOT NULL,
  payment_method      payment_method NOT NULL,
  status              txn_status     NOT NULL DEFAULT 'pending',
  -- Détection automatique (interne — jamais affiché au marchand)
  detected_operator   VARCHAR(64),    -- ex: MTN_MOMO
  detected_network    VARCHAR(32),    -- ex: VISA, MASTERCARD
  detected_country    CHAR(2),        -- ex: CM, SN
  -- Gateway info
  gateway_name        VARCHAR(32),
  gateway_payment_id  VARCHAR(128),
  gateway_order_id    VARCHAR(128),
  auth_code           VARCHAR(64),
  response_code       VARCHAR(8),
  response_message    TEXT,
  -- Infos client (hashées pour la privacy)
  customer_phone_hash VARCHAR(64),    -- SHA-256 du numéro
  -- Device
  device_id           VARCHAR(64),
  -- Montants calculés
  fee_amount          NUMERIC(15,2),
  net_amount          NUMERIC(15,2),
  -- Description marchand
  description         TEXT,
  -- Timestamps
  initiated_at        TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  reversed_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_txn_merchant    ON transactions(merchant_id);
CREATE INDEX IF NOT EXISTS idx_txn_status      ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_txn_initiated   ON transactions(initiated_at DESC);
CREATE INDEX IF NOT EXISTS idx_txn_date        ON transactions(merchant_id, DATE(initiated_at));

-- ─── Queue de settlement ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS settlement_queue (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  UUID    UNIQUE NOT NULL REFERENCES transactions(transaction_id),
  merchant_id     UUID    NOT NULL REFERENCES merchants(merchant_id),
  amount          NUMERIC(15,2) NOT NULL,
  currency        CHAR(3) NOT NULL,
  fee_amount      NUMERIC(15,2),
  net_amount      NUMERIC(15,2),
  settled         BOOLEAN NOT NULL DEFAULT FALSE,
  batch_id        UUID,
  queued_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at      TIMESTAMPTZ
);

-- ─── Batches de settlement ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS settlement_batches (
  batch_id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id         UUID          NOT NULL REFERENCES merchants(merchant_id),
  batch_date          DATE          NOT NULL,
  total_gross         NUMERIC(15,2) NOT NULL,
  total_fees          NUMERIC(15,2) NOT NULL,
  total_net           NUMERIC(15,2) NOT NULL,
  currency            CHAR(3)       NOT NULL,
  txn_count           INTEGER       NOT NULL,
  settlement_type     settlement_type NOT NULL,
  settlement_account  VARCHAR(100),
  settlement_provider VARCHAR(64),
  status              settlement_status NOT NULL DEFAULT 'pending',
  submitted_at        TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_batch_merchant ON settlement_batches(merchant_id);
CREATE INDEX IF NOT EXISTS idx_batch_date     ON settlement_batches(batch_date);

-- ─── Pay Links & QR Codes ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pay_links (
  pay_link_id   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  merchant_id   UUID NOT NULL REFERENCES merchants(merchant_id),
  short_id      VARCHAR(16) UNIQUE,
  amount        NUMERIC(15,2),
  currency      CHAR(3),
  description   TEXT,
  type          VARCHAR(16) NOT NULL DEFAULT 'paylink',  -- paylink | qr
  short_url     VARCHAR(512),
  status        VARCHAR(16) NOT NULL DEFAULT 'active',
  paid_at       TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paylink_short   ON pay_links(short_id);
CREATE INDEX IF NOT EXISTS idx_paylink_merchant ON pay_links(merchant_id);

-- ─── Plafonds journaliers ─────────────────────────────────────────

CREATE OR REPLACE VIEW v_merchant_daily_volume AS
SELECT
  merchant_id,
  CURRENT_DATE AS day,
  COUNT(*)     AS txn_count,
  SUM(amount)  AS daily_volume,
  currency
FROM transactions
WHERE DATE(initiated_at) = CURRENT_DATE
  AND status IN ('authorized', 'pending')
GROUP BY merchant_id, currency;

-- ─── Dashboard marchand ───────────────────────────────────────────
-- Vue simplifiée — aucune complexité technique visible

CREATE OR REPLACE VIEW v_merchant_dashboard AS
SELECT
  t.merchant_id,
  COUNT(*)                  FILTER (WHERE DATE(t.initiated_at) = CURRENT_DATE AND t.status = 'authorized') AS txn_today,
  COALESCE(SUM(t.amount)    FILTER (WHERE DATE(t.initiated_at) = CURRENT_DATE AND t.status = 'authorized'), 0) AS amount_today,
  COALESCE(SUM(sb.total_net) FILTER (WHERE sb.batch_date = CURRENT_DATE AND sb.status IN ('pending','submitted')), 0) AS settling_tomorrow
FROM transactions t
LEFT JOIN settlement_queue sq  ON t.transaction_id = sq.transaction_id
LEFT JOIN settlement_batches sb ON sq.batch_id     = sb.batch_id
GROUP BY t.merchant_id;

-- ─── Seed minimal ─────────────────────────────────────────────────

INSERT INTO merchants (merchant_id, business_name, phone, email, country, currency, settlement_type, settlement_account, kyb_level, merchant_status)
VALUES (
  uuid_generate_v4(),
  'Boutique Test',
  '+237699000001',
  'test@calculus.africa',
  'CM', 'XAF',
  'mobile_money', '+237699000001',
  1, 'active'
) ON CONFLICT DO NOTHING;
