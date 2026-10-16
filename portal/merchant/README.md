# C-Pay — Espace marchand (`portal/merchant`)

Portail React 18 (Create React App, react-router 6, axios, react-hot-toast, qrcode.react) servi sur
`merchant.c-pay.global`. Il aide le marchand à **encaisser** ses recettes (Mobile Money, carte par lien ou QR),
à tenir sa **caisse** (retirer, transférer, journal) et lui donne une **vue à 360°** de son activité.

```bash
npm ci
npm start                                   # http://localhost:3002, API via REACT_APP_API_BASE_URL (ou proxy localhost:3000)
CI=false npm run build                      # bundle de production dans build/
```

Variables : `REACT_APP_API_BASE_URL` (origine de l'API, vide = même origine), `INLINE_RUNTIME_CHUNK=false`
(CSP, voir `docker/Dockerfile.portal`), `REACT_APP_DEV_TOOLS=1` (préremplissage par paramètres d'URL, réservé
au développement et aux captures d'écran ; jamais en production).

## Architecture de l'information

Une entrée par capacité, aucun doublon. Les anciennes adresses redirigent (`src/layout/nav.js`).

| Zone | Route | Contenu | Anciennes routes |
|---|---|---|---|
| **Accueil** | `/` | Solde disponible / en attente, encaissé aujourd'hui et sur 7 jours (par moyen), règlement à venir, graphique 7/30 jours, liste de mise en route (KYB, wallet, banque, 2FA, webhook), dix dernières opérations, actions rapides | `/dashboard`, `/caisse` |
| **Caisse** | `/caisse/encaisser` · `/caisse/retirer` · `/caisse/transferer` | Flux de la vague 4 (détection d'opérateur, interrogation 3 s / 90 s, confirmation forte, bordereau d'approvisionnement) | `/operations`, `/withdraw` |
| **Activité** | `/activite/journal` · `/activite/reglements` | Journal unifié (filtres, totaux, export CSV, tiroir de détail avec reçu / impression / SMS) ; règlements par journée et par lot | `/transactions`, `/caisse/journal`, `/settlements` |
| **Outils de vente** | `/ventes/liens` · `/ventes/terminaux` · `/ventes/tap-to-phone` | Liens & QR (création, envoi SMS/WhatsApp, annulation, statistiques) ; terminaux (code d'appairage, régénération, désactivation) ; Tap-to-Phone : page d'information honnête | `/pay-links`, `/terminals`, `/tap-to-phone` |
| **Intégrations** | `/integrations/cles-api` · `/integrations/webhooks` · `/integrations/plugins` · `/integrations/connecteurs` | Clés API (secret affiché une fois), webhook (URL, secret affiché une fois, test, en-têtes `X-CPay-*`), plugins & SDK 2.7.0, connecteurs comptabilité / CRM / ERP | `/api-keys`, `/integrations` |
| **Compte** | `/compte/profil` · `/compte/comptes` · `/compte/tarifs` · `/compte/securite` · `/compte/support` | Profil & documents KYB, comptes bancaires & wallet, tarifs & frais (grille indicative, simulateur, plafonds), mot de passe & 2FA, tickets de support | `/account`, `/support` |
| Auth | `/login`, `/register`, `/forgot-password`, `/reset-password`, `/accept` | Connexion (2FA, mot de passe temporaire), inscription en trois étapes, réinitialisation, acceptation des CGU | — |

Sur mobile : barre d'onglets (Accueil, Activité, Caisse, Ventes, Plus) et sous-navigation par zone ; sur
ordinateur : barre latérale repliable.

## Code

```
src/
  App.jsx               routeur (fin) + redirections héritées
  services/api.js       couche axios (token en mémoire, refresh cookie cp_rt_merchant single-flight, 401 -> refresh, 403 -> toast)
                        espaces : authApi, consentApi, cashApi, detectApi, activityApi, salesApi, integrationsApi, accountApi
  hooks/                useAuth (AuthProvider, Guard), useAsync, useCashSummary, useStepUp, usePagination, useDebounce, useMediaQuery
  components/           système de design : Button, Card, Stat, Badge, Field/Input/Select/Textarea/AmountInput/OtpInput, Modal/Drawer/
                        ConfirmDialog, Table (cartes sur mobile), EmptyState/ErrorState/FeatureUnavailable, Skeleton, Tabs, PageHeader,
                        Notice, Segmented, KeyValue, Pagination, StepUpModal, Toast, Icon (~60 pictogrammes), charts/BarChart, charts/Sparkline
  layout/               AppShell (barre haute, barre latérale, onglets mobiles, bannières 2FA / mot de passe temporaire, garde CGU),
                        AuthLayout, Brand, nav.js
  pages/<zone>/         un fichier par écran
  utils/                format (montants, dates FR relatives + absolues, téléphone), errors (code -> message, FEATURE_DISABLED),
                        labels (statuts, types, opérateurs), actions (copier, partager, imprimer, télécharger), dev
  styles/               tokens.css, base.css, components.css, layout.css (CSS brut, aucune bibliothèque d'interface)
dev/mock-api.js         API factice (Node, sans dépendance)
```

Seules les routes existantes du backend sont appelées (`backend/src/routes/merchant.routes.js`,
`cash.routes.js`, `server.js` pour `/consent/*` et `/detect/phone`). Une réponse `410 FEATURE_DISABLED` ou `404`
affiche « Fonctionnalité en cours d'intégration ». Les fonctions sans point d'entrée (liste des sessions,
notifications) ne sont pas simulées : un message explicite est affiché.

## Jetons de design (`src/styles/tokens.css`)

| Jeton | Valeur | Usage |
|---|---|---|
| `--navy` | `#12306e` | marque, dégradés, en-tête de connexion |
| `--primary` | `#1d4f92` | liens, éléments actifs, série « Mobile Money » |
| `--accent` | `#f07800` | appels à l'action principaux (`.btn-primary`) |
| `--cyan` | `#00b4c8` | secondaire, série « Carte » |
| `--n50…--n900` | neutres | fonds, bordures, textes (`--text` = `#16202e`, `--muted` = `#6b7687`, AA sur fond clair) |
| `--success` / `--warn` / `--error` | `#1b8f5a` / `#b86a00` / `#c93a2c` | statuts, avis |
| `--s1…--s8` | 4 → 64 px | grille de 8 points |
| `--r-sm` / `--r` / `--r-lg` | 6 / 10 / 14 px | rayons |
| `--sh-1…--sh-3` | ombres | cartes, menus, modales |
| `--font` | pile système | une seule famille ; `--mono` pour les références |

Règles : montants toujours formatés (`fmtMoney`, séparateur de milliers, devise), dates relatives + absolues,
états de chargement (squelettes) / vide / erreur avec relance sur chaque liste, validation en ligne des
formulaires, confirmation des actions destructives, aucun émoji (icônes SVG), vouvoiement, utilisable à 360 px.

## API factice (`dev/mock-api.js`)

```bash
node dev/mock-api.js                              # API seule sur http://127.0.0.1:4010 (CORS avec identifiants)
REACT_APP_API_BASE_URL=http://127.0.0.1:4010 npm start

# ou bundle + API sur la même origine (captures d'écran) :
REACT_APP_DEV_TOOLS=1 REACT_APP_API_BASE_URL= CI=false npm run build
node dev/mock-api.js --static build               # http://127.0.0.1:4010
node dev/mock-api.js --static build --no-session --port 4011   # écran de connexion (refresh refusé)
```

- Connexion : n'importe quel e-mail, mot de passe `secret` ; un e-mail contenant `mfa` déclenche l'étape 2FA (code `123456`).
- Confirmation forte : code `123456` si la 2FA est active, sinon mot de passe `secret`.
- `--no-consent` : force l'écran d'acceptation des CGU.
- Un encaissement Mobile Money passe à « confirmé » 9 s après sa création ; un montant finissant par 999 échoue.
- Avec `REACT_APP_DEV_TOOLS=1` : `/caisse/encaisser?phone=%2B242061234567&amount=25000`, `/caisse/retirer?amount=50000&stepup=1`.

Données simulées : résumé de caisse, 30 jours de transactions, transferts (retrait, virement, approvisionnement),
liens de paiement, terminaux, clés API, webhook, connecteurs, compte, documents KYB, comptes bancaires, tickets.
