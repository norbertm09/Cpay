# Audit production 2.6.0 — couche services, flux d'argent, rails

Snapshot OVH `/opt/cplus` (branche `ovh-prod-clean`), chemins relatifs à `backend/`.

## 1. Cartographie et doublons

- **Deux pipelines de paiement parallèles** : l'orchestrateur (`/api/v1/collect|payout`, `orchestrator.js`, 444 l.) avec détection, pilot, fraude, routeur MM ; et `merchant.routes.js:1407` (`/merchant/collect`) / `:1643` (`/merchant/disburse`) qui appellent `rails/mtn-momo.client` et `airtel.provider` **en direct**, sans détection, sans fraude, sans routeur. L'app Android native utilise le second.
- **Doublons** : `psp/` (cybersource, migs, stripe) réimplémente `gateways/` avec d'autres variables d'env, sans timeout ni retry, signature CyberSource différente (`(request-target)` vs `request-target` : l'une des deux est non conforme) ; `rails/mtn-momo.client.js` doublonne `providers/mtn.provider.js` ; `email.service.js` racine vs `notifications/email.service.js` ; `settlement.service.js.bak`, `rails/*.rest.bak` (760 l.) laissés en prod ; `notifications/otp.service.js` sans aucun appelant (et journalise l'OTP en clair l.25) ; `card.router.refund/voidTransaction` jamais appelés.
- **Trois moteurs de règlement** avec marqueurs indépendants : `settlement.service.js` (temps réel, `transactions.settlement_status`), `settlement/settlement.engine.js` (queue nocturne, `settlement_queue.settled`), `settlement/auto-settlement.js` (batch J-1 **simulé**, `settlement_batch_id`). **Quatre barèmes de frais** différents (1,5/2,5 % ; `commission_rate ?? 0.02` ; 4/1/0,5 % ; 4 %).
- Stubs : `gimac.gateway.js:7` et `interswitch.gateway.js:7` lèvent une erreur → GIMAC/Verve = refus puis failover.
- Seul job planifié du backend : `setInterval` de réconciliation 120 s (`server.js:772`). **Aucun cron de règlement** malgré les commentaires « 23h » / « 00:30 ».

## 2. Flux d'argent — points de rupture vérifiés

### Schéma
Colonnes `settlement_status`, `settlement_ref`, `settled_at`, `settlement_instant`, `provider_raw_response`, `terminal_id`, `reference`, fonction `calc_fee()` : **utilisées partout mais absentes des migrations versionnées 001–006**. Si `calc_fee` manque, l'UPDATE de confirmation lève et est avalé (`merchant.routes.js:1551`) → paiement encaissé, transaction restant `pending`.

### Encaissement
- **Airtel marqué réussi sans confirmation** : `airtel.provider.js:55-57` renvoie `success:true` dès l'acceptation du push (statut TIP) → `authorized` + règlement enfilé **avant la saisie du PIN client**.
- **MTN : timeout = échec** : poll 30 s puis `{success:false, reason:'TIMEOUT'}` (`mtn.provider.js:81-103`) → `failed` alors que le client peut encore valider → **client débité, transaction `failed`**, et la réconciliation ne la rattrape pas : `reconcile.service.js:106` filtre `detected_operator IN ('mtn','airtel')` alors que l'orchestrateur écrit `MTN_MOMO`/`AIRTEL_MONEY`.
- **Vodacom** : `INS-0` à l'initiate pris pour un débit confirmé (`vodacom.provider.js:40`), sans pending ni callback.
- **Orange/Wave/Africell/Express Union/Free Money : `pending` sans retour possible** — les URLs de callback annoncées pointent vers des routes **qui n'existent pas** (seuls `/webhooks/mtn|airtel|cybersource|migs` et `paymenthub` existent). Transactions `pending` à vie.
- Retries sans idempotence : CyberSource rejoue `POST /pts/v2/payments` jusqu'à 2 fois sur 5xx (`cybersource.gateway.js:87-121`) ; MIGS idem avec le même `vpc_MerchTxnRef` → double autorisation possible.

