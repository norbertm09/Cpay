# Éléments à confirmer avec les opérateurs (vague 3)

Liste de travail pour l'équipe Calculus Plus : chaque ligne doit être validée par écrit avec l'opérateur
(ou l'agrégateur) avant l'ouverture du pays. Source code : `backend/src/services/detection/detection.engine.js`
(entrées `verified:false`), `backend/src/services/mobilemoney/mobilemoney.router.js` (clés de gateway),
`backend/src/routes/webhooks-mm.routes.js` (authentification des callbacks).

## 1. Préfixes / réseaux marqués `verified:false`

| # | Pays | Entrée | Opérateur / réseau | Gateway | Ce qu'il faut confirmer | Contact | Statut | Date |
|---|---|---|---|---|---|---|---|---|
| 1 | CG (Congo-Brazzaville) | préfixes `05`, `04` | Airtel Money | `airtel_cg` | `04` = ex-Azur migré chez Airtel ? Plage encore attribuée ? Airtel Money actif sur `04` ? | | ☐ | |
| 2 | CD (RDC) | préfixes `90`, `91` | Africell Money | `africell_cd` | Plages exactes d'Africell RDC ; `91` toujours Africell ; wallet « Africell Money » lancé et accessible par API ? | | ☐ | |
| 3 | Cartes | BIN `979` | GIMAC (réseau CEMAC) | acquéreur `gimac_gateway` | Plage IIN officielle GIMAC (6 chiffres), acquéreur/switch de rattachement, longueur PAN, Luhn | | ☐ | |
| 4 | CF (Centrafrique, +236, 8 chiffres) | préfixes `72`, `75`, `77` | Orange Money | `orange_cf` (aucun provider — `planned`) | Plages Orange Centrafrique ; API Orange Money disponible pour CF ? | | ☐ | |
| 5 | CF (Centrafrique) | préfixes `70`, `71`, `78` | Telecel Money | `telecel_cf` (aucun provider — `planned`) | Plages Telecel ; existence et accès API du wallet Telecel Money | | ☐ | |
| 6 | GA (Gabon, +241, **8 chiffres avec le 0 initial — à vérifier**) | préfixe `07` | Airtel Money | `airtel_ga` (aucun provider — `planned`) | Format international réel (`+241 07…` vs `+241 7…`), plages Airtel ; Airtel Money API Gabon | | ☐ | |
| 7 | GA (Gabon) | préfixe `06` | Moov Money (Moov Africa Gabon Telecom) | `moov_ga` (aucun provider — `planned`) | Plages Moov / ex-Libertis ; API Moov Money | | ☐ | |
| 8 | GQ (Guinée équatoriale, +240, 9 chiffres) | préfixes `222`, `223` | GETESA (Orange) | `getesa_gq` (aucun provider — `planned`) | Plages GETESA ; wallet mobile money opérationnel et accessible par API ? | | ☐ | |
| 9 | GQ (Guinée équatoriale) | préfixe `55` | Muni (Hits Telecom) | `muni_gq` (aucun provider — `planned`) | Plages Muni (551–55x) ; existence d'un service de monnaie mobile | | ☐ | |
| 10 | TD (Tchad, +235, 8 chiffres) | préfixes `62`, `63`, `65`, `69` | Airtel Money | `airtel_td` (aucun provider — `planned`) | Plages Airtel Tchad ; Airtel Money API Tchad | | ☐ | |
| 11 | TD (Tchad) | préfixes `66`, `90`–`93`, `95`, `99` | Moov Money (Moov Africa Tchad, ex-Tigo) | `moov_td` (aucun provider — `planned`) | Plages Moov / ex-Tigo (`66` encore attribué ?) ; API Moov Money | | ☐ | |

Lignes 4 à 11 (vague 6, lot 2) : ces pays sont **détectés** (pays, devise XAF, opérateur) mais aucun provider n'existe :
le registre de capacités (`backend/src/services/capabilities/registry.js`) les expose `planned`, l'API refuse toute
opération (`403 CAPABILITY_NOT_ACTIVE`) et l'inscription marchande y est fermée (`422 COUNTRY_NOT_OPEN`) tant qu'aucun
encaissement n'est `active` ou `pilot`. Après confirmation des plages, implémenter le provider (`mobilemoney.router.PROVIDERS`),
puis la configuration (`<GATEWAY>_API_KEY` ou `api_configurations`) rend le statut `active` sans autre modification.

Une fois confirmée, passer l'entrée à `verified:true` dans `detection.engine.js` (ou corriger les
préfixes) et ajouter le cas dans `backend/src/tests/wave2-detection.test.js`.

## 2. Par opérateur : ce qui doit être fourni / configuré

Colonnes à remplir ; « config » = `api_configurations` (clé de gateway, chiffrée via `PUT /admin/api-configs/:key`)
ou variable d'environnement (`<KEY>_…`).

