# Lot 6 — Residual Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corriger la reprise du paiement app et les labels HTTP, puis produire un audit actuel et traçable.

**Architecture:** Réutiliser le rejeu transactionnel existant de `cardholder_payment_requests`. Ajouter une intention locale isolée par acteur/carte et remplacer les labels de chemins libres par une classification de routes bornée.

**Tech Stack:** React/CRA existants, Jest, supertest, PGlite, Node 22, npm audit.

**Spec:** `docs/superpowers/specs/2026-10-21-lot6-residual-audit-design.md` et contraintes communes de `2026-10-21-lots-5b-5c-6-design.md`.

## Global Constraints

- Aucun paiement, email, SMS ou message réel pendant les tests.
- Aucun secret, PIN, PAN/CVV, jeton d'accès ou contenu de `.env` dans les artefacts.
- Une seule PR, commits par lot ; aucune fusion ni activation de production par cette implémentation.
- Le périmètre reste CEMAC + RDC ; aucun connecteur non validé activé.
- Pas de mise à niveau majeure opportuniste ; les observations non vérifiables restent ouvertes.

## Review Focus

- Réponse perdue après débit : rechargement et reprise emploient la même clé et ne débitent pas une seconde fois.
- Changement d'acteur/carte ou réponse tardive d'une ancienne session : aucune mutation de la nouvelle session.
- Stockage corrompu, refusé ou indisponible : bloquer l'envoi ; aucune recréation silencieuse d'intention.
- Résultat incertain et paramètres modifiés : pas de nouvelle clé ; nouvelle intention seulement après résultat connu et action explicite.
- Webhooks secrets, identifiants libres, route inconnue : aucun chemin brut, secret ou cardinalité arbitraire dans les métriques.

## Task 1: Intention durable app/cardholder

**Files:**
- Create: `portal/cardholder/src/hooks/usePaymentIntent.js`, `portal/cardholder/src/hooks/usePaymentIntent.test.jsx`, `portal/cardholder/src/pages/pay/PayPage.test.jsx`.
- Modify: `portal/cardholder/src/pages/pay/PayPage.jsx`, `portal/cardholder/package.json`, `.github/workflows/ci.yml`.
- Extend if necessary: `backend/src/tests/hotfix-cardholder.test.js` ou `audit-financial.integration.test.js` pour prouver le rejeu SQL.

**Interfaces:**
- `usePaymentIntent({cardholderId,cardId,currency})` retourne `{execute,startNew,restored,pending,canStartNew,error}`.
- `execute({merchantId,amount,description}, send)` appelle `send({merchantId,amount,description,idempotencyKey})` ; le PIN est fourni seulement par la fermeture courante de l'écran, jamais au stockage.
- Clé de stockage : `cpay:cardholder-payment-intent:v1:` suivie de l'identité acteur/carte/devise sérialisée. Entrée persistée : `{version:1,key,payload,known}` ; payload limité aux champs de l'interface.
- `startNew()` refuse si l'intention est incertaine ou en cours ; succès terminal connu puis action explicite permettent le remplacement. Une erreur réseau/5xx ne marque jamais `known`.
- Les refus de validation avant effet peuvent être corrigés avec la même intention lorsque le contrat serveur le permet ; aucun abandon silencieux fondé uniquement sur HTTP 4xx. Vérifier les codes existants avant de les classifier.

- [ ] Écrire les tests de hook : émission après persistance, double clic, changement de montant, erreur réseau, remount/reload même clé, stockage illisible/indisponible, changement d'acteur/carte, réponse tardive, absence de PIN/token dans les données persistées.
- [ ] Ajouter le script `test: react-scripts test` ; exécuter `npm test -- --watchAll=false --runInBand` depuis `portal/cardholder` et observer le RED.
- [ ] Implémenter le hook et remplacer `paymentKey`/`goConfirm` dans PayPage ; restaurer les paramètres après rechargement, demander à nouveau le PIN, afficher clairement la reprise d'une opération existante. Préserver le contrat `operations.pay` et les frais/limites du backend.
- [ ] Tester l'écran : timeout puis reprise, nouvelle intention explicitement demandée, refus de changement de paramètres tant que résultat inconnu. Vérifier le même identifiant transmis et le comportement SQL de rejeu existant ; ajouter une assertion de non-double-débit si elle manque.
- [ ] Lancer tests cardholder + tests backend concernés, puis build cardholder. Étendre la matrice de tests CI aux trois portails sans modifier leurs routes de production.
- [ ] Commit : `fix: preserve app payment intents across reloads`.

