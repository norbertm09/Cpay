# Changelog - ameliorations integrees

## 2.7.2-deps (2026-11-09) — tri de la premiere vague Dependabot
* `dependabot.yml` : majeures ignorees pour Node (images), React / Vitest / Vite (portails), uuid (backend, ESM-only),
  babel-preset-expo et modules React Native lies au SDK Expo ; nginx suivi sur la branche stable (mineures impaires =
  mainline ignorees) ; AndroidX et Kotlin/KSP groupes. `dotenv.config({ quiet: true })` avant le passage a dotenv 18.

## 2.7.2-lot7 (2026-11-09) — P2 infrastructure (audit du 2 novembre, § 8 a 13) + back-office des suppressions de compte
* Conteneurs durcis : portails et vitrine sur `nginxinc/nginx-unprivileged:1.28-alpine` (processus sans root, port 8080,
  ports hote inchanges), `security_opt no-new-privileges`, `cap_drop ALL`, limites memoire/CPU par service (API 1,5 Go /
  2 CPU, portails 128 Mo, vitrine 64 Mo, cron 32 Mo), healthcheck du portail partenaires, en-tetes de securite + CSP sur
  le portail partenaires ; `certbot/certbot:v4.1.1`, nginx autonome 1.28 ; Node 22 pour tous les builders et la CI.
* Dependabot (`.github/dependabot.yml`) : actions GitHub (groupe hebdomadaire), images Docker, npm backend/portails/Expo,
  Gradle. `release.yml` : `contents: read` par defaut, `contents: write` + `actions: write` reserves au job `release`.
* CI : migrations rejouees deux fois sur un service PostgreSQL 16 (nombre de lignes `schema_migrations` = fichiers SQL,
  fonctions `cpay_calculate_fee`/`calc_fee` presentes) ; l'image API est demarree (tini, entrypoint, migrations,
  utilisateur non root) et doit repondre 200 sur `/health` ; `docker compose config -q` ; `nginx -t` sur les trois
  configurations avec l'image non privilegiee.
* Hote : `scripts/harden-host.sh` (appele par `init-vps.sh`) — `unattended-upgrades` securite + `needrestart`, redemarrage
  planifie 04:30 si requis (ou alerte seule), metrique `cpay_reboot_required` et alerte `HostRebootRequired` (48 h),
  `sshd_config.d/00-cpay.conf` (cles uniquement, les directives permissives des autres fichiers sont neutralisees, `PermitRootLogin prohibit-password` puis `no` apres `setup-deploy-user.sh`,
  valide par `sshd -t`), jail fail2ban `nginx-limit-req`, rotation des journaux Docker imposee (fusion `daemon.json`).
* Documentation et scripts : `backend/.env.example` genere depuis `env.js` (valeurs `change_me` detectees comme
  manquantes), `scripts/deploy-prod.sh` supprime (service `postgres` inexistant), anciens scripts dans `scripts/legacy/`
  avec README, `docs/CI-CD.md` realigne (declencheurs, audit `high` bloquant, Node 22, limites connues), README.
* Back-office : page « Suppressions de compte » (`/marchands/suppressions`, roles super_admin / ops_admin) — liste par
  statut, solde a la demande, delai de retractation, fermeture (avertissements delai / solde) ou refus motive ;
  `merchantsApi.deletionRequests/processDeletion` ; 4 tests vitest.

## 2.7.2-lot5 (2026-11-09) — application Expo (audit du 2 novembre, P0-3, P1-6, P1-7, P2-5)
* Expo SDK 54 / React Native 0.81.5 / React 19.1 (API 36, iOS 26 SDK, Nouvelle Architecture), lockfile et `npm ci`
  (CI et EAS), `expo-doctor`/`check` dans les scripts npm.
* Mode administrateur retire (ecrans Admin*, Rails, segment de mode, preference de mode) : application marchande
  uniquement ; une ancienne session admin stockee est ignoree.
* Alignement caisse : detection du numero avec le pays du marchand (numero local), champ reference d'encaissement,
  onglet Carte masque si `cardAcceptance` indisponible, `isFeatureUnavailable` limite au 410, messages IDEMPOTENCY_*,
  statut de retrait `unknown` affiche comme verification en cours (fonds reserves, suivi Journal).
* Ecran Compte : profil, politique de confidentialite, demande / annulation de suppression de compte (step-up),
  lien vers la procedure web ; lien confidentialite sur l'ecran de connexion.
