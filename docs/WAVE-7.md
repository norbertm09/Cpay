# Vague 7 — suite de l'audit résiduel des lots 5B, 5C et 6 (branche `wave-7`)

Audit de référence : `docs/AUDIT-RESIDUEL-LOTS-5B-5C-6.md`. Cette vague traite les points laissés
ouverts : Nodemailer de production (P1 high), scénario SMTP `535` des alertes, runbook du fichier de
scrape Prometheus (section « Backend »), la session du portail porteur et la migration des six autres
portails (sections suivantes, rédigées par leurs lots respectifs). Aucun déploiement ni activation de production ne découle de ce document.

## Backend

### Nodemailer 9.1.1 → 10.1.7 (P1 : GHSA-6vj9-mwq6-2f5v, GHSA-v53p-9fqp-m79j)

`backend/package.json` : `nodemailer ^10.1.7` ; `package-lock.json` mis à jour sans `--force`,
`npm ci --dry-run` cohérent. Nodemailer 10 exige Node ≥ 20 : l'image `docker/Dockerfile.api` est en
`node:22-alpine`, la CI en Node 22.

Changements d'API 10.x examinés (CHANGELOG 10.0.0 → 10.1.7) et traitement :

| Changement | Impact C-Pay | Traitement |
|---|---|---|
| Réécriture TypeScript, double build ESM + CommonJS (`exports`) | `require('nodemailer')` conservé ; les sous-chemins `lib/*` sont remappés | Aucun sous-chemin utilisé ; point d'entrée CJS vérifié (`createTransport`, `createTestAccount`, `getTestMessageUrl`) |
| `createTransport(options)`, `verify()`, résultat de `sendMail` (`messageId`, `accepted`, `rejected`, `response`, `envelope`) | Inchangés | Le service notifications renvoie désormais aussi `rejected` et `response` |
| `requireTLS` réellement honoré (10.0.12), contradiction `ignoreTLS`/`opportunisticTLS` refusée | Nos transports posent `requireTLS: true` : STARTTLS obligatoire, jamais de repli en clair | Conservé ; test fixture « certificat non reconnu » |
| Attente du greeting imputée à `connectionTimeout` (10.1.0, défaut 2 min) | Un relais injoignable bloquait longtemps un envoi métier | Délais bornés dans la fabrique commune : connexion 10 s, greeting 10 s, socket 30 s |
| Toute réponse `421` clôt la session ; un second `connect()` est refusé | Sans effet sur un transport simple non poolé | — |
| Cache DNS global ne réutilise plus `tls.servername` (GHSA-6vj9) ; `addressparser` linéaire (GHSA-v53p, GHSA-prgh, GHSA-8vvx, GHSA-g57g) ; `mime-node`, `fetch`, SASL durcis | Correctifs de sécurité absorbés | Aucune adaptation : adresses fournies par le backend, pas de `fetch` d'URL distante |
| `dkim`, pièces jointes, `maxRecipients` | Non utilisés | — |
| Rien n'est lu dans l'environnement à l'import (10.1.0) | Sans effet : la configuration est lue à la création du transport | — |

Code modifié :

- **Nouveau** `backend/src/services/notifications/smtp-transport.js` : fabrique unique
  `buildTransportOptions` / `createSmtpTransport` (TLS implicite seulement sur 465, STARTTLS forcé
  sinon, certificat toujours vérifié via `config/smtp-tls.js`, délais bornés) et `describeSmtpError`
  (code Nodemailer, code de réponse SMTP, commande, message court ; séquences base64 masquées ; `535`
  → `EAUTH`, non réessayable).
- `backend/src/services/notifications/email.service.js` : utilise la fabrique ; `send()` et
  `testConnection()` lèvent une erreur normalisée (`code`, `responseCode`, `retryable`, `cause`) ;
  `resetTransport()` ajouté (rotation des identifiants, tests).
- `backend/src/services/email.service.js` (historique, alertes ops, mots de passe) : utilise la
  fabrique ; **correction** : `secure` suit le port (l'ancien `secure: true` figé rendait
  `SMTP_PORT=587` inutilisable) ; journal d'erreur avec code et sans secret.