## Task 2: Confidentialité et cardinalité des métriques

**Files:**
- Modify: `backend/src/config/metrics.js`.
- Create: `backend/src/tests/http-metrics-privacy.test.js`.

**Interfaces:**
- Le middleware `httpMetrics` conserve son export et les noms `api_requests_total`, `api_request_duration_sum/count` ; seul le label `path` devient une catégorie/template contrôlée.
- Les routes Express peuvent être regroupées par templates connus ; une route inconnue prend `unmatched`, sans `req.path`, `originalUrl`, `baseUrl` dynamique ou données client. Méthodes inconnues regroupées en `OTHER`.
- Ne pas créer de label contenant une valeur de paramètre, un token ou une query string.

- [ ] Tests supertest utilisant le vrai middleware : requêtes sur deux secrets de webhook, deux identifiants libres, UUID, caractères spéciaux, query strings et 404. Le rendu `/metrics` ne doit contenir aucune valeur injectée ; le nombre de séries reste borné pour 100 chemins arbitraires.
- [ ] Exécuter `npm test -- src/tests/http-metrics-privacy.test.js` depuis `backend` ; observer le RED.
- [ ] Implémenter une classification fondée sur des templates/catégories fixes ; tester les montages Express imbriqués et les chemins d'erreur. Garder l'accès `/metrics` protégé et sans données brutes.
- [ ] Relancer cette suite et `reconciliation-job-status.test.js` ; attendu : succès.
- [ ] Commit : `fix: bound HTTP metrics labels and redact secret paths`.

## Task 3: Audit résiduel documenté et dépendances compatibles

**Files:**
- Create: `docs/AUDIT-RESIDUEL-LOTS-5B-5C-6.md`.
- Modify only if justified: package manifests/lockfiles des quatre applications ; tests des comportements effectivement corrigés.

**Interfaces:**
- Rapport : constat, gravité/impact, commit et chemin, reproduction, statut, correction/preuve ou action restante.
- États autorisés : `corrigé et testé`, `ouvert`, `non reproduit`, `non vérifiable`. Aucun secret ou résultat contenant des identifiants réels.

- [ ] Auditer flux financiers, rôles/IDOR, TLS/secrets, pays/capacités et scripts ; comparer aux anciens rapports et aux tests actuels. Examiner notamment le stockage `ch_token` de l'app et distinguer ce sujet du stockage de l'intention.
- [ ] Exécuter `npm audit --json` et `npm audit --omit=dev --json` dans backend, cardholder, merchant et admin ; conserver les sorties expurgées hors Git. Pour un lockfile absent, noter le défaut de reproductibilité au lieu d'inventer une preuve.
- [ ] Pour chaque correction compatible, écrire/reproduire le test pertinent avant modification puis relancer les suites/builds affectés ; pas de `npm audit fix --force`. Documenter les correctifs majeurs ou preuves externes requis sans les déclarer résolus.
- [ ] Ajouter la matrice des sept pays et trois familles de moyens : annoncé/détecté/configuré/activé/validé partenaire, avec code à l'appui et inconnues explicites.
- [ ] Inscrire les résultats 5B/5C distinctement de la validation VPN, du SMTP de production et des accès opérateurs.
- [ ] Commit : `docs: refresh residual audit with verified fixes and remaining gaps` ; commits de dépendances séparés si nécessaires.

## Livraison

- [ ] Suite backend complète, tests/builds des trois portails, validation monitoring et recette navigateur fraîches.
- [ ] Revue indépendante globale avant création de la PR ; aucun élargissement architectural silencieux.