### Retrait
- `orchestrator.js:154-156` appelle bien `sendPayout` pour le Mobile Money ✔. **Mais la branche carte ignore `type`** : un `POST /api/v1/payout` avec `emvPayload` **débite la carte du client** (`card.router.js:65-117` → `authorizeCard`).
- MTN payout : un seul poll après 5 s (`mtn.provider.js:105-113`) → `PENDING` ⇒ `failed` côté C-Pay alors que le transfert aboutit ensuite → **argent envoyé, transaction `failed`, re-tentative = double paiement**.
- Orange payout : `success = statusCode === 200` quel que soit le corps (`orange.provider.js:48`).
- PaymentHub webhook (`server.js:676-717`) : UPDATE **sans garde `status='pending'`** ni contrôle de montant → un callback rejoué bascule une transaction `authorized` en `failed`.
- **Les retraits sont reversés au marchand** : l'orchestrateur enfile dans `settlement_queue` quel que soit `type` (`orchestrator.js:196-198`) et `auto-settlement.js:20` ne filtre pas le type → les montants décaissés sont additionnés dans le net reversé.

### Transferts (`transfer.service.js`, carte GTP ⇄ wallet)
- Exécution détachée après réponse HTTP ; timeout `waitMomo` 90 s ⇒ `failed` alors que le client peut confirmer → **wallet débité, carte non créditée** ; échec de `cardToBank` après `topUp` réussi → fonds bloqués sans compensation ; `from_bank` : si `mtn.transfer` lève, étape `failed` **mais transfert `completed`** (l.191-205) → carte déchargée, wallet non crédité.
- `gtp-card.service.js:226-232,289-293` : trace DB en `.catch(() => {})` → mouvement GTP sans trace locale.

### card2momo (`psp.router`)
Débit carte puis `mtn.transfer` ; remboursement seulement si la 2ᵉ jambe **lève**. Si MTN échoue ensuite (PENDING → FAILED), **carte débitée, MoMo non crédité, pas de remboursement**.

## 3. Détection (`detection.engine.js`)
Mêmes défauts que la version GitHub (jamais corrigés en prod) : clé `+225` dupliquée ; SN Free/Wave même pattern ; CI `\d{7,9}` accepte 9 à 11 chiffres, Moov inatteignable ; **CM et CG exigent 8 chiffres (réels : 9) → tout part chez MTN** ; CD chevauchements ; `normalizePhone` rejette les numéros locaux attendus par `merchant.routes` ; Mastercard 2221–2720 non couvert ; AID `A000000333` (UnionPay) → GIMAC, `A000000065` (JCB) → Verve, RID Verve réel absent.

## 4. Sécurité
- **Secrets providers en clair** en base (`api_configurations`, commentaire « chiffrés en prod » sans implémentation), cachés 5 min en mémoire avec `...extra_params` pouvant écraser `apiKey` (`mobilemoney.router.js:53-66`). PIN de décaissement Airtel envoyé en clair si pas de clé RSA (`airtel.provider.js:70`).
- **Webhook MTN sans aucune authentification** (`webhook-handlers.js:10-66` + doublon `mtn-momo.routes.js:262`) : un POST forgé `{referenceId, status:'SUCCESSFUL'}` **crédite `virtual_cards.balance`** (l.30-34). Airtel/CyberSource/MIGS : HMAC vérifié seulement si secret **et** en-tête présents → omettre l'en-tête contourne. PaymentHub : jeton optionnel. Stripe et Wave : aucun endpoint.
- Webhooks sortants marchands : secret par défaut `'cplus-default-secret'`, `http://` accepté, `fetch` sans timeout ni filtrage d'IP privées (SSRF).
- **PAN/EMV** : MIGS reçoit le cryptogramme dans `vpc_CardNum` ; `psp/migs.client.js:94` admet un PAN brut dans `tokenId` reçu du body ; **Visa Direct** (`rails.routes.js:11-19`) passe `req.body` tel quel (`senderPrimaryAccountNumber`…) sous simple `merchantAuth` → tout marchand peut soumettre des PAN et déclencher un pull funds. `pan_fingerprint = SHA-256(pan)` non salé (inversible par énumération Luhn).
- **TLS désactivé** : `rails/mtn-momo.client.js:44` `rejectUnauthorized:false` sur tous les appels MTN (prod incluse), sans timeout ; `psp/*.client.js` idem sauf `*_SANDBOX=false` ; SMTP et PG SSL idem.
- **Défauts sandbox en prod** : `MTN_ENV || 'sandbox'`, `CS_HOST || 'apitest…'`, MPGS `mtf.`, Visa `sandbox.api.visa.com`, PaymentHub **`https://paymenthub.example.com`**. Une variable manquante ⇒ appels sandbox silencieux.
- Fraud engine inopérant : interroge `transactions.terminal_id` (colonne absente) → exception avalée ; `review` jamais traité ; non appliqué au pipeline `merchant.routes`.
- Logs : corps bruts Airtel (msisdn), OTP en clair ; CSV sans protection anti-formule ; emails HTML sans échappement.

