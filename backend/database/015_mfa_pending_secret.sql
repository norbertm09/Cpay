-- 015 — Audit du 10 novembre 2026, § 3 « comptes et parcours » : remplacement protégé du second facteur.
-- Avant : POST /auth/2fa/setup écrasait mfa_secret et remettait mfa_enabled=FALSE sur une simple session valide
-- (une session volée désactivait la 2FA sans code). Désormais, quand la 2FA est active, un nouvel enrôlement exige
-- un code TOTP courant et le nouveau secret attend dans mfa_pending_secret jusqu'à /auth/2fa/verify.
ALTER TABLE IF EXISTS merchant_users ADD COLUMN IF NOT EXISTS mfa_pending_secret VARCHAR(64);
ALTER TABLE IF EXISTS admin_users    ADD COLUMN IF NOT EXISTS mfa_pending_secret VARCHAR(64);
ALTER TABLE IF EXISTS cardholders    ADD COLUMN IF NOT EXISTS mfa_pending_secret VARCHAR(64);
ALTER TABLE IF EXISTS bank_users     ADD COLUMN IF NOT EXISTS mfa_pending_secret VARCHAR(64);
ALTER TABLE IF EXISTS agents         ADD COLUMN IF NOT EXISTS mfa_pending_secret VARCHAR(64);
