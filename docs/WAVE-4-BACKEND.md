# Vague 4 — Backend : caisse marchande (branche `wave-4`)

Base : `wave-3`. Contrat : [`CAISSE-API.md`](CAISSE-API.md). Backend : **21 suites / 516 tests verts**
(20 / 475 avant), tous les fichiers touchés passent `node --check`. Une migration SQL idempotente (`009`),
trois variables d'environnement optionnelles.

## 1. Ce qui change

### 1.1 Nouveau service `services/cash/cash.service.js` — logique métier unique
- `computeAvailableBalance(exec, merchantId)` : formule **unique** du solde, déplacée depuis
  `merchant.routes.js`. `+` encaissements `collect` autorisés non réglés (`net_amount`), **`+` approvisionnements
  `direction='funding'` `completed`** (nouveau), `−` `merchant_transfers` payout non échoués
  (`pending, processing, pending_settlement, pending_manual, completed`), `−` `transactions.type='payout'`
  (`/disburse`). Renvoie aussi `reserved` (sorties en vol) et `totalFunded`. Utilisée par `GET /merchant/balance`,
  `POST /merchant/transfer/payout`, `POST /merchant/disburse` et toute la caisse.
- `createPayout(...)` : **une seule machine d'état** pour `/merchant/transfer/payout`, `/merchant/cash/withdraw`
  et `/merchant/cash/transfers` (`wallet_to_bank`) — verrou (`pg_advisory_xact_lock` + `FOR UPDATE`), solde et
  limite journalière calculés **dans** la transaction SQL, ligne `pending` insérée avant tout appel rail, appel
  rail hors transaction (MTN Congo via `rails/mtn-momo.client.transfer`, autres opérateurs via
  `mobilemoney.router.sendPayout`), banque → file manuelle (`pending_manual`, ou `pending_settlement` pour la
  route historique) + e-mail opérations.
- `transitionTransfer(...)` : point unique de changement de statut d'un `merchant_transfers` (claim atomique
  `status = ANY(from)`, `events` JSONB append, `completed_at`/`cancelled_at`, `bank_reference`, `executed_by`,
  `amount`/`amount_requested`). Pose `merchants.cash_wallet_verified_at` au premier retrait `completed` vers le
  wallet enregistré. Utilisé par les routes admin, le polling de statut et les échecs rail.
- `refreshPayoutStatus(t)` : un retrait `processing` est re-interrogé (MTN : provider pays si configuré sinon
  client rails Congo ; autres : `provider.getStatus({ product:'disbursement' })` quand il existe) à chaque
  `GET /cash/transfers/:id` (marchand ou admin). Indisponibilité → reste `processing`.
- `createFundingOrder` (`FND-…`, `awaiting_funds`, `instructions` JSONB depuis `platform_bank_accounts` de la
  devise, `expires_at` +7 j), `cancelTransfer` (`awaiting_funds | pending_manual` seulement, garde d'appartenance
  dans l'UPDATE), `verifyStepUp` (TOTP si `mfa_enabled`, sinon bcrypt du mot de passe ; 5 échecs / 15 min par
  utilisateur → 429 `STEP_UP_LOCKED`, compteur en mémoire par processus), `summary`, `history`, `historyCsv`.
- `payoutRail({ operator, gateway, country })` / `collectRail(gateway)` / `cardGatewayFor(country)` : disponibilité
  des rails (voir §4). `detectWallet(phone, { country, operator })` : détection + override insensible à la casse.
