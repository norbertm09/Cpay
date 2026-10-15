-- ================================================================
-- CPlus 2.6.0 — Migration 002
-- api_configurations  : paramètres des opérateurs MM et gateways
-- terminals           : terminaux marchands (multi-device)
-- admin_users         : administrateurs plateforme
-- audit_logs          : journal des actions admin
-- ================================================================

-- ─── Enum types ───────────────────────────────────────────────────
DO $$ BEGIN CREATE TYPE api_provider_type AS ENUM (
  'mobile_money', 'card_gateway'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE api_status AS ENUM (
  'active', 'inactive', 'testing', 'error'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE terminal_status AS ENUM (
  'active', 'inactive', 'blocked'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN CREATE TYPE admin_role AS ENUM (
  'super_admin', 'ops_admin', 'finance_admin', 'support_agent'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Configurations API ────────────────────────────────────────────
-- Stocke les clés et paramètres de chaque opérateur/gateway.
-- Démarrage : on lit ces configs si présentes, sinon la transaction
-- échoue au moment de l'appel (pas de blocage au login).

CREATE TABLE IF NOT EXISTS api_configurations (
  config_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key    VARCHAR(64)  NOT NULL UNIQUE,  -- ex: mtn_cm, orange_sn, cybersource
  provider_type   api_provider_type NOT NULL,
  display_name    VARCHAR(128) NOT NULL,
  country         CHAR(2),                        -- NULL = global (ex: cybersource)
  -- Paramètres (stockés chiffrés en prod via pgcrypto ou Vault)
  base_url        VARCHAR(512),
  api_key         VARCHAR(512),
  api_secret      TEXT,                           -- peut être long (certs, keys)
  extra_params    JSONB NOT NULL DEFAULT '{}',    -- params spécifiques opérateur
  -- État
  status          api_status NOT NULL DEFAULT 'inactive',
  last_tested_at  TIMESTAMPTZ,
  last_test_ok    BOOLEAN,
  last_error      TEXT,
  -- Métadonnées
  notes           TEXT,
  created_by      UUID,
  updated_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_config_provider ON api_configurations(provider_key);
CREATE INDEX IF NOT EXISTS idx_api_config_country  ON api_configurations(country);
CREATE INDEX IF NOT EXISTS idx_api_config_status   ON api_configurations(status);

-- Affectation par pays: chaque marchand recoit les providers Mobile Money
-- de son pays et MIGS comme gateway Mastercard par defaut.
CREATE TABLE IF NOT EXISTS country_payment_defaults (
  country                 CHAR(2) PRIMARY KEY,
  currency                CHAR(3) NOT NULL,
  mobile_money_providers  TEXT[] NOT NULL DEFAULT '{}',
  default_card_gateway    VARCHAR(64) NOT NULL DEFAULT 'migs',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS merchant_api_assignments (
  merchant_id    UUID NOT NULL REFERENCES merchants(merchant_id) ON DELETE CASCADE,
  provider_key   VARCHAR(64) NOT NULL REFERENCES api_configurations(provider_key),
  provider_type  api_provider_type NOT NULL,
  is_default     BOOLEAN NOT NULL DEFAULT FALSE,
  assigned_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (merchant_id, provider_key)
);

CREATE INDEX IF NOT EXISTS idx_merchant_api_assignments_provider ON merchant_api_assignments(provider_key);

-- ─── Terminaux marchands ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS terminals (
  terminal_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     UUID NOT NULL REFERENCES merchants(merchant_id) ON DELETE CASCADE,
  terminal_code   VARCHAR(32) UNIQUE NOT NULL,    -- ex: TERM-CM-001
  terminal_name   VARCHAR(128),                   -- nom libre : "Caisse principale"
  device_model    VARCHAR(128),                   -- ex: Samsung Galaxy A54
  android_id      VARCHAR(64) UNIQUE,             -- android_id de l'appareil
  app_version     VARCHAR(16),
  status          terminal_status NOT NULL DEFAULT 'active',
  last_seen_at    TIMESTAMPTZ,
  last_ip         INET,
  created_by      UUID,                           -- user_id qui a créé le terminal
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_terminals_merchant   ON terminals(merchant_id);
CREATE INDEX IF NOT EXISTS idx_terminals_android    ON terminals(android_id);
CREATE INDEX IF NOT EXISTS idx_terminals_status     ON terminals(status);

-- ─── Administrateurs plateforme ───────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_users (
  admin_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           VARCHAR(255) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  first_name      VARCHAR(100),
  last_name       VARCHAR(100),
  role            admin_role NOT NULL DEFAULT 'support_agent',
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  mfa_secret      VARCHAR(64),
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Audit logs ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  log_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id        UUID,                     -- admin_id ou user_id
  actor_type      VARCHAR(16) NOT NULL,     -- 'admin' | 'merchant'
  actor_email     VARCHAR(255),
  action          VARCHAR(128) NOT NULL,    -- ex: 'API_CONFIG_UPDATE', 'MERCHANT_SUSPEND'
  entity_type     VARCHAR(64),              -- ex: 'api_config', 'merchant', 'terminal'
  entity_id       UUID,
  old_values      JSONB,
  new_values      JSONB,
  ip_address      INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_actor   ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_action  ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

-- ─── Seed configs API (toutes inactives par défaut) ───────────────
INSERT INTO api_configurations (provider_key, provider_type, display_name, country, status)
VALUES
  -- Mobile Money — Sénégal
  ('orange_sn',       'mobile_money', 'Orange Money Sénégal',       'SN', 'inactive'),
  ('wave_sn',         'mobile_money', 'Wave Sénégal',                'SN', 'inactive'),
  ('free_money_sn',   'mobile_money', 'Free Money Sénégal',          'SN', 'inactive'),
  -- Mobile Money — Côte d'Ivoire
  ('orange_ci',       'mobile_money', 'Orange Money Cote d''Ivoire',  'CI', 'inactive'),
  ('mtn_ci',          'mobile_money', 'MTN Mobile Money Cote d''Ivoire', 'CI', 'inactive'),
  ('moov_ci',         'mobile_money', 'Moov Money Cote d''Ivoire',    'CI', 'inactive'),
  ('wave_ci',         'mobile_money', 'Wave Cote d''Ivoire',           'CI', 'inactive'),
  -- Mobile Money — Cameroun
  ('mtn_cm',          'mobile_money', 'MTN Mobile Money Cameroun',    'CM', 'inactive'),
  ('orange_cm',       'mobile_money', 'Orange Money Cameroun',        'CM', 'inactive'),
  ('express_union_cm','mobile_money', 'Express Union Cameroun',       'CM', 'inactive'),
  ('moov_cm',         'mobile_money', 'Moov Money Cameroun',          'CM', 'inactive'),
  -- Mobile Money — Congo Brazzaville
  ('mtn_cg',          'mobile_money', 'MTN Mobile Money Congo',       'CG', 'inactive'),
  ('airtel_cg',       'mobile_money', 'Airtel Money Congo',           'CG', 'inactive'),
  ('orange_cg',       'mobile_money', 'Orange Money Congo',           'CG', 'inactive'),
  -- Mobile Money — RDC
  ('vodacom_cd',      'mobile_money', 'Vodacom M-Pesa RDC',           'CD', 'inactive'),
  ('airtel_cd',       'mobile_money', 'Airtel Money RDC',             'CD', 'inactive'),
  ('orange_cd',       'mobile_money', 'Orange Money RDC',             'CD', 'inactive'),
  ('africell_cd',     'mobile_money', 'Africell Money RDC',           'CD', 'inactive'),
  -- Gateways carte
  ('cybersource',     'card_gateway', 'CyberSource (Visa TTP)',        NULL, 'inactive'),
  ('mpgs',            'card_gateway', 'MPGS (Mastercard ToP)',         NULL, 'inactive'),
  ('stripe',          'card_gateway', 'Stripe Terminal',               NULL, 'inactive'),
  ('migs',            'card_gateway', 'MIGS (Mastercard IGS)',         NULL, 'inactive'),
  ('gimac',           'card_gateway', 'GIMAC (Réseau CEMAC)',          NULL, 'inactive'),
  ('visa_direct',     'card_gateway', 'Visa Direct Funds Transfer',     NULL, 'inactive'),
  ('visa_account_wallet', 'card_gateway', 'Visa Account and Wallet Payouts', NULL, 'inactive'),
  ('mastercard_developers', 'card_gateway', 'Mastercard Developers API', NULL, 'inactive')
ON CONFLICT (provider_key) DO NOTHING;

INSERT INTO api_configurations (provider_key, provider_type, display_name, country, status, extra_params, notes)
VALUES
  ('interswitch_mpesa_cd',    'mobile_money', 'Interswitch Wallet DRC - M-Pesa',        'CD', 'inactive', '{"walletProvider":"MPESA"}',       'Wallet Payments API DRC: collect via mobile-wallet/initialize'),
  ('interswitch_orange_cd',   'mobile_money', 'Interswitch Wallet DRC - Orange Money',  'CD', 'inactive', '{"walletProvider":"ORANGE"}',      'Wallet Payments API DRC: collect via mobile-wallet/initialize'),
  ('interswitch_airtel_cd',   'mobile_money', 'Interswitch Wallet DRC - Airtel Money',  'CD', 'inactive', '{"walletProvider":"AIRTELMONEY"}', 'Wallet Payments API DRC: collect via mobile-wallet/initialize'),
  ('interswitch_africell_cd', 'mobile_money', 'Interswitch Wallet DRC - Africell Money','CD', 'inactive', '{"walletProvider":"AFRIMONEY"}',   'Wallet Payments API DRC: collect via mobile-wallet/initialize'),
  ('paymenthub_mpesa_cd',     'mobile_money', 'PaymentHub DRC - M-Pesa Payout',         'CD', 'inactive', '{"paymentItemCode":"MPESA"}',      'PaymentHub API v1.1: payout payment instruction'),
  ('paymenthub_orange_cd',    'mobile_money', 'PaymentHub DRC - Orange Money Payout',   'CD', 'inactive', '{"paymentItemCode":"OM"}',         'PaymentHub API v1.1: payout payment instruction'),
  ('paymenthub_airtel_cd',    'mobile_money', 'PaymentHub DRC - Airtel Money Payout',   'CD', 'inactive', '{"paymentItemCode":"AM"}',         'PaymentHub API v1.1: payout payment instruction'),
  ('paymenthub_africell_cd',  'mobile_money', 'PaymentHub DRC - Africell Money Payout', 'CD', 'inactive', '{"paymentItemCode":"AFM"}',        'PaymentHub API v1.1: payout payment instruction')
ON CONFLICT (provider_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  country = EXCLUDED.country,
  extra_params = api_configurations.extra_params || EXCLUDED.extra_params,
  notes = EXCLUDED.notes,
  updated_at = NOW();

INSERT INTO country_payment_defaults (country, currency, mobile_money_providers, default_card_gateway)
VALUES
  ('SN', 'XOF', ARRAY['orange_sn','wave_sn','free_money_sn'], 'migs'),
  ('CI', 'XOF', ARRAY['orange_ci','mtn_ci','moov_ci','wave_ci'], 'migs'),
  ('CM', 'XAF', ARRAY['mtn_cm','orange_cm','express_union_cm','moov_cm'], 'migs'),
  ('CG', 'XAF', ARRAY['mtn_cg','airtel_cg','orange_cg'], 'migs'),
  ('CD', 'CDF', ARRAY[
    'vodacom_cd','airtel_cd','orange_cd','africell_cd',
    'interswitch_mpesa_cd','interswitch_orange_cd','interswitch_airtel_cd','interswitch_africell_cd',
    'paymenthub_mpesa_cd','paymenthub_orange_cd','paymenthub_airtel_cd','paymenthub_africell_cd'
  ], 'migs')
ON CONFLICT (country) DO UPDATE SET
  currency = EXCLUDED.currency,
  mobile_money_providers = EXCLUDED.mobile_money_providers,
  default_card_gateway = EXCLUDED.default_card_gateway,
  updated_at = NOW();

-- ─── Premier administrateur ────────────────────────────────────────
-- Initialisation admin: utiliser une procedure d'exploitation securisee.
-- Aucun compte admin par defaut n'est cree.
-- Creer le premier super_admin via une procedure d'exploitation securisee
-- avec un mot de passe unique hashe en bcrypt.
