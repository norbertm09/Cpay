# Audit backend C-Pay — `backend/` (branche `develop`, commit `e8a536e`)

Date : 2026-11-02 · Périmètre : Node.js/Express `backend/src` · Méthode : lecture du code (grep + lecture ciblée), vérification de chaque hypothèse dans le code, exécution de deux suites de tests (`wave6-integrity`, `durable-idempotency` : 45/45 OK).
Hors périmètre (déjà connus, non repris) : TLS PostgreSQL non vérifié, clés MTN en cours, Airtel prod en attente, supervision, protection des branches, rotation des secrets.

Sévérités : **P0** bloquant pilote · **P1** avant ouverture aux marchands · **P2** dette.

Synthèse : **3 P0 · 5 P1 · 5 P2** (13 constats). Les chemins « vague 4/6 » (caisse, finalize, settlement, idempotence) sont solides ; les risques résiduels se concentrent dans les **routes historiques encore montées** (`/merchant/collect`, `/merchant/disburse`, `/momo/*`) et dans la **réconciliation MTN/Airtel** qui dépend d'une fonction SQL absente.

---

## 1. Constats

### P0-1 — `/merchant/disburse` : un décaissement incertain est marqué `failed` → fonds libérés alors que l'opérateur a pu payer (double dépense)

**Preuve** — `src/routes/merchant.routes.js`
- Airtel, minuterie 30 s : l.102 `const msg = s.failed ? … : 'Timeout: aucune confirmation Airtel/MTN sous 30s'; UPDATE transactions SET status='failed', … fee_amount=0, net_amount=0 … AND status='pending'` — un statut Airtel `TIP` (en cours) à T+30 s devient `failed`.
- l.108 (`catch`) : si la consultation Airtel échoue (réseau), `UPDATE … status='failed' … 'check operateur indisponible'`.
- MTN : l.1788 `const d = await mtn.transfer(...)` puis l.1846 `catch … UPDATE transactions SET status='failed'` — un timeout HTTPS après acceptation par MTN marque l'ordre `failed`.

**Impact** — Le solde disponible (`computeAvailableBalance`, `cash.service.js` l.220-226) ne compte un payout que s'il est `authorized|pending`. Dès que la ligne passe `failed`, le marchand peut re-décaisser le même montant alors qu'Airtel/MTN a exécuté le premier virement. C'est exactement le scénario que la vague 6 a corrigé dans `cash.service.createPayout` (statut `unknown`, réservation conservée) — mais pas sur cette route, toujours montée et utilisée par les apps 2.7.0 (`docs/WAVE-4-BACKEND.md` §5). Les minuteries `setTimeout` sont en mémoire (perdues au redémarrage).

