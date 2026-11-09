-- ============================================================================
-- 014_account_deletion_requests.sql — Lot 4 de l'audit du 2026-11-02 (mobile P0-2)
--
-- Demandes de suppression de compte marchand (Google Play « Suppression de compte », Apple 5.1.1(v)).
-- La demande est enregistrée avec un délai de rétractation de 30 jours ; l'exécution (désactivation des
-- utilisateurs, révocation des sessions, anonymisation des données personnelles hors obligations LCB-FT /
-- comptables) est réalisée par les opérations C-Pay depuis le back-office. Une seule demande en attente par
-- marchand.
-- ============================================================================
CREATE TABLE IF NOT EXISTS account_deletion_requests (
  request_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id        UUID NOT NULL,
  user_id            UUID,
  email              TEXT,
  reason             TEXT,
  channel            TEXT NOT NULL DEFAULT 'app',          -- app | web | support
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','cancelled','processed','rejected')),
  requested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retract_until      TIMESTAMPTZ NOT NULL,
  balance_at_request NUMERIC,
  ip_address         TEXT,
  cancelled_at       TIMESTAMPTZ,
  processed_at       TIMESTAMPTZ,
  processed_by       UUID,
  note               TEXT
);
CREATE INDEX IF NOT EXISTS idx_adr_merchant_status ON account_deletion_requests(merchant_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_adr_one_pending ON account_deletion_requests(merchant_id) WHERE status = 'pending';
