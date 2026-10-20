# Vague 6 — Lot 1 : intégrité financière (audit externe du 17 octobre 2026)

Référence : `docs/AUDIT-2026-10-17.md`, points P1 n°1, 2, 3 et P2 n°5. Périmètre backend uniquement ; les portails
(affichage du statut `unknown`, vérification des comptes bancaires, historique des bénéficiaires) suivent dans un lot
ultérieur. Contrat API mis à jour : `docs/CAISSE-API.md` (§0, §3, §5, §8, §9).

## 1. Résultat opérateur incertain ≠ échec définitif

### Classification des résultats rail (`services/cash/cash.service.js`)
`classifyRailResult(res)` / `classifyRailError(err)` → `declined | accepted | completed | unknown` :

| Résultat | Classification | Effet (retrait `merchant_transfers`) | Effet (orchestrateur `transactions`) |
|---|---|---|---|
| Refus explicite (`approved:false` avec code ≠ 96/91/68, HTTP 400/401/403/404/422) | `declined` | `failed`, fonds libérés, `502 GATEWAY_ERROR { outcome:'declined' }` | `failed` |
| `pending:true` | `accepted` | `processing` | `pending` |
| `approved:true` | `completed` | `completed` | `authorized` |
| Timeout, erreur réseau (ECONNRESET…), HTTP 5xx/408/409/429, réponse vide ou illisible, routeur MM « indisponible » (`responseCode 96`, `retryable`) | `unknown` | **`unknown`**, réservation conservée, `gateway_reference` + `request_payload` stockés, `201 { status:'unknown', outcome:'unknown' }` | reste `pending`, `response_message='pending_unknown'`, événement `GATEWAY_UNKNOWN` (payouts : y compris le résultat `96` normalisé par le routeur) |

Le solde disponible (`computeAvailableBalance`) compte `unknown` comme réservé (`OUT_NOT_FAILED`, `OUT_INFLIGHT`).
Pour les **encaissements** via l'orchestrateur, un résultat `96` normalisé par le routeur reste `failed` (aucun fonds ne
quitte la plateforme, le client peut représenter sa demande) ; seules les exceptions sont classées.

### Rapprochement (`refreshPayoutStatus`, `sweepUncertainPayouts`, `reconcile.service.reconcileUncertainPayouts`)
- Interroge l'opérateur pour `unknown` **et** `processing` (MTN : `getTransferStatus` / `getDisbursementStatus` ;
  autres providers : `getStatus({ product:'disbursement' })` par `txnId` = `transfer_id`, utilisable même sans référence).
- Seul un statut explicite change l'état : `SUCCESSFUL|SUCCESS|COMPLETED` → `completed` ; `FAILED|REJECTED` → `failed`
  (fonds libérés). « Introuvable » (`NOT_FOUND` / HTTP 404) → `failed` **uniquement** après `CASH_UNKNOWN_GRACE_MINUTES`.
  Erreur réseau au poll → statut inchangé, `last_status_check_at` mis à jour.
- Après `CASH_UNKNOWN_ALERT_HOURS` en `unknown` : `needs_review=true`, `review_alerted_at`, événement `needs_review`,
  e-mail ops (`ADMIN_ALERT_EMAIL`), **une seule fois**.
- Décaissements orchestrateur `pending_unknown` : `reconcileOne` si une référence existe ; sinon alerte ops une fois
  (événement `PAYOUT_NEEDS_REVIEW`).
- Déclencheurs : `GET /merchant/cash/transfers/:id`, `GET /admin/cash/transfers/:id`, `POST /admin/cash/reconcile/uncertain-payouts`,
  `scripts/reconcile-pending.js` (cron 10 min).

### Idempotence durable (`middleware/idempotency.js`)
- Endpoints monétaires (`MONEY_ENDPOINTS`) : 5xx ou interruption → clé conservée (`status_code=NULL, in_progress=false,
  last_error, failed_at`) avec la ressource créée (`resource_type/resource_id`).
- `idempotency.attachResource(req, { type, id })` : appelé par `cash.routes` via `createPayout({ onReserved })` **avant
  l'appel opérateur** (et sur les ordres d'approvisionnement, les encaissements). Les routes historiques
  `merchant.routes` (`/transfer/payout`, `/disburse`, `/collect`) bénéficient du repli : le `transferId`/`txnId` présent
  dans le corps 5xx est référencé.
- Rejeu : ressource existante → `200 { replayed:true, code:'IDEMPOTENCY_REPLAY', … }` ; sinon `409 IDEMPOTENCY_RETRY_AFTER_ERROR`.
  Autres endpoints : comportement vague 2 inchangé.