* Configuration stores : `ios.buildNumber`, `ITSAppUsesNonExemptEncryption=false`, `supportsTablet=false`,
  `privacyManifests`, `allowBackup=false`, `blockedPermissions` ; `eas.json` `appVersionSource=local`,
  `EXPO_PUBLIC_API_BASE_URL` par profil ; `bump-version.sh` tient aussi `ios.buildNumber`.
* `scripts/add-spa-security-headers.sh` ignore les blocs `listen 80` (redirections).

## 2.7.2-lot4 (2026-11-09) — application mobile : publication (audit du 2 novembre)
* Suppression de compte (Google Play / Apple) : migration 014, service `account/deletion.service`, routes
  `GET/POST/DELETE /merchant/account/deletion-request` (proprietaire, step-up, retractation 30 j, une demande en
  attente, e-mails) et `/admin/account-deletion-requests` (liste, `processed` = desactivation + suspension +
  revocation des sessions, `rejected`) ; ecran Android « Confidentialite et donnees » (politique, demande, annulation).
* Android : cle d'idempotence UUID stable par intention (encaissement, retrait, lien carte ; conservee sur reseau/5xx/
  428/409 en cours, liberee sur reponse definitive, etat sauvegarde), codes IDEMPOTENCY_* traites ; statut `unknown`
  et `processing` affiches comme attente (feuille PENDING, « ne relancez pas », suivi Journal) ; cache Room purge a
  la deconnexion et a la perte de session, cles prefixees par utilisateur ; FLAG_SECURE (accueil marchand, 2FA, recu,
  connexion) ; journal HTTP en debug reduit aux en-tetes (Authorization masque) ; deep link pay.c-pay.global factice
  retire ; profil porteur masque, scanner QR / CameraX / ML Kit / Glide / MPAndroidChart retires, permission CAMERA
  supprimee ; ancien retrait direct remplace par la caisse ; build `staging` (serveur de dev, R8, sans journal,
  `.staging`) construit en CI (`android-staging-apk`).
* Tests : `lot4-account-deletion.test.js` (7 cas PGlite).

## 2.7.2-lot3 (2026-11-09) — P1 exploitation de l'audit du 2 novembre
* Deploiement : utilisateur `deploy` dedie (`scripts/setup-deploy-user.sh`) avec commande forcee `scripts/deploy-remote.sh`
  (ref et options validees, commit deja deploye ignore sauf --force) ; `deploy.yml` compatible root (mode historique) et
  deploy ; images `cplus-*:<VERSION>-<sha12>`, rollback sans rebuild, conservation des 3 derniers deploiements.
* Sauvegardes : chiffrement age/openssl avant toute copie, copie rclone obligatoire en production, purge apres copie
  reussie, empreinte SHA-256, metriques et alertes, battement de coeur ; `restore-db.sh --yes --db` (dechiffrement) ;
  `restore-test.sh` mensuel ; `/etc/cplus/backup.env` (modele `monitoring/backup.env.example`).
* Supervision : node-exporter et postgres-exporter demarres par `setup-monitoring.sh` ; alertes ExporterDown, certificats
  (`cert-expiry-metric.sh`), sauvegardes, health check (tous les vhosts, `healthcheck-prod.sh`), test de restauration ;
  scenarios promtool `ops.test.yml`.
* `scripts/lib/env.sh` : lecture des .env sans execution, utilisee par backup/restore/monitoring ; test CI.
* Docs : `docs/EXPLOITATION.md`, CI-CD §7, ENVIRONNEMENTS, GO-LIVE-CG, LOT-5B.

## 2.7.2-legal (2026-11-09) — identite de l'editeur et script nginx hote
Mentions legales, CGU, confidentialite et page de suppression de compte : CALCULUS PLUS SAS, siege 25 rue Bangui,
quartier Moungali, Brazzaville (Republique du Congo), RCCM Brazzaville CG-BZV-01-2026-B16-00002, droit congolais et
tribunaux de Brazzaville ; fiche docs/SOCIETE.md (stores, DSA, contrats operateurs) et champs restant a renseigner.
`scripts/add-spa-security-headers.sh` : installe le snippet CSP et l'include dans les blocs server des portails du vhost hote.

