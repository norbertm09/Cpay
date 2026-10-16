-- Audit 2026-10-16 : additive migration. No repricing of historical transactions.
ALTER TABLE settlement_batches ADD COLUMN IF NOT EXISTS cash_offset_amount NUMERIC(15,2) NOT NULL DEFAULT 0;

-- Existing queue links are authoritative; never invent links from dates/amounts.
UPDATE transactions t SET settlement_batch_id=sq.batch_id
FROM settlement_queue sq WHERE sq.transaction_id=t.transaction_id
  AND sq.batch_id IS NOT NULL AND t.settlement_batch_id IS NULL;

CREATE TABLE IF NOT EXISTS cardholder_payment_requests (
  cardholder_id UUID NOT NULL,
  request_key VARCHAR(128) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cardholder_id, request_key)
);

-- Fail migration on historical duplicate active attempts: reconcile them first.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_link_one_active_attempt
  ON transactions(pay_link_id) WHERE pay_link_id IS NOT NULL AND status IN ('pending','authorized');

-- Shared fee calculation for NEW authorizations; merchant overrides take precedence.
-- The optional legacy merchant_fees table is not present on every installation.
CREATE OR REPLACE FUNCTION cpay_calculate_fee(p_merchant UUID, p_type TEXT, p_operator TEXT, p_amount NUMERIC, p_method TEXT DEFAULT 'mobile_money')
RETURNS NUMERIC LANGUAGE plpgsql AS $$
DECLARE v_rate NUMERIC; v_currency TEXT; v_kyb INT;
BEGIN
  SELECT currency,kyb_level INTO STRICT v_currency,v_kyb FROM merchants WHERE merchant_id=p_merchant;
  IF to_regclass('public.merchant_fees') IS NOT NULL THEN
    EXECUTE 'SELECT fee_rate FROM merchant_fees
      WHERE (merchant_id=$1 OR merchant_id IS NULL) AND txn_type=$2
        AND (operator IS NULL OR lower(operator)=lower($3))
      ORDER BY merchant_id NULLS LAST, operator NULLS LAST LIMIT 1'
      INTO v_rate USING p_merchant, CASE WHEN p_type IN ('qr_payment','pay_link') THEN 'collect' ELSE p_type END, p_operator;
  END IF;
  v_rate := COALESCE(v_rate, CASE
    WHEN p_type='payout' THEN 0.01
    WHEN p_method='card_nfc' THEN CASE WHEN v_kyb>=2 THEN 0.018 WHEN v_kyb>=1 THEN 0.020 ELSE 0.025 END
    ELSE CASE WHEN v_kyb>=2 THEN 0.010 WHEN v_kyb>=1 THEN 0.012 ELSE 0.015 END END);
  IF v_rate < 0 OR v_rate > 1 THEN RAISE EXCEPTION 'Invalid merchant fee rate'; END IF;
  RETURN round(p_amount*v_rate, CASE WHEN v_currency IN ('XOF','XAF','CDF','GNF','RWF','UGX') THEN 0 ELSE 2 END);
END $$;
