# Vague 6 — Lot 2 : registre de capacités CEMAC / RDC, contrôles serveur, interfaces réelles, TLS PostgreSQL

Base : `wave-6` (audit externe [`AUDIT-2026-10-17.md`](AUDIT-2026-10-17.md), P1 n°4 et P2 n°6 ; périmètre
[`LAUNCH-CEMAC-RDC.md`](LAUNCH-CEMAC-RDC.md)). Le lot 1 (états incertains, atomicité, bénéficiaires) est livré en
parallèle et ne partage aucun fichier avec ce lot : les routes financières (`cash.routes.js`, `merchant.routes.js`,
`orchestrator.js`, `cash.service.js`…) ne sont **pas modifiées** ici ; tout passe par des middlewares montés avant elles.

Trois suites ajoutées (`wave6-capabilities`, `wave6-capability-guard`, `wave6-detection-tls` : 72 tests) — `npm test`
(`node --experimental-vm-modules … jest --runInBand --forceExit`, requis par les suites pglite) : 28 suites / 651 tests verts ; tous les
fichiers touchés passent `node --check`, vitrine `scripts/check-landing.py` OK, portails marchand et admin construits
(`CI=false npm run build`). Aucune migration : le registre est calculé, pas persisté.

## 1. Registre de capacités — `backend/src/services/capabilities/registry.js`

