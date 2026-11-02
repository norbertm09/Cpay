# Audit des interfaces web C-Pay — portails et vitrine

Dépôt `/home/user/cpay`, branche `develop`, commit `e8a536e`. Lecture seule (aucun fichier modifié ; `npx vitest run` et `npm run build` exécutés dans `portal/merchant` uniquement).

Périmètre : `portal/merchant` (React 18 + Vite 5), `portal/admin`, `portal/cardholder`, `portal/landing` (HTML/JS statique), et en second plan `portal/partners`, `bank`, `agency`, `agent`. Les configurations de service (`docker/nginx.conf`, `docker/nginx-spa.conf`) et les routes backend ont été consultées uniquement pour vérifier des hypothèses front.

Hors champ (déjà connu) : DNS de `merchant.c-pay.global`, numéros locaux et référence générée en caisse (PR 31), absence volontaire de tarification sur la vitrine, migration Vite récente.

Échelle de sévérité : **P0** bloquant pilote · **P1** à corriger avant ouverture aux marchands · **P2** dette à planifier.

---

## Synthèse

| Sévérité | Nombre | Constats |
|---|---|---|
| P0 | 1 | Pages légales publiées avec des champs « À COMPLÉTER » alors que le consentement marchand s'y adosse |
| P1 | 5 | Mot de passe forcé contournable (marchand, porteur) · jeton admin en localStorage · aucune CSP sur les SPA · création marchand : pays/devise non fiabilisés · injection HTML dans les rapports du portail partenaires |
| P2 | 6 | Double toast 403 · politique de mot de passe incohérente · modales marchand (focus, id dupliqué) · textes téléphone/pays obsolètes · duplication de la couche session · couverture de tests et bundle monolithique |

Notes de maturité : **Marchand B · Admin B · Porteur B · Vitrine C** (détail en fin de rapport).

---

## Constats

### P0-1 — Vitrine : CGU, confidentialité et mentions légales publiées avec des espaces réservés

**Preuve.**
- `portal/landing/legal/mentions-legales.html:50` — bandeau « À COMPLÉTER avant publication » ; lignes 59-65 : capital social, immatriculation, identifiant fiscal, siège, téléphone, directeur de la publication = `[À COMPLÉTER]` ; ligne 83 : statut réglementaire (COBAC/BEAC, BCC) à compléter.
- `portal/landing/legal/cgu.html:50` (bandeau) et `:164` : « régies par le droit de [À COMPLÉTER — pays] … juridictions compétentes de [À COMPLÉTER — ville] ».
- `portal/landing/legal/confidentialite.html:50, 54, 96-101, 116, 128` : adresse du responsable, toutes les durées de conservation, transferts hors UE, autorité de contrôle.
- Ces pages sont la référence du consentement marchand : `portal/merchant/src/pages/auth/Accept.jsx:180` et `:189` pointent vers `https://c-pay.global/legal/cgu.html` / `confidentialite.html`, puis `POST /consent/accept` (`Accept.jsx:165`). Le résumé affiché (`Accept.jsx:178`) annonce « juridictions de Brazzaville » alors que la CGU complète dit « [À COMPLÉTER — ville] » : contradiction visible.
- `scripts/check-landing.py` passe (7 pages, 160 liens) : il ne détecte pas ces marqueurs.

**Impact.** Les marchands du pilote acceptent des CGU et une politique de confidentialité incomplètes et publiquement marquées « à compléter » ; le consentement collecté est fragile et l'image de la plateforme en pâtit (page indexée : `sitemap.xml` liste les trois pages légales).