- `CASH_LIMITS` : limite journalière de retrait par `kyb_level` — 0 → 100 000, 1 → 500 000, 2 → 2 000 000
  (devise du marchand), surchargeable par `CASH_WITHDRAW_DAILY_L0/L1/L2`. `TRANSFER_MIN` = 1 000. Frais :
  `merchant_fees` si la table existe, sinon 1 % (`payout`) / 1,5 % (`collect`, estimation renvoyée à l'encaissement).

### 1.2 Routes marchand `routes/cash.routes.js` — `/api/v1/merchant/cash/*` (`merchantAuth`)
| Route | Notes |
|---|---|
| `GET /summary` | §1 + `fees` et `limits.withdrawFee*` (aperçu des frais demandé par le portail), `profile.cardAcceptance` = `link` si passerelle carte du pays, sinon `unavailable` |
| `POST /collect` (`Idempotency-Key`) | `mobile_money` : `detectWallet` (pays du marchand pour les numéros locaux, `operator` en minuscules accepté), `422 CURRENCY_MISMATCH` si la devise du numéro ≠ devise marchand, `410 FEATURE_DISABLED { operator, operatorLabel }` si aucun provider `collectPayment` pour la gateway, puis **`orchestrator.processTransaction`** (même chemin que `POST /api/v1/collect` : plafonds KYB, fraude, routage, `transaction_events`, webhooks sortants) ; `201` avec `fee`/`net` estimés (`feeEstimated:true`) et `statusUrl`. `card` : lien `pay_links` (`payment_method='card'`, `psp=<gateway>`, 24 h) si `country_payment_defaults.default_card_gateway` est `active` dans `api_configurations` ou configuré par env (`card.router.isConfigured`), sinon `410` |
| `GET /collect/:txnId` | lecture DB ; si `pending` avec `gateway_payment_id`, `reconcile.service.reconcileOne` (MTN, Airtel, providers vague 2) puis relecture. `customerPhone` toujours `null` |
| `GET|PUT /wallet` | step-up ; détection + devise ; `cash_wallet_verified_at` remis à `NULL` si le wallet change |
| `POST /withdraw` (`Idempotency-Key`) | step-up → `WALLET_MISSING` → rail (410 avant toute réservation) → `createPayout` avec `dailyLimit` ; `201 { transferId, reference:'PAY-…', status: processing|completed, amount, fee, net, currency, wallet }` |
| `POST /transfers` (`Idempotency-Key`) | `wallet_to_bank` : step-up, compte `verified`, `createPayout` (`TRF-…`, `pending_manual`) ; `bank_to_wallet` : **sans step-up**, `409 FUNDING_UNAVAILABLE` sans compte de collecte |
| `GET /transfers`, `GET /transfers/:id`, `POST /transfers/:id/cancel` | filtres `direction` (`wallet_to_bank|bank_to_wallet|withdraw`), `status`, `limit`, `offset` ; `409 TRANSFER_NOT_CANCELLABLE` |
| `GET /history`, `GET /history/export.csv` | UNION `transactions` (`collect`, `payout` → `withdraw`) + `merchant_transfers` ; totaux `in` (`collect|transfer_in` finalisés) / `out` (`withdraw|transfer_out` non échoués) ; CSV BOM UTF-8, `;`, auth Bearer |

`/merchant/collect`, `/merchant/collect/:id/status`, `/merchant/transfer/payout`, `/merchant/transfers`,
`/merchant/balance`, `/merchant/bank-accounts` restent en service (apps 2.7.0). `/merchant/withdraw` reste 410.
`/transfer/payout` vers un wallet vérifie désormais le rail **avant** d'insérer (`503 OPERATOR_NOT_CONFIGURED`,
aucune ligne `failed`), et `/balance` renvoie la devise du marchand.

### 1.3 Routes admin `routes/cash-admin.routes.js` — `/api/v1/admin/cash/*` (`super_admin`, `ops_admin`)
`GET /stats`, `GET /transfers` (`status` accepte une liste ; `pending_manual` inclut `pending_settlement`),
`GET /transfers/:id` (+ `events`, `gatewayReference`, numéro de compte complet), `POST /transfers/:id/confirm-funds`
(`amount` = `amountReceived`, `amount_requested` + événement si différent), `mark-executed`
(`pending_manual | pending_settlement`), `reject` (`awaiting_funds | pending_manual | pending_settlement`),
`GET/POST/PATCH /platform-accounts`. Chaque action : `audit_logs` (`CASH_FUNDING_CONFIRM`,
`CASH_TRANSFER_EXECUTED`, `CASH_TRANSFER_REJECT`, `CASH_PLATFORM_ACCOUNT_*`) + événement JSONB + e-mail marchand.
Les anciennes routes `/admin/settlements/*` (rôle `finance_admin`) continuent de traiter `pending_settlement`.

### 1.4 Paiement par carte sur la page hébergée (`pay.c-pay.global`) — checkout redirigé
Aucun PAN ne transite par C-Pay. `services/cash/card-link.service.js` + `server.js` :
- `POST /api/v1/pay/:shortId/card` (limiteur public) : lien `pending` non expiré → transaction `pending`
  (`type=collect`, `payment_method=pay_link`, `pay_link_id`, `gateway_name`, `gateway_order_id=<shortId>-<ts>`
  unique par tentative) via `orchestrator.createTransactionRecord`, puis session de checkout hébergé →
  `{ success, txnId, gateway, redirectUrl }`. `410 CARD_PAYMENT_DISABLED` sans passerelle hébergée configurée
  (ou si un PAN/CVV est envoyé), `409 LINK_NOT_PAYABLE`, `502 GATEWAY_ERROR` (transaction marquée `failed`).
