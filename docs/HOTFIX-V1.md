# C-Pay 2.6.0 — Hotfix v1 (vague 1 de l'audit de production, octobre 2026)

Branche `prod-hotfix-v1`, basée sur `main` (= production OVH nettoyée). Objectif : fermer les 15 constats P0
de [`audit-prod-2.6.0/00-SYNTHESE.md`](audit-prod-2.6.0/00-SYNTHESE.md) sans refonte, par des correctifs ciblés.
Suite de tests : **238 tests verts** (71 d'origine + 167 ajoutés), tous les fichiers passent `node --check`.

## Ce qui change (par constat P0)

| # | Constat | Correctif |
|---|---|---|
| 1 | Mot de passe DB dans le dépôt | `reset-creds.js` supprimé (déjà dans `main`). **À faire : changer le mot de passe Cloud DB.** |
| 2 | Webhook MTN non authentifié | Plus aucun crédit sur callback seul : le statut est **re-demandé à MTN** avant tout changement ; jeton optionnel `MTN_WEBHOOK_TOKEN` (`x-webhook-token`). Airtel, CyberSource, MIGS, Stripe, PaymentHub : signature/jeton **obligatoires** (401 sinon). Toute mise à jour est gardée par `status='pending'`, montant et devise contrôlés (409), rejeux ignorés, callbacks journalisés (`webhook_events`, `transaction_events`). |
| 3 | Cartes virtuelles orphelines | `cardholder_id` posé à la création, clauses `OR cardholder_id IS NULL` retirées, backfill en migration 007 ; cartes GTP : propriétaire vérifié sur chaque route et dans le service ; `cardAuth` contrôle le type de jeton. |
| 4 | Monnaie créée sans mouvement | **410 `FEATURE_DISABLED`** sur `/cardholder/topup`, `/unload`, `/payment/tokenized` (cas sans opérateur), `/merchant/withdraw`, `/collect/contactless`, `/merchant/public/collect`, `/partners/collect|disburse`. Code conservé derrière le garde-fou. `/transactions/:id/refund` → 501. |
| 5 | Retrait par carte = débit client | Refusé par l'orchestrateur (`PAYOUT_CARD_UNSUPPORTED`, 422) avant tout appel. |
| 6 | Airtel/Vodacom marqués payés, MTN timeout = échec | Providers renvoient `pending` jusqu'à confirmation finale ; un timeout reste `pending` ; réconciliation alignée sur les valeurs d'opérateur de l'orchestrateur et basée sur le vrai statut provider ; aucune erreur réseau ne marque `failed`. |
| 7 | Callbacks inexistants (Orange, Wave…) | Non traité dans cette vague (routes à créer en vague 2 à partir de `refonte-2026`). Les transactions concernées restent `pending` et visibles. |
| 8 | Double règlement, retraits reversés | **Un seul moteur** : `settlement.engine` (verrou global PostgreSQL, claim `FOR UPDATE SKIP LOCKED`, batches par marchand **et devise**, arrondis à l'unité XOF/XAF, virement hors transaction SQL, statut du batch selon le résultat réel, banque = `pending` manuel). `settlement.service` : claim atomique, pas de rejeu automatique d'un échec, `externalId` stable. `auto-settlement` (simulation `completed`) désactivé. Les retraits ne sont plus enfilés. Cron Docker `settlement-cron` à 01:15 UTC. |
| 9 | Escalade admin | `requireRole` sur `/admin-users*`, `/finance/*`, `/settlements/:id/complete|reject`, `/merchants/:id/fees|velocity`, `/tenants`, `/partners/banks`. `bcrypt` → `bcryptjs`. |
| 10 | 2FA factice | Partenaires : secret base32 réel, QR généré côté serveur, vérification TOTP (`speakeasy`), login → `mfaRequired` → `/auth/2fa/validate`. Marchands/porteurs : vérification réelle, garde-fous NULL. (Application du 2FA au login marchand/admin : vague 2.) |
| 11 | XSS page de paiement, PAN serveur | Échappement HTML de toutes les interpolations ; formulaire carte retiré ; `method=card` → 410 ; téléphone validé ; rate limit 10/10 min. |
| 12 | PCI cosmétique, PAN en clair, TLS désactivé | `rejectUnauthorized:false` retiré du client MTN (`MTN_TLS_INSECURE=true` pour sandbox uniquement) ; `/rails/visa-direct` inchangé (à restreindre en vague 2) ; `pci.middleware` inchangé (à supprimer en vague 2). |
| 13 | APK debug, SDK, WooCommerce | APK debug retiré du dépôt (**à retirer aussi du serveur**). Clés API marchands **hachées** (`api_key_hash`, migration transparente des clés existantes), `X-API-Secret` vérifié pour les nouvelles clés. SDK/plugin : vague 2. |
| 14 | Infra | nginx : `/internal/` et `/metrics` bloqués, upstream porteur par nom de service, en-têtes de sécurité sur `app./card.`, zones de rate-limit sur les vraies routes de paiement, `default_server`. `deploy-ovh.sh` : plus de service `postgres`, rollback par tag horodaté réel, services annexes conditionnels. **Sauvegardes** : `backup-db.sh`/`restore-db.sh` via `pg_dump` vers la Cloud DB (client installé par `init-ovh.sh`). |
| 15 | Schéma, routes de santé, deps manquantes | `/live`, `/ready`, `/metrics` déplacés avant `/:shortId` ; `/metrics` et `/internal/*` fail-closed ; `axios`/`bcrypt` manquants : routes désactivées/corrigées ; migration 007 ajoute les colonnes utilisées par le code ; **tous les handlers async** passent par un gestionnaire d'erreurs (`middleware/async-wrap.js`). |

Autres : `/transfer/payout` et `/merchant/disburse` réservent les fonds **atomiquement** (verrou + `FOR UPDATE`, solde = encaissements nets − retraits en attente/validés) ; `/merchant/reconcile` déplacé côté admin ; secrets (SMTP, WhatsApp, SMPP, clés opérateurs, webhook) masqués dans toutes les réponses ; webhooks sortants : `https` obligatoire, IP privées refusées, secret généré, timeout 10 s ; CSV échappé ; consentements liés au jeton ; pagination bornée partout ; `err.stack` plus renvoyé ; variables d’environnement : voir ci-dessous.

## Variables d'environnement désormais nécessaires
| Variable | Effet si absente |
|---|---|
| `INTERNAL_TOKEN` | `/internal/settlement/run` répond 503 (était ouvert) |
| `METRICS_TOKEN` | `/metrics` répond 404 (jamais de jeton en query string) |
| `PAYMENTHUB_WEBHOOK_TOKEN`, `AIRTEL_WEBHOOK_SECRET`, `CYBERSOURCE_SHARED_SECRET`, `MIGS_SECURE_HASH`, `STRIPE_WEBHOOK_SECRET` | le webhook correspondant répond 401 et ne change rien |
| `MTN_WEBHOOK_TOKEN` (optionnel) | callback MTN accepté sans jeton mais toujours re-vérifié auprès de MTN |
| `MTN_TLS_INSECURE` | ne mettre `true` qu'en sandbox |
| `APP_URL_PARTNERS` (optionnel) | défaut `https://partners.c-pay.global` (liens de réinitialisation) |

## Impacts fonctionnels visibles
- Le **solde disponible** des marchands peut baisser : il déduit maintenant les retraits en attente et les décaissements (c'est le calcul correct).
- Les applications qui appelaient `/merchant/withdraw` reçoivent 410 ; `/transfer/payout` reste disponible avec contrôle de solde.
- Portail admin : les champs secrets arrivent sous la forme `{configured, last4}` ; portail marchand : la clé API n'est affichée qu'à la création, `webhook_secret` une seule fois.
- Transactions bloquées sur une 2ᵉ jambe (card2momo, transferts) passent en `needs_refund` / `needs_reversal` : vue `v_manual_compensation` pour les opérateurs.
- Cartes virtuelles dont le propriétaire n'a pu être reconstitué : inutilisables jusqu'à réaffectation (requête listée dans la migration 007).

## Déploiement
```bash
cd /opt/cplus && git fetch origin && git checkout prod-hotfix-v1
# 1. sauvegarde AVANT (nouveau script, pg_dump vers la Cloud DB)
apt install -y postgresql-client && ./scripts/backup-db.sh --label pre-hotfix-v1
# 2. compléter backend/.env (tableau ci-dessus) puis
cd backend && node scripts/check-production-env.js && cd ..
# 3. migration 007 (idempotente) + redéploiement
cd docker && docker compose run --rm --no-deps -e RUN_MIGRATIONS=false api node src/config/migrate.js
docker compose build api && docker compose up -d api settlement-cron
# 4. vérifications
curl -s https://api.c-pay.global/live ; curl -s https://api.c-pay.global/health
curl -s -o /dev/null -w '%{http_code}\n' https://api.c-pay.global/metrics      # attendu 404
rm -f /opt/cplus/portal/landing/downloads/cplus-v2.6.0-debug.apk
```
Puis reporter la configuration du nginx réellement utilisé sur l'hôte à partir de `docker/nginx.conf` (blocs `/internal/` et `/metrics`, rate-limit).

## Non couvert (vague 2, à partir de `refonte-2026`)
Routes webhooks Orange/Wave/Africell/Express Union/Free Money ; détection corrigée (plans de numérotation, AID) ; chiffrement des secrets opérateurs en base ; auth unifiée (cookies, rotation, révocation, 2FA au login marchand/admin) ; Visa Direct restreint ; suppression du middleware PCI factice et des doublons (`psp/`, moteurs de règlement, services email) ; SDK et plugin WooCommerce alignés ; `idempotency` ne doit plus persister les 5xx ; Express 5 et dépendances (42 vulnérabilités npm).