- `backend/src/routes/admin.routes.js` : `POST /notification-configs/test` et `/send-test` (section
  `smtp`) passent par la même fabrique (TLS vérifié, délais) ; une erreur renvoie `400` avec
  `{ code, responseCode, retryable, error }` — un `535` est explicite et jamais retenté ; transport
  fermé après usage ; `send-test` renvoie `messageId` et `accepted`.

Les mots de passe temporaires (admin, partenaires) restent remis une seule fois dans la réponse API et
ne sont pas envoyés par e-mail (comportement existant, inchangé).

Tests ajoutés (transport mocké et vrai relais local) :

- `backend/src/tests/wave7-email.test.js` (12 tests, Nodemailer mocké) : fabrique, description
  d'erreur, service notifications (forme du résultat, cache du transport, `535`, configuration
  manquante, bienvenue marchand, réinitialisation), service historique (alertes ops, 465/587,
  absence de `SMTP_PASS`), `cash.notifyBeneficiaryChange` (wallet modifié, échec sans exception),
  routes admin `test` / `send-test`.
- `backend/src/tests/wave7-smtp-fixture.test.js` (8 tests) : réutilise
  `monitoring/tests/smtp-fixture.cjs` (SMTP loopback, STARTTLS obligatoire, certificat généré par
  OpenSSL à l'exécution, aucun secret versionné). Livraison réelle après STARTTLS + AUTH pour les deux
  services, `535` (erreur `EAUTH`/535 claire sans secret, exactement un `AUTH`, rien de livré),
  certificat non reconnu (aucun `AUTH`, aucun repli), et `POST /admin/notification-configs/test`
  contre ce relais (200, 400 `EAUTH`/535, 400 TLS).

Les suites existantes (`security-first-lot`, mocks `nodemailer` et `email.service`) passent sans
modification.

### Résultats `npm audit` (backend, après `npm ci`)

| Mesure | Avant (audit résiduel) | Après vague 7 |
|---|---|---|
| `--omit=dev` : critical / high / moderate / low | 0 / 1 / 0 / 0 (nodemailer) | **0 / 0 / 0 / 0** |
| toutes dépendances : critical / high / moderate / low | 0 / 31 / 5 / 0 | 0 / 30 / 5 / 0 |

`npm audit --omit=dev --audit-level=high` : aucun constat. Les 35 alertes restantes concernent
uniquement les dépendances de développement (`jest` 29 et sa chaîne `@jest/*`, `babel`, `micromatch`
etc. ; `nodemon` et sa chaîne) : outillage de test local, absent de l'image de production
(`npm ci --omit=dev` dans `Dockerfile.api`). Leur résolution impose des majeures (`jest` 30,
`nodemon` 3.x récent) non triviales ; elles sont listées, non corrigées dans cette vague. Les
nombres dépendent des avis du registre à la date de mesure (21 octobre 2026).

Point ouvert : la CI backend exécute `npm audit --omit=dev --audit-level=critical` en informatif
(`continue-on-error`) ; le passer en bloquant au niveau `high` est désormais possible et relève du
lot CI (fichier partagé avec les travaux portails de cette vague).

### Supervision (suite du lot 5B)

- **Scénario SMTP `535`** : `monitoring/tests/smtp-fixture.cjs` compte les refus d'authentification
  (`authFailures`) ; `monitoring/tests/alert-delivery.test.cjs` ajoute le scénario « mauvais
  identifiants » avec le vrai Alertmanager 0.34.1 : fichier mot de passe erroné, aucun message
  livré, erreur `535` dans le journal (jamais le secret), compteurs
  `alertmanager_notification_requests_failed_total` puis `alertmanager_notifications_failed_total`
  (`integration="email"`), nouvelles tentatives bornées par le backoff (≤ 10 `AUTH` / 5 s), `AUTH`
  uniquement après STARTTLS. Recette : `node --test monitoring/alertmanager/config.test.cjs
  monitoring/tests/alert-delivery.test.cjs` → **15/15**.
- **Runbook Prometheus** (`docs/LOT-5B-ALERTES.md`, section « Scrape Prometheus : fichier secret
  `metrics_token` ») : correspondance `METRICS_TOKEN` (backend) ↔ `MONITORING_METRICS_TOKEN_FILE`
  (hôte, validé par le générateur) ↔ `/etc/prometheus/secrets/metrics_token` (conteneur,
  `credentials_file`), propriétaire/permissions (`65534`, `0400`/`0440`), rotation, cinq commandes de
  vérification sans affichage du token. Le générateur valide le fichier mais **ne configure pas
  Prometheus** : c'est écrit explicitement.
- **Nouveau** `monitoring/docker-compose.monitoring.yml` : référence (non démarrée par le compose
  applicatif ni `deploy.sh`) montant le token sur `/etc/prometheus/secrets/metrics_token:ro`, la
  configuration Alertmanager générée, le mot de passe SMTP et le template aux mêmes chemins absolus
  que sur l'hôte, Prometheus/Alertmanager sous l'uid `65534`, réseau applicatif externe. À valider par
  `docker compose config` et `promtool check config` dans le conteneur avant toute activation.

### Validation

`cd backend && npm test` : **38 suites / 797 tests verts** (36/777 avant). `node --check` sur les
fichiers touchés. `npm ci --dry-run` sans écart. Monitoring 15/15 avec l'Alertmanager officiel
(`node scripts/fetch-alertmanager.cjs`, SHA256 vérifié).

## Session porteur (`portal/cardholder`)

Audit résiduel P2 : le jeton d'accès du portail porteur vivait dans `localStorage` (`ch_token`),
donc exfiltrable par tout XSS et persistant au-delà de l'onglet. Le portail adopte le modèle du
portail marchand.

### Modèle

| Élément | Avant | Après (vague 7) |
|---|---|---|
| Jeton d'accès (JWT 15 min) | `localStorage.ch_token` | **mémoire du module `services/api.js` uniquement** |
| Refresh | cookie HttpOnly `cp_rt_cardholder` (inchangé) | idem : `Path=/api/v1/cardholder/auth`, `SameSite=Strict`, `Secure`, rotation + détection de réutilisation (backend, lecture seule) |
| Démarrage | lecture du jeton persisté | `POST /cardholder/auth/refresh` silencieux (cookie seul) -> jeton en mémoire -> `GET /auth/me` ; échec = anonyme, sans redirection forcée |
| 401 sur route protégée | refresh single-flight + rejeu | idem, échec -> `/connexion` |
| Déconnexion | `POST /auth/logout` + suppression `localStorage` | `POST /auth/logout` (Bearer + cookie, révocation serveur + cookie effacé) + purge mémoire + diffusion aux autres onglets |
| Multi-onglets | aucun | `BroadcastChannel('cpay-cardholder-session')` : `logout` -> les autres onglets purgent et reviennent à `/connexion` ; `login` -> un onglet anonyme obtient son propre jeton par refresh. Repli sans `BroadcastChannel` : évènement `storage` sur la clé `cpay-cardholder-session` (type + horodatage, jamais de jeton) |
| Refresh concurrent entre onglets | — | verrou `navigator.locks('cpay-cardholder-refresh')` autour de l'appel : le backend révoque **toutes** les sessions sur réutilisation d'un refresh déjà tourné (`REFRESH_REUSED`), deux onglets restaurés en même temps doivent donc se rafraîchir l'un après l'autre |
| Expiration pendant l'inactivité | 401 sur la requête suivante | `visibilitychange` : onglet revenu au premier plan avec un jeton expirant sous 90 s -> refresh anticipé (échec -> déconnexion locale) |

Fichiers : `src/services/api.js` (jeton mémoire, canal, verrou, `logoutServer`/`logoutLocal`),
`src/hooks/useAuth.jsx` (refresh au démarrage, abonnements canal/visibilité, `signOut`),
`src/pages/auth/LoginPage.jsx` et `RegisterPage.jsx` inchangés (`setToken` garde sa signature, il
diffuse maintenant `login`). Plus aucun `localStorage` dans `src/` : seul `sessionStorage` reste,
pour l'intention de paiement (`hooks/usePaymentIntent.js` : clé d'idempotence, marchand, montant,
description — vérifié : ni PIN ni jeton), inchangée et toujours couverte par ses tests.

