# Contrat API — Caisse marchande (vague 4)

Vocation de C-Pay : permettre au marchand d'**encaisser digitalement ses recettes** (carte et opérateurs de
Mobile Money) et d'effectuer les opérations de caisse : **Encaisser, Retirer, Transférer** (wallet → banque,
banque → wallet), avec un journal unique. Ce contrat est la référence pour le backend, le portail marchand,
le portail admin, l'app Android et l'app Expo.

Base : `https://api.c-pay.global/api/v1`. Auth marchand : `Authorization: Bearer <access>` (15 min, refresh).
Erreurs : `{ "error", "code", "details?" }`. Montants en unité de la devise (entiers pour XOF/XAF/CDF).
Toute opération qui crée un mouvement exige `Idempotency-Key` (8–128 caractères).

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
  (`GET/POST /merchant/bank-accounts` existants). Si un rail bancaire est configuré → `status: "processing"`,
  sinon `status: "pending_manual"` (exécuté par les opérations C-Pay, J+1 ouvré). Réponse
  `201 { "transferId", "reference": "TRF-XXXXXX", "direction", "status", "amount", "fee", "net", "bankAccount": { "bankName", "accountMasked" } }`.
- `bank_to_wallet` (approvisionnement) : crée un **ordre d'approvisionnement** ; le marchand vire le montant
  sur le compte de collecte C-Pay de sa devise en indiquant la référence ; les opérations confirment la
  réception et le solde est crédité. Réponse `201 { "transferId", "reference": "FND-XXXXXX", "direction",
  "status": "awaiting_funds", "amount", "currency", "instructions": { "bankName", "accountName", "accountNumber",
  "iban?", "swift?", "reference": "FND-XXXXXX", "expiresAt" } }`. Sans compte de collecte pour la devise :
  `409 FUNDING_UNAVAILABLE`. **Aucune confirmation forte n'est exigée** pour `bank_to_wallet` (aucun fonds ne
  quitte le compte) : `confirm` est ignoré ; le step-up ne s'applique qu'à `wallet_to_bank`.
- Statuts : `pending`, `processing`, `pending_manual`, `awaiting_funds`, `completed`, `failed`, `cancelled`, `rejected`
  (+ `pending_settlement`, statut historique des transferts créés par `POST /merchant/transfer/payout`, traité comme
  `pending_manual` par l'admin).
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
| GET | `/admin/cash/transfers?status&direction&merchantId&q&limit&offset` | liste |
| GET | `/admin/cash/transfers/:id` | détail + journal des changements |
| POST | `/admin/cash/transfers/:id/confirm-funds` `{ amountReceived, bankReference }` | `awaiting_funds` → `completed`, crédite le solde |
| POST | `/admin/cash/transfers/:id/mark-executed` `{ bankReference }` | `pending_manual` → `completed` |
| POST | `/admin/cash/transfers/:id/reject` `{ reason }` | `awaiting_funds`, `pending_manual`, `pending_settlement` → `rejected` (libère les fonds) ; autre statut → `409 INVALID_STATUS` |
| GET/POST/PATCH | `/admin/cash/platform-accounts` | comptes de collecte C-Pay par devise (`currency`, `bankName`, `accountName`, `accountNumber`, `iban`, `swift`, `active`) |

Chaque action admin écrit un audit log et un événement sur le transfert.

## 9. Données (`backend/database/009_wave4_cash.sql`, idempotente)
`financial_institutions`, `bank_accounts`, `merchant_transfers` (créées si absentes — elles sont utilisées par
le code depuis 2.6.0 mais n'existaient dans aucune migration), `merchant_transfers.direction` ∈ `payout|funding`,
colonnes `bank_reference`, `executed_by`, `instructions JSONB`, `events JSONB`, `completed_at` ;
`platform_bank_accounts` ; `merchants.cash_wallet_operator`, `cash_wallet_phone`, `cash_wallet_verified_at`.
