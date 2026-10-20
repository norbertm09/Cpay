-- ================================================================
-- C-Pay — Migration 011 (VAGUE 6, lot 1) : intégrité financière (audit externe du 17/10/2026)
--   1. merchant_transfers : statut `unknown` (résultat opérateur incertain, réservation conservée),
--      request_payload, unknown_since, needs_review, last_status_check_at, review_alerted_at ;
--   2. idempotency_keys : clé conservée après une erreur serveur (in_progress=false, last_error)
--      et référence de la ressource créée (resource_type / resource_id) → un rejeu renvoie
--      l'ordre d'origine, jamais un doublon ;
--   3. settlement_queue : unicité par transaction (déjà présente en 001, garantie ici si absente) ;
--   4. bank_accounts : vérification explicite (pending_verification → verified par l'admin) ;
--   5. beneficiary_events : historique des changements de bénéficiaire (wallet, comptes bancaires).
-- Idempotente (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS), gen_random_uuid() uniquement.
-- Aucune donnée supprimée, aucun statut historique modifié.
-- ================================================================

-- ─── 1. merchant_transfers : statut incertain ────────────────────
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS request_payload      JSONB;        -- requête envoyée au rail (montant net, destinataire masqué, référence)
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS unknown_since        TIMESTAMPTZ;  -- premier passage en `unknown`
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS needs_review         BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS last_status_check_at TIMESTAMPTZ;  -- dernière interrogation opérateur
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS review_alerted_at    TIMESTAMPTZ;  -- alerte ops envoyée (CASH_UNKNOWN_ALERT_HOURS)
-- Une contrainte CHECK sur le statut créée à la main en production refuserait `unknown` : levée si présente.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'merchant_transfers_status_check') THEN
    ALTER TABLE merchant_transfers DROP CONSTRAINT merchant_transfers_status_check;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_mt_uncertain ON merchant_transfers(status, created_at)
  WHERE status IN ('unknown', 'processing');
CREATE INDEX IF NOT EXISTS idx_mt_needs_review ON merchant_transfers(needs_review) WHERE needs_review;
COMMENT ON COLUMN merchant_transfers.status IS
  'pending | processing | unknown (résultat opérateur incertain, fonds réservés) | pending_settlement (legacy /transfer/payout) | pending_manual | awaiting_funds | completed | failed | cancelled | rejected';

-- ─── 2. idempotency_keys : rejeu durable après erreur serveur ────
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS in_progress   BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS last_error    TEXT;
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS failed_at     TIMESTAMPTZ;
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS resource_type VARCHAR(32);   -- merchant_transfer | transaction
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS resource_id   VARCHAR(64);
-- Les clés historiques déjà répondues ne sont plus « en cours ».
UPDATE idempotency_keys SET in_progress = FALSE WHERE status_code IS NOT NULL AND in_progress = TRUE;

-- ─── 3. settlement_queue : une seule ligne par transaction ────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_queue_txn_unique ON settlement_queue(transaction_id);

-- ─── 4. bank_accounts : vérification explicite ────────────────────
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS verified_at            TIMESTAMPTZ;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS verified_by            UUID;          -- admin
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS verification_method    VARCHAR(16);   -- document | micro_deposit | manual
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS verification_reference VARCHAR(128);
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS created_by             UUID;          -- merchant_users.user_id
ALTER TABLE bank_accounts ALTER COLUMN status SET DEFAULT 'pending_verification';
-- Les comptes insérés `verified` avant cette migration restent utilisables (aucun re-contrôle automatique).
CREATE INDEX IF NOT EXISTS idx_bank_accounts_pending ON bank_accounts(status) WHERE status = 'pending_verification';
COMMENT ON COLUMN bank_accounts.status IS 'pending_verification | verified | removed (pending : valeur historique, traitée comme pending_verification)';

-- ─── 5. Historique des bénéficiaires ─────────────────────────────
CREATE TABLE IF NOT EXISTS beneficiary_events (
  event_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id   UUID NOT NULL,
  actor_type    VARCHAR(16) NOT NULL DEFAULT 'merchant',   -- merchant | admin | system
  actor_id      UUID,
  actor_email   VARCHAR(255),
  actor_role    VARCHAR(32),
  event_type    VARCHAR(48) NOT NULL,                      -- wallet_updated | bank_account_added | bank_account_removed | bank_account_verified
  entity_type   VARCHAR(32) NOT NULL,                      -- wallet | bank_account
  entity_id     UUID,
  old_values    JSONB,                                     -- valeurs masquées
  new_values    JSONB,                                     -- valeurs masquées
  ip_address    VARCHAR(64),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_beneficiary_events_merchant ON beneficiary_events(merchant_id, created_at DESC);
