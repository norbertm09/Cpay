# Changelog - ameliorations integrees

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