### CSRF

Les appels avec état (`POST`/`PATCH`/`DELETE`) exigent l'en-tête `Authorization: Bearer` que seul le
JavaScript de l'origine du portail peut poser ; un formulaire cross-site ne le peut pas. Les deux
seules routes qui reposent sur le cookie (`/auth/refresh`, `/auth/logout`) sont protégées par le
cookie lui-même : `SameSite=Strict` (aucune requête initiée par un autre site ne l'emporte, même en
navigation de premier niveau) et `Path=/api/v1/cardholder/auth` (le cookie ne voyage vers aucune autre
route, y compris les sous-domaines de paiement). Défense en profondeur : `X-Requested-With:
XMLHttpRequest` est ajouté sur ces deux appels. Le backend utilise `cors()` **sans** `allowedHeaders`
(`backend/src/server.js`), donc le paquet `cors` reflète `Access-Control-Request-Headers` en preflight
et l'en-tête passe ; `dev/mock-api.js` l'autorise explicitement. Un navigateur ne peut pas poser cet
en-tête sans preflight CORS, qu'une origine non listée dans `ALLOWED_ORIGINS` échoue.

### Mock et recette

`dev/mock-api.js` : la connexion posait déjà le cookie et `/auth/refresh` répondait déjà au cookie
(rotation) ; ajout de `MOCK_STATIC=build` (sert le bundle en repli SPA avec la CSP
`script-src 'self'`, même origine donc cookie de refresh fonctionnel) et de `X-Requested-With` dans
`Access-Control-Allow-Headers`. Recette Playwright sur le build servi par le mock (mobile 390 px) :
connexion -> aucune clé dans `localStorage`, cookie `cp_rt_cardholder` HttpOnly à `Path=/api/v1/cardholder/auth`
-> rechargement : refresh silencieux, profil affiché -> second onglet connecté seul -> déconnexion
onglet 1 : onglet 2 revient à `/connexion`, cookie effacé -> rechargement : anonyme. Captures : connexion,
accueil, payer.