## 5. Rails
- **Visa Direct** : client mTLS réel mais proxy sans intégration (aucune écriture en base, `stan/rrn` aléatoires non persistés, pays acquéreur 840 par défaut) → non exploitable.
- **Mastercard** : OAuth1 du portail développeurs (projects/credentials), **pas un rail de paiement** ; signature sans `oauth_body_hash` → POST rejetés.
- **GTP** (cartes) : client SOAP réel, opérations financières complètes, mais traces DB avalées, mémo en clair, PIN dans le XML, un seul endpoint sans sandbox.
- **MTN MoMo client** : hard-codé Congo/XAF, `externalId` suffixé aléatoirement → non idempotent, non corrélable.

## 6. Règlement
- J+1 non respecté : `runSettlement` appelé sans date règle J+0 à l'instant T, les items postérieurs ne sont jamais repris ; `auto-settlement` « simule » le virement (`completed` sans mouvement de fonds).
- Groupement par marchand **sans devise** (XOF et XAF additionnés) ; `toFixed(2)` sur XOF/XAF ; `ALTER TABLE` à chaque batch (verrou exclusif).
- Appel réseau de payout **dans** `withTransaction`, résultat **ignoré** → batch `submitted` même en échec ; COMMIT raté après payout réussi → rejeu = double paiement ; virement bancaire = no-op TODO marqué `submitted`.
- **Double règlement possible par trois voies** : trois moteurs concurrents ; `settleTransaction` sans claim atomique, déclenché par 5 timers + cron + endpoints de statut, `externalId` différent à chaque tentative ; `runSettlement` sans `FOR UPDATE SKIP LOCKED`.

## 7. Recommandations
**P0** : refuser payout carte (`orchestrator.js:167-178`) ; Airtel/Vodacom → `pending` jusqu'à confirmation ; MTN timeout → `pending` + réconciliation alignée sur `MTN_MOMO/AIRTEL_MONEY` ; authentifier le webhook MTN (re-interroger `GET requesttopay/{ref}`), HMAC obligatoire partout, `AND status='pending'` + contrôle montant/devise, créer les routes Wave (signature), Orange, Stripe, Africell… ; **un seul** moteur de règlement avec claim atomique, `SKIP LOCKED`, réseau hors transaction, résultat vérifié, exclusion des payouts ; compensation sur échec différé (card2momo, transferts) ; supprimer `rejectUnauthorized:false` ; interdire les PAN bruts sur Visa Direct ; corriger AID/préfixes.
**P1** : chiffrer les secrets providers ; supprimer les défauts sandbox/example.com (échec au démarrage) ; versionner `calc_fee` et les colonnes manquantes ; réparer le fraud engine ; idempotence des retries ; arrondis par devise et batches par (marchand, devise) ; saler `pan_fingerprint` ; retirer les logs sensibles ; cron de règlement J-1 avec verrou.
**P2** : supprimer doublons et code mort ; unifier les frais ; SSRF/timeout webhooks sortants ; échappement emails/CSV ; plage Mastercard 2-series.
