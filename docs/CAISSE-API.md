# Contrat API — Caisse marchande (vague 4)

Vocation de C-Pay : permettre au marchand d'**encaisser digitalement ses recettes** (carte et opérateurs de
Mobile Money) et d'effectuer les opérations de caisse : **Encaisser, Retirer, Transférer** (wallet → banque,
banque → wallet), avec un journal unique. Ce contrat est la référence pour le backend, le portail marchand,
le portail admin, l'app Android et l'app Expo.

Base : `https://api.c-pay.global/api/v1`. Auth marchand : `Authorization: Bearer <access>` (15 min, refresh).
Erreurs : `{ "error", "code", "details?" }`. Montants en unité de la devise (entiers pour XOF/XAF/CDF).
Toute opération qui crée un mouvement exige `Idempotency-Key` (8–128 caractères).

## 0. Idempotence et résultats incertains (vague 6, audit du 17/10/2026)
- Même clé + même corps → la réponse d'origine (2xx/4xx) est rejouée ; corps différent → `409 IDEMPOTENCY_CONFLICT` ;
  requête identique encore en cours → `409 IDEMPOTENCY_IN_PROGRESS`.
- **Endpoints monétaires** (`/merchant/cash/withdraw`, `/merchant/cash/transfers`, `/merchant/cash/collect`,
  `/merchant/transfer/payout`, `/merchant/disburse`, `/merchant/collect`) : une erreur serveur (5xx) ou une
  interruption ne libère plus la clé. Le rejeu avec la même clé renvoie **l'ordre d'origine** s'il a été créé
  (`200 { "replayed": true, "code": "IDEMPOTENCY_REPLAY", "resourceType": "merchant_transfer|transaction",
  "transferId"|"txnId", "status", … }`), sinon `409 IDEMPOTENCY_RETRY_AFTER_ERROR { "lastError" }` : le client
  vérifie ses opérations (`GET /merchant/cash/transfers`) avant de réémettre avec une **nouvelle** clé. Un retry
  ne crée jamais un second ordre. Les autres endpoints conservent le comportement vague 2 (5xx → clé libérée).
- Statut `unknown` (retraits) : l'opérateur n'a ni confirmé ni refusé (timeout, réseau, 5xx, réponse illisible).
  La réponse reste `201` avec `"status": "unknown", "outcome": "unknown"` ; les fonds **restent réservés** ; le
  client interroge `GET /merchant/cash/transfers/:id` (statut réel opérateur) — voir §5.

## 1. Solde et résumé — `GET /merchant/cash/summary`
```json
{ "currency": "XAF",
  "balance": { "available": 125000, "pending": 15000, "reserved": 0 },
  "today":   { "collected": 80000, "collectedCount": 12, "byMethod": { "mobile_money": 70000, "card": 10000 },
               "withdrawn": 20000, "transfersOut": 0, "transfersIn": 0 },
  "limits":  { "withdrawDailyMax": 500000, "withdrawDailyRemaining": 480000, "transferMin": 1000,
               "withdrawFeePercent": 1, "withdrawFeeFixed": 0, "withdrawFeeMin": 0 },
  "fees":    { "withdraw": { "percent": 1, "fixed": 0, "min": 0 }, "transfer": { "percent": 1, "fixed": 0, "min": 0 } },
  "profile": { "kybLevel": 1, "wallet": { "operator": "mtn_momo", "phone": "+2376…", "verifiedAt": "…|null" },
               "bankAccounts": 1, "cardAcceptance": "link|tap_to_phone_pending|unavailable" } }
```
Formule du solde disponible : encaissements `authorized` non réglés + approvisionnements `completed`
− retraits/transferts sortants non échoués (`merchant_transfers`) − décaissements (`transactions.type='payout'`).

## 2. Encaisser
### `POST /merchant/cash/collect`
```json
{ "amount": 25000, "currency?": "XAF", "method": "mobile_money|card",
  "customerPhone?": "+2376…", "operator?": "mtn_momo|orange_money|wave|…", "description?": "…", "reference?": "FACT-001" }
```
- `mobile_money` : `customerPhone` requis ; l'opérateur est **détecté** depuis le numéro (`detection.engine`),
  `operator` ne sert qu'à forcer un service au choix du client (Wave, Express Union) ; il est accepté sans
  distinction de casse (`wave`, `WAVE`) et renvoyé en minuscules (`mtn_momo`, `orange_money`, `wave`…). Devise déduite du pays,
  doit être celle du marchand (sinon `422 CURRENCY_MISMATCH`). Exécution via l'orchestrateur ; réponse
  `201 { "txnId", "status": "pending", "method", "operator", "operatorLabel", "country", "currency", "amount", "fee", "net", "statusUrl" }`.