**Correction** — Faire de `/merchant/disburse` un simple adaptateur vers `cash.createPayout` (ou l'orchestrateur `type:'payout'`, qui applique déjà `classifyRailError` → `pending_unknown`). À défaut : ne jamais écrire `failed` sans statut opérateur explicite `TF/TE/FAILED` ; remplacer les deux branches « timeout » par `response_message='pending_unknown'` et supprimer les `setTimeout` au profit de `reconcile.service`.

---

### P0-2 — Fonction SQL `calc_fee()` référencée 10 fois mais définie dans aucune migration → la réconciliation MTN/Airtel des encaissements marchands échoue silencieusement

**Preuve**
- `grep -rnw calc_fee database/` : aucune définition (seule `cpay_calculate_fee` existe, `database/010_audit_financial_integrity.sql` l.24). La seule définition est un stub de test : `src/tests/lot4-cash-recovery.test.js` l.42.
- Usages : `src/services/reconcile.service.js` l.238 (`markCollectOk`) et l.253 (`markPayoutOk`) ; `src/routes/merchant.routes.js` l.130, 147, 1640, 1690, 1862, 1898 (statut/polling MTN & Airtel).
- `reconcileOne` (l.226-229) avale l'exception : `logger.warn('Reconcile erreur txn (left pending)')`.
- Le webhook MTN ne traite **que** `card_transactions` (`webhook-handlers.js` l.242 `findCardTxnByReference`) : pour une transaction marchand MTN créée par l'orchestrateur ou la caisse, la finalisation après la fenêtre de polling synchrone (30 s, `mtn.provider.pollStatus`) repose **uniquement** sur `reconcile.service.markCollectOk`.

**Impact** — Si `calc_fee` n'existe pas en production (le schéma versionné ne la crée pas ; déjà signalé dans `docs/audit-prod-2.6.0` et `docs/WAVE-4-BACKEND.md` §5, toujours non corrigé), tout encaissement MTN confirmé par le client après 30 s reste `pending` indéfiniment : client débité, marchand jamais crédité, pay-link jamais `paid`. Même effet pour les décaissements MTN/Airtel (`markPayoutOk`) : fonds réservés à vie.

**Correction** — (1) Vérifier immédiatement en prod : `SELECT 1 FROM pg_proc WHERE proname='calc_fee'`. (2) Remplacer les 10 appels par `cpay_calculate_fee(merchant_id, type::text, detected_operator, amount, payment_method::text)` ou ajouter une migration `calc_fee` = wrapper de `cpay_calculate_fee`. (3) Faire passer `markCollectOk/markPayoutOk` par `finalize.service.finalizeTransaction` (une seule machine d'état, règlement enfilé dans la même transaction).

---

### P0-3 — Webhook MTN : n'applique rien aux `transactions` marchandes, et accepte les appels sans authentification si `MTN_WEBHOOK_TOKEN` est absent

**Preuve** — `src/routes/webhook-handlers.js`
- l.228-229 : `const token = process.env.MTN_WEBHOOK_TOKEN; if (token) { … }` — sans variable, aucun contrôle (contrairement à Airtel l.345-351, Wave, CyberSource, MIGS qui sont fail-closed). `MTN_WEBHOOK_TOKEN` n'est pas dans `requiredInProduction` (`config/env.js`).
- l.242 : `findCardTxnByReference(referenceId)` → si absent, `200 unknown_reference`. La table `transactions` (orchestrateur, caisse, `/merchant/collect`) n'est jamais consultée, alors que `X-Callback-Url` est bien envoyé à MTN (`mtn-momo.client.js` l.133) et que `mtn.provider.collectPayment` utilise `txnId` comme `X-Reference-Id`.

**Impact** — Le callback MTN, seul signal temps réel après le polling de 30 s, est perdu pour 100 % des encaissements marchands du pilote (voir P0-2). Sans jeton, n'importe qui peut déclencher des re-interrogations MTN et remplir `pci_audit_logs` avec `details: body` (l.240) — pas de faux crédit possible grâce au requery, mais amplification et bruit.

**Correction** — Dans `handleMtnWebhook`, après `findCardTxnByReference`, chercher `transactions WHERE gateway_payment_id=$1 AND status='pending'` et finaliser via `finalize.service` après re-interrogation MTN (même logique que `webhooks-mm.routes.js` l.333-366). Rendre `MTN_WEBHOOK_TOKEN` obligatoire en production (ou accepter uniquement via l'URL `WEBHOOK_PATH_SECRET`).

---

### P1-1 — Réponses HTTP 5xx / illisibles des providers MM classées « refus explicite » → fonds libérés

**Preuve**
- `src/services/mobilemoney/providers/mtn.provider.js` l.105 : `return { success: false, responseCode: String(result.statusCode) }` — un 500/502/503 devient `responseCode:'503'`.
- `src/services/mobilemoney/providers/airtel.provider.js` l.118 : corps non-JSON → `body: {}` ; l.93 : `failed = !success && (!apiOk || …)` → `errorMessage: 'Airtel payout failed'`.
- `src/services/cash/cash.service.js` l.126-135 `classifyRailResult` : `UNKNOWN_RESPONSE_CODES = {'96','91','68'}` ; un code `'503'` non vide avec `retryable:false` (posé par `mobilemoney.router.normalize` l.199) tombe sur `return 'declined'` (l.135). `classifyRailError` (l.122) ne protège que les **exceptions**, pas les résultats normalisés.

**Impact** — Pour un retrait caisse via `mm_router` (Airtel CG, MTN hors Congo, ou MTN CG si les variables `MTN_CG_DISB_*` manquent) : une page d'erreur 502 d'un reverse-proxy opérateur **après** exécution → `transitionTransfer(… to:'failed')` → solde re-crédité → second retrait possible. Même chemin dans l'orchestrateur `type:'payout'` (`orchestrator.js` l.274-287).

**Correction** — Dans `classifyRailResult`, traiter tout `responseCode` numérique ≥ 500 (et `'TIMEOUT'`) comme `unknown` ; dans les providers, renvoyer `{ success:false, pending:true, reason:'HTTP_5xx' }` ou lever une erreur avec `statusCode` pour `statusCode ≥ 500` et pour un corps non-JSON.

---

### P1-2 — Webhook Airtel (branche `transactions`) contourne `finalize.service` : pas de frais/net, pas de règlement, pas de pay-link, pas de re-interrogation

**Preuve** — `src/routes/webhook-handlers.js` l.407-446 : `UPDATE transactions SET status=$1, auth_code=…, response_code=…, response_message=$3, completed_at=… WHERE transaction_id=$4 AND status='pending'`. Aucune colonne `fee_amount/net_amount`, aucun `settlementQueue.enqueue`, aucun `UPDATE pay_links`, aucun `queryTransaction` Airtel (le callback signé est cru sur parole, contrairement à MTN).
- Les lignes créées par `/merchant/collect` l.1527-1537 portent `fee_amount=0, net_amount=0` (`const fee = 0; const net = 0;`). Elles ne sont pas `NULL`, donc `COALESCE(fee_amount, …)` ne les recalculera jamais.

**Impact** — Un encaissement Airtel initié par l'app marchande et confirmé par webhook est `authorized` avec `net_amount=0` : le solde (`SUM(net_amount)`) et le règlement J+1 (`settlement.engine` exige `net_amount IS NOT NULL`, 0 passe) créditent **0** au marchand ; la réparation `sweepAuthorizedWithoutQueue` enfile un règlement à 0 ; les pay-links Airtel restent `pending`.

**Correction** — Remplacer le bloc par `finalizeTransaction({ txn: main, provider:'airtel', outcome, authCode: airtelRef, … })` après `airtel.queryTransaction` ; insérer `fee_amount/net_amount` à `NULL` (pas 0) dans `/merchant/collect`, ou calculer via `cpay_calculate_fee` à l'insertion comme l'orchestrateur (`orchestrator.js` l.500-504).

---

### P1-3 — `/api/v1/momo/*` (cartes virtuelles) : appel MTN **dans** la transaction SQL, montants non typés, endpoints MTN bruts exposés à tout porteur

**Preuve** — `src/routes/mtn-momo.routes.js`
- l.140-221 (`/payout`) : `withTransaction(async client => { … UPDATE virtual_cards SET balance=… ; INSERT card_transactions … ; const mtnResult = await mtn.transfer(...) ; … })`. Un échec réseau après acceptation MTN → `ROLLBACK` → débit carte annulé et ligne `pending` supprimée : l'argent part chez MTN sans aucune trace en base. La connexion pool et le verrou `FOR UPDATE` sont tenus pendant l'I/O réseau (30 s).
- l.132/160 : `amount` non converti (`if (!amount || amount < 500)` puis `const total = amount + fee`) — avec `"1000"` en chaîne, `total` vaut `"100015"`.
- l.329-338 `/requesttopay` : tout porteur ou marchand peut envoyer un `requestToPay` MTN vers n'importe quel numéro, montant et `externalId`, sans ligne en base ni idempotence.
- l.310-325 `/accountbalance` : renvoie le **solde du compte Collections de la plateforme** à tout porteur authentifié.
- l.232-261 `/status/:referenceId` : aucune vérification de propriété de la `card_transaction` trouvée.

**Impact** — Perte financière non tracée (payout), spam USSD vers des tiers au nom de C-Pay, fuite d'information financière de la plateforme.

**Correction** — Calquer `/momo/payout` sur `cash.createPayout` (réservation + ligne `pending` commitée, appel MTN hors transaction, `unknown` si incertain). Supprimer `/requesttopay` et `/accountbalance` (ou `requireType('admin')`). Valider `amount` avec `Number()`/entier. Filtrer `/status` par `cardholder_id`.

---

### P1-4 — Routes historiques `/merchant/collect` et `/merchant/disburse` : second moteur de paiement sans les contrôles de l'orchestrateur

**Preuve** — `src/routes/merchant.routes.js` l.1501-1613 et l.1738-1852 : devise codée `'XAF'`, aucun contrôle `merchant_status`, aucun plafond KYB (`checkMerchantLimits`), aucun moteur antifraude, config Airtel lue dans l'env uniquement (`AIRTEL_CG_*`) alors que le routeur MM lit `api_configurations` chiffrées, polling par `setTimeout` en mémoire (l.68-160). `/merchant/collect` l.1607 : toute exception → `status='failed'` ; or `reconcilePending` ne balaie que `status='pending'` → un client qui confirme ensuite est débité sans crédit marchand ni réconciliation. Frais en dur `FEE_RATES`/`getFeeRate` défaut 4 % (l.14-15, l.57-66) incohérents avec `cpay_calculate_fee` (1–2,5 %) et `cash.FEE_RATES` (1,5 %).

**Impact** — Trois barèmes de frais, deux machines d'état, une surface de bugs doublée pour les mêmes fonds ; les protections WAVE-6 (fraude dégradée, `pending_unknown`, capacités) sont contournables par les apps qui utilisent encore ces routes (la garde `legacyCapabilityGuard` ne couvre que pays/méthode).

**Correction** — Transformer ces deux handlers en délégations : `/merchant/collect` → `orchestrator.processTransaction({type:'collect', …})` (comme `cash.routes.js` l.147-151) ; `/merchant/disburse` → `cash.createPayout`. Supprimer `scheduleAirtel*Polling`, `computeFees`, `getFeeRate`, `OPERATOR_LIMITS`.

---

### P1-5 — Deux chemins admin concurrents pour le même `merchant_transfers`, dont un sans journal ni garde-fous ; `/admin/settlement/run` annonce un règlement qui n'a pas lieu

**Preuve** — `src/routes/admin.routes.js`
- l.897-943 `/settlements/:transferId/complete` et l.945-963 `/reject` : `UPDATE merchant_transfers SET status='completed'…` / `status='failed'` directs, sans `cash.transitionTransfer` (pas d'événement JSONB, pas de `needs_review` reset, pas d'`audit_logs`), alors que `/admin/cash/transfers/:id/mark-executed|reject` (`cash-admin.routes.js` l.292-327) est le chemin WAVE-4 audité.
- l.1389-1396 `/settlement/run` : appelle `runAutoSettlement()` (désactivé, renvoie `{disabled:true}`) puis répond `{ success:true, message:'Règlement J+1 exécuté manuellement' }`.

**Impact** — Traçabilité financière incomplète (un ops peut clôturer un virement sans trace dans `events`/`audit_logs`), faux positif opérationnel sur le règlement J+1 (le vrai point d'entrée est `POST /internal/settlement/run`, `server.js` l.479).

**Correction** — Supprimer ou rediriger les routes legacy vers `cash.transitionTransfer` ; faire pointer `/admin/settlement/run` vers `settlement.engine.runSettlement` (ou 410).

---

### P2-1 — Fuite de détails internes et journalisation hors standard

**Preuve** — 234 occurrences de `res.status(500).json({ error: err.message })` dans `src/routes` et `src/server.js` (ex. `server.js` l.271, 286 ; `merchant.routes.js` l.1089-1097 `/balance`). `console.*` dans 14 fichiers (`merchant.routes.js` : 21 appels) → logs hors Winston/JSON, sans `requestId`. `airtel.provider.js` l.53, 88, 133, 153 : `logger.info('AIRTEL RAW …', { rawBody })` (msisdn, références). `request-context.js` l.21 journalise `req.originalUrl` → le segment `WEBHOOK_PATH_SECRET` apparaît en clair dans chaque ligne de log de webhook.

**Impact** — Messages PostgreSQL/opérateurs exposés aux clients ; secret d'URL dans les logs (rotation prévue, mais il faut aussi masquer) ; données personnelles au niveau `info`.

**Correction** — Généraliser `asyncHandler` + `ApiError` + `errorHandler` (déjà en place : `middleware/errors.js`) et remplacer les `catch → err.message` par `next(err)` ; `console.*` → `logger` ; `AIRTEL RAW` → `debug` ; masquer `/api/v1/webhooks/<secret>/` dans `requestContext`.

---

### P2-2 — Rate limiting global appliqué aux callbacks opérateurs ; formulaires publics peu protégés

**Preuve** — `src/server.js` l.83 : `app.use('/api/', rateLimit({ windowMs: 15 min, max: 300 }))` couvre `/api/v1/webhooks/*`, `/api/v1/momo/webhooks/*`, `/api/v1/webhooks/<secret>/:provider`. Les opérateurs émettent depuis une poignée d'IP : au-delà de 300 callbacks / 15 min → 429 silencieux. Seul `/webhooks/*` (legacy, hors `/api`) échappe. `/api/v1/developer/register|upgrade` (l.251-287) : non authentifiés, uniquement ce limiteur global, insertion libre dans `admin_notifications`, `LIKE '%email%'` (l.258).

**Correction** — Exempter les chemins webhooks du limiteur global (`skip`) ou leur donner un limiteur dédié par IP ≥ 1 000/15 min ; limiteur strict (5/h/IP) + validation e-mail sur `/developer/*`.

---

### P2-3 — Robustesse processus : pas de gestionnaire `unhandledRejection`/`uncaughtException`, rollback masquant, état en mémoire

**Preuve** — `grep -rn unhandledRejection src/` : aucun résultat ; `server.js` ne pose que `SIGTERM/SIGINT`. `config/database.js` l.326-329 : `catch (err) { await client.query('ROLLBACK'); throw err; }` — si la connexion est tombée, le `ROLLBACK` lève et remplace l'erreur d'origine. Compteurs step-up (`cash.service.js` l.254), rate limiters et `_loggedOnce` sont par processus (documenté WAVE-4 §5).

**Correction** — Ajouter `process.on('unhandledRejection', …)` (log + métrique, arrêt propre si répétitif) ; entourer le `ROLLBACK` d'un `try/catch` qui conserve l'erreur initiale et `release(true)` ; prévoir un store partagé (PostgreSQL/Redis) avant tout déploiement multi-instance.

---

### P2-4 — Intégrations opérateurs : détails fragiles

**Preuve** — `airtel.provider.js` l.33 : `client_id=${config.apiKey}&client_secret=${config.apiSecret}` sans `encodeURIComponent` (un secret contenant `&`, `+`, `=` casse l'auth). `airtel.provider.js`/`mtn.provider.js` `httpRequest` : aucun `retry` ni distinction 4xx/5xx (voir P1-1), `statusCode` non propagé dans le résultat Airtel. `mtn-momo.client.js` l.147 `getCollectionStatus` renvoie `status: undefined` sur un 401/404 (token expiré, mauvais `X-Target-Environment`) → interprété « encore pending » partout, sans alerte. `tokenCache` MTN n'est pas invalidé sur 401.

**Correction** — Encoder le formulaire OAuth ; lever une erreur typée (`statusCode`) pour tout `statusCode ≥ 400` dans les `getStatus` ; invalider le cache de jeton sur 401 et re-tenter une fois.

---

### P2-5 — Routes monétaires sans test identifié

Recherche : `grep -rn` des chemins dans `src/tests/`. Aucun test trouvé pour :
- `POST /api/v1/payout` (`server.js` l.382) — seul `/api/v1/collect` est testé ;
- `POST /merchant/disburse` branche Airtel + `scheduleAirtelDisbPolling`, `GET /merchant/disburse/:txnId/status` ;
- `POST /api/v1/momo/topup`, `/momo/payout`, `GET /momo/status/:ref`, `/momo/requesttopay`, `/momo/accountbalance` ;
- `POST /admin/settlements/:transferId/complete|reject`, `POST /admin/settlement/run` ;
- `reconcile.service.markCollectOk/markPayoutOk` (branche MTN/Airtel ; `wave3-reconcile-admin.test.js` ne couvre que les providers vague 2 via `finalizeTransaction`) ;
- branche `transactions` marchandes de `handleAirtelWebhook` (les tests `hotfix-webhooks` l.243-309 portent sur `card_transactions`).
Les tests existants (`wave4-cash`, `wave6-integrity`, `durable-idempotency`, `settlement-recovery-atomic`) couvrent bien la caisse et le règlement.

**Correction** — Ajouter des tests PGlite sur ces routes (en priorité P0-1/P1-1 : « timeout opérateur ne libère jamais les fonds »), et un test de migration qui échoue si une fonction SQL référencée par le code (`calc_fee`) n'existe pas après `migrate`.

---

## 2. Points positifs vérifiés

1. **Authentification unifiée robuste** (`src/middleware/auth.js`) : un seul point `jwt.verify` avec `iss/aud`, access 15 min, refresh **opaque** stocké en SHA-256, rotation atomique (`UPDATE … RETURNING`, l.328-333) avec détection de réutilisation → `revokeAll` (l.342-349), cookies `HttpOnly/Secure/SameSite=Strict` host-only à path restreint, verrouillage après 5 échecs sur les quatre portails (merchant l.322-327, admin l.94-99, cardholder, partners), 2FA TOTP avec jeton MFA typé.
2. **Aucune injection SQL trouvée** : toutes les requêtes sont paramétrées ; les fragments dynamiques sont issus de listes blanches (`DATE_TRUNC('${trunc}')` avec `trunc ∈ {day,week,month}` `partners.routes.js` l.528 ; `PATCHABLE` `cash-admin.routes.js` l.356 ; `RESET_TARGETS` `admin.routes.js` ; `DIRECTION_SQL`).
3. **Webhooks fail-closed et idempotents** : HMAC en temps constant pour Wave (horodaté), Airtel (multi-secrets), CyberSource, MIGS, Stripe (tolérance 300 s), jeton PaymentHub ; corps brut signé conservé (`express.json verify`) ; contrôle montant/devise systématique ; claim atomique `WHERE status='pending'` ; provider injoignable → 202 sans changement d'état ; `webhook_events` journalise chaque appel.
4. **Intégrité financière du cœur WAVE-4/6** : `finalize.service` applique statut + `settlement_queue` + `pay_links` + événement dans **une** transaction SQL ; `settlement.engine` sous `pg_try_advisory_lock`, `FOR UPDATE SKIP LOCKED`, verrou par marchand partagé avec les retraits, net plafonné au solde disponible (`cash_offset_amount`), arrondi par devise ; `cash.createPayout` réserve les fonds sous verrou **avant** l'appel rail (hors transaction), statut `unknown` conservant la réservation, revue ops avec bail anti-doublon ; index unique partiel `idx_pay_link_one_active_attempt` contre le double paiement d'un lien.
5. **Idempotence durable et hygiène des secrets** : `middleware/idempotency.js` rend la clé obligatoire sur les endpoints monétaires, conserve la clé après 5xx avec référence à la ressource créée (`attachResource`) et rejoue l'ordre d'origine ; secrets opérateurs chiffrés AES-256-GCM (`config/secrets.js`, fail-closed en prod) ; clés API marchands hashées SHA-256 + secret ; URL de webhook marchand validée anti-SSRF avec résolution DNS et `redirect:'manual'` ; `/metrics` fail-closed par jeton ; `validateEnv` bloque le démarrage prod si les variables critiques manquent ; suites de tests exécutées vertes (45/45).

## 3. Maturité globale : **C** (pilote fermé possible après correction des 3 P0 ; ouverture marchands après les P1)

Justification : le code récent (caisse, finalize, settlement, idempotence, auth) est de niveau B — conception explicite des cas incertains, verrous, tests ciblés. Mais le dépôt garde **deux générations de code montées en parallèle** : les routes historiques (`/merchant/collect|disburse`, `/momo/*`, `/admin/settlements/*`) appliquent encore les comportements que les vagues 1→6 ont précisément bannis (échec sur timeout, appel réseau en transaction, frais à 0), et la réconciliation MTN/Airtel — unique filet pour les encaissements du pilote Congo — repose sur une fonction SQL non versionnée et un webhook MTN qui ignore les transactions marchandes. Tant que ces chemins ne sont pas supprimés ou redirigés vers la machine d'état unique, la garantie « jamais de double dépense, jamais de client débité sans crédit » n'est pas tenue de bout en bout.