## 2.7.2-lot2 (2026-11-09) — P1 integrite et securite de l'audit du 2 novembre
* Resultats operateur (P1-1) : une reponse HTTP 5xx, un corps illisible (page d'erreur d'un proxy) ou un delai ne
  sont plus classes « refus » : `classifyRailResult` rend `unknown` (code 5xx, `httpStatus`, TIMEOUT/UNPARSABLE),
  les providers MTN et Airtel qualifient eux-memes ces cas (`outcome:'unknown'`, propage par `normalize`), la caisse
  conserve la reservation, l'orchestrateur laisse `pending`. Secret Airtel encode dans la requete de jeton.
* Webhook Airtel marchand (P1-2) : plus d'UPDATE direct ; enquiry Airtel via `reconcileOne` puis
  `finalize.service` (frais `cpay_calculate_fee`, reglement J+1, lien de paiement, evenement) ; si l'enquiry est
  indisponible, le callback signe HMAC fait foi par la meme machine d'etat ; TIP/TA → `pending`.
* `/api/v1/momo/*` (P1-3) : `/payout` (appel MTN dans la transaction SQL), `/requesttopay` et `/accountbalance`
  retires (410 FEATURE_DISABLED, aucun client) ; `/status/:ref` reserve aux transactions du porteur authentifie ;
  montant de `/topup` type et entier.
* Routes historiques `/merchant/collect` et `/merchant/collect/:id/status` (P1-4) : delegation a l'orchestrateur
  (plafonds KYB, antifraude, routage par pays, frais uniques) et a `reconcileOne` ; bareme local, `computeFees`,
  `getFeeRate` et pollings `setTimeout` supprimes. Reponse compatible avec l'application Android.
* Reglements admin (P1-5) : `/admin/settlements/:id/complete|reject` passent par `cash.transitionTransfer`
  (claim de statut, evenement JSONB, audit_logs, reference bancaire obligatoire, `rejected` libere les fonds) ;
  `/admin/settlement/run` execute reellement `settlement.engine.runSettlement`.
