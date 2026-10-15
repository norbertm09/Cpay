-- ================================================================
-- C-Pay — Migration 009 (VAGUE 4) : Caisse marchande
--   * financial_institutions, bank_accounts, merchant_transfers : utilisées par le code
--     depuis 2.6.0 (merchant.routes, admin.routes, gtp-card.routes, transfer.service)
--     mais absentes de toute migration → créées si absentes, colonnes ajoutées si absentes
--     (la production peut déjà les posséder, créées à la main).
--   * merchant_transfers.direction ∈ payout | funding, bank_reference, executed_by,
--     instructions JSONB, events JSONB, completed_at, expires_at, cancelled_at, amount_requested
--   * platform_bank_accounts : comptes de collecte C-Pay par devise (ordres d'approvisionnement)
--   * merchants.cash_wallet_operator / cash_wallet_phone / cash_wallet_verified_at
--   * pay_links : colonnes écrites par POST /merchant/pay-links (recipient_phone, send_channel,
--     psp, payment_method, sent_at) absentes de 001/008
-- Idempotente (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS). Aucune donnée supprimée.
-- ================================================================

-- ─── 1. Référentiel des institutions financières ─────────────────
CREATE TABLE IF NOT EXISTS financial_institutions (
  institution_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            VARCHAR(32),
  name            VARCHAR(255) NOT NULL,
  type            VARCHAR(32)  NOT NULL DEFAULT 'bank',      -- bank | microfinance | mobile_money
  country         CHAR(2),
  swift           VARCHAR(16),
  status          VARCHAR(16)  NOT NULL DEFAULT 'active',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
ALTER TABLE financial_institutions ADD COLUMN IF NOT EXISTS code    VARCHAR(32);
ALTER TABLE financial_institutions ADD COLUMN IF NOT EXISTS type    VARCHAR(32) NOT NULL DEFAULT 'bank';
ALTER TABLE financial_institutions ADD COLUMN IF NOT EXISTS country CHAR(2);
ALTER TABLE financial_institutions ADD COLUMN IF NOT EXISTS swift   VARCHAR(16);
ALTER TABLE financial_institutions ADD COLUMN IF NOT EXISTS status  VARCHAR(16) NOT NULL DEFAULT 'active';
ALTER TABLE financial_institutions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE financial_institutions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_fi_country_type ON financial_institutions(country, type);

-- ─── 2. Comptes bancaires (marchands et porteurs : owner_type + owner_id) ───
CREATE TABLE IF NOT EXISTS bank_accounts (
  account_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type      VARCHAR(16)  NOT NULL,                     -- merchant | cardholder
  owner_id        UUID         NOT NULL,
  institution_id  UUID REFERENCES financial_institutions(institution_id),
  account_number  VARCHAR(64)  NOT NULL,
  account_name    VARCHAR(255) NOT NULL,
  iban            VARCHAR(48),
  status          VARCHAR(16)  NOT NULL DEFAULT 'verified',  -- pending | verified | removed
  is_default      BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS institution_id UUID;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS iban       VARCHAR(48);
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS status     VARCHAR(16) NOT NULL DEFAULT 'verified';
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE bank_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_bank_accounts_owner ON bank_accounts(owner_type, owner_id) WHERE status <> 'removed';

-- ─── 3. Mouvements de caisse : retraits / transferts / approvisionnements ───
CREATE TABLE IF NOT EXISTS merchant_transfers (
  transfer_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id        UUID NOT NULL REFERENCES merchants(merchant_id),
  direction          VARCHAR(16)  NOT NULL DEFAULT 'payout',   -- payout | funding
  dest_type          VARCHAR(16),                              -- bank | wallet | balance (funding)
  bank_account_id    UUID,
  wallet_operator    VARCHAR(32),
  wallet_phone       VARCHAR(32),
  amount             NUMERIC(15,2) NOT NULL,
  fee                NUMERIC(15,2) NOT NULL DEFAULT 0,
  net_amount         NUMERIC(15,2),
  currency           CHAR(3),
  status             VARCHAR(32)  NOT NULL DEFAULT 'pending',
  -- pending | processing | pending_settlement | pending_manual | awaiting_funds
  -- completed | failed | cancelled | rejected
  reference          VARCHAR(32),
  description        TEXT,
  gateway_reference  VARCHAR(128),
  error_message      TEXT,
  settlement_method  VARCHAR(16),
  settled_by         UUID,
  settlement_ref     VARCHAR(128),
  admin_note         TEXT,
  settled_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Colonnes lues/écrites par le code 2.6.0 (si la table existait déjà sans elles)
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS direction         VARCHAR(16) NOT NULL DEFAULT 'payout';
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS dest_type         VARCHAR(16);
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS bank_account_id   UUID;
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS wallet_operator   VARCHAR(32);
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS wallet_phone      VARCHAR(32);
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS fee               NUMERIC(15,2) NOT NULL DEFAULT 0;
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS net_amount        NUMERIC(15,2);
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS currency          CHAR(3);
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS reference         VARCHAR(32);
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS description       TEXT;
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS gateway_reference VARCHAR(128);
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS error_message     TEXT;
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS settlement_method VARCHAR(16);
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS settled_by        UUID;
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS settlement_ref    VARCHAR(128);
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS admin_note        TEXT;
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS settled_at        TIMESTAMPTZ;
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS completed_at      TIMESTAMPTZ;
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();
-- Vague 4 (CAISSE-API.md §9)
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS bank_reference    VARCHAR(128);   -- référence du virement bancaire (admin)
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS executed_by       UUID;           -- admin ayant confirmé / exécuté / rejeté
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS instructions      JSONB;          -- ordre d'approvisionnement : coordonnées du compte de collecte
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS events            JSONB NOT NULL DEFAULT '[]'::jsonb; -- journal des changements
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS expires_at        TIMESTAMPTZ;    -- ordre d'approvisionnement : +7 jours
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS cancelled_at      TIMESTAMPTZ;
ALTER TABLE merchant_transfers ADD COLUMN IF NOT EXISTS amount_requested  NUMERIC(15,2);  -- approvisionnement : montant demandé si ≠ montant reçu
CREATE INDEX IF NOT EXISTS idx_mt_merchant_created ON merchant_transfers(merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mt_status           ON merchant_transfers(status);
CREATE INDEX IF NOT EXISTS idx_mt_reference        ON merchant_transfers(reference);
COMMENT ON COLUMN merchant_transfers.direction IS 'payout (retrait wallet / transfert vers banque) | funding (approvisionnement banque → solde)';
COMMENT ON COLUMN merchant_transfers.status IS 'pending | processing | pending_settlement (legacy /transfer/payout) | pending_manual | awaiting_funds | completed | failed | cancelled | rejected';

-- ─── 4. Comptes de collecte C-Pay (approvisionnement bank_to_wallet) ───
CREATE TABLE IF NOT EXISTS platform_bank_accounts (
  account_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  currency        CHAR(3)      NOT NULL,
  bank_name       VARCHAR(255) NOT NULL,
  account_name    VARCHAR(255) NOT NULL,
  account_number  VARCHAR(64)  NOT NULL,
  iban            VARCHAR(48),
  swift           VARCHAR(16),
  active          BOOLEAN      NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_by      UUID,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_bank_accounts_currency ON platform_bank_accounts(currency) WHERE active;

-- ─── 5. Wallet du marchand (destination des retraits) ─────────────
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS cash_wallet_operator    VARCHAR(32);   -- mtn_momo | orange_money | wave | …
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS cash_wallet_phone       VARCHAR(32);   -- E.164
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS cash_wallet_verified_at TIMESTAMPTZ;   -- posé au premier retrait completed

-- ─── 6. pay_links : colonnes écrites par POST /merchant/pay-links et la caisse (carte) ───
ALTER TABLE pay_links ADD COLUMN IF NOT EXISTS recipient_phone VARCHAR(32);
ALTER TABLE pay_links ADD COLUMN IF NOT EXISTS send_channel    VARCHAR(16);
ALTER TABLE pay_links ADD COLUMN IF NOT EXISTS psp             VARCHAR(32);
ALTER TABLE pay_links ADD COLUMN IF NOT EXISTS payment_method  VARCHAR(16);  -- card | mobile_money
ALTER TABLE pay_links ADD COLUMN IF NOT EXISTS sent_at         TIMESTAMPTZ;
ALTER TABLE pay_links ADD COLUMN IF NOT EXISTS paid_amount     NUMERIC(15,2);