**Correction.** Faire compléter/valider les trois documents avant le pilote (ce n'est pas une correction de code) ; supprimer les blocs `.notice-todo` et les `span.placeholder` ; aligner le résumé d'`Accept.jsx` sur le texte final ; ajouter dans `check-landing.py` un contrôle qui échoue sur `À COMPLÉTER` / `class="placeholder"` pour que la CI (`.github/workflows/ci.yml:143`) bloque toute régression.

---

### P1-1 — Marchand (et porteur) : le changement de mot de passe forcé se contourne par un simple rechargement

**Preuve.**
- `portal/merchant/src/pages/auth/Login.jsx:113` : si `mustChangePassword`, le jeton d'accès est posé en mémoire et l'écran passe à l'étape « nouveau mot de passe » ; le cookie de refresh `cp_rt_merchant` a déjà été posé par le backend.
- Au rechargement, `hooks/useAuth.jsx:45-52` refait un refresh silencieux, `Guard` (`useAuth.jsx:106-111`) laisse entrer ; `layout/AppShell.jsx:163-165` n'affiche qu'une bannière d'avertissement. Aucune route n'est bloquée.
- Côté API, `temp_password` n'est qu'exposé (`backend/src/routes/merchant.routes.js:298, 387`), aucun middleware ne refuse les opérations (`backend/src/middleware/auth.js` : aucune occurrence).
- Même schéma côté porteur : `portal/cardholder/src/pages/auth/LoginPage.jsx:32` puis simple alerte `pages/home/HomePage.jsx:37`.
- À l'inverse, l'admin fait correctement : `portal/admin/src/App.jsx:33-35` rend `ForcePasswordPage` tant que `admin.mustChangePassword` est vrai (lu depuis `/auth/me`).

**Impact.** Un mot de passe temporaire transmis par un administrateur (`MerchantUsersPage.jsx:18-38`, « mot de passe temporaire affiché une fois ») peut rester le mot de passe définitif d'un compte qui encaisse et retire des fonds.

**Correction.** Reproduire le garde admin : dans `App.jsx`/`AppShell.jsx` marchand, si `user.mustChangePassword` rendre uniquement l'écran de changement (réutiliser le bloc `step === 'password'` de `Login.jsx`). Idem porteur. En défense en profondeur, refuser côté API les routes non-auth tant que `temp_password = TRUE`.

---

### P1-2 — Admin : jeton d'accès persistant en `localStorage`, sans CSP, sur le portail le plus privilégié

**Preuve.**
- `portal/admin/src/services/api.js:7-18` : `admin_token` lu/écrit dans `localStorage` ; même modèle pour `partners/src/App.jsx:13-15`, `bank`, `agency`, `agent` (`App.jsx:16-19`, y compris l'objet utilisateur).
- Marchand et porteur ont migré vers la mémoire (`merchant/src/services/api.js:13-19`, `cardholder/src/services/api.js:20-24`) avec le même mécanisme de refresh par cookie HttpOnly, qui existe déjà pour l'admin (`cp_rt_admin`, `admin/src/services/api.js:48`).
- Le bloc nginx `admin.c-pay.global` (`docker/nginx.conf`, bloc ~lignes 196-227) ne pose ni `Content-Security-Policy` ni `Referrer-Policy`.

**Impact.** Toute XSS (ou extension malveillante) sur `admin.c-pay.global` exfiltre un jeton valable 15 minutes donnant accès aux règlements, à la suspension de marchands, aux réinitialisations de mots de passe.

**Correction.** Aligner `admin/src/services/api.js` sur `merchant/src/services/api.js` (jeton en mémoire, `authListeners`, refresh silencieux au démarrage déjà présent dans `useAuth.jsx:315-322`). Même chantier pour partners/bank/agency/agent. Ajouter une CSP (voir P1-3).

---

### P1-3 — Marchand, admin, porteur : aucune CSP sur les SPA alors que la configuration de build la présuppose

**Preuve.**
- `portal/merchant/vite.config.js:20` et `cardholder/vite.config.js` : « Pas de script inline dans index.html : CSP script-src 'self' » ; `build/index.html` généré est effectivement sans inline (vérifié après `npm run build`).
- Mais aucun en-tête CSP n'est servi : `docker/nginx.conf` bloc `merchant.c-pay.global` (HSTS, nosniff, X-Frame-Options seulement), bloc `admin`, bloc `app./card.c-pay.global` ; `docker/nginx-spa.conf` (conteneur) : idem. Seule la vitrine a une CSP (`nginx.conf`, bloc `c-pay.global`).
- Les SPA utilisent massivement des `style={{…}}` inline (ex. `merchant/src/layout/AppShell.jsx:101`, `admin/src/pages/auth/LoginPage.jsx:142`) et une image `data:` pour le QR 2FA (`merchant/src/pages/compte/Securite.jsx:173`) : une CSP devra en tenir compte.

**Impact.** Pas de seconde ligne de défense contre l'injection de script ; combiné à P1-2 sur l'admin.

**Correction.** Pour chaque bloc SPA : `Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src 'self' https://api.c-pay.global; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'` (puis migrer les `style` inline vers des classes pour retirer `'unsafe-inline'`). Ajouter `Referrer-Policy` et `Permissions-Policy` comme sur la vitrine. Mettre la même CSP dans `nginx-spa.conf` pour que les conteneurs soient protégés même derrière un autre reverse proxy.

---

### P1-4 — Admin : création de marchand — pays jamais déduit du téléphone, devise en texte libre, liste de pays hors périmètre

**Preuve.**
- `portal/admin/src/pages/merchants/MerchantsPage.jsx:94` : `country: 'CM'` par défaut ; `:103` ne retire du payload que les chaînes vides, donc `country` est **toujours** envoyé.
- `MerchantsPage.jsx:128` promet « Le pays peut être détecté à partir de l'indicatif », mais le backend (`backend/src/routes/admin.routes.js:459-461`) n'utilise la détection que si `country` est absent : la promesse n'est jamais tenue.
- `MerchantsPage.jsx:131` : devise saisie en texte libre (3 lettres), sans lien avec le pays.
- `portal/admin/src/utils/format.js:59` : `COUNTRIES` = CM, CG, CD, SN, CI, GA, TD, **BF, ML, TG, BJ, FR** ; il manque **CF et GQ** (CEMAC, pourtant ouverts sur la vitrine) et il expose des pays hors périmètre.

**Impact.** Un marchand de Brazzaville (`+242…`) créé par un opérateur pressé devient `CM / XAF` ; un `CD` saisi avec devise `XAF` crée des incohérences que la caisse remonte ensuite en `CURRENCY_MISMATCH` et fausse le registre de capacités par pays.

**Correction.** Option vide « Déduire du téléphone » par défaut ; détection en direct via `/api/v1/detect/phone` (déjà utilisée côté marchand, `shared.jsx:159-176`) pour préremplir pays et devise ; devise en `Select` alimentée par `/country-defaults` ; liste de pays issue de `capabilitiesApi.publicSummary()` plutôt qu'une constante.

---

### P1-5 — Partenaires : injection HTML dans les rapports imprimés (XSS stockée inter-tenant)

**Preuve.**
- `portal/partners/src/App.jsx:1195-1212` : `t.reference`, `t.agent_name`, `t.type`, `t.status` interpolés sans échappement dans une chaîne HTML puis `win.document.write(html)` (`:1212`) ; idem `:1838-1853` (`a.agent_name`, `a.agency_name`).
- La fenêtre `window.open('', '_blank')` est `about:blank` de même origine que `partners.c-pay.global` ; un script injecté y lit `localStorage` (`pt_token`, `App.jsx:13`).
- Les noms d'agents et d'agences sont saisis par d'autres tenants (banques/agences).
- Le marchand fait correctement la même chose : `portal/merchant/src/utils/actions.js:28-35` (`escHtml` sur chaque valeur).

**Impact.** Un nom d'agent du type `<img src=x onerror=…>` exécute du code dans la session d'un administrateur de banque qui imprime un rapport et vole son jeton.

**Correction.** Réutiliser `escHtml` / construire le DOM avec `textContent`, ou factoriser `printDoc` du marchand dans un module partagé.

---

### P2-1 — Marchand : deux toasts contradictoires sur un 403 `CAPABILITY_NOT_ACTIVE`

**Preuve.** `portal/merchant/src/services/api.js:84` affiche « Accès refusé » pour tout 403 hors routes d'auth ; puis `pages/caisse/Encaisser.jsx:111` et `Retirer.jsx:70` affichent `errorMessage()` → « Non disponible dans votre pays pour le moment ». L'admin a déjà un mécanisme `silent403` (`admin/src/services/api.js:89, 99`).

**Impact.** Message trompeur (« accès refusé ») pour une simple indisponibilité pays.

**Correction.** Dans l'intercepteur, ne pas toaster quand `data.code === 'CAPABILITY_NOT_ACTIVE'` (ou adopter `silent403`).

---

### P2-2 — Politique de mot de passe incohérente entre écrans et portails

**Preuve.** Inscription marchand : 10 caractères (`Register.jsx:36`, backend `merchant.routes.js:404`) ; changement forcé à la connexion : 8 (`Login.jsx:135`) ; page Sécurité : 8 (`Securite.jsx:110`, backend `merchant.routes.js:1964`) ; réinitialisation par lien : 8 + majuscule/minuscule/chiffre (`ResetPassword.jsx:105-110`) ; admin : 10 (`ForcePasswordPage.jsx:207`, backend `admin.routes.js:175`).

**Impact.** Un compte créé avec 10 caractères peut redescendre à 8 sans complexité au premier changement ; messages d'aide divergents (« recommandés » vs règles).

**Correction.** Une règle unique (10 caractères + complexité) implémentée une fois côté API et dans un module `passwordPolicy` partagé par les quatre écrans, avec la liste de règles visuelle de `ResetPassword.jsx`.

---

### P2-3 — Marchand : modales sans piège de focus, id ARIA dupliqué, focus non restitué

**Preuve.** `portal/merchant/src/components/Modal.jsx:116` : `aria-labelledby="dlg-title"` statique ; `:105-112` : Échap et focus initial mais pas de piège Tab ni de restitution du focus à la fermeture. Cas concret de deux dialogues simultanés : `pages/caisse/Retirer.jsx:119` (modale « Modifier mon wallet ») contient `WalletForm` qui ouvre `StepUpModal` (`shared.jsx:217`) → deux `#dlg-title`. L'admin a déjà `useFocusTrap` avec restitution (`admin/src/components/ui.jsx:245-252`).

**Impact.** Navigation clavier/lecteur d'écran dégradée sur les écrans les plus sensibles (confirmation forte).

**Correction.** Porter `useFocusTrap` dans le marchand, générer l'id avec `useId()`.

---

### P2-4 — Marchand : textes et validations téléphone/pays en retard sur la caisse « numéro local »

**Preuve.**
- `utils/errors.js:139` : `INVALID_PHONE` → « format international attendu (ex. +237 6XX XXX XXX) » alors que la caisse accepte le local (PR 31).
- `pages/caisse/shared.jsx:213` : `WalletForm` garde le placeholder `+237 6XX XXX XXX` alors que `phonePlaceholder(country)` existe deux lignes plus haut dans le même fichier (`:146`) ; un marchand congolais voit un exemple camerounais.
- `pages/auth/Register.jsx:33` : regex exige le format international ; `:49` `delete body.country` — le `Select` Pays (`:67`) n'est jamais envoyé, le serveur déduit le pays du téléphone, mais l'UI laisse choisir Côte d'Ivoire / Sénégal (`utils/labels.js:48-51`) et ne renvoie `COUNTRY_NOT_OPEN` qu'à la fin de l'étape 3.

**Impact.** Confusion pour l'utilisateur (quel format saisir ?), inscription qui échoue tardivement pour un pays non ouvert.

**Correction.** Message `INVALID_PHONE` contextualisé par pays ; `phonePlaceholder(user.country)` dans `WalletForm` ; restreindre `COUNTRIES` à l'inscription aux pays ouverts du registre de capacités et valider le pays dès l'étape 1.

---

### P2-5 — Qualité : couche session et messages d'erreur dupliqués en trois variantes divergentes

**Preuve.** `decodeJwt`, refresh single-flight, intercepteurs 401/403 et `errorMessage` existent en trois copies : `merchant/src/services/api.js` + `utils/errors.js`, `admin/src/services/api.js` + `utils/errors.js`, `cardholder/src/services/api.js` + `utils/errors.js`. Divergences : stockage du jeton (P1-2), traitement des 403 (P2-1), `errorMessage` admin renvoie en priorité `data.error` brut du serveur (`admin/src/utils/errors.js:23`) tandis que le marchand traduit d'abord par code. Les portails partners/bank/agency/agent sont des `App.jsx` monolithiques (partners ≈ 2 000 lignes, version affichée « 2.6.0 » `App.jsx:1210`) sans tests.

**Impact.** Chaque correctif de sécurité doit être rejoué sept fois ; les écarts actuels en sont la preuve.

**Correction.** Créer `portal/_shared` (workspace npm) avec `session.js` (jeton mémoire, refresh, intercepteurs paramétrés par `actorType`), `errors.js`, `printDoc`, `Modal` accessible ; migrer progressivement.

---

### P2-6 — Tests, dépendances et bundle

**Preuve.**
- `npx vitest run` dans `portal/merchant` : 4 fichiers, 46 tests verts (`useFinancialIntent`, `financialIntents`, `uncertainPayouts`, `bankAccounts`). Rien sur `Login` (2FA, mot de passe forcé), `Encaisser` (interrogation 3 s / 90 s, états `timeout`/`failed`/`card_unavailable`), `useStepUp`, `errorMessage`. E2E Playwright : 4 tests marchand, 4 admin, 8 porteur (`e2e/tests/*.spec.cjs`). Partners/bank/agency/agent : aucun test (pas de `vitest` dans leurs `package.json`).
- Versions verrouillées (lecture des `package-lock.json`, aucune installation) : axios 1.20.0, react-router-dom 6.30.6, react 18.3.1, vitest 3.2.7, jsdom 26.1.0 — à jour. `vite 5.4.21` : branche 5 en fin de maintenance (Vite 7 courant) ; `esbuild 0.21.5` concerné par l'avis GHSA-67mh-4wv8-2f99 (serveur de développement uniquement, sans impact sur le bundle).
- `npm run build` marchand : un seul chunk `index-*.js` de 448 kB (145 kB gzip) ; aucun découpage par route, tout est chargé pour afficher `/login`.

**Impact.** Régressions possibles sur les parcours d'authentification et de caisse non couverts ; temps de premier affichage sur mobile 3G.

**Correction.** Tests ciblés `Login.test.jsx`, `Encaisser.test.jsx` (timers factices), `useStepUp.test.jsx`, `errors.test.js` ; `React.lazy` par zone dans `App.jsx` ; planifier Vite 6/7 ; ajouter vitest aux quatre portails secondaires.

---

## Points vérifiés qui vont dans le bon sens

1. **Session marchand et porteur solides** : jeton d'accès en mémoire, refresh par cookie HttpOnly `SameSite=Strict`, single-flight pour éviter la révocation par rotation (`merchant/src/services/api.js:52-71`), verrou inter-onglets Web Locks et synchronisation `BroadcastChannel` sans jamais transporter de jeton côté porteur (`cardholder/src/services/api.js:45-113`). Purge des anciens jetons `localStorage` (`merchant/src/App.jsx:37`). Aucun secret ni URL interne dans les bundles (grep des sources : seules les URL publiques `*.c-pay.global`), `sourcemap: false`, outils de développement désactivés hors `REACT_APP_DEV_TOOLS=1` (`utils/dev.js:5`).
2. **Intents financiers persistés** (`hooks/useFinancialIntent.js`) : une clé d'idempotence par opération, liste blanche de champs métier, détection de conflit de paramètres, conservation de la clé sur erreur réseau/serveur, reprise après reconnexion ; 46 tests verts couvrant retrait, transfert et payouts incertains, plus `TransferRecovery` qui rafraîchit sans rejouer de `POST`.
3. **Confirmation forte et anti-double soumission** : retrait, transfert wallet→banque, enregistrement du wallet, ajout/suppression de compte bancaire passent par `useStepUp` + `StepUpModal` avec verrou synchrone (`hooks/useStepUp.js:196-199`), rejeu en cas de 428 et modale verrouillée pendant l'envoi ; toutes les actions destructives (lien, terminal, clé API, secret webhook, annulation de transfert) ont un `ConfirmDialog`.
4. **Vitrine propre techniquement** : DOM construit uniquement par `createElement`/`textContent` (`app.js:26-31`, `assistant.js:43-48`), aucune ressource externe, CSP stricte cohérente avec les deux scripts chargés et l'API (`nginx.conf`, bloc `c-pay.global`), `check-landing.py` vert en CI, formulaires lead/réclamation avec consentement, gestion 400/422/429/réseau et repli e-mail, aucun tarif chiffré et uniquement les pays CEMAC + RDC, `robots.txt`/`sitemap.xml`/`security.txt` présents, images raisonnables (og 108 ko, logo 96 ko).
5. **Admin bien cadré** : routes et menu filtrés par rôle (`layout/guards.jsx`, `layout/nav.js`, `AppShell.jsx:59`), suspension/fermeture/rejet avec motif obligatoire tracé en audit (`MerchantsPage.jsx:82-84`, `MerchantDetailPage.jsx:82-84`, `tabs.jsx:291`), réinitialisation du mot de passe marchand et admin présente avec secret affiché une seule fois (`MerchantUsersPage.jsx:18-38`, `SettingsPages.jsx:187`), changement forcé réellement bloquant (`App.jsx:33-35`), modales avec piège de focus (`ui.jsx:245-252`). Côté marchand, labels/`aria-invalid`/`role="alert"` systématiques (`components/Field.jsx`), barre d'onglets mobile et points de rupture 1023/720/600/480 px (`styles/layout.css`, `components.css`), contraste du texte secondaire `#6b7687` sur blanc ≈ 4,6:1 (AA).

---

## Notes de maturité

| Portail | Note | Justification |
|---|---|---|
| Marchand | **B** | Architecture session/idempotence/step-up de bon niveau et testée ; reste le contournement du mot de passe forcé (P1-1), l'absence de CSP (P1-3), quelques incohérences de texte et d'accessibilité (P2). |
| Admin | **B** | Rôles, confirmations, audit et mot de passe forcé bien faits ; pénalisé par le jeton en `localStorage` sans CSP (P1-2/P1-3) et par la création marchand non fiabilisée (P1-4). |
| Porteur | **B** | Couche session la plus aboutie (verrous inter-onglets), intents de paiement testés ; même faiblesse que le marchand sur le mot de passe forcé, pas de CSP. |
| Vitrine | **C** | Techniquement propre (A/B) mais les trois pages légales sont publiées inachevées et servent de base au consentement (P0-1) ; sans ce point, B+. |

Portails secondaires (partners/bank/agency/agent) : **D** — jetons et profil en `localStorage`, monolithes sans tests, injection HTML dans les rapports (P1-5) ; à ne pas ouvrir au-delà d'un usage interne sans refonte sur le socle partagé.