- `GET /pay/:shortId/return` (alias `/:shortId/return`) : page de retour/annulation. **MIGS** : les `vpc_*` signés
  (`vpc_SecureHash`, `MIGS_SECURE_HASH`, `MIGS_HASH_TYPE`) sont vérifiés puis appliqués par
  `webhook-handlers.applyMerchantPspResult` (même machine d'état que `handleMigsWebhook` : claim `pending`,
  contrôle montant/devise, `pay_links.paid`, `transaction_events MIGS_CALLBACK`). **MPGS** : `resultIndicator`
  comparé au `successIndicator` journalisé (`transaction_events CARD_CHECKOUT_CREATED`) **et** `getOrder(orderId)`
  côté serveur ; seul `result=SUCCESS` + indicateur valide autorise. Preuve invérifiable → reste `pending`
  (le webhook MIGS / une réconciliation finalisent) ; la page interroge `GET /api/v1/pay/:shortId/status`
  toutes les 3 s (30 essais).
- `GET /api/v1/pay/:shortId/status` → `{ status: paid|pending|failed|expired|cancelled, txnId, txnStatus, gateway }`.
- Page de paiement : plus aucun champ carte ; bouton « Payer par carte » → `/card` → redirection. L'ancien
  `POST /api/v1/pay/:shortId` continue de refuser toute donnée carte (410).
- Gateways : `migs.gateway.createHostedCheckout/parseHostedReturn/hostedConfigured` (VPC 3-Party, `vpc_ReturnURL`,
  montant sans décimales pour XOF/XAF/CDF comme `minorToMajor`), `mpgs.gateway.createHostedCheckout/hostedConfigured`
  (`INITIATE_CHECKOUT`, redirection `/checkout/pay/{session}`). `webhook-handlers.applyMerchantPspResult` marque
  aussi `pay_links` par `transactions.pay_link_id`.
- **Ce qui est réellement payable par carte** : un lien dont le marchand est dans un pays dont
  `country_payment_defaults.default_card_gateway` vaut `migs` (défaut de tous les pays) avec
  `MIGS_MERCHANT_ID`, `MIGS_ACCESS_CODE`, `MIGS_SECURE_HASH` (+ `MIGS_HOST/PATH/HASH_TYPE` selon la banque)
  renseignés ; ou `mpgs` avec `MPGS_MERCHANT_ID`, `MPGS_API_PASSWORD` (+ `MPGS_HOST`). CyberSource, Stripe,
  GIMAC, Interswitch : pas de checkout hébergé branché → `410` (collect caisse et page). Le statut `active`
  d'`api_configurations` ne suffit pas (les modules carte lisent l'environnement) ; `cardAcceptance` et
  `POST /cash/collect {method:'card'}` suivent exactement cette règle.

### 1.5 Autres
- `orchestrator.processTransaction` accepte `operatorOverride` (Wave, Express Union) transmis à `detectFromPhone`.
- `server.js` : routeurs montés avant `/api/v1/admin` et `/api/v1/merchant` ; log de démarrage et `/health`
  lisent la version de `package.json` ; `config/database.js` `application_name` = `cpay-api` ; e-mail de bienvenue
  pointe vers `https://merchant.c-pay.global/download/`.
- `services/assistant/knowledge.js` : section « Caisse » (encaisser, retirer, transférer, step-up).

## 2. Migration `backend/database/009_wave4_cash.sql` (idempotente)
`financial_institutions`, `bank_accounts`, `merchant_transfers` : utilisées par le code depuis 2.6.0 mais absentes
de toute migration — `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE … ADD COLUMN IF NOT EXISTS` pour chaque colonne
lue/écrite par le code (inventaire par grep : `merchant.routes`, `admin.routes`, `gtp-card.routes`,
`transfer.service`). Nouveautés : `merchant_transfers.direction`, `bank_reference`, `executed_by`,
`instructions JSONB`, `events JSONB`, `completed_at`, `expires_at`, `cancelled_at`, `amount_requested`, index ;
`platform_bank_accounts` ; `merchants.cash_wallet_operator / cash_wallet_phone / cash_wallet_verified_at` ;
`pay_links.recipient_phone / send_channel / psp / payment_method / sent_at` (écrites par `POST /pay-links`,
absentes de 001/008). Rien n'est supprimé ; si la production possède déjà ces tables, seules les colonnes
manquantes sont ajoutées.

```bash
cd /opt/cplus && git fetch origin && git checkout wave-4
./scripts/backup-db.sh --label pre-wave-4
cd docker && docker compose run --rm --no-deps -e RUN_MIGRATIONS=false api node src/config/migrate.js
docker compose build api && docker compose up -d api
```
Puis créer le(s) compte(s) de collecte par devise (`POST /api/v1/admin/cash/platform-accounts`) : sans compte
actif pour la devise, `bank_to_wallet` répond `409 FUNDING_UNAVAILABLE`.

