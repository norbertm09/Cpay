-- ============================================================================
-- 013_calc_fee_compat.sql — Lot 1 de l'audit du 2026-11-02 (P0 #3)
--
-- La fonction SQL calc_fee(merchant_id, type, operator, amount) était appelée par la
-- réconciliation et par les routes historiques /merchant/collect|disburse sans être
-- définie par aucune migration : sur une base où elle manquait, toute confirmation
-- MTN/Airtel obtenue après le délai de 30 s échouait et la transaction restait
-- `pending` à vie.
--
-- Le code appelle désormais cpay_calculate_fee (migration 010). Ce wrapper garantit
-- l'existence de calc_fee pour les scripts ou anciennes images qui l'appelleraient
-- encore ; une calc_fee déjà présente (créée à la main en production) est conservée.
-- ============================================================================
DO $$
BEGIN
  IF to_regprocedure('calc_fee(uuid,text,text,numeric)') IS NULL THEN
    CREATE FUNCTION calc_fee(p_merchant UUID, p_type TEXT, p_operator TEXT, p_amount NUMERIC)
    RETURNS NUMERIC LANGUAGE sql STABLE AS $fn$
      SELECT cpay_calculate_fee($1, $2, $3, $4, 'mobile_money')
    $fn$;
    COMMENT ON FUNCTION calc_fee(UUID, TEXT, TEXT, NUMERIC) IS
      'Compatibilite (migration 013) : delegue a cpay_calculate_fee(..., ''mobile_money'')';
  END IF;
END $$;
