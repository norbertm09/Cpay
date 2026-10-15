-- ================================================================
-- CPlus 2.6.0 - Pilot control production rollout
-- Objectif: lancer un pilote controle avant generalisation.
-- ================================================================

DO $$ BEGIN CREATE TYPE pilot_program_status AS ENUM ('draft','active','paused','completed','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE pilot_enrollment_status AS ENUM ('invited','active','paused','completed','removed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE feature_flag_status AS ENUM ('disabled','audit','enabled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS pilot_programs (
  pilot_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_key         VARCHAR(80) NOT NULL UNIQUE,
  name              VARCHAR(160) NOT NULL,
  target_version    VARCHAR(32) NOT NULL DEFAULT '2.3',
  status            pilot_program_status NOT NULL DEFAULT 'draft',
  country_scope     TEXT[] NOT NULL DEFAULT '{}',
  success_metrics   JSONB NOT NULL DEFAULT '{}',
  risk_controls     JSONB NOT NULL DEFAULT '{}',
  start_at          TIMESTAMPTZ,
  end_at            TIMESTAMPTZ,
  created_by        UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pilot_merchant_enrollments (
  enrollment_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pilot_id          UUID NOT NULL REFERENCES pilot_programs(pilot_id) ON DELETE CASCADE,
  merchant_id       UUID NOT NULL REFERENCES merchants(merchant_id) ON DELETE CASCADE,
  status            pilot_enrollment_status NOT NULL DEFAULT 'active',
  rollout_percent   SMALLINT NOT NULL DEFAULT 100 CHECK (rollout_percent BETWEEN 0 AND 100),
  notes             TEXT,
  enrolled_by       UUID,
  enrolled_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (pilot_id, merchant_id)
);

CREATE TABLE IF NOT EXISTS feature_flags (
  flag_key          VARCHAR(80) PRIMARY KEY,
  display_name      VARCHAR(160) NOT NULL,
  description       TEXT,
  status            feature_flag_status NOT NULL DEFAULT 'audit',
  default_enabled   BOOLEAN NOT NULL DEFAULT FALSE,
  pilot_only        BOOLEAN NOT NULL DEFAULT TRUE,
  rollout_percent   SMALLINT NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
  config            JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS feature_flag_overrides (
  override_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flag_key          VARCHAR(80) NOT NULL REFERENCES feature_flags(flag_key) ON DELETE CASCADE,
  merchant_id       UUID NOT NULL REFERENCES merchants(merchant_id) ON DELETE CASCADE,
  enabled           BOOLEAN NOT NULL,
  reason            TEXT,
  updated_by        UUID,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (flag_key, merchant_id)
);

CREATE TABLE IF NOT EXISTS pilot_decision_logs (
  decision_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id       UUID REFERENCES merchants(merchant_id) ON DELETE SET NULL,
  pilot_key         VARCHAR(80),
  flag_key          VARCHAR(80),
  decision          VARCHAR(24) NOT NULL,
  mode              VARCHAR(24) NOT NULL,
  reason            TEXT,
  context           JSONB NOT NULL DEFAULT '{}',
  request_id        VARCHAR(80),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pilot_readiness_checks (
  check_key         VARCHAR(80) PRIMARY KEY,
  category          VARCHAR(80) NOT NULL,
  display_name      VARCHAR(160) NOT NULL,
  required          BOOLEAN NOT NULL DEFAULT TRUE,
  status            VARCHAR(24) NOT NULL DEFAULT 'pending',
  evidence          TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pilot_enrollments_merchant ON pilot_merchant_enrollments(merchant_id, status);
CREATE INDEX IF NOT EXISTS idx_pilot_decisions_merchant ON pilot_decision_logs(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pilot_decisions_flag ON pilot_decision_logs(flag_key, created_at DESC);

INSERT INTO pilot_programs (pilot_key, name, target_version, status, country_scope, success_metrics, risk_controls)
VALUES (
  'cplus-2-6-production-ovh',
  'CPLUS 2.6.0 - Pilot controle production OVH',
  '2.3',
  'active',
  ARRAY['CD','CM','SN','CI'],
  '{"approvalRateMin":0.90,"p95LatencyMsMax":3500,"incidentP1Max":0,"settlementSuccessMin":0.98}'::jsonb,
  '{"mode":"controlled","dailyVolumeCap":5000000,"supportSlaHours":4,"rollback":"feature_flag_disable"}'::jsonb
)
ON CONFLICT (pilot_key) DO UPDATE SET
  status = EXCLUDED.status,
  success_metrics = EXCLUDED.success_metrics,
  risk_controls = EXCLUDED.risk_controls,
  updated_at = NOW();

INSERT INTO feature_flags (flag_key, display_name, description, status, default_enabled, pilot_only, rollout_percent, config)
VALUES
  ('tap_to_phone', 'Tap to Phone', 'Encaissement carte NFC sur telephone/TPE Android.', 'audit', FALSE, TRUE, 0, '{"requiresTokenization":true}'::jsonb),
  ('qr_code', 'QR Code paiement', 'Generation et paiement par QR visuel.', 'enabled', TRUE, FALSE, 100, '{}'::jsonb),
  ('pay_by_link', 'Pay by Link', 'Lien de paiement partageable WhatsApp/SMS/copier.', 'enabled', TRUE, FALSE, 100, '{}'::jsonb),
  ('tokenization', 'Tokenization', 'Vault token provider/network sans stockage PAN.', 'audit', FALSE, TRUE, 0, '{"rawPanAllowed":false}'::jsonb),
  ('visa_direct', 'Visa Direct', 'Rails Visa Direct et Visa Account/Wallet.', 'audit', FALSE, TRUE, 0, '{}'::jsonb),
  ('mastercard_migs', 'Mastercard MIGS', 'Gateway carte par defaut selon pays.', 'enabled', TRUE, FALSE, 100, '{}'::jsonb),
  ('interswitch_wallet_drc', 'Interswitch Wallet DRC', 'Wallet payments DRC via Interswitch.', 'audit', FALSE, TRUE, 0, '{}'::jsonb),
  ('paymenthub_drc', 'PaymentHub DRC', 'Mobile Money DRC via PaymentHub.', 'audit', FALSE, TRUE, 0, '{}'::jsonb),
  ('ticketing', 'Ticketing', 'Support marchand-admin.', 'enabled', TRUE, FALSE, 100, '{}'::jsonb),
  ('crm_accounting_export', 'CRM/Accounting export', 'Webhooks et exports comptables.', 'audit', FALSE, TRUE, 0, '{}'::jsonb)
ON CONFLICT (flag_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  status = EXCLUDED.status,
  default_enabled = EXCLUDED.default_enabled,
  pilot_only = EXCLUDED.pilot_only,
  rollout_percent = EXCLUDED.rollout_percent,
  config = EXCLUDED.config,
  updated_at = NOW();

INSERT INTO pilot_readiness_checks (check_key, category, display_name, required, status, evidence)
VALUES
  ('env_secrets', 'security', 'Secrets production configures', TRUE, 'pending', 'npm run check:prod'),
  ('db_migrations', 'database', 'Migrations appliquees sans checksum change', TRUE, 'pending', 'npm run migrate'),
  ('provider_credentials', 'payments', 'Credentials providers pilotes valides', TRUE, 'pending', 'POST /api/v1/admin/api-configs/:key/test'),
  ('observability', 'operations', 'Logs, healthchecks et alerting actifs', TRUE, 'pending', '/live, /ready, /health'),
  ('rollback_flags', 'operations', 'Rollback par feature flag documente', TRUE, 'done', 'PUT /api/v1/admin/pilot/features/:flagKey status=disabled'),
  ('support_sla', 'support', 'Circuit ticketing support pilote actif', TRUE, 'done', '/api/v1/admin/support/tickets')
ON CONFLICT (check_key) DO NOTHING;