## 3. Variables d'environnement (toutes optionnelles)
| Variable | Défaut | Rôle |
|---|---|---|
| `CASH_WITHDRAW_DAILY_L0` / `L1` / `L2` | 100 000 / 500 000 / 2 000 000 | limite journalière de retrait par niveau KYB (devise du marchand) |
| `MTN_CG_DISB_API_USER`, `MTN_CG_DISB_API_KEY`, `MTN_CG_DISB_SUB_KEY_PRIMARY` | — | rail de retrait MTN **Congo** (client rails) ; sans ces trois valeurs le retrait MTN CG répond `410` |
| `PAY_LINK_BASE_URL` | `https://pay.c-pay.global` | base des liens carte |
| `ADMIN_ALERT_EMAIL` | `support@c-pay.global` | destinataire des demandes de virement manuel |

## 4. Rails par opérateur (ce qui est réellement branché)
Collecte = `provider.collectPayment` via l'orchestrateur ; Retrait = rail sortant de `payoutRail` ; Statut =
re-interrogation (`GET /cash/collect/:id` → `reconcileOne` ; `GET /cash/transfers/:id` → `refreshPayoutStatus`).
« Config » = clé API présente dans `api_configurations` (ou env `<GATEWAY>_API_KEY`).

| Opérateur (gateway) | Collecte | Retrait vers wallet | Statut collecte | Statut retrait |
|---|---|---|---|---|
| MTN MoMo Congo (`mtn_cg`) | oui | oui (client rails `MTN_CG_DISB_*`, sinon routeur MM si config) | oui | oui |
| MTN MoMo CM / CI (`mtn_cm`, `mtn_ci`) | oui | routeur MM si config | oui | oui |
| Airtel Money CG / CD | oui | routeur MM si config | oui (CG) | **non** (reste `processing`, aucun `getStatus` provider) |
| Orange Money SN/CI/CM/CG/CD | oui | routeur MM si config | **non** (pas d'endpoint statut branché, cf. WAVE-3 §4) | **non** |
| Wave SN / CI | oui | routeur MM si config | oui | **non** (B2C sans endpoint confirmé) |
| Moov CI/CM, Free Money SN, Express Union CM, Africell CD | oui | routeur MM si config | si `extra_params.statusPath` | si `statusPath` |
| Vodacom M-Pesa CD | oui | routeur MM si config | **non** | **non** |
| Interswitch wallet CD | oui | **410** (collecte seule) | non | — |
| PaymentHub CD | oui | routeur MM si config | partiel | partiel |
| Carte (MIGS / MPGS) | lien hébergé → checkout redirigé si `MIGS_*` ou `MPGS_*` configurés pour la passerelle du pays (§1.4) | — | retour signé / `getOrder` + webhook MIGS | — |
| Carte (CyberSource, Stripe, GIMAC, Interswitch) | **410** — pas de checkout hébergé | — | — | — |

Reste **manuel** : virements `wallet_to_bank` (`pending_manual`, exécutés par les opérations, `mark-executed`),
réception des approvisionnements (`confirm-funds`), retraits dont l'opérateur n'a pas d'endpoint de statut
(ils restent `processing` jusqu'à un webhook opérateur ou une action admin — aucun webhook de versement n'est
branché aujourd'hui, voir §5).

## 5. Points ouverts
- **Webhooks de versement** : aucun callback opérateur ne met à jour `merchant_transfers` (les webhooks MM
  traitent `transactions`). À brancher sur `cash.transitionTransfer` quand les opérateurs confirmeront leurs
  callbacks B2C ; en attendant, `refreshPayoutStatus` au `GET` détail + action admin.
- `calc_fee()` et `merchant_fees` sont référencés par `merchant.routes.js` (statut MTN/Airtel) mais n'existent
  dans aucune migration ; la caisse n'en dépend pas (barème interne de repli).
- Compteur step-up en mémoire (par processus) — comme les rate limiters (WAVE-3 §1.5).
- Carte : MPGS n'a pas de webhook branché (finalisation au retour navigateur via `getOrder`) ; une transaction
  MPGS dont le client ferme la page avant le retour reste `pending` (à couvrir par une réconciliation `getOrder`).
  Les paramètres MIGS/MPGS n'ont pas pu être testés contre une banque réelle : valider `MIGS_HOST/PATH`,
  `MIGS_HASH_TYPE` et la version d'API MPGS (`MPGS_API_VERSION` ≥ 57 pour `INITIATE_CHECKOUT`) en recette.
- `POST /merchant/transfer/payout` (apps 2.7.0) continue de produire `pending_settlement` pour une banque ;
  l'admin caisse le traite comme `pending_manual`. À aligner quand les apps passeront sur `/cash/transfers`.
- Liste admin / stats : pas d'index sur `merchant_transfers(direction, dest_type)` — ajouter si les volumes grimpent.
