# Changelog - ameliorations integrees

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
