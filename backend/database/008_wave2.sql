-- ================================================================
-- C-Pay 2.6.0 — Migration 008 (VAGUE 2) : paiements (a), authentification (b), CRM/vitrine (c)
-- Fusion de 008a/008b/008c (config/migrate.js n'accepte que ^\d+_.*\.sql)
-- ================================================================

-- ============================================================================
-- 008a — WAVE-2 (paiements) : audit production 2.6.0
--   * transactions.pay_link_id : lien encaissement ↔ pay_links (marqué 'paid' par les webhooks MM)
--   * pay_links.paid_amount    : montant encaissé (déjà écrit par server.js / webhook-handlers,
--                                absent de 001)
--   * webhook_events.provider  : élargi aux providers Mobile Money WAVE-2
--   * idempotency_keys         : index de purge (IDEMPOTENCY_TTL_HOURS) et de lookup
-- Idempotent (IF NOT EXISTS). Aucune donnée supprimée.
-- ============================================================================

-- 1. Pay links ↔ transactions
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS pay_link_id UUID REFERENCES pay_links(pay_link_id);
CREATE INDEX IF NOT EXISTS idx_txn_pay_link ON transactions(pay_link_id) WHERE pay_link_id IS NOT NULL;

ALTER TABLE pay_links ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(15,2);

-- 2. Lookup des webhooks par référence opérateur (Orange notif_token, Wave session id…)
CREATE INDEX IF NOT EXISTS idx_txn_gateway_payment_id ON transactions(gateway_payment_id) WHERE gateway_payment_id IS NOT NULL;

-- 3. Journal des callbacks : providers Mobile Money WAVE-2
COMMENT ON COLUMN webhook_events.provider IS
  'mtn | airtel | cybersource | migs | stripe | orange | wave | africell | express_union | free_money | moov';
COMMENT ON COLUMN webhook_events.outcome IS
  'authorized | failed | completed | needs_refund | replay_ignored | mismatch | still_pending | provider_unavailable | unknown_reference | rejected | received';

-- 4. Idempotence : purge paresseuse (middleware/idempotency.js) et libération des clés 5xx
CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at DESC);
COMMENT ON TABLE idempotency_keys IS
  'Clés Idempotency-Key : 2xx/4xx persistées et rejouées ; 5xx et handlers en erreur libèrent la clé ; purge après IDEMPOTENCY_TTL_HOURS (défaut 24 h).';

-- 5. Secrets providers chiffrés au repos (config/secrets.js, AES-256-GCM, préfixe enc:v1:)
--    Migration des lignes existantes : CONFIG_ENCRYPTION_KEY=… node scripts/encrypt-api-configs.js [--dry-run]
COMMENT ON COLUMN api_configurations.api_key    IS 'Chiffré AES-256-GCM (enc:v1:…) via CONFIG_ENCRYPTION_KEY ; valeurs héritées en clair tolérées jusqu''à migration';
COMMENT ON COLUMN api_configurations.api_secret IS 'Chiffré AES-256-GCM (enc:v1:…) via CONFIG_ENCRYPTION_KEY ; valeurs héritées en clair tolérées jusqu''à migration';
COMMENT ON COLUMN api_configurations.extra_params IS 'JSONB ; les clés /secret|pass|token|key|pin|private/i sont chiffrées (enc:v1:…). Clés réservées non prises en compte : apiKey, apiSecret, baseUrl, providerKey';

-- ================================================================
-- C-Pay 2.6.0 — Migration 008b (WAVE-2 : authentification unifiee)
-- Audit prod 2.6.0 §1.1, §2.11, §2.13-2.16, §2.19-2.20
--
-- - refresh_tokens : un seul mecanisme pour TOUS les acteurs (merchant,
--   admin, cardholder, partner, bank/agency/agent). Les refresh sont opaques
--   (32 octets aleatoires) et stockes hashes ; les identifiants partenaires
--   ne sont pas forcement des UUID (bank_users / agents non versionnes) ->
--   subject_id passe en TEXT.
-- - 2FA (mfa_enabled / mfa_secret) sur merchant_users, admin_users, cardholders.
-- - Hygiene mots de passe : temp_password (force mustChangePassword au login),
--   failed_attempts / locked_until (verrouillage partenaires apres 10 echecs).
--
-- Toutes les instructions sont idempotentes (IF NOT EXISTS / IF EXISTS) et
-- rejouables sur une base vierge comme sur la production (tables non
-- versionnees : cardholders, bank_users, agents -> ALTER TABLE IF EXISTS).
-- ================================================================

