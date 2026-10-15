-- ================================================================
-- CPlus 2.6.0 - Support ticketing marchands / administrateurs
-- ================================================================

DO $$ BEGIN CREATE TYPE support_ticket_status AS ENUM ('open','pending_admin','pending_merchant','resolved','closed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE support_ticket_priority AS ENUM ('low','normal','high','urgent'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE support_ticket_sender AS ENUM ('merchant','admin','system'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS support_tickets (
  ticket_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_number     VARCHAR(32) UNIQUE NOT NULL,
  merchant_id       UUID NOT NULL REFERENCES merchants(merchant_id),
  created_by_user   UUID REFERENCES merchant_users(user_id),
  assigned_admin_id UUID,
  subject           VARCHAR(180) NOT NULL,
  category          VARCHAR(64) NOT NULL DEFAULT 'general',
  priority          support_ticket_priority NOT NULL DEFAULT 'normal',
  status            support_ticket_status NOT NULL DEFAULT 'open',
  last_message_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ,
  closed_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  message_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id     UUID NOT NULL REFERENCES support_tickets(ticket_id) ON DELETE CASCADE,
  sender_type   support_ticket_sender NOT NULL,
  sender_id     UUID,
  sender_name   VARCHAR(180),
  message       TEXT NOT NULL,
  attachments   JSONB NOT NULL DEFAULT '[]',
  is_internal   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_merchant ON support_tickets(merchant_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status   ON support_tickets(status, priority, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket  ON support_ticket_messages(ticket_id, created_at);