## 2. Confirmation atomique (`services/mobilemoney/finalize.service.js`)
`finalizeTransaction` exécute dans **une transaction PostgreSQL** (`withTransaction`) : claim `status='pending'` →
`authorized|failed`, événement `transaction_events`, `settlement_queue.enqueue(…, client)` (nouveau paramètre `client`
dans `settlement.engine.enqueue`), `pay_links → paid`. Toute erreur annule tout (la transaction reste `pending`, le webhook
peut être rejoué) et remonte à l'appelant (webhook → 5xx, rejeu opérateur ; réconciliation → `error`, laissé pending).
Plus aucune erreur « seulement journalisée ».

Job de réparation `services/settlement/settlement.repair.js#sweepAuthorizedWithoutQueue({ minAgeMinutes=5 })` :
encaissements `authorized` réglables, sans ligne `settlement_queue`, non réglés/liés à un lot, plus vieux que 5 min →
enfilés (`ON CONFLICT DO NOTHING`, index unique `idx_settlement_queue_txn_unique`) + événement `SETTLEMENT_QUEUE_REPAIRED`.
Appelé par `scripts/reconcile-pending.js` et `POST /admin/cash/repair/settlement-queue` (super_admin / ops_admin, audit).

## 3. Bénéficiaires
- `middleware/auth.js#requireMerchantOwner` (additif) : `role='owner'` du JWT marchand, sinon `403 INSUFFICIENT_ROLE`
  (caissier, manager, clé API `role='api'`).
- `PUT /merchant/cash/wallet`, `POST /merchant/bank-accounts`, `DELETE /merchant/bank-accounts/:id` : owner + step-up
  (`cash.verifyStepUp`, `confirm` dans le corps, y compris pour `DELETE`).
- Nouveau compte bancaire : `status='pending_verification'` (défaut SQL modifié) ; seul `verified` est utilisable pour
  `wallet_to_bank` (filtre existant `ba.status='verified'`, vérifié par test) ; `GET /merchant/bank-accounts` expose `usable`.
- Vérification : `POST /admin/cash/bank-accounts/:id/verify { method: document|micro_deposit|manual, reference }` →
  `verified_at/by`, `verification_method/reference`, audit, `beneficiary_events`, e-mail au marchand ;
  `GET /admin/cash/bank-accounts?status=` liste les comptes à vérifier. Les comptes historiques `verified` ne sont pas
  re-contrôlés automatiquement.
- Historique `beneficiary_events` (qui, quand, valeurs masquées, IP) : `GET /merchant/cash/beneficiaries/history` et
  `context.beneficiaryHistory` dans `GET /admin/cash/transfers/:id` ; e-mail au propriétaire à chaque changement.

## 4. Antifraude en mode dégradé (`services/orchestration/orchestrator.js`)
Exception (ou décision absente) de `fraud.engine.evaluate` → `FRAUD_DEGRADED_MODE` :

| Mode | Comportement |
|---|---|
| `allow_limited` (défaut) | autorisé si `amount ≤ FRAUD_DEGRADED_MAX_AMOUNT` (100 000), sinon transaction `failed` + `503 FRAUD_UNAVAILABLE` |
| `review` | autorisé, événement `FRAUD_DEGRADED { fraud_degraded:true, mode:'review' }` + alerte ops (pas de statut `pending_review` disponible) |
| `block` | tout refusé (`503 FRAUD_UNAVAILABLE`) |

