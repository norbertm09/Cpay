# Vague 7

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