- `card` : crée un lien de paiement hébergé (page `pay.c-pay.global`) qui accepte la carte si une passerelle
  carte est configurée pour le pays du marchand ; réponse `201 { "txnId": null, "status": "pending",
  "payLink": { "shortId", "shortUrl", "expiresAt" } }`. Sans passerelle : `410 FEATURE_DISABLED`.
  Sur la page hébergée, le client est redirigé vers le checkout de la passerelle (MIGS ou MPGS, aucun PAN sur
  C-Pay) : `POST /pay/:shortId/card → { redirectUrl }`, retour sur `/pay/:shortId/return`, statut public
  `GET /pay/:shortId/status → { status: paid|pending|failed|expired|cancelled }`.
  Tap-to-Phone reste `410` tant que la certification n'est pas obtenue.
- `429` limites, `422 VALIDATION_ERROR`, `403 MERCHANT_INACTIVE`.

### `GET /merchant/cash/collect/:txnId`
`{ "txnId", "status": "pending|authorized|failed|expired", "amount", "fee", "net", "operator", "customerPhone", "createdAt", "finalizedAt", "receiptUrl?" }`
(le client interroge toutes les 3 s pendant 90 s puis affiche « en attente de confirmation »). `customerPhone` est
toujours `null` : le numéro du client n'est pas conservé en clair.

## 3. Wallet du marchand (destination des retraits)
- `GET /merchant/cash/wallet` → `{ "operator", "phone", "verifiedAt" }` ou `204`.
- `PUT /merchant/cash/wallet` `{ "operator", "phone", "confirm": {…} }` (step-up, §6) → `200 { "operator", "phone", "verifiedAt": null }`.
  Le wallet est marqué vérifié (`verifiedAt`) après le premier retrait `completed`.
- **Vague 6** : réservé au rôle `owner` du compte marchand (JWT `role`) — caissier, manager, clé API →
  `403 INSUFFICIENT_ROLE` ; step-up obligatoire. Chaque changement écrit `beneficiary_events` (qui, quand,
  anciennes/nouvelles valeurs masquées, IP), un `audit_logs` et envoie un e-mail au propriétaire.
- `GET /merchant/cash/beneficiaries/history?limit&offset` → `{ "data": [ { "eventId", "type":
  "wallet_updated|bank_account_added|bank_account_removed|bank_account_verified", "entityType", "entityId",
  "actor": { "type", "id", "email", "role" }, "oldValues", "newValues", "ip", "createdAt" } ], "total" }`.
- Comptes bancaires (`/merchant/bank-accounts`) : `POST` et `DELETE /:accountId` exigent le rôle `owner` **et**
  `confirm` (step-up) ; un nouveau compte est créé `status: "pending_verification"`, `usable: false`, et devient
  utilisable (`verified`) après vérification par les opérations C-Pay (§8). `GET` liste `status`, `usable`, `verifiedAt`.

## 4. Retirer — `POST /merchant/cash/withdraw`
```json
{ "amount": 50000, "description?": "Caisse du soir", "confirm": { "code": "123456" } }
```
Paie du solde disponible vers le wallet enregistré (§3). Frais : règle plateforme (`fee`, `net`). Limite
journalière selon `kyb_level`. Réponse `201 { "transferId", "reference": "PAY-XXXXXX", "status": "pending|processing",
"amount", "fee", "net", "wallet": { "operator", "phone" } }`. Erreurs : `422 INSUFFICIENT_BALANCE { available }`,
`422 WALLET_MISSING`, `422 DAILY_LIMIT_EXCEEDED`, `428 STEP_UP_REQUIRED`, `410 FEATURE_DISABLED` si l'opérateur
du wallet n'a pas de rail de paiement sortant configuré.

## 5. Transférer — `POST /merchant/cash/transfers`
```json
{ "direction": "wallet_to_bank|bank_to_wallet", "accountId": "<bank_accounts.account_id>",
  "amount": 200000, "description?": "…", "confirm": { "password": "…" } }
```
- `wallet_to_bank` : débit du solde disponible vers un compte bancaire **vérifié** du marchand
  (`GET/POST /merchant/bank-accounts` ; un compte `pending_verification` → `404 BANK_ACCOUNT_NOT_FOUND`, aucune réservation). Si un rail bancaire est configuré → `status: "processing"`,
  sinon `status: "pending_manual"` (exécuté par les opérations C-Pay, J+1 ouvré). Réponse
  `201 { "transferId", "reference": "TRF-XXXXXX", "direction", "status", "amount", "fee", "net", "bankAccount": { "bankName", "accountMasked" } }`.