-- ─── 1. refresh_tokens : sujets non-UUID, metadonnees, tracabilite ──
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type INTO col_type
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'refresh_tokens' AND column_name = 'subject_id';
  IF col_type IS NOT NULL AND col_type <> 'text' THEN
    ALTER TABLE refresh_tokens ALTER COLUMN subject_id TYPE TEXT USING subject_id::text;
  END IF;
END $$;

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS meta         JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS user_agent   VARCHAR(512);
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS ip_address   VARCHAR(64);
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

-- Rotation / revocation : lookup par hash + acteur, et revocation par sujet
CREATE INDEX IF NOT EXISTS idx_refresh_active
  ON refresh_tokens (actor_type, subject_id) WHERE revoked_at IS NULL;

COMMENT ON COLUMN refresh_tokens.meta IS
  'Contexte persiste avec le refresh (userType / tenantId partenaires…), rejoue a la rotation.';
COMMENT ON COLUMN refresh_tokens.actor_type IS
  'merchant | admin | cardholder | partner | bank | agency | agent (cookie cp_rt_<actor_type>).';

-- Les anciens refresh JWT (merchant/admin) deja stockes hashes restent valides
-- jusqu'a leur expiration : aucune purge necessaire. Nettoyage des lignes
-- expirees ou revoquees depuis plus de 30 jours (purge d'entretien).
DELETE FROM refresh_tokens
 WHERE expires_at < NOW() - INTERVAL '30 days'
    OR (revoked_at IS NOT NULL AND revoked_at < NOW() - INTERVAL '30 days');

-- ─── 2. merchant_users : 2FA, verrouillage, mot de passe temporaire ──
ALTER TABLE merchant_users ADD COLUMN IF NOT EXISTS mfa_enabled     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE merchant_users ADD COLUMN IF NOT EXISTS mfa_secret      VARCHAR(64);
ALTER TABLE merchant_users ADD COLUMN IF NOT EXISTS mfa_method      VARCHAR(16) DEFAULT 'totp';
ALTER TABLE merchant_users ADD COLUMN IF NOT EXISTS temp_password   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE merchant_users ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE merchant_users ADD COLUMN IF NOT EXISTS locked_until    TIMESTAMPTZ;
ALTER TABLE merchant_users ADD COLUMN IF NOT EXISTS last_login_at   TIMESTAMPTZ;
ALTER TABLE merchant_users ADD COLUMN IF NOT EXISTS first_login_at  TIMESTAMPTZ;
ALTER TABLE merchant_users ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ─── 3. admin_users : 2FA, verrouillage, mot de passe temporaire ─────
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS mfa_enabled     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS mfa_secret      VARCHAR(64);
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS temp_password   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS locked_until    TIMESTAMPTZ;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- ─── 4. cardholders (table non versionnee : IF EXISTS) ───────────────
ALTER TABLE IF EXISTS cardholders ADD COLUMN IF NOT EXISTS mfa_enabled     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS cardholders ADD COLUMN IF NOT EXISTS mfa_secret      VARCHAR(64);
ALTER TABLE IF EXISTS cardholders ADD COLUMN IF NOT EXISTS mfa_method      VARCHAR(16) DEFAULT 'totp';
ALTER TABLE IF EXISTS cardholders ADD COLUMN IF NOT EXISTS temp_password   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS cardholders ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS cardholders ADD COLUMN IF NOT EXISTS locked_until    TIMESTAMPTZ;
ALTER TABLE IF EXISTS cardholders ADD COLUMN IF NOT EXISTS last_login_at   TIMESTAMPTZ;
ALTER TABLE IF EXISTS cardholders ADD COLUMN IF NOT EXISTS first_login_at  TIMESTAMPTZ;
ALTER TABLE IF EXISTS cardholders ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ DEFAULT NOW();

-- ─── 5. Partenaires : verrouillage apres 10 echecs, mot de passe temporaire ──
-- (is_mfa_enabled / mfa_secret deja ajoutes en 007a)
ALTER TABLE IF EXISTS bank_users ADD COLUMN IF NOT EXISTS temp_password   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS bank_users ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS bank_users ADD COLUMN IF NOT EXISTS locked_until    TIMESTAMPTZ;
ALTER TABLE IF EXISTS bank_users ADD COLUMN IF NOT EXISTS last_login_at   TIMESTAMPTZ;
ALTER TABLE IF EXISTS agents     ADD COLUMN IF NOT EXISTS temp_password   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS agents     ADD COLUMN IF NOT EXISTS failed_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS agents     ADD COLUMN IF NOT EXISTS locked_until    TIMESTAMPTZ;
ALTER TABLE IF EXISTS agents     ADD COLUMN IF NOT EXISTS last_login_at   TIMESTAMPTZ;

-- ─── 6. Distribution (tables non versionnees) ────────────────────────
ALTER TABLE IF EXISTS distribution_users  ADD COLUMN IF NOT EXISTS temp_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS distribution_agents ADD COLUMN IF NOT EXISTS temp_password BOOLEAN NOT NULL DEFAULT FALSE;

-- ================================================================
-- C-Pay — Migration 008c (vague 2) : CRM vitrine — leads, réclamations, assistant
-- ================================================================
CREATE TABLE IF NOT EXISTS assistant_conversations (
  conversation_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  locale            VARCHAR(5)  NOT NULL DEFAULT 'fr',
  page              VARCHAR(200),
  ip_address        INET,
  user_agent        TEXT,
  message_count     INTEGER     NOT NULL DEFAULT 0,
  handoff_requested BOOLEAN     NOT NULL DEFAULT FALSE,
  handoff_team      VARCHAR(16),
  handoff_reason    TEXT,
  handoff_contact   VARCHAR(160),
  lead_id           UUID,
  claim_id          UUID,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_assistant_conv_last ON assistant_conversations(last_message_at DESC);

CREATE TABLE IF NOT EXISTS assistant_messages (
  message_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES assistant_conversations(conversation_id) ON DELETE CASCADE,
  role            VARCHAR(16) NOT NULL,          -- user | assistant
  content         TEXT NOT NULL,
  tool_calls      JSONB,
  usage           JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_assistant_msg_conv ON assistant_messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS crm_leads (
  lead_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(120) NOT NULL,
  email           VARCHAR(160),
  phone           VARCHAR(32),
  company         VARCHAR(160),
  country         CHAR(2),
  interest        VARCHAR(16) NOT NULL DEFAULT 'other',   -- merchant | partner | developer | other
  message         TEXT,
  source          VARCHAR(64) NOT NULL DEFAULT 'website', -- website | assistant | ...
  status          VARCHAR(16) NOT NULL DEFAULT 'new',     -- new | contacted | qualified | converted | lost
  assigned_to     UUID,
  notes           TEXT,
  conversation_id UUID,
  ip_address      INET,
  consent_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_leads_status ON crm_leads(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_leads_email  ON crm_leads(email);

CREATE TABLE IF NOT EXISTS crm_claims (
  claim_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       VARCHAR(12) NOT NULL UNIQUE,            -- REC-XXXXXX
  name            VARCHAR(120) NOT NULL,
  email           VARCHAR(160),
  phone           VARCHAR(32),
  category        VARCHAR(16) NOT NULL,                   -- payment | settlement | account | fraud | other
  description     TEXT NOT NULL,
  merchant_ref    VARCHAR(120),
  transaction_ref VARCHAR(120),
  source          VARCHAR(64) NOT NULL DEFAULT 'website',
  status          VARCHAR(16) NOT NULL DEFAULT 'open',    -- open | in_progress | resolved | closed
  assigned_to     UUID,
  resolution      TEXT,
  conversation_id UUID,
  ip_address      INET,
  consent_at      TIMESTAMPTZ,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_crm_claims_status ON crm_claims(status, created_at DESC);
