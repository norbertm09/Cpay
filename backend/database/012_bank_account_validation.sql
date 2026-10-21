-- Lot 3: pending_verification requires 20 characters; migration 009 used VARCHAR(16).
-- Widen only narrow character columns, preserving existing TEXT/wider schemas.
-- Existing migration checksums and account data remain unchanged.
DO $$
DECLARE status_width INTEGER;
BEGIN
  SELECT character_maximum_length INTO status_width
  FROM information_schema.columns
  WHERE table_schema=current_schema() AND table_name='bank_accounts' AND column_name='status';
  IF status_width IS NOT NULL AND status_width < 32 THEN
    ALTER TABLE bank_accounts ALTER COLUMN status TYPE VARCHAR(32);
  END IF;
END $$;
COMMENT ON COLUMN bank_accounts.status IS
  'pending_verification | verified | rejected | removed (pending: historical pending verification)';
