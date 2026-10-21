# Lot 5C — Browser Recipe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exercer les vrais builds app/cardholder, merchant et admin dans Chromium avec des API déterministes et aucun accès externe.

**Architecture:** Un runner Playwright isolé démarre trois serveurs statiques loopback avec fallback SPA. Les fixtures d'API imitent les contrats existants et comptent les requêtes pour détecter toute réémission financière lors d'une reprise.

**Tech Stack:** Node 22, `@playwright/test` 1.64.1 verrouillé et Chromium correspondant, builds CRA existants.

**Spec:** `docs/superpowers/specs/2026-10-21-lot5c-browser-recipe-design.md` et contraintes communes de `2026-10-21-lots-5b-5c-6-design.md`.

## Global Constraints

- Aucun paiement, email, SMS ou message réel pendant les tests.
- Aucun secret, PIN, PAN/CVV, jeton d'accès ou contenu de `.env` dans les artefacts.
- Une seule PR, commits par lot ; aucune fusion ni activation de production par cette implémentation.
- Les scripts de test écoutent uniquement sur loopback et refusent les cibles de production.
- Pas de migration CRA ; Playwright est une dépendance de développement du runner, pas des portails.
- La correction d'intention app du plan lot 6 précède le scénario de reprise app ; 5B peut avancer indépendamment.

## Review Focus

- Rechargement direct d'une route SPA : vraie page React servie, pas de faux succès sur un fichier manquant.
- Requête API inattendue ou hôte externe : échec du test, même si l'écran finit par afficher un résultat.
- Expiration de session et refresh refusé : accès protégé, aucune action financière autorisée par le simulateur.
- Réponse tardive/ordre incertain : même intention, identifiant et clé ; compte exact des POST et GET.
- Collision de port, erreur ou arrêt du runner : échec clair et nettoyage des seuls processus démarrés par la recette.

## Task 1: Runner isolé et barrières réseau

**Files:**
- Create: `e2e/package.json`, `e2e/package-lock.json`, `e2e/playwright.config.cjs`, `e2e/serve-portals.cjs`, `e2e/tests/fixture.cjs`, `e2e/tests/harness.spec.cjs`.
- Modify: `.gitignore`.

**Interfaces:**
- `npm --prefix e2e test` lance le runner et ses serveurs ; builds requis présents dans `portal/{cardholder,merchant,admin}/build`.
- Origines fixes : cardholder `http://127.0.0.1:4311`, merchant `:4312`, admin `:4313`. Bind loopback, aucun serveur existant réutilisé.
- `serve-portals.cjs` refuse un build absent, un port occupé et un chemin hors racine ; fallback HTML uniquement pour les routes SPA, pas pour des assets absents.
- Fixture Playwright : nouveau contexte par test, APIs explicitement déclarées, `serviceWorkers:'block'`, journal des requêtes inattendues, teardown qui échoue si le journal n'est pas vide. Intercepter aussi les connexions WebSocket non locales si l'API du runner le permet ; aucun trafic de production autorisé.
- `apiScenario({portal,actor,...})` fournit uniquement des comptes/jetons/références fictifs ; authentification via les vrais formulaires puis contrats `auth/login`, `refresh`, `me` et consentement selon le portail.

- [ ] Écrire les tests du harnais : requête externe bloquée et signalée, API non déclarée détectée, asset absent 404, traversal refusé, collision de port explicite, fallback SPA valide.
- [ ] Installer le runner avec version exacte et lockfile puis `npx --prefix e2e playwright install chromium` ; aucun changement de dépendance de production.
- [ ] Implémenter serveur, fixtures et configuration, avec durée bornée et arrêt/cleanup `finally`. Lancer les tests du harnais et vérifier qu'une barrière retirée les fait échouer.
- [ ] Ajouter les exclusions des rapports/traces, captures, node_modules et données runtime ; garder les fichiers de tests dans Git.
- [ ] Commit : `test: add isolated browser recipe harness`.

## Task 2: Scénarios métier des trois portails

**Files:**
- Create: `e2e/tests/cardholder.spec.cjs`, `e2e/tests/merchant.spec.cjs`, `e2e/tests/admin.spec.cjs`, `e2e/fixtures/contracts.cjs`.
- Modify if a regression proves it necessary: composants/pages concernés et leurs tests unitaires.

**Interfaces:**
- App : `/connexion`, `/payer`, `/operations` ; paiements via `operations.pay` et son `Idempotency-Key` ; restauration d'intention issue du lot 6.
- Merchant : `/login`, `/caisse/retirer`, `/caisse/transferer`, `/activite/journal` ; les GET de reprise ciblent le même transfert et ne créent aucun POST supplémentaire.
- Admin : `/login`, `/operations/caisse` ; files unknown/needsReview, détail et `/api/v1/admin/cash/reconcile/status` selon les contrats actuels.
- Les fixtures reprennent les formats de `services/api.js` et des tests existants, jamais un contrat inventé pour faire passer la UI.

- [ ] Écrire connexion et accès protégé pour les trois portails, retour direct sur route profonde, session expirée et indisponibilité API avec message visible.
- [ ] App : succès, refus explicite, réponse perdue après prise en compte simulée puis reload et même clé ; le simulateur ne compte qu'un effet par clé. Rechercher PIN/token dans le stockage d'intention, pas dans toute la session d'authentification existante.
- [ ] Merchant : inconnu puis confirmation et inconnu puis refus, montants/frais/net/réservation, refresh GET même ordre ; double clic et changement de session ne créent pas d'ordre indépendant. Nouvelle intention distincte et explicite lorsque permise.
- [ ] Admin : file incertaine/à examiner, détails, santé du worker, absence d'action de rejet forcé ; échec d'un chargement ne doit pas simuler une liste vide.
- [ ] Exécuter `npm --prefix e2e test` après les trois builds ; observer chaque régression avant une éventuelle correction ciblée, puis vérifier le retour au vert.
- [ ] Commit : `test: cover app merchant and admin recovery journeys`.

## Task 3: CI et procédure reproductible

**Files:**
- Modify: `.github/workflows/ci.yml`.
- Create: `docs/LOT-5C-RECETTE-NAVIGATEUR.md`.

**Interfaces:**
- Job navigateur `needs: portals` : télécharge les seuls artefacts des trois portails issus du même run, installe `e2e` par `npm ci` et Chromium 1.64.1, puis exécute la recette.
- Rapports seulement sur échec, conservation 7 jours, identités fictives uniquement ; pas de capture des corps auth/paiement dans les rapports. Traces réseau désactivées pour éviter d'enregistrer PIN et jetons, même de recette. Aucun secret d'environnement de production transmis au job.

- [ ] Ajouter le job et vérifier les chemins exacts des artefacts `portal-cardholder`, `portal-merchant`, `portal-admin` produits par la matrice existante.
- [ ] Documenter les commandes de builds locaux, installation du navigateur, commande unique de recette, ports, nettoyage et séparation UI simulée / preuves SQL / recette opérateur réelle. Vérifier qu'un échec de test ne publie pas les payloads d'authentification/paiement.
- [ ] Exécuter le parcours complet local, puis vérifier le job réel de la PR ; corriger toute divergence de plateforme avant de déclarer la validation CI acquise.
- [ ] Commit : `ci: run three-portal browser recipes on pull requests`.

## Livraison

- [ ] Joindre les résultats navigateur au rapport du lot 6, sans les présenter comme une validation bancaire/opérateur.
- [ ] Revue indépendante de la PR commune et des barrières anti-production avant publication.