| Opérateur (gateway) | Pays | URL de webhook à déclarer chez l'opérateur | Authentification du callback | Endpoint de statut (`statusPath` / API) | Identifiants sandbox | Compte de règlement (encaissements → C-Pay) | Contact | Statut |
|---|---|---|---|---|---|---|---|---|
| Orange Money (`orange_sn`, `orange_ci`, `orange_cm`, `orange_cg`, `orange_cd`) | SN CI CM CG CD | `https://api.c-pay.global/api/v1/webhooks/<WEBHOOK_PATH_SECRET>/orange` (`notif_url` ; l'ancien `/webhooks/orange` reste valide) | `notif_token` comparé au jeton stocké à l'initiation | **Aucun endpoint de statut branché** (Web Payment : `paymentstatus` nécessite `pay_token`, non conservé) → confirmer l'API de statut et le champ à stocker | `merchant_key`, `baseUrl` par pays | | | ☐ |
| Wave (`wave_sn`, `wave_ci`) | SN CI | `…/webhooks/<WEBHOOK_PATH_SECRET>/wave` (à saisir dans Wave Business, récupérer le secret) | HMAC `Wave-Signature` (`WAVE_WEBHOOK_SECRET` ou `extra_params.webhookSecret`) | `GET /v1/checkout/sessions/{id}` (encaissements, branché) ; statut des **versements B2C** à confirmer | clé API `wave_sn_…` | | | ☐ |
| Africell Money (`africell_cd`) | CD | `…/webhooks/<WEBHOOK_PATH_SECRET>/africell` (ou `/africell/{txnId}`) | jeton `X-Webhook-Token` (`AFRICELL_WEBHOOK_TOKEN` / `extra_params.webhookToken`) | `extra_params.statusPath` (ex. `/v1/payment/status/{ref}`) — **à obtenir** | `apiKey`, `apiSecret`, `merchantId`, `baseUrl` | | | ☐ |
| Express Union Mobile (`express_union_cm`) | CM | `…/webhooks/<WEBHOOK_PATH_SECRET>/express_union` | jeton `X-Webhook-Token` (`EXPRESS_UNION_WEBHOOK_TOKEN`) | `extra_params.statusPath` — **à obtenir** | `apiKey`, `baseUrl` | | | ☐ |
| Free Money (`free_money_sn`) | SN | `…/webhooks/<WEBHOOK_PATH_SECRET>/free_money` | jeton `X-Webhook-Token` (`FREE_MONEY_WEBHOOK_TOKEN`) | `extra_params.statusPath` — **à obtenir** | `apiKey`, `apiSecret`, `merchantId`, `baseUrl` | | | ☐ |
| Moov Money (`moov_ci`, `moov_cm`) | CI CM | `…/webhooks/<WEBHOOK_PATH_SECRET>/moov` | jeton `X-Webhook-Token` (`MOOV_WEBHOOK_TOKEN`) | `extra_params.statusPath` — **à obtenir** | `apiKey`, `apiSecret`, `partnerId`, `baseUrl` | | | ☐ |
| MTN MoMo (`mtn_cm`, `mtn_ci`, `mtn_cg`) | CM CI CG | `…/webhooks/mtn` (jeton optionnel `MTN_WEBHOOK_TOKEN`) | re-interrogation systématique du statut MTN | `requesttopay/{ref}` / `transfer/{ref}` (branché) | `subscriptionKey`, `apiKey`, `apiSecret` (collection + disbursement) ; bascule sandbox→production par `MTN_ENV=production` (unique, voir `docs/GO-LIVE-CG.md`) | | | ☐ |
| Airtel Money (`airtel_cd`, `airtel_cg`) | CD CG | `…/webhooks/airtel` | `AIRTEL_WEBHOOK_SECRET` obligatoire | `queryTransaction` / `queryDisbursement` (branché) | `AIRTEL_CG_*` (collection + disbursement) | | | ☐ |

Pour chaque opérateur, demander aussi : la liste d'IP sources des callbacks (pour un filtrage nginx),
le format exact du corps de callback (un exemple réel), le délai maximal de confirmation d'un push, la
politique de rejeu des callbacks, et le processus de réconciliation / de réclamation (fichier journalier ?).

## 3. Après confirmation

1. Renseigner la config (`PUT /api/v1/admin/api-configs/<gateway>` : `baseUrl`, `apiKey`, `apiSecret`,
   `extra_params.{webhookSecret|webhookToken|statusPath|merchantId|partnerId}`).
2. Déclarer l'URL de webhook chez l'opérateur, puis tester un encaissement sandbox de bout en bout
   (push → callback → `transactions.status='authorized'` → règlement).
3. Vérifier que `POST /api/v1/admin/reconcile` (ou `node scripts/reconcile-pending.js --json`) finalise
   bien une transaction laissée `pending` (callback coupé volontairement).