* Portails : mot de passe temporaire bloquant (marchand `ForcePassword`, porteur `ForcePasswordPage`, rendus a la
  place de tout l'espace, plus de banniere contournable) + defense en profondeur API : claim `pwdTemp` au login et au
  refresh, `merchantAuth`/`cardholderAuth` refusent toute operation hors profil / changement / deconnexion
  (403 PASSWORD_CHANGE_REQUIRED). Jeton admin en memoire (plus de `localStorage`, purge de `admin_token`).
  CSP + Permissions-Policy + X-Frame-Options DENY sur les SPA (`nginx-spa.conf`, origine API injectee au build,
  blocs admin/merchant/app du `nginx.conf`, snippet `cpay-security-spa.conf` pour l'hote). Creation marchand admin :
  pays deduit du telephone (`/detect/phone`), devise a choix ferme (`/country-defaults`), liste de pays CEMAC + RDC +
  SN/CI (CF et GQ ajoutes). Rapports imprimes du portail partenaires echappes (`escHtml`).
* Tests : `lot2-p1-integrity.test.js` (27 cas : classification, providers 5xx via HTTPS simule, webhook Airtel
  PGlite, garde pwdTemp, routes momo, reglements admin) ; test webhook Airtel historique adapte. 872 tests backend.

## 2.7.2-lot1 (2026-11-09) — P0 backend de l'audit du 2 novembre
* `POST /merchant/disburse` (application Android) delegue a `cash.createPayout` : reservation atomique des fonds, frais
  « en sus » (le beneficiaire recoit le montant saisi, le solde est debite de montant + frais), limite journaliere KYB,
  resultat operateur incertain (delai, erreur reseau) → statut `unknown` avec fonds reserves et rapprochement automatique ;
  plus aucune ecriture `failed` sans refus explicite de l'operateur. `GET /merchant/disburse/:id/status` lit les transferts
  `merchant_transfers` (statuts mappes pending/authorized/failed pour l'application) et les anciennes lignes `transactions`.
  Polling Airtel des decaissements retire ; le polling des encaissements historiques laisse `pending` au lieu de `failed`
  apres 30 s (la reconciliation tranche).
* `calc_fee` : plus aucune reference dans le code (`cpay_calculate_fee` partout) ; migration `013_calc_fee_compat.sql`
  cree un wrapper uniquement si la fonction manque (une definition manuelle existante est conservee). La reconciliation
  MTN/Airtel historique (`markCollectOk`, `markPayoutOk`, `markFailed`) passe par `finalize.service` : claim atomique,
  frais, reglement J+1, lien de paiement et evenement dans une seule transaction ; une transaction refusee porte des frais
  a 0 ; les frais a 0 d'une ligne historique sont recalcules a l'autorisation.
* Callback MTN (`/api/v1/webhooks/mtn`, `/api/v1/momo/webhooks/mtn`, POST ou PUT) : traite aussi les encaissements et
  versements marchands (`transactions`) retrouves par `referenceId` ou `externalId` (caisse : identifiant de transaction ;
  client historique : prefixe de reference), re-interroge MTN puis finalise via `reconcileOne` ; jeton `MTN_WEBHOOK_TOKEN`
  obligatoire en production (503 fail-closed sinon) et accepte dans l'URL de rappel (`?token=`), MTN n'envoyant pas
  d'en-tete personnalise. Les ordres du client rails historique (`gateway_name='mtn'`) sont rapproches comme Congo.
* Tests : `lot1-p0-backend.test.js` (PGlite, 21 cas : migration 013, frais en sus, delai → `unknown`, reconciliation via
  finalize, callback MTN marchand, jeton). 845 tests.

## 2.7.1 (2026-11-04) — premiere version signee de l'application Android
Application Android marchande : API cible 36 (exigence Google Play, audit 2026-11-02 P0), AGP 8.11 / Gradle 8.13 /
Kotlin 2.1, security-crypto 1.1.0 stable, affichage bord a bord desactive explicitement sur Android 15+ en attendant
la gestion des insets. Release GitHub : APK et AAB signes avec le keystore de release (secrets ANDROID_*), une
release sans signature est desormais refusee. Build debug sur le serveur de developpement, workflow Expo EAS,
supervision de production (setup-monitoring.sh), audit complet du 2 novembre et evaluation du 1er novembre.

## 2.7.0-mobile-stores (2026-11-01) — publication Google Play et App Store
Build Android debug pointe sur le serveur de developpement (api.dev / pay.dev), release inchangee ; workflow
`mobile-expo.yml` (EAS Build Android/iOS, profils preview/production, soumission TestFlight / Play interne
optionnelle, secret EXPO_TOKEN) ; `eas.json` complete (APK en preview, AAB en production, submit) ;
docs/MOBILE-STORES.md (keystore, secrets, release signee, Play Console, Apple Developer, EAS, App Store Connect).

## 2.7.0-supervision (2026-11-01) — activation de la supervision en production
`scripts/setup-monitoring.sh` : mise en route de Prometheus + Alertmanager (SMTP STARTTLS) a partir d'un fichier
prive, secrets pour l'uid 65534, configuration generee dans le conteneur api, validation promtool, demarrage,
alerte de test (`--test`), arret (`--down`). Voir docs/LOT-5B-ALERTES.md.

## 2.7.0-migrations-base-vierge (2026-10-25) — initialisation d'un nouvel environnement
La migration 007 creait la vue `v_manual_compensation` sur des tables historiques de production absentes des migrations
(`card_transactions`, `bank_transfers`) : echec sur une base vierge (serveur de developpement). Vue conditionnee a
l'existence des tables ; `migrate.js` accepte l'ancien checksum de 007 pour les bases deja migrees (production
inchangee) ; test de rejeu integral des 12 migrations sur PGlite en CI. 824 tests.

## 2.7.0-caisse-pilote (2026-10-24) — demandes du pilote Congo
Saisie du numero client en format local sans indicatif : le pays du marchand est transmis a la detection
(`POST /detect/phone` accepte `country`), portail marchand (exemple et aide par pays) et app Android (pays memorise a
la connexion). Reference d'encaissement automatique `ENC-AAMMJJ-XXXXX` generee par le serveur si absente, renvoyee
dans les reponses et relue dans l'historique ; champ pre-rempli et modifiable dans le portail. 822 tests backend.

## 2.7.0-mtn-production-host (2026-10-24) — hote de production MTN
L'API MTN MoMo de production est servie sur https://momoapi.momo.africa depuis octobre 2026 : nouveau defaut de
`config/mtn-env.js`, l'ancien proxy.momoapi.mtn.com reste accepte en surcharge mais signale comme obsolete. Cle
d'abonnement confirmee obligatoire (test du 2026-10-24). Runbook : clés d'abonnement, guillemets pour les valeurs a
caracteres speciaux.

## 2.7.0-mtn-octobre-2026 (2026-10-24) — API MTN MoMo
MTN exige depuis octobre 2026 l'en-tete `X-Target-Environment` sur toutes les requetes, demande de jeton comprise :
ajoute dans le client rails (CG) et le provider du routeur (CM/CI/CG). Le provider demande desormais un jeton par
produit (`/collection/token/` ou `/disbursement/token/`) avec les identifiants et la cle d'abonnement du produit
(`extra_params.disbursement`), au lieu d'utiliser le jeton de collection pour les retraits. `X-Callback-Url` envoye sur
`requesttopay` quand `MTN_CG_CALLBACK_URL` est definie ; jeton refuse journalise. 813 tests.

## 2.7.0-environnements (2026-10-24) — serveurs de developpement et de production
Voir `docs/ENVIRONNEMENTS.md` : branche `develop` -> environnement GitHub `development` (51.91.98.115,
dev.c-pay.global, base dediee, operateurs sandbox) et `main` -> `production` (137.74.46.246, c-pay.global) avec un seul
workflow `deploy.yml` (environnement choisi par la branche, garde-fou production = main ou tag, smoke test par
`CPAY_DOMAIN`), URL d'API des portails parametree par `docker/.env`, vitrine deduisant l'API du nom d'hote,
`scripts/setup-dev-server.sh` (certificat, vhost derive de la production, docker/.env), health check parametre.

## 2.7.0-go-live-cg (2026-10-22) — migration VPS dedie et preparation go-live Congo
Voir `docs/GO-LIVE-CG.md` : scripts de migration de serveur (`scripts/vps-export.sh` sur l'ancien,
`scripts/init-vps.sh` pour Ubuntu 24.04/26.04 avec nginx hote, certbot, Docker, UFW, fail2ban, import des
certificats, secrets et crons), configuration nginx hote documentee et allowlist des callbacks operateurs
(`docker/nginx-host/`), environnement MTN unifie (`MTN_ENV` unique pour l'encaissement et le retrait, cibles de
production derivees par pays, incoherences journalisees), runbook complet de bascule DNS et de pilote MTN/Airtel
Congo, 807 tests.

## 2.7.0-wave-7 (2026-10-21) — reliquats de l'audit residuel
Voir `docs/WAVE-7.md` : Nodemailer 10 (plus aucune vulnerabilite high en production, audit npm bloquant en CI),
fabrique SMTP commune (STARTTLS force, delais bornes, erreurs normalisees), scenario d'alerte « identifiants
refuses » (535) et runbook Prometheus du secret de scrape, portail porteur avec jeton en memoire et refresh par
cookie, migration CRA 5 -> Vite 5 des sept portails avec lockfiles, 797 tests backend.

## 2.7.0-wave-6 (2026-10-20) — reponse a l'audit du 17 octobre
Voir `docs/WAVE-6.md` : resultats operateur incertains (statut unknown, reservation conservee, reconciliation,
alertes), idempotence durable sur les routes monetaires, finalisation atomique et reparation de la file de
reglement, beneficiaires proteges (proprietaire, confirmation forte, verification admin, historique), antifraude en
mode degrade explicite, registre des capacites pays x moyen x operation avec garde serveur et interrupteur
report/enforce, detection CF/GA/GQ/TD, GIMAC non active, TLS PostgreSQL verifie, migration 011, 655 tests.

## 2.7.0-wave-5 (2026-10-16) — deploiement automatique, refonte des interfaces
Voir `docs/WAVE-5.md` : deploiement automatique apres CI verte sur main ; vitrine allegee (4 entrees, sans tarifs,
page reclamation, hub developpeurs) ; refonte complete des portails marchand (accueil 360, caisse, activite,
ventes, integrations, compte avec tarifs), utilisateur et admin (design system, API simulee, captures) ;
app Android marchande en Material 3 avec parcours d'encaissement en 4 ecrans et cache hors ligne.

## 2.7.0 (2026-10-15) — vague 4 : CI/CD GitHub, caisse marchande
Voir `docs/WAVE-4.md` : GitHub Actions (tests, builds portails/vitrine/PHP/Expo/Android, release sur tag,
deploiement OVH par SSH avec approbation), gestion des versions (2.7.0 partout, bump-version/check-version),
caisse marchande (encaisser par carte via lien heberge MIGS/MPGS et Mobile Money par detection, retrait vers le
wallet du marchand avec confirmation forte, transferts wallet→banque et banque→wallet par ordre reference,
journal, administration des files d'attente), vitrine recentree, apps Android/Expo avec ecrans de caisse,
migration 009 (tables manquantes creees), 526 tests.

## 2.7.0-wave-3 (2026-10-15) — apps mobiles, reliquats, logo HD
Voir `docs/WAVE-3.md` : apps Android et Expo alignees sur l'authentification unifiee (refresh 15 min, 2FA,
mot de passe force, fonctions desactivees explicites, marque C-Pay 2.7.0), reset de mot de passe admin,
desassignation CRM, en-tetes de webhook `X-CPay-*` (+ legacy), reconciliation des transactions en attente
pour tous les operateurs, portails sur `/auth/me` avec refresh partout et QR locaux, SDK JS/PHP/Android et
plugin WooCommerce en marque C-Pay avec compatibilite, logo Calculus Plus HD partout, 475 tests.

## 2.6.0-wave-2 (2026-10-15) — refonte produit « C-Pay par Calculus Plus »
Voir `docs/WAVE-2.md` : webhooks Mobile Money reels (Orange, Wave, Africell, Express Union, Free Money, Moov),
moteur de detection reecrit, secrets providers chiffres au repos, authentification unifiee (JWT 15 min,
refresh opaque avec rotation, 2FA TOTP au login, mot de passe temporaire), vitrine c-pay.global interactive
(demo de detection, simulateur, formulaires, assistant Claude avec creation de leads et de reclamations),
CRM admin, passe de marque sur les 7 portails, migration 008, 446 tests.

## 2.6.0-hotfix-v1 (2026-10-15) — vague 1 de l'audit de production
Voir `docs/HOTFIX-V1.md` : webhooks fail-closed avec re-verification operateur, IDOR cartes corrigees,
endpoints creant de la valeur sans mouvement desactives (410), retrait carte refuse, statuts pending reels,
un seul moteur de reglement (verrou, devise, resultat verifie), roles admin, 2FA partenaires reelle,
pages de paiement echappees, cles API hachees, secrets masques, reservation atomique des fonds,
routes de sante reparees, `/internal` et `/metrics` fail-closed, sauvegardes pg_dump, nginx/deploy corriges,
APK debug retire, migration 007, 238 tests.


Version cible: CPlus 2.6.0

## Backend

- Ajout du runner de migrations `backend/src/config/migrate.js`.
- Ajout des tables `schema_migrations`, `idempotency_keys`, `refresh_tokens` et `transaction_events`.
- Ajout d'une validation API centralisee.
- Ajout de l'idempotence via `Idempotency-Key` sur collect, payout, QR code et pay link.
- JWT durci: secret obligatoire en production, refresh tokens hashes, rotation, refresh/logout.
- Ajout de l'inscription marchand pour aligner l'app Android.
- Limites KYB basees sur la DB au lieu d'une simulation.
- Erreurs DB critiques non masquees dans l'orchestrateur.
- Evenements transactionnels gateway et persistance de `gateway_name`.
- Routage payout Mobile Money vers `sendPayout`.
- Correction de la sauvegarde des QR/pay links.
- Ajout de l'envoi Pay Link serveur via WhatsApp Cloud API et SMS SMPP.
- Ajout des defaults par pays: providers Mobile Money locaux + MIGS Mastercard par defaut.
- Ajout de la creation marchand par administration avec affectation automatique des APIs.
- Ajout Interswitch Wallet Payments API DRC pour collect Mobile Money.
- Ajout PaymentHub API v1.1 pour payouts DRC avec callback de statut.
- Ajout Visa Direct Funds Transfer: push funds, pull funds et transaction query.
- Ajout Visa Account and Wallet Payouts v3: payout, validation, query et balance.
- Ajout Mastercard Developers API: services, projets, ajout service et credentials via OAuth 1.0a.
- Bascule domaine officiel: api.c-pay.global, pay.c-pay.global, admin.c-pay.global et merchant.c-pay.global.
- Suppression du compte admin par defaut.

## Android

- Ajout du refresh token.
- Ajout de cles d'idempotence par operation sensible.
- Alignement du modele dashboard.
- Ajout de `SecureStorage.updateTokens`.
- Rendu QR Code reel avec ZXing.
- Partage Pay Link natif: WhatsApp, SMS et copie du lien.
- Ajout d'une application mobile cross-platform Android/iOS sous `mobile/cpay-mobile`.
- App mobile: marchand, admin, collect, payout, QR, Pay Link, transactions, règlements, APIs, marchands, monitoring et rails Visa.

## Portail admin

- Suppression du mot de passe admin par defaut affiche dans l'interface.
- Application de la palette du logo CPlus 2.6.0 aux interfaces web:
  blanc, bleu logo, turquoise logo, gris texte, police Verdana.

## Android UI

- Application de la palette du logo au theme Compose:
  surfaces claires, bleu logo, turquoise logo, textes gris/bleu.

## Packaging

- Suppression des dossiers invalides avec accolades.
- Archive propre generee sans entrees invalides.

## Production rapide

- Correction du `docker-compose.yml` pour exposer correctement API, admin portal, merchant portal et proxy Nginx.
- Ajout d'un Dockerfile API production avec migrations automatiques optionnelles.
- Ajout d'un Dockerfile portail React reutilisable pour admin et marchand.
- Ajout du reverse proxy Nginx pour `api.c-pay.global`, `admin.c-pay.global`, `merchant.c-pay.global` et `pay.c-pay.global`.
- Ajout de l'initialisation TLS Let's Encrypt via Certbot.
- Ajout de la validation d'environnement production: `npm run check:prod`.
- Ajout des scripts `preflight`, `deploy-prod`, `backup-db`, `restore-db` et `healthcheck-prod`.
- Ajout de GitHub Actions CI et workflow de deploiement manuel par SSH.
- Ajout de `backend/.env.production.example`.

## Qualite code et robustesse

- Ajout d'un middleware de contexte requete: `X-Request-Id`, logs HTTP structures et duree de traitement.
- Ajout d'un gestionnaire d'erreurs centralise avec codes d'erreur et `requestId`.
- Ajout des endpoints `/live` et `/ready` pour Kubernetes, Docker et monitoring.
- Ajout de l'arret gracieux `SIGTERM`/`SIGINT` avec fermeture du pool PostgreSQL.
- Durcissement PostgreSQL: timeouts configurables, nom d'application, gestion des erreurs du pool.
- Validation stricte de l'envoi Pay Link WhatsApp/SMS.
- Correction du routage carte: une gateway non configuree ne declenche plus un failover reseau.
- Extension de la detection Mobile Money Cote d'Ivoire aux formats de numeros plus longs.
- Ajout de tests unitaires pour validation API et configuration production.

## Support, integrations et tokenisation

- Ajout du ticketing support entre marchands et administrateurs: tickets, messages, priorite, statut, audit admin.
- Ajout des interfaces Support dans le portail marchand et le portail administrateur.
- Ajout des connecteurs comptabilite/CRM/ERP/webhook par marchand.
- Ajout des webhooks sortants signes `X-CPlus-Signature` pour pousser transactions et reglements vers les logiciels clients.
- Ajout export transactions marchand en JSON ou CSV pour comptabilite/CRM.
- Ajout du coffre de tokenisation `payment_tokens`: tokens PSP/reseau, fingerprint, last4, statut et revocation.
- Refus explicite du stockage de PAN brut dans la tokenisation (`RAW_PAN_NOT_ALLOWED`).
- Ajout mobile: onglets Support, CRM/Compta et Tokens.
- Adaptation mobile pour TPE, telephone et tablette: tabs horizontaux, largeur max responsive et indication de profil appareil.

## Roadmap CPlus 3.0

- Ajout du document `ROADMAP_CPLUS_3_0.md`.
- Structuration des priorites 30/60/90/120 jours.
- Definition des criteres d'acceptation pour Fraud/AML, observabilite, PCI/token vault/HSM et multi-tenant.
- Ajout d'une architecture cible CPlus 3.0 en diagramme Mermaid.

## CPLUS 2.6.0 - production pilot control

- Ajout de la migration `006_pilot_control.sql`: programmes pilotes, enrollement marchands, feature flags, overrides, decision logs et readiness checks.
- Ajout du service backend `pilot-control` avec mode `audit` ou `enforce`.
- Ajout des endpoints admin `/api/v1/admin/pilot/*` et marchand `/api/v1/merchant/pilot/state`.
- Controle progressif de Tap to Phone, QR Code, Pay by Link et Tokenization par feature flags.
- Ajout du runbook `PILOT_CONTROL_RUNBOOK.md` et du script `npm run check:pilot`.