Source de vérité serveur : **pays × devise × famille / opérateur × opération × statut**, où le statut est **calculé**,
jamais affirmé. Une cellule porte `status`, `implemented`, `configured`, `since` (version où le code existe), `note`
et `requires` (variables d'environnement, clés `api_configurations`, prérequis contractuels).

| Statut | Condition | Exposé au public |
|---|---|---|
| `active` | code d'intégration présent **et** configuration présente | « Disponible » |
| `pilot` | idem **et** `CAPABILITY_PILOT_<CC>=true` | « Pilote » |
| `planned` | dans le périmètre de lancement, aucun code | « En cours d'intégration » |
| `unavailable` | tout le reste : code sans configuration, retrait / transfert carte, hors périmètre | « En cours d'intégration » (vitrine) / « Non disponible » (admin) |

Règles de calcul (les mêmes que le code financier, lues sans le modifier) :

- **Encaissement Mobile Money** (par opérateur) : provider enregistré dans `mobilemoney.router.PROVIDERS` avec
  `collectPayment` **et** clé présente : env `<GATEWAY>_API_KEY` / `<GATEWAY>_CLIENT_ID` (`buildConfigFromEnv`) ou ligne
  `api_configurations` (`provider_type='mobile_money'`, `api_key` non vide).
- **Retrait Mobile Money** : MTN Congo via `MTN_CG_DISB_API_USER` + `MTN_CG_DISB_API_KEY` + `MTN_CG_DISB_SUB_KEY_PRIMARY`
  (`rails/mtn-momo.client`), sinon provider avec `sendPayout` + clé (`cash.service.payoutRail`) ; `interswitch_*` exclus.
- **Encaissement carte** : checkout hébergé configuré (`MIGS_MERCHANT_ID`+`MIGS_ACCESS_CODE`+`MIGS_SECURE_HASH` ou
  `MPGS_MERCHANT_ID`+`MPGS_API_PASSWORD`, `card-link.service.hostedGatewayConfigured`) **et** passerelle par défaut du pays
  (`country_payment_defaults.default_card_gateway`, ou `CARD_GATEWAY_<CC>` en secours).
- **Retrait / transfert carte** : `unavailable` partout (non pris en charge par l'orchestrateur — ne pas annoncer).
- **GIMAC / GIMACPAY** : aucun code → `planned` dans les six pays CEMAC, `unavailable` en RDC (hors CEMAC) et SN / CI ;
  `requires` = contrat de participation GIMAC, spécifications techniques, tests partenaires (encaissement, retrait,
  transfert, rapprochement), `GIMAC_MERCHANT_ID`, `GIMAC_AID_PREFIXES`.
- **Transfert wallet → banque** : `active` (file manuelle des opérations, `createPayout` dest `bank`).
- **Transfert banque → wallet** : compte de collecte C-Pay actif pour la devise (`platform_bank_accounts.active`), ou
  `CAPABILITY_FUNDING_<CUR>=true`.
- **SN / CI** (connecteurs historiques) : `legacy:true`, hors résumé public, **inscription refusée** ; les marchands
  existants restent servis (statut calculé normalement) sauf `CAPABILITY_LEGACY_ALLOW=false`.

API du module : `getCapabilities({ env, facts, providers })` (matrice complète), `isAllowed({ country, operation,
method|direction, operator })`, `assertAllowed(...)` → `CapabilityError` (`statusCode 403`, `code CAPABILITY_NOT_ACTIVE`,
`toJSON()` = `{ error, code, country, operation, method, status, operator?, message }`), `countryOpenForRegistration(cc)`,
`summary()` (forme publique), `loadFacts()` / `invalidateFacts()` (faits base en cache 60 s, tolérants à une base
indisponible : `country_payment_defaults`, `api_configurations`, `platform_bank_accounts`). `env`, `facts` et `providers`
sont injectables : le registre est synchrone et sans effet de bord.

### Matrice au démarrage (sans configuration)

| Pays | Devise | Encaisser MM | Encaisser carte | Retirer MM | Transfert W→B / B→W | GIMAC |
|---|---|---|---|---|---|---|
| CM Cameroun | XAF | MTN MoMo, Orange Money, Express Union : code présent → `active` dès la clé | code présent → `active` dès MIGS/MPGS + passerelle pays | MTN, Orange, Express Union : `active` dès la clé | `active` / selon compte de collecte XAF | `planned` |
| CF Centrafrique | XAF | Orange Money, Telecel Money : `planned` | idem CM | `planned` | idem | `planned` |
| CG Congo | XAF | MTN MoMo, Airtel Money (préfixe 04 à confirmer) : `active` dès la clé | idem CM | MTN via `MTN_CG_DISB_*` ou clé ; Airtel dès la clé | idem | `planned` |
| GA Gabon | XAF | Airtel Money, Moov Money : `planned` | idem CM | `planned` | idem | `planned` |
| GQ Guinée équatoriale | XAF | GETESA, Muni : `planned` | idem CM | `planned` | idem | `planned` |
| TD Tchad | XAF | Airtel Money, Moov Money : `planned` | idem CM | `planned` | idem | `planned` |
| CD RD Congo | CDF | M-Pesa, Airtel Money, Orange Money, Africell Money : `active` dès la clé | idem CM | idem (Interswitch exclu) | `active` / selon compte CDF | `unavailable` (hors CEMAC) |
| SN, CI (historiques) | XOF | calculé, `legacy:true` | calculé | calculé | calculé | `unavailable` |

Sans clé ni passerelle, tout est `unavailable` ou `planned` : **rien n'est présenté comme disponible par défaut.**

## 2. Contrôles serveur — `backend/src/middleware/capability.js`, `routes/capabilities.routes.js`, `server.js`

Montage dans `server.js` (lignes de montage uniquement, avant les routes concernées) :

```js
app.post('/api/v1/pay/:shortId/card', capability.payCardCapabilityGuard);
app.use('/api/v1/public/capabilities', wrapRouterAsync(capabilityRoutes.publicRouter));
app.use('/api/v1/admin/capabilities',  adminAuth, wrapRouterAsync(capabilityRoutes.adminRouter));
app.post('/api/v1/merchant/auth/register', capability.registerCapabilityGuard);
app.use('/api/v1/merchant/cash', merchantAuth, capability.capabilityGuard);
app.post(['/api/v1/merchant/collect', '/api/v1/merchant/disburse'], merchantAuth, capability.legacyCapabilityGuard);
app.post(['/api/v1/collect', '/api/v1/payout'], merchantAuth, capability.legacyCapabilityGuard);
```

| Garde | Routes | Mapping | Refus |
|---|---|---|---|
| `capabilityGuard` | `POST /merchant/cash/collect` (`body.method` mobile_money\|card, `body.operator`), `/withdraw` (mobile_money), `/transfers` (`body.direction`) | pays du marchand (`SELECT country FROM merchants`, 1 requête mise en cache sur `req`) → `isAllowed` | `403 { error, code:'CAPABILITY_NOT_ACTIVE', country, operation, method, status, operator?, message }` |
| `legacyCapabilityGuard` | `POST /merchant/collect`, `/merchant/disburse`, `/collect`, `/payout` | `method` `mtn_momo`/`airtel_money` → opérateur ; `card`/`emvPayload`/`aidDetected` → carte ; disburse/payout → `withdraw` | idem |
| `registerCapabilityGuard` | `POST /merchant/auth/register` | pays déduit du téléphone (`detectFromPhone`, comme la route) ; ouvert si périmètre de lancement **et** au moins un encaissement `active`\|`pilot` | `422 { error, code:'COUNTRY_NOT_OPEN', country, status, launchCountries }` |
| `payCardCapabilityGuard` | `POST /pay/:shortId/card` (page publique) | pays du marchand du lien ; **refus structurels seulement** (pays hors registre, `planned`, historique bloqué) : l'absence de passerelle reste tranchée par la route (`410 CARD_PAYMENT_DISABLED`), qui conserve ses `404` / `409` | `403 CAPABILITY_NOT_ACTIVE` |

Les requêtes `GET`, les corps invalides (la route répond `422`) et les marchands introuvables (`404` par la route)
traversent la garde ; une erreur base remonte au gestionnaire d'erreurs (`500`), jamais de passage silencieux.
Le `merchantAuth` au niveau de la route reste en place (double appel idempotent).

### 2.1 Interrupteur global et procédure de déploiement — `CAPABILITY_ENFORCE`

Les fusions sur `main` déploient automatiquement en production : une erreur de calcul du registre bloquerait de vrais
marchands. Toutes les gardes (caisse, routes historiques, inscription, page carte) lisent `CAPABILITY_ENFORCE` à chaque
requête (bascule par simple changement d'environnement + redémarrage, sans redéploiement de code) :

| Valeur | Comportement |
|---|---|
| `enforce` (défaut, et toute valeur inconnue) | refus `403 CAPABILITY_NOT_ACTIVE` / `422 COUNTRY_NOT_OPEN`, journal `capability: refused` |
| `report` | **tout passe** ; chaque refus évité est journalisé en avertissement structuré `capability: would refuse { guard, country, operation, method, operator, status, merchantId, path }` et compté en mémoire : `GET /api/v1/admin/capabilities` → `enforcement:'report'`, `reportOnly:{ since, count, refusals:[…50 derniers] }` (remis à zéro au redémarrage) |
| `off` | gardes désactivées (aucune lecture base, aucun journal), avertissement `CAPABILITY_ENFORCE=off` au démarrage — retour arrière d'urgence uniquement |

Procédure de mise en production du registre :

1. Déployer avec `CAPABILITY_ENFORCE=report` dans `backend/.env` ; vérifier au démarrage le journal
   `capability: CAPABILITY_ENFORCE=report — gardes en observation seule`.
2. Pendant **48 h**, suivre le portail admin, page « Capacités pays » (bloc « Mode d'application ») et le journal
   `capability: would refuse` : chaque entrée est une requête réelle que le mode `enforce` aurait refusée. Pour chacune,
   trancher : refus légitime (moyen non activé) ou cellule mal calculée (clé présente sous un autre nom, passerelle pays
   absente de `country_payment_defaults`, opérateur manquant dans le registre…) → corriger la configuration ou le registre
   avant d'aller plus loin. `count` = 0 ou uniquement des refus légitimes pendant 48 h = feu vert.
3. Passer `CAPABILITY_ENFORCE=enforce` (ou retirer la variable), redémarrer, vérifier `enforcement:'enforce'` sur
   `GET /api/v1/admin/capabilities` et, sur un compte de test d'un pays `planned`, le `403 CAPABILITY_NOT_ACTIVE`.
4. En cas d'incident après bascule : `CAPABILITY_ENFORCE=report` rétablit immédiatement le passage (le journal continue
   d'alimenter l'analyse) ; `off` n'est à utiliser que si les gardes elles-mêmes posent problème.

Endpoints :

- `GET /api/v1/public/capabilities` — sans authentification, `Cache-Control: public, max-age=60`, cache serveur 60 s :
  `{ countries:[{ code, name, currency, region, callingCode, pilot, operations:{ collect:{ mobile_money:{ status,
  operators:[{ operator, brand, status, alternative? }] }, card:{ status }, gimac:{ status } }, withdraw:{ … },
  transfer:{ wallet_to_bank:{ status }, bank_to_wallet:{ status }, gimac:{ status } } } }], statuses, generatedAt }`.
  Sept pays, aucun nom de variable ni prérequis exposé.
- `GET /api/v1/admin/capabilities` (`adminAuth`, tous rôles) — matrice complète (`requires`, `note`, `implemented`,
  `configured`, `since`, `legacy`), `pilots`, `enforcement`, `reportOnly` (§2.1), `env.{enforce, legacyAllowed,
  registrationGuard, pilotFlags}`, `facts` ;
  `?refresh=1` ou `POST /api/v1/admin/capabilities/refresh` recharge les faits base.

## 3. Détection et GIMAC

- `detection.engine.js` : CF (+236, nsn 8), GA (+241, nsn 8 **avec le 0 initial — à vérifier**), GQ (+240, nsn 9),
  TD (+235, nsn 8), XAF / CEMAC, avec leurs opérateurs principaux (Orange CF, Telecel CF ; Airtel GA, Moov GA ; GETESA,
  Muni GQ ; Airtel TD, Moov TD) marqués `verified:false, planned:true`. La détection renvoie pays / devise / opérateur
  (`planned:true` dans la réponse) ; aucun provider n'existe (`mobilemoney.router.getProvider` → `null`), donc le registre
  marque `planned` et l'API refuse avec un message clair. Préfixes listés dans
  [`OPERATEURS-A-CONFIRMER.md`](OPERATEURS-A-CONFIRMER.md) §1 (lignes 4 à 11).
- `gateways/gimac.gateway.js` : `GatewayNotActivatedError` (`code GATEWAY_NOT_ACTIVATED`, `statusCode 503`,
  `retryable:false`, `toJSON()` → `{ error, code, gateway, status:'planned' }`) remplace l'erreur générique ; `isActivated()`
  → `false` ; `REQUIRES` exporté. `card.router` continue de basculer sur la passerelle de repli (MPGS) comme avant.

## 4. TLS PostgreSQL — `backend/src/config/database.js` (P2 n°6)

`DB_SSL=true` n'utilise plus `rejectUnauthorized:false`. `buildSslConfig(env)` (exporté, testé) :

| Variables | Résultat | Mode journalisé |
|---|---|---|
| `DB_SSL` absent / `false` | pas de TLS | `off` |
| `DB_SSL=true` | `{ rejectUnauthorized:true }` — chaîne vérifiée avec le **magasin système** (les certificats OVH Cloud DB sont émis par une CA publique) | `verify-system` |
| `DB_SSL=true` + `DB_SSL_CA` (PEM, `\n` échappés acceptés) ou `DB_SSL_CA_FILE` (chemin) | `{ ca, rejectUnauthorized:true }` | `verify-ca` |
| `DB_SSL_SERVERNAME` | nom attendu dans le certificat (si `DB_HOST` est une IP ou un alias) | — |
| `DB_SSL=true` + `DB_SSL_REJECT_UNAUTHORIZED=false` | **ancien mode non sûr**, `logger.warn` au démarrage + avertissement `validateEnv` (`postgresTls`) | `insecure` |

Déploiement (OVH Cloud Databases) :

1. Dans `backend/.env` : `DB_SSL=true` ; ne **pas** positionner `DB_SSL_REJECT_UNAUTHORIZED`. Redémarrer l'API et
   vérifier `PostgreSQL TLS enabled {"mode":"verify-system"}` dans les journaux et `GET /health` → `db: ok`.
2. Si la connexion échoue (`self signed certificate in certificate chain`, `unable to get local issuer certificate`) :
   manager OVH → Databases → votre service → onglet « Informations générales » → **Certificat CA** → télécharger le PEM,
   le déposer hors du dépôt (ex. `/opt/cplus/secrets/ovh-db-ca.pem`, monté dans le conteneur) et renseigner
   `DB_SSL_CA_FILE=/opt/cplus/secrets/ovh-db-ca.pem` (ou `DB_SSL_CA="-----BEGIN CERTIFICATE-----\n…"` sur une ligne).
3. Test de l'opérateur avant bascule (depuis le serveur, variables chargées) :
   `node -e "require('dotenv').config();const {pool}=require('./src/config/database');pool.query('SELECT version()').then(r=>{console.log(r.rows[0]);return pool.end()}).catch(e=>{console.error(e.message);process.exit(1)})"`.
4. `DB_SSL_REJECT_UNAUTHORIZED=false` ne sert qu'à un retour arrière temporaire : il est signalé au démarrage et par
   `node scripts/check-production-env.js` (avertissement `postgresTls`).
5. `scripts/backup-db.sh` / `restore-db.sh` utilisent `PGSSLMODE=require` : pour la même garantie, exporter
   `PGSSLMODE=verify-full PGSSLROOTCERT=/opt/cplus/secrets/ovh-db-ca.pem` dans l'environnement du cron.

`NODE_TLS_REJECT_UNAUTHORIZED=0` n'apparaît ni dans `docker/` ni dans `docs/` (vérifié) ; rien à retirer.

## 5. Interfaces

- **Vitrine** (`portal/landing/index.html` `#pays`, `app.js`, `style.css`) : le tableau statique (pays, indicatif, devise,
  zone) reste le repli ; `GET /api/v1/public/capabilities` ajoute trois colonnes (Monnaie mobile avec les opérateurs,
  Carte, GIMAC) avec les badges « Disponible » / « Pilote » / « En cours d'intégration ». Sans réponse de l'API, aucune
  colonne de service n'est ajoutée : rien n'est présumé disponible. `scripts/check-landing.py` : OK.
- **Portail marchand** (`services/api.js` `capabilitiesApi` + `isCapabilityBlocked`, `hooks/useCapabilities.js`,
  `utils/errors.js`, pages `Encaisser`, `Retirer`, `Transférer`) : lecture unique du résumé public, méthodes / opérateurs
  non actifs pour le pays du marchand désactivés avec « Non disponible dans votre pays pour le moment », opérateur détecté
  non actif bloqué avant l'envoi, `403 CAPABILITY_NOT_ACTIVE` traduit (message serveur conservé), `COUNTRY_NOT_OPEN`
  traduit à l'inscription. API indisponible = non bloquant côté client (le serveur refuse de toute façon).
- **Portail admin** (`/configuration/capacites`, `pages/settings/CapabilitiesPage.jsx`, `capabilitiesApi`, entrée de
  navigation « Capacités pays ») : matrice en lecture seule (statuts, notes, `requires`, préfixes à confirmer, pilotes
  `CAPABILITY_PILOT_*`, réglages `CAPABILITY_LEGACY_ALLOW` / `CAPABILITY_REGISTRATION_GUARD`, faits base), bouton
  « Recharger les faits base », filtre périmètre / historiques.
- **Assistant** (`services/assistant/knowledge.js`) : section couverture alignée sur les sept pays et les statuts ;
  interdiction explicite d'annoncer un moyen « en cours d'intégration » comme disponible (GIMAC, CF/GA/GQ/TD, carte retrait).

## 6. Variables d'environnement (toutes optionnelles, `config/env.js` `capabilityEnvVars`)

| Variable | Effet |
|---|---|
| `CAPABILITY_ENFORCE=enforce\|report\|off` | interrupteur global des gardes (§2.1) : `enforce` (défaut) refuse ; `report` laisse passer et journalise `capability: would refuse` ; `off` désactive les gardes (avertissement au démarrage). Lu à chaque requête |
| `CAPABILITY_PILOT_<CC>=true` | pays CC (CM, CF, CG, GA, GQ, TD, CD) en ouverture restreinte : toute cellule `active` devient `pilot` (autorisée, affichée « Pilote ») |
| `CAPABILITY_LEGACY_ALLOW=false` | bloque aussi les marchands SN / CI existants (défaut : tolérés ; l'inscription y est toujours refusée) |
| `CAPABILITY_REGISTRATION_GUARD=off` | désactive le contrôle pays à l'inscription (environnements de test sans aucune clé opérateur) |
| `CARD_GATEWAY_<CC>=migs\|mpgs` | passerelle carte du pays si `country_payment_defaults` est absent / injoignable |
| `CAPABILITY_FUNDING_<CUR>=true` | déclare un compte de collecte pour la devise sans ligne `platform_bank_accounts` |
| `DB_SSL`, `DB_SSL_CA`, `DB_SSL_CA_FILE`, `DB_SSL_SERVERNAME`, `DB_SSL_REJECT_UNAUTHORIZED` | §4 |

Activer un pays « planned » ne demande **aucune modification du registre** : implémenter le provider
(`mobilemoney.router.PROVIDERS`), confirmer les préfixes (`verified:true`), renseigner la clé → `active`.

## 7. Points ouverts

- Plans de numérotation CF / GA / GQ / TD et préfixes opérateurs à confirmer par écrit (GA : présence du 0 initial en
  format international) — `OPERATEURS-A-CONFIRMER.md` §1.
- GIMAC : contrat, spécifications et tests partenaires avant toute implémentation ; la cellule passera `active` une fois
  le code et `GIMAC_MERCHANT_ID` présents (ajouter alors la règle de configuration dans le registre).
- Retrait par carte : volontairement `unavailable` ; une décision produit (OCT / crédit carte) et une certification
  seraient nécessaires.
- La garde de la page publique de paiement carte ne refuse que les cas structurels ; l'absence de passerelle continue de
  produire `410 CARD_PAYMENT_DISABLED` (comportement déjà géré par le portail marchand).
- Le pilote est un drapeau par pays (pas par opérateur) ; un pilote par opérateur demanderait `CAPABILITY_PILOT_<GATEWAY>`.
- Les suites `wave2-webhooks-mm`, `wave3-reconcile-admin`, `wave4-cash` sont en cours de modification par le lot 1
  (fichiers du cœur financier) ; leur état final dépend de cette livraison.