### Migration Vite (même convention que les six autres portails)

- `package.json` : `react-scripts` et `typescript` retirés (TypeScript n'était là que pour CRA),
  `vite ^5.4.21`, `@vitejs/plugin-react ^4.7.0`, `vitest ^3.2.4`, `jsdom ^26.1.0` ; scripts
  `dev`/`start`/`build`/`preview`/`test` (`vitest run`) ; `proxy` et `browserslist` CRA supprimés ;
  lockfile régénéré (`npm ci` passe, 170 paquets contre ~1 350).
- `vite.config.js` : `base '/'`, `build.outDir 'build'`, `sourcemap false`,
  `modulePreload.polyfill false` (aucun `<script>` inline dans `build/index.html`, vérifié : un seul
  `<script type="module" src="/assets/…">`), `envPrefix ['VITE_','REACT_APP_']` (l'argument de build
  `REACT_APP_API_BASE_URL` du Dockerfile/CI reste valable), `server.port 3003`, `server.proxy /api`
  -> `http://localhost:3000` (surchargeable par `API_PROXY_TARGET`, ex. le mock), `test` jsdom + globals.
  Pas de `define process.env` ni de loader `.js -> jsx` : le seul `.js` avec JSX était `src/index.js`,
  renommé `src/index.jsx` ; tous les composants étaient déjà en `.jsx`.
- `index.html` déplacé de `public/` à la racine (`%PUBLIC_URL%/x` -> `/x`, `<script type="module"
  src="/src/index.jsx">`), icônes/logo/police restent dans `public/`.
- `process.env.REACT_APP_*` -> `import.meta.env.REACT_APP_*` (`services/api.js`, `utils/features.js`,
  accès dynamique conservé : Vite remplace `import.meta.env` par l'objet complet).
- Tests : `jest.*` -> `vi.*` (`usePaymentIntent.test.jsx`, `PayPage.test.jsx`), `require('crypto')`
  -> `import { webcrypto } from 'node:crypto'`, mock de module par défaut `{ default }`. 16 tests verts.
- Build : `build/index.html` (1,15 kB), `build/assets/index-*.js` (379 kB, 120 kB gzip),
  `build/assets/index-*.css` (37 kB), icônes et police copiées depuis `public/`.

### Points ouverts (hors périmètre `portal/cardholder`)

- `docker/Dockerfile.portal` ne copie que `public/` et `src/` : il doit aussi copier `index.html` et
  `vite.config.js` (et peut abandonner `INLINE_RUNTIME_CHUNK`, `GENERATE_SOURCEMAP`, `CI=false`).
- `.github/workflows/ci.yml` : l'étape de tests passe `-- --watchAll=false --runInBand` (options Jest) ;
  avec `vitest run` il faut un simple `npm test`. Le commentaire « Build (react-scripts) » est obsolète.
- `backend/src/server.js` : `ALLOWED_ORIGINS` par défaut liste `localhost:3001` et `3002` ; le portail
  porteur en dev Vite écoute sur `3003` (sans conséquence si l'on passe par le proxy Vite, même origine).
- Le mock pose le cookie en `SameSite=Lax` (dev http), la production est en `Strict` côté backend.
- Vite affiche « The CJS build of Vite's Node API is deprecated » car `vite.config.js` (ESM) est chargé
  depuis un paquet sans `"type": "module"` (`dev/mock-api.js` est CommonJS) : avertissement sans effet.

## Portails (`portal/merchant`, `admin`, `partners`, `bank`, `agency`, `agent`)

Audit résiduel P2 : les six portails étaient construits par Create React App 5 (`react-scripts 5.0.1`,
non maintenu, dépendances transitives vulnérables : webpack 5 figé, `nth-check`, `postcss`, `svgo`…).
Ils passent à **Vite 5** avec la même convention que le portail porteur (ci-dessus) ; rien ne change
pour les consommateurs du bundle : `docker/Dockerfile.portal`, `docker/nginx-spa.conf`, la CI,
`e2e/serve-portals.cjs` et les `dev/mock-api.js` lisent toujours `build/`.

### Par portail

| Portail | Fichiers renommés `.js` → `.jsx` | `process.env` → `import.meta.env` | Tests | Lockfile | `server.port` |
|---|---|---|---|---|---|
| merchant | 1 (`src/index.js`) | `services/api.js`, `utils/dev.js` | 4 fichiers, 46 tests → vitest | régénéré | 3002 |
| admin | 1 (`src/index.js`) | `services/api.js`, `layout/AppShell.jsx` | 2 fichiers, 25 tests → vitest | **créé** (absent avant) | 3004 |
| partners | 1 (`src/index.js`) | `App.jsx` (3 occurrences) | — | régénéré | 3005 |
| bank | 1 (`src/index.js`) | `App.jsx` | — | **créé** | 3002 (valeur du `start` CRA) |
| agency | 1 (`src/index.js`) | `App.jsx` | — | **créé** | 3002 (idem) |
| agent | 1 (`src/index.js`) | `App.jsx` | — | **créé** | 3002 (idem) |

Seul `src/index.js` contenait du JSX dans chaque portail (tous les composants étaient déjà en `.jsx`) ;
les autres `.js` (hooks, services, utils, `nav.js`, `i18n.js`, `components/index.js`) sont du JS pur et
gardent leur extension — vérifié par le build Vite (esbuild refuse le JSX dans un `.js`).

### Décisions communes

- `package.json` : `react-scripts` retiré ; `ajv` (merchant, partners : n'était là que pour CRA) et
  `typescript 4.9.5` (admin : aucun `.ts`) retirés ; `proxy` et `browserslist` CRA supprimés.
  Dev-deps : `vite ^5.4.21`, `@vitejs/plugin-react ^4.7.0` (+ `vitest ^3.2.4`, `jsdom ^26.1.0` pour
  merchant et admin). Scripts `dev`/`start` (`vite`), `build` (`vite build`), `preview`, `test`
  (`vitest run`, merchant/admin), `mock` conservé (admin). Les six lockfiles sont régénérés ou créés :
  `npm ci` passe partout (94 à 170 paquets contre ~1 350 avec CRA).
- `vite.config.js` (identique à un port près) : `base '/'`, `envPrefix ['VITE_','REACT_APP_']`,
  `server.proxy /api -> http://localhost:3000`, `build.outDir 'build'`, `build.sourcemap false`
  (ex-`GENERATE_SOURCEMAP=false`), `build.modulePreload.polyfill false` (ex-`INLINE_RUNTIME_CHUNK=false` :
  aucun `<script>` inline, CSP `script-src 'self'`) ; bloc `test` jsdom + globals pour merchant/admin.
- `public/index.html` -> `index.html` à la racine, `%PUBLIC_URL%/x` -> `/x`, entrée
  `<script type="module" src="/src/index.jsx">` ; icônes, logo, polices et `download/index.html`
  restent dans `public/` (copiés tels quels dans `build/`).
- Version affichée dans la barre latérale admin : `require('../../package.json').version` ->
  `import { version as appVersion } from '../../package.json'` (import JSON Vite, tree-shaké au
  champ `version`) ; `REACT_APP_VERSION` garde la priorité.
- Tests merchant/admin : `jest.*` -> `vi.*` ; la seule fabrique `jest.requireActual` devient une
  fabrique `async` avec `await vi.importActual` (`merchant/src/pages/compte/bankAccounts.test.jsx`).
  Les fabriques ne lisent les variables `mock*` que paresseusement, donc le hissage de `vi.mock`
  au-dessus des `import` ne pose pas de TDZ. 71 tests verts (46 merchant, 25 admin).
- `docker/Dockerfile.portal` : `npm ci` (tous les portails ont un lockfile), copie
  `${APP_DIR}/index.html` et `${APP_DIR}/vite.config.js` en plus de `public/` et `src/`,
  suppression de `INLINE_RUNTIME_CHUNK` et `GENERATE_SOURCEMAP` (portés par `vite.config.js`),
  `CI=false` conservé (sans effet), `NODE_OPTIONS` conservé ; sortie `build/` -> nginx inchangée.
  `portal/partners/Dockerfile` (image dédiée) aligné de la même façon (plus d'`ajv`, `npm ci`).
- `.github/workflows/ci.yml`, job `portals` : `npm ci` systématique (`cache-dependency-path` sur
  `package-lock.json`), tests `npm test` (vitest, plus d'options Jest), build `npm run build` avec
  seulement `REACT_APP_API_BASE_URL`, artefact `build/` inchangé, Node 20 conservé ; job
  `browser-recipes` : `CI=false` retiré (sans effet avec Vite).
- README merchant/admin et commentaires `dev/mock-api.js` : `npm run dev`, `npm run build`,
  `npm test`, `MOCK_STATIC=build` / `--static build` servent le build Vite.

### Vérification

Pour chacun des six portails : `npm ci` puis `npm run build` (0 erreur ; seul avertissement : chunk
admin > 500 kB, comme le bundle CRA, non bloquant), `build/index.html` sans corps de `<script>`
inline (un seul `<script type="module" crossorigin src="/assets/index-*.js">`), tests verts
(merchant, admin). Rendu : build servi par `dev/mock-api.js` (même origine) et captures Chromium
headless 1366 px — merchant connexion (`--no-session`) et accueil, admin connexion (`MOCK_SESSION=none`)
et tableau de bord (console vide) ; partners, bank, agency, agent : build servi par
`e2e/serve-portals.cjs`, chargé dans Chromium headless (`--enable-logging=stderr`) : aucune erreur de
module ni d'exécution, `#root` rendu (formulaire de connexion). Tous les `build/` ont été supprimés.
La première capture admin a révélé une régression (import de version manquant,
`ReferenceError: appVersion`), corrigée avant livraison : la recette visuelle reste indispensable.

### Points ouverts

- `server.port` de bank/agency/agent = 3002 comme merchant (reprise de leurs scripts `start` CRA qui
  étaient déjà en doublon) : à distinguer si l'on veut lancer plusieurs portails en dev simultanément.
- `docs/CI-CD.md` (ligne « portals ») décrit encore `CI=false INLINE_RUNTIME_CHUNK=false` et « seuls
  merchant et partners ont un lockfile » ; `docs/audit-prod-2.6.0/03-portails-landing.md` cite CRA.
- Avertissement « The CJS build of Vite's Node API is deprecated » à chaque `vitest`/`vite` : le
  `package.json` des portails n'a pas `"type": "module"` car `dev/mock-api.js` est CommonJS ; renommer
  `vite.config.js` en `.mjs` le ferait taire mais le Dockerfile copie `vite.config.js` pour les 7 portails.
- `react-dom/test-utils` (`Simulate`) est déprécié en React 18.3 ; fonctionne encore sous vitest/jsdom.