- `bank_to_wallet` (approvisionnement) : crée un **ordre d'approvisionnement** ; le marchand vire le montant
  sur le compte de collecte C-Pay de sa devise en indiquant la référence ; les opérations confirment la
  réception et le solde est crédité. Réponse `201 { "transferId", "reference": "FND-XXXXXX", "direction",
  "status": "awaiting_funds", "amount", "currency", "instructions": { "bankName", "accountName", "accountNumber",
  "iban?", "swift?", "reference": "FND-XXXXXX", "expiresAt" } }`. Sans compte de collecte pour la devise :
  `409 FUNDING_UNAVAILABLE`. **Aucune confirmation forte n'est exigée** pour `bank_to_wallet` (aucun fonds ne
  quitte le compte) : `confirm` est ignoré ; le step-up ne s'applique qu'à `wallet_to_bank`.
- Statuts : `pending`, `processing`, `unknown`, `pending_manual`, `awaiting_funds`, `completed`, `failed`, `cancelled`, `rejected`
  (+ `pending_settlement`, statut historique des transferts créés par `POST /merchant/transfer/payout`, traité comme
  `pending_manual` par l'admin).
  - `unknown` (vague 6) : résultat opérateur incertain (timeout, réseau, 5xx, réponse illisible) pour un retrait /
    décaissement. Les fonds restent **réservés** (comptés comme `pending`/`processing` dans le solde) ; la réponse
    `POST /withdraw` est `201 { "status": "unknown", "outcome": "unknown", "message" }`. `GET /transfers/:id` interroge
    l'opérateur : `SUCCESSFUL` → `completed`, `FAILED` → `failed` (fonds libérés) ; « introuvable » ne vaut échec
    qu'après `CASH_UNKNOWN_GRACE_MINUTES` (30 min). Après `CASH_UNKNOWN_ALERT_HOURS` (2 h) le transfert est marqué
    `needsReview` et les opérations sont alertées ; la clôture est alors manuelle (§8). Un `unknown` n'est ni
    annulable par le marchand ni rejetable par l'admin tant que l'opérateur n'a pas répondu.
  - `failed` n'est posé que sur un **refus explicite** de l'opérateur (`502 GATEWAY_ERROR { "outcome": "declined", "transferId" }`).
- `GET /merchant/cash/transfers?direction&status&limit&offset` → `{ "data": [ {transfer…} ], "total" }` ;
  `GET /merchant/cash/transfers/:id` ; `POST /merchant/cash/transfers/:id/cancel` (uniquement
  `awaiting_funds` et `pending_manual`, sinon `409 TRANSFER_NOT_CANCELLABLE { status }`). `direction` du filtre :
  `wallet_to_bank | bank_to_wallet | withdraw`.

## 6. Confirmation forte (step-up) — objet `confirm`
`{ "code": "<TOTP 6 chiffres>" }` si le 2FA du compte est activé, sinon `{ "password": "<mot de passe>" }`.
Absent ou invalide → `428 STEP_UP_REQUIRED { "methods": ["totp"] | ["password"] }`. Cinq échecs / 15 min → `429`.

## 7. Journal — `GET /merchant/cash/history?from&to&type&limit&offset`
`type` ∈ `collect|withdraw|transfer_out|transfer_in`. Réponse `{ "data": [ { "id", "type", "reference", "amount",
"fee", "net", "status", "counterparty": "…", "method", "createdAt" } ], "total", "totals": { "in", "out" } }`.
`GET /merchant/cash/history/export.csv?from&to` → CSV UTF-8 avec BOM (séparateur `;`), même en-tête `Authorization`
que les autres routes (pas d'auth par cookie). Entrées : `collect|transfer_in` = entrées, `withdraw|transfer_out` = sorties.

## 8. Administration — `/admin/cash/*` (rôles `super_admin`, `ops_admin`)
| Méthode | Route | Rôle |
|---|---|---|
| GET | `/admin/cash/stats` | volumes du jour / 7 j, files d'attente (`pending_manual`, `awaiting_funds`) |
| GET | `/admin/cash/transfers?status&direction&merchantId&q&needsReview&limit&offset` | liste (`status=uncertain` = `unknown,processing` ; `needsReview=1`) |
| GET | `/admin/cash/transfers/:id` | détail + journal des changements ; rafraîchit `processing`/`unknown` ; `needsReview`, `unknownSince`, `requestPayload`, `context.beneficiaryHistory` |
| POST | `/admin/cash/reconcile/uncertain-payouts` `{ graceMinutes? }` | interroge l'opérateur pour tous les retraits `unknown`/`processing` (même logique que le cron) |
| POST | `/admin/cash/repair/settlement-queue` `{ minAgeMinutes? }` | enfile les encaissements `authorized` sans ligne `settlement_queue` (> 5 min) |
| GET | `/admin/cash/bank-accounts?status=pending_verification` | comptes bancaires marchands à vérifier |
| POST | `/admin/cash/bank-accounts/:id/verify` `{ method: "document\|micro_deposit\|manual", reference }` | `pending_verification` → `verified` (audit, `beneficiary_events`, e-mail au marchand) ; déjà vérifié → `409 ALREADY_VERIFIED` |
| POST | `/admin/cash/transfers/:id/confirm-funds` `{ amountReceived, bankReference }` | `awaiting_funds` → `completed`, crédite le solde |
| POST | `/admin/cash/transfers/:id/mark-executed` `{ bankReference }` | `pending_manual` → `completed` |
| POST | `/admin/cash/transfers/:id/reject` `{ reason }` | `awaiting_funds`, `pending_manual`, `pending_settlement` → `rejected` (libère les fonds) ; autre statut → `409 INVALID_STATUS` |
| GET/POST/PATCH | `/admin/cash/platform-accounts` | comptes de collecte C-Pay par devise (`currency`, `bankName`, `accountName`, `accountNumber`, `iban`, `swift`, `active`) |

Chaque action admin écrit un audit log et un événement sur le transfert. `GET /admin/cash/stats` expose en plus
`queues.unknown { count, amount }` et `queues.needsReview { count }`.

## 9. Données (`backend/database/009_wave4_cash.sql` et `011_wave6_integrity.sql`, idempotentes)
Vague 6 (`011_wave6_integrity.sql`) : `merchant_transfers.request_payload`, `unknown_since`, `needs_review`,
`last_status_check_at`, `review_alerted_at` ; `idempotency_keys.in_progress`, `last_error`, `failed_at`, `resource_type`,
`resource_id` ; index unique `settlement_queue(transaction_id)` ; `bank_accounts.verified_at`, `verified_by`,
`verification_method`, `verification_reference`, `created_by` (défaut de `status` : `pending_verification`) ;
table `beneficiary_events`. Voir `docs/WAVE-6-LOT1.md`.

`financial_institutions`, `bank_accounts`, `merchant_transfers` (créées si absentes — elles sont utilisées par
le code depuis 2.6.0 mais n'existaient dans aucune migration), `merchant_transfers.direction` ∈ `payout|funding`,
colonnes `bank_reference`, `executed_by`, `instructions JSONB`, `events JSONB`, `completed_at` ;
`platform_bank_accounts` ; `merchants.cash_wallet_operator`, `cash_wallet_phone`, `cash_wallet_verified_at`.

## 10. Capacités par pays (vague 6, lot 2 — [`WAVE-6-LOT2.md`](WAVE-6-LOT2.md))
Toute opération de caisse est soumise au **registre de capacités** (`backend/src/services/capabilities/registry.js`),
évalué par un middleware monté avant `/merchant/cash` (`middleware/capability.js`) à partir du **pays du marchand** :

| Requête | Cellule contrôlée |
|---|---|
| `POST /merchant/cash/collect` `{ method:'mobile_money', operator? }` | `collect.mobile_money` (ou l'opérateur précis s'il est forcé) |
| `POST /merchant/cash/collect` `{ method:'card' }` | `collect.card` |
| `POST /merchant/cash/withdraw` | `withdraw.mobile_money` |
| `POST /merchant/cash/transfers` `{ direction }` | `transfer.wallet_to_bank` ou `transfer.bank_to_wallet` |

Statuts : `active` (code + configuration), `pilot` (idem, `CAPABILITY_PILOT_<CC>=true`), `planned` (périmètre de lancement
sans code), `unavailable`. Seuls `active` et `pilot` laissent passer la requête ; sinon :

```
403 { "error": "Encaissement Mobile Money non disponible au Tchad pour le moment : intégration en cours.",
      "code": "CAPABILITY_NOT_ACTIVE", "country": "TD", "operation": "collect", "method": "mobile_money",
      "status": "planned", "operator": "AIRTEL_MONEY", "message": "…" }
```

`GET /api/v1/public/capabilities` (sans authentification, cache 60 s) donne le résumé par pays que les portails
utilisent pour désactiver à l'avance les méthodes non disponibles ; `GET /api/v1/admin/capabilities` (admin) expose la
matrice complète avec les prérequis. Les `GET` de la caisse ne sont jamais filtrés ; un corps invalide reste traité par
la route (`422 VALIDATION_ERROR`). L'inscription (`POST /merchant/auth/register`) est refusée (`422 COUNTRY_NOT_OPEN`)
pour un pays sans encaissement `active|pilot` ou hors périmètre (SN, CI).
