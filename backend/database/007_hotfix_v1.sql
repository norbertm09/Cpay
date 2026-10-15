-- ================================================================
-- C-Pay 2.6.0 — Migration 007 (hotfix v1, octobre 2026)
-- Colonnes utilisées par le code mais absentes des migrations versionnées,
-- et colonnes nécessaires aux correctifs de règlement.
-- Toutes les instructions sont idempotentes (IF NOT EXISTS).
-- ================================================================

-- Règlement
ALTER TABLE settlement_batches ADD COLUMN IF NOT EXISTS failure_reason TEXT;
ALTER TABLE settlement_batches ADD COLUMN IF NOT EXISTS payout_ref     VARCHAR(128);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS settlement_status   VARCHAR(32);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS settlement_ref      VARCHAR(80);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS settled_at          TIMESTAMPTZ;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS settlement_batch_id UUID REFERENCES settlement_batches(batch_id);
CREATE INDEX IF NOT EXISTS idx_txn_settlement_status ON transactions(settlement_status) WHERE settlement_status IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sq_unsettled ON settlement_queue(merchant_id, currency, queued_at) WHERE settled = FALSE;

-- Callbacks opérateurs : traçabilité (table déjà présente en 00x si créée ailleurs)
CREATE TABLE IF NOT EXISTS transaction_events (
  event_id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id UUID,
  merchant_id    UUID,
  event_type     VARCHAR(64) NOT NULL,
  payload        JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_txn_events_txn ON transaction_events(transaction_id);

-- ═══════════ 007a : porteurs, cartes virtuelles, partenaires (2FA, resets) ═══════════
-- ================================================================
-- CPlus 2.6.0 — HOTFIX P0 wave 1 (audit 2.6.0 §2.4, §2.11, §2.14)
-- Périmètre : cartes virtuelles (IDOR), 2FA partenaires, reset-link partenaires
--
-- Les tables ci-dessous (virtual_cards, cardholders, card_transactions,
-- bank_users, agents) existent en production mais ne sont pas définies dans
-- les migrations 001–006 (cf. audit §1). Toutes les instructions sont donc
-- conditionnelles (IF EXISTS / to_regclass) pour que la migration reste
-- rejouable sur une base vierge comme sur la production.
-- ================================================================

-- ─── 1. virtual_cards.cardholder_id (IDOR §2.4) ──────────────────
-- Les INSERT applicatifs renseignent désormais toujours cardholder_id et
-- les clauses `OR cardholder_id IS NULL` ont été retirées : une carte dont
-- cardholder_id reste NULL n'est plus utilisable (PIN, paiement, top-up…)
-- tant qu'un administrateur ne l'a pas réassignée.
ALTER TABLE IF EXISTS virtual_cards ADD COLUMN IF NOT EXISTS cardholder_id UUID;

DO $$
BEGIN
  IF to_regclass('public.virtual_cards') IS NOT NULL AND to_regclass('public.cardholders') IS NOT NULL THEN
    -- 1a. Backfill depuis cardholders.card_id (relation 1–1 attendue).
    --     On ne renseigne que les cartes référencées par EXACTEMENT un porteur.
    UPDATE virtual_cards vc
       SET cardholder_id = s.cardholder_id
      FROM (
        SELECT card_id, MIN(cardholder_id::text)::uuid AS cardholder_id
          FROM cardholders
         WHERE card_id IS NOT NULL
         GROUP BY card_id
        HAVING COUNT(DISTINCT cardholder_id) = 1
      ) s
     WHERE vc.cardholder_id IS NULL
       AND vc.card_id = s.card_id;
  END IF;

  IF to_regclass('public.virtual_cards') IS NOT NULL AND to_regclass('public.card_transactions') IS NOT NULL THEN
    -- 1b. Backfill depuis l'historique card_transactions (un seul porteur distinct).
    UPDATE virtual_cards vc
       SET cardholder_id = s.cardholder_id
      FROM (
        SELECT card_id, MIN(cardholder_id::text)::uuid AS cardholder_id
          FROM card_transactions
         WHERE cardholder_id IS NOT NULL
         GROUP BY card_id
        HAVING COUNT(DISTINCT cardholder_id) = 1
      ) s
     WHERE vc.cardholder_id IS NULL
       AND vc.card_id = s.card_id;
  END IF;

  -- 1c. Les cartes dont le porteur n'a pas pu être inféré restent à NULL.
  --     ELLES DEVIENNENT INUTILISABLES jusqu'à réassignation manuelle par un
  --     admin (UPDATE virtual_cards SET cardholder_id=... WHERE card_id=...).
  --     Pour les lister :
  --       SELECT card_id, card_masked, balance, created_at
  --         FROM virtual_cards WHERE cardholder_id IS NULL;

  IF to_regclass('public.virtual_cards') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS idx_virtual_cards_cardholder_id ON virtual_cards (cardholder_id);
  END IF;
END $$;

-- ─── 2. 2FA partenaires (§2.11) ──────────────────────────────────
-- Le secret TOTP (base32) est stocké sur la ligne utilisateur ; is_mfa_enabled
-- (nom déjà utilisé par partners.routes.js) ne passe à TRUE qu'après un
-- /auth/2fa/verify réussi.
ALTER TABLE IF EXISTS bank_users ADD COLUMN IF NOT EXISTS mfa_secret     VARCHAR(64);
ALTER TABLE IF EXISTS bank_users ADD COLUMN IF NOT EXISTS is_mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS bank_users ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE IF EXISTS agents     ADD COLUMN IF NOT EXISTS mfa_secret     VARCHAR(64);
ALTER TABLE IF EXISTS agents     ADD COLUMN IF NOT EXISTS is_mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE IF EXISTS agents     ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE IF EXISTS agencies   ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ DEFAULT NOW();

-- Les secrets 2FA « temporaires » que l'ancien code déposait en clair dans
-- admin_notifications sont purgés.
DO $$
BEGIN
  IF to_regclass('public.admin_notifications') IS NOT NULL THEN
    DELETE FROM admin_notifications WHERE type IN ('2fa_setup_pending', 'password_reset_link');
  END IF;
END $$;

-- ─── 3. Reset-link partenaires (§2.14) ───────────────────────────
-- Seul le hash SHA-256 du token est persisté ; le token brut part par email
-- et n'est jamais renvoyé à l'appelant. Consommé par POST /partners/auth/reset-password.
CREATE TABLE IF NOT EXISTS partner_password_resets (
  reset_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_type   VARCHAR(16) NOT NULL,              -- 'bank_user' | 'agent'
  user_id     TEXT NOT NULL,                     -- bank_users.user_id / agents.agent_id (type non versionné → TEXT)
  token_hash  CHAR(64) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_partner_password_resets_user ON partner_password_resets (user_type, user_id);

-- ═══════════ 007b : webhooks, compensation manuelle ═══════════
-- ================================================================
-- 007b — HOTFIX WAVE-1 : webhooks fail-closed, compensation transferts
-- Idempotent (IF NOT EXISTS / DO blocks). A appliquer avant le deploiement
-- du backend 2.6.0-hotfix. Aucune donnee existante modifiee.
-- ================================================================

-- 1. Journal brut des callbacks providers (MTN, Airtel, CyberSource, MIGS, Stripe).
--    Utilise par routes/webhook-handlers.js (recordWebhookEvent) pour l'audit et
--    l'analyse des rejeux. L'insertion est non bloquante cote applicatif.
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider        VARCHAR(32)  NOT NULL,          -- mtn | airtel | cybersource | migs | stripe
  reference_id    VARCHAR(128),                   -- reference provider (X-Reference-Id, transaction.id, order id…)
  provider_status VARCHAR(32),                    -- statut annonce par le callback
  outcome         VARCHAR(32),                    -- completed | failed | needs_refund | replay_ignored | mismatch | still_pending | provider_unavailable | unknown_reference | received
  payload         JSONB        NOT NULL DEFAULT '{}',
  ip_address      VARCHAR(64),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_ref      ON webhook_events(provider, reference_id);
CREATE INDEX IF NOT EXISTS idx_webhook_events_created  ON webhook_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_events_outcome  ON webhook_events(outcome) WHERE outcome IN ('mismatch','needs_refund');

-- 2. Index de recherche des callbacks MoMo sur card_transactions
--    (lookup par mm_reference et par metadata->'leg2'->>'mtnRef' pour card2momo).
--    card_transactions n'est pas dans les migrations versionnees 001-006 : garde-fou.
DO $$
BEGIN
  IF to_regclass('public.card_transactions') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_card_txn_mm_reference ON card_transactions(mm_reference) WHERE mm_reference IS NOT NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_card_txn_leg2_mtnref ON card_transactions ((metadata->''leg2''->>''mtnRef'')) WHERE metadata ? ''leg2''';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_card_txn_pending ON card_transactions(status) WHERE status IN (''pending'',''needs_refund'')';
  END IF;
END $$;

-- 3. Nouveaux statuts applicatifs :
--      card_transactions.status = 'needs_refund'   (card2momo : carte debitee, MoMo echoue)
--      bank_transfers.status    = 'needs_reversal' (transfert : une jambe a deplace des fonds, la suivante a echoue)
--    Si ces colonnes sont des ENUM (schema prod non versionne), on ajoute la valeur ;
--    si ce sont des VARCHAR/TEXT, rien a faire.
DO $$
DECLARE
  udt text;
BEGIN
  SELECT c.udt_name INTO udt
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'card_transactions' AND c.column_name = 'status';
  IF udt IS NOT NULL AND udt NOT IN ('varchar', 'text', 'bpchar', 'character varying') THEN
    EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS %L', udt, 'needs_refund');
  END IF;

  SELECT c.udt_name INTO udt
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'bank_transfers' AND c.column_name = 'status';
  IF udt IS NOT NULL AND udt NOT IN ('varchar', 'text', 'bpchar', 'character varying') THEN
    EXECUTE format('ALTER TYPE %I ADD VALUE IF NOT EXISTS %L', udt, 'needs_reversal');
  END IF;
END $$;

-- 4. Index pour la reconciliation (filtre LOWER(detected_operator) LIKE 'mtn%'/'airtel%')
CREATE INDEX IF NOT EXISTS idx_txn_pending_reconcile
  ON transactions (initiated_at DESC)
  WHERE status = 'pending' AND gateway_payment_id IS NOT NULL;

-- 5. Vue operateur : incidents a compenser manuellement
CREATE OR REPLACE VIEW v_manual_compensation AS
SELECT 'card2momo'::text AS source, ct.txn_id::text AS id, ct.cardholder_id::text AS owner_id,
       ct.amount, ct.currency, ct.status::text AS status, ct.failure_reason AS reason, ct.initiated_at
  FROM card_transactions ct
 WHERE ct.status::text = 'needs_refund'
UNION ALL
SELECT 'bank_transfer'::text, bt.transfer_id::text, bt.cardholder_id::text,
       bt.amount, bt.currency, bt.status::text, bt.error_message, bt.created_at
  FROM bank_transfers bt
 WHERE bt.status::text = 'needs_reversal';

-- ═══════════ 007c : clés API hachées, webhooks sortants ═══════════
-- ================================================================
-- CPlus 2.6.0 — HOTFIX WAVE-1 (audit prod 2.6.0) : routes marchand / admin
-- Fichier fusionne par l'orchestrateur dans la migration 007.
-- Idempotent : rejouable sans effet de bord.
--
-- 1. merchant_api_keys : cles API hachees (audit §2.9)
--    - api_key_hash    SHA-256 hex de la cle (recherche a l'authentification)
--    - key_prefix      12 premiers caracteres (affichage « sk_live_xxxx**** »)
--    - api_secret_hash SHA-256 hex du secret (verification X-API-Secret pour
--                      les cles creees apres ce hotfix)
--    - api_key / api_secret deviennent NULLables : les lignes legacy (cle en
--      clair) restent acceptees et sont migrees au premier usage reussi
--      (hash renseigne, colonne brute mise a NULL) par apiKeyAuth.
-- 2. merchants.webhook_url / webhook_secret : colonnes utilisees par
--    /merchant/webhook-config (absentes des migrations 001-006 — audit §1).
--    Le secret est genere par PATCH /webhook-config (crypto.randomBytes(32)).
-- ================================================================

-- ─── 1. merchant_api_keys ────────────────────────────────────────
-- La table existe en production mais n'est pas versionnee : on la cree si
-- absente (structure minimale utilisee par merchant.routes.js), puis on ajoute
-- les colonnes du hotfix.
CREATE TABLE IF NOT EXISTS merchant_api_keys (
  key_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id     UUID NOT NULL REFERENCES merchants(merchant_id) ON DELETE CASCADE,
  key_name        VARCHAR(100) NOT NULL,
  api_key         VARCHAR(128),
  api_secret      VARCHAR(128),
  permissions     JSONB NOT NULL DEFAULT '["collect","disburse","transactions","pay_links"]'::jsonb,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_used_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE merchant_api_keys ADD COLUMN IF NOT EXISTS api_key_hash    CHAR(64);
ALTER TABLE merchant_api_keys ADD COLUMN IF NOT EXISTS key_prefix      VARCHAR(12);
ALTER TABLE merchant_api_keys ADD COLUMN IF NOT EXISTS api_secret_hash CHAR(64);
ALTER TABLE merchant_api_keys ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Les colonnes brutes ne sont plus renseignees pour les nouvelles cles
ALTER TABLE merchant_api_keys ALTER COLUMN api_key    DROP NOT NULL;
ALTER TABLE merchant_api_keys ALTER COLUMN api_secret DROP NOT NULL;

-- Migration immediate des lignes legacy dont la cle brute est encore presente :
-- le hash est calcule cote SQL (pgcrypto) si l'extension est disponible ;
-- sinon apiKeyAuth migre chaque ligne au premier usage reussi.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    UPDATE merchant_api_keys
       SET api_key_hash = encode(digest(api_key, 'sha256'), 'hex'),
           key_prefix   = LEFT(api_key, 12),
           api_key      = NULL,
           updated_at   = NOW()
     WHERE api_key IS NOT NULL AND api_key_hash IS NULL;
  END IF;
END $$;

-- Prefixe derive pour les lignes deja hachees sans prefixe
UPDATE merchant_api_keys SET key_prefix = 'sk_live_' WHERE key_prefix IS NULL AND api_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_merchant_api_keys_hash
  ON merchant_api_keys (api_key_hash) WHERE api_key_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_merchant_api_keys_merchant
  ON merchant_api_keys (merchant_id);
-- Recherche legacy (api_key brut) tant que des lignes non migrees subsistent
CREATE INDEX IF NOT EXISTS idx_merchant_api_keys_legacy_key
  ON merchant_api_keys (api_key) WHERE api_key IS NOT NULL;

COMMENT ON COLUMN merchant_api_keys.api_key IS
  'LEGACY — cle en clair, NULL apres migration. Ne plus alimenter (hotfix 2.6.0 wave-1).';
COMMENT ON COLUMN merchant_api_keys.api_key_hash IS
  'SHA-256 hex de la cle API ; seule valeur consultee par apiKeyAuth.';
COMMENT ON COLUMN merchant_api_keys.api_secret_hash IS
  'SHA-256 hex du secret ; si present, l''en-tete X-API-Secret est obligatoire et verifie.';

-- ─── 2. merchants : configuration webhook sortant ────────────────
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS webhook_url    VARCHAR(512);
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS webhook_secret VARCHAR(128);

COMMENT ON COLUMN merchants.webhook_secret IS
  'Secret HMAC genere par PATCH /merchant/webhook-config (64 hex). Renvoye une seule fois, jamais relu via l''API.';

-- Une URL de webhook doit etre https:// (la garde SSRF complete est cote application)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_merchants_webhook_https') THEN
    ALTER TABLE merchants ADD CONSTRAINT chk_merchants_webhook_https
      CHECK (webhook_url IS NULL OR webhook_url LIKE 'https://%') NOT VALID;
  END IF;
END $$;