Journal `error` + e-mail ops au plus **une fois toutes les 10 minutes** par instance (compteur d'alertes supprimées).
`cash.routes` renvoie `503 FRAUD_UNAVAILABLE { txnId }`.

## 5. Nouveaux statuts, événements, endpoints, variables

| Élément | Valeurs |
|---|---|
| `merchant_transfers.status` | + `unknown` (`UNCERTAIN = ['unknown','processing']`) ; `needs_review` |
| `transactions.response_message` | `pending_unknown` (statut `pending` conservé), `fraud_unavailable` |
| `transaction_events.event_type` | `GATEWAY_UNKNOWN`, `GATEWAY_DECLINED`, `FRAUD_DEGRADED`, `FRAUD_DEGRADED_REFUSED`, `SETTLEMENT_QUEUE_REPAIRED`, `PAYOUT_NEEDS_REVIEW` |
| `beneficiary_events.event_type` | `wallet_updated`, `bank_account_added`, `bank_account_removed`, `bank_account_verified` |
| Codes API | `IDEMPOTENCY_REPLAY` (200), `IDEMPOTENCY_RETRY_AFTER_ERROR` (409), `FRAUD_UNAVAILABLE` (503), `GATEWAY_UNKNOWN` (orchestrateur), `ALREADY_VERIFIED` (409), `INSUFFICIENT_ROLE` (403, bénéficiaires) |
| Endpoints | `GET /merchant/cash/beneficiaries/history` ; `POST /admin/cash/bank-accounts/:id/verify` ; `GET /admin/cash/bank-accounts` ; `POST /admin/cash/repair/settlement-queue` ; `POST /admin/cash/reconcile/uncertain-payouts` ; `GET /admin/cash/transfers?status=uncertain&needsReview=1` |
| Env | `CASH_UNKNOWN_GRACE_MINUTES` (30), `CASH_UNKNOWN_ALERT_HOURS` (2), `FRAUD_DEGRADED_MODE` (`allow_limited`), `FRAUD_DEGRADED_MAX_AMOUNT` (100000), `ADMIN_ALERT_EMAIL` (existant) |

## 6. Runbook ops — opérations `unknown`
1. **Alerte** : e-mail « Retrait à vérifier (résultat opérateur incertain) » ou `GET /admin/cash/transfers?needsReview=1`
   (`GET /admin/cash/stats → queues.unknown / needsReview`). Le détail contient `requestPayload` (montant net, destinataire
   masqué, référence externe `PAY-…`), `gatewayReference` (peut être vide : timeout avant réponse), `events`, `context.beneficiaryHistory`.
2. **Forcer l'interrogation** : `POST /admin/cash/reconcile/uncertain-payouts` (ou `GET /admin/cash/transfers/:id`). Un
   statut opérateur explicite clôt le transfert automatiquement.
3. **Sans réponse opérateur** (référence absente — MTN génère `X-Reference-Id` côté client rails et le timeout l'a perdu) :
   consulter le relevé / portail opérateur avec la **référence externe** et le montant net, puis :
   - exécuté chez l'opérateur → `POST /admin/cash/transfers/:id/mark-executed { bankReference: <réf. opérateur> }`
     n'accepte que `pending_manual|pending_settlement` : passer d'abord par la décision Finance documentée et une mise à
     jour SQL contrôlée `status='completed'` (ou étendre `MANUAL_QUEUE` dans un lot ultérieur) ;
   - non exécuté (confirmation écrite de l'opérateur) → idem vers `failed` (libère les fonds). Les routes `reject`/`cancel`
     refusent volontairement `unknown` (409) : aucune libération automatique sans preuve.
4. Ne jamais relancer un retrait `unknown` : le marchand doit attendre la clôture ; un rejeu client avec la même
   `Idempotency-Key` renvoie l'ordre d'origine.
5. Cron : `*/10 * * * * node scripts/reconcile-pending.js` (options `--grace-minutes`, `--alert-hours`, `--skip-payouts`,
   `--skip-repair`, `--json`). Sortie : encaissements pending, retraits incertains, décaissements `pending_unknown`,
   réparation de la file.

## 7. Déploiement
- Migration additive `backend/database/011_wave6_integrity.sql` (idempotente, `gen_random_uuid()` seul) : à exécuter
  avec la nouvelle image **avant** de servir le code (le code écrit `request_payload`, `in_progress`, `beneficiary_events`).
  Une contrainte CHECK manuelle `merchant_transfers_status_check` est levée si présente ; vérifier qu'aucune autre
  contrainte maison n'interdit `unknown`.
- Pas de reprise des données : les transferts historiques `failed` sur erreur rail ne sont pas requalifiés (rapprochement
  manuel via `npm run check:financial`). Les clés d'idempotence existantes sont marquées `in_progress=false` si répondues.
- Jobs : conserver `scripts/reconcile-pending.js` toutes les 10 min ; définir `ADMIN_ALERT_EMAIL` et SMTP (sinon les
  alertes ne partent pas — journalisées seulement). `FRAUD_DEGRADED_MODE` par défaut `allow_limited`.
- Tests : `npm test` (= `node --experimental-vm-modules … jest --runInBand --forceExit`, flag requis par PGlite) ;
  `src/tests/wave6-integrity.test.js` (19 tests) ; ajustements minimes de `wave2-webhooks-mm`, `wave3-reconcile-admin`
  (`enqueue(…, client)`), `wave4-cash` (rôle `owner`, nouvelles files admin). `node --check` sur tous les fichiers touchés.

## 8. Points ouverts
- MTN (client rails Congo) : la référence `X-Reference-Id` est générée dans `services/rails/mtn-momo.client.js` (hors
  périmètre du lot) ; un timeout avant réponse laisse le retrait sans référence interrogeable → revue ops manuelle.
  Évolution proposée : générer la référence dans `cash.service` et la passer au client.
- Clôture manuelle d'un `unknown` : pas de route admin dédiée (décision volontaire : aucune libération sans preuve) ;
  à spécifier avec Finance (lot 3 : rapprochement admin).
- Les webhooks (`routes/webhooks-mm.routes.js`, hors périmètre) reçoivent désormais une exception si la finalisation
  échoue ; ils sont montés via `asyncHandler` → réponse 5xx, l'opérateur rejoue (vérifié en lecture, non modifié).
- Portails : afficher `unknown` / `needsReview`, `pending_verification`, l'historique bénéficiaires ; écran admin de
  vérification des comptes (lot suivant).
