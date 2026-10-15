# Audit production 2.6.0 — front-ends (7 portails React + landing)

## 1. Inventaire
| Portail | App.jsx | Particularités |
|---|---|---|
| admin | 3 372 l. | pas de lockfile, pas de `PORT` (collision avec l'API en dev), deux tables i18n, deux instances axios |
| merchant | 4 076 l. + i18n 528 l. | lockfile, access token en mémoire + refresh cookie (seul portail modernisé) |
| cardholder | 3 142 l. | pas de lockfile, `PORT=3002` (même que merchant) |
| partners | 2 650 l. | axios 1.3 / router 6.8 (très datés), Dockerfile propre node:20 `--legacy-peer-deps` |
| bank / agency / agent | 263 / 244 / 347 l. | `package.json` copié de merchant (nom `cplus-2-6-merchant-portal`), `i18n.js` copié mais jamais importé, **absents du docker-compose** |
| landing | statique | index, developers, legal/*, downloads (APK debug 30 Mo, 2 zips), security.txt, robots, sitemap |

Tous sur **Create React App 5.0.1** (abandonné), `CI=false` pour ignorer les warnings, aucun test, `favicon.ico` absent partout (404 à chaque chargement). Fichiers `.bak` dans `src/` (8 fichiers de 200-250 Ko), fonts et logo dupliqués 7 fois.

**Déploiement** : nginx ne déclare aucun `server_name` pour `c-pay.global` (landing) ni `partners.c-pay.global` (pourtant affiché dans admin et partners) ; certbot ne couvre pas `app.`, `card.`, `partners.` ; on ne peut pas confirmer comment landing et partners sont servis.

## 2. Sécurité
- **Tokens en `localStorage`** : admin, cardholder, partners, bank, agency, agent (merchant seul en mémoire + cookie). Régressions merchant : `Register` écrit encore `localStorage.merchant_token` (l.1653) → après inscription, renvoi sur `/login` ; bouton ⏻ (l.1345) ne déconnecte pas (token mémoire conservé, pas de `/auth/logout`).
- **Décodage JWT `atob` sur base64url** (admin:102, cardholder:24, merchant:31) → `isAuth=false` aléatoire selon le contenu.
- **403 jamais géré** ; refresh nulle part sauf merchant ; logout serveur appelé par merchant seulement (admin et cardholder ont l'endpoint mais ne l'appellent pas).
- **Boucle de redirection** bank/agency/agent : l'intercepteur 401 ne purge que `*_token`, `AuthProvider` relit `*_user` → `/login` → `/` → 401 → … (vérifié).
- **Fuite du secret TOTP vers un tiers (P0)** : partners:1290 envoie l'URI `otpauth://…?secret=` à `https://api.qrserver.com`. merchant envoie aussi les URLs de paiement à qrserver (1135, 3199, 3350).
- **APK debug public** : `landing/downloads/cplus-v2.6.0-debug.apk`, signé avec la clé debug, non lié mais servi à quiconque connaît l'URL ; `public/download/index.html` (merchant/bank/agency/agent) pointe vers un APK inexistant et vers Play Store `africa.calculus.plus` alors que l'app est `global.cpay.app`.
- CSP seulement sur le vhost API ; bloc `app/card` sans aucun en-tête ni `ssl_protocols` ; `partners/nginx.conf` sans en-tête ; rate-limit nginx auth ne couvre pas cardholder/partners/bank/agency/agent.
- **Pages légales = placeholders** en production (« À COMPLÉTER », `[ADRESSE COMPLÈTE]`, `[RCS…]`, `[PAYS]`) ; `cgu.html` lie `/legal/privacy.html` inexistant (9 liens morts au total).
- Email super-admin codé en dur (`admin@cplus.africa`, admin:3186 et placeholder de login) ; dashboard admin avec courbe `Math.random()` (admin:408) ; bannière 2FA merchant lit `mfa_enabled` que personne n'écrit.

## 3. Bugs vérifiés
- 10 promesses sans `catch` (admin:620,702 ; cardholder:997,1155,1314 ; merchant:1953,2110,2441,2915,3147) ; spinner infini dashboard admin si `/stats/global` échoue.
- Race conditions sur toutes les listes paginées (aucune annulation dans admin/bank/agency/agent).
- Formulaires sans `<form>` : touche Entrée inopérante sur les logins admin, cardholder, partners, bank, agency, agent.
- Tickets admin : `limit:100` puis filtre client → au-delà de 100 tickets, invisibles.
- Page « Porteurs » agency affiche le nombre d'agents.
- Duplication : `Guard`, `Badge`, `Spin`, `Btn`, `Inp`, `Layout`, `Login`, `Dashboard` définis dans les 7 fichiers ; ~15-20 % de copier-coller exact, ~40-50 % de code fonctionnellement dupliqué.

## 4. Contrat API — appels vers des routes inexistantes
- **admin** : `GET /cardholders`, `/cardholders/:id`, `/cardholders/:id/kyc-documents`, `PATCH /cardholders/:id/kyc` (module Porteurs non fonctionnel) ; `PUT /admin/merchants/:id/fees|velocity` (préfixe doublé) ; `POST /api-configs` ; `GET /settlements/:batchId/transactions`.
- **merchant** : `GET /settlements/:batchId/transactions` ; `PATCH /account` (backend `PUT`) ; `PATCH /terminals/:id/status`.
- **cardholder** : `POST /auth/2fa/disable` ; `GET /pay-links/:shortId` et `/merchant-info/:id` (scan QR dégrade silencieusement).
- **partners** : `POST /auth/forgot-password|reset-password` (flux « mot de passe oublié » cassé) ; `PATCH /users/:id/agency`.
- bank/agency/agent : tous présents.

## 5. Landing
SEO correct (title, OG, sitemap). Liens morts : `/legal/privacy.html`, `cplus-android-project-v2.6.0.zip`, `wa.me/242000000000` (placeholder). **Trois marques coexistent** : « C-Pay » (title), « CPlus » (developers, 33 occurrences), « Calculus Plus » (logo, CGU, placeholder admin, id Play Store). Archives publiées sans checksum ni signature.

## 6. Recommandations
**P0** : retirer l'APK debug ; générer le QR 2FA côté serveur (partners) et faire tourner les secrets TOTP partenaires ; corriger la boucle de redirection bank/agency/agent et les régressions auth merchant ; compléter les pages légales ; corriger les 14 appels vers des routes inexistantes.
**P1** : généraliser le modèle merchant (mémoire + cookie + logout serveur) à tous ; `/auth/me` au lieu d'`atob` ; CSP et en-têtes sur tous les vhosts ; décider du sort de bank/agency/agent ; `catch` et annulation systématiques ; `<form onSubmit>` ; nettoyage (`.bak`, i18n morts, double axios, console.log, favicon, marque unique).
**P2** : sortir de CRA vers Vite en mono-repo (`packages/ui`, `auth`, `i18n`, `consent-2fa`) avec apps minces par rôle ; client API typé généré depuis le Swagger ; publication des archives via releases signées.
