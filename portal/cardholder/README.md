# C-Pay — Portail porteur (`portal/cardholder`)

Application React (CRA, React 18, react-router 6, axios, react-hot-toast) servie sur
`app.c-pay.global` / `card.c-pay.global` pour les **porteurs** de cartes C-Pay (consommateurs,
mobile d'abord). Aucune bibliothèque UI : design system maison en CSS (variables), icônes SVG inline.

## Démarrer

```bash
npm install                 # pas de lockfile versionné
npm start                   # http://localhost:3002, proxy API -> http://localhost:3000
CI=false npm run build      # build de production dans build/
```

Variable `REACT_APP_API_BASE_URL` : origine de l'API (vide = même origine, via le proxy CRA).
Drapeaux optionnels (`true` pour activer l'écran complet, sinon état « en cours d'intégration ») :
`REACT_APP_FEATURE_TOPUP`, `REACT_APP_FEATURE_UNLOAD`, `REACT_APP_FEATURE_GTP_TOPUP`,
`REACT_APP_FEATURE_GTP_UNLOAD`, `REACT_APP_FEATURE_EXTERNAL_CARD_PAYMENT` (voir `src/utils/features.js`).
Même drapeau levé, un `410 FEATURE_DISABLED` renvoyé par l'API ramène l'écran à cet état honnête.

## Architecture de l'information

| Zone | Route | Contenu |
|---|---|---|
| Accueil | `/` | solde et carte principale, actions rapides (Payer, Recharger, Mes cartes, Signaler), alertes (mot de passe temporaire, carte gelée, 2FA, KYC), statistiques 30 j, opérations récentes, soldes par carte |
| Mes cartes | `/cartes`, `/cartes/gtp`, `/cartes/externes` | cartes virtuelles C-Pay (détail en tiroir : plafonds, PIN, gel/réactivation, suppression, création), carte réseau GTP (émission, gel, PIN, transfert carte à carte, historique), cartes bancaires externes enrôlées |
| Payer | `/payer` | 3 étapes : commerçant (QR via caméra `BarcodeDetector` ou saisie / lien de paiement), montant (frais 0,5 %, contrôle de solde), confirmation par PIN, reçu imprimable |
| Opérations | `/operations`, `/operations/recharger`, `/operations/retirer` | historique paginé avec filtres type/statut et recherche, tiroir de détail, reçu, export CSV ; recharge et retrait en état « en cours d'intégration » |
| Aide | `/aide`, `/aide/reclamations`, `/aide/tickets` | FAQ, contact support@c-pay.global, réclamations (claims), demandes au support avec fil de conversation |
| Profil | `/profil`, `/profil/securite`, `/profil/verification` | informations, mot de passe, 2FA (QR + code), renvoi du lien de vérification e-mail, journal de sécurité, documents KYC |
| Auth | `/connexion`, `/inscription`, `/mot-de-passe-oublie`, `/reinitialiser-mot-de-passe`, `/verifier-email` | connexion avec étape 2FA et changement de mot de passe forcé, inscription en 2 étapes, réinitialisation |

Navigation : barre d'onglets basse à 5 entrées sur téléphone (Accueil, Mes cartes, Payer, Opérations,
Profil ; Aide via la barre haute et le menu compte), barre latérale sur ordinateur. L'acceptation des CGU
(`/api/v1/consent/check|accept`) est demandée dans une modale bloquante après connexion.

### Redirections depuis l'ancien portail

`/login`→`/connexion`, `/register`→`/inscription`, `/reset-password`→`/reinitialiser-mot-de-passe`
(ou `/mot-de-passe-oublie` sans jeton), `/verify-email`→`/verifier-email` (requête conservée),
`/cards`→`/cartes`, `/gtp-card`→`/cartes/gtp`, `/payment`→`/payer`, `/transactions`→`/operations`,
`/topup`→`/operations/recharger`, `/unload`→`/operations/retirer`, `/incidents`→`/aide`, `/profile`→`/profil`.

## Arborescence

```
src/
  App.jsx                 routeur fin, gardes (RequireAuth / PublicOnly), redirections
  index.js                point d'entrée (importe styles/index.css)
  services/               api.js (axios, jeton ch_token, refresh single-flight par cookie cp_rt_cardholder,
                          403 toast), auth.js, cards.js, operations.js, support.js, profile.js
  hooks/                  useAuth (AuthProvider, /auth/me), useAsync, useForm, useMediaQuery, useDocumentTitle
  utils/                  format (monnaie, dates FR, téléphone), errors (mapping FEATURE_DISABLED…),
                          validation, txn (libellés, CSV), features (drapeaux, constantes)
  components/             Button, Card, Stat, Badge, Field (Input/PasswordInput/Select/Textarea/Checkbox/AmountInput),
                          PinInput, Modal, Drawer, ConfirmDialog, Tabs, PageHeader, EmptyState, ErrorState,
                          Skeleton, Alert, FeatureDisabled, ListTable, VirtualCard, Steps, CopyButton, TxnList, Icon
  layout/                 AppShell (barre haute, barre latérale, onglets bas, consentement), AuthLayout
  pages/                  auth/, home/, cards/, pay/, operations/, help/, profile/
  styles/                 tokens.css, base.css, components.css, layout.css, pages.css
dev/mock-api.js           API factice (Node pur) pour le développement et les captures
```

## Design system (`src/styles/tokens.css`)

- Couleurs : marine `--navy #12306e`, primaire `--primary #1d4f92`, accent `--accent #f07800` (CTA, texte
  marine `--on-accent` pour un contraste AA), cyan `--cyan #00b4c8`, neutres `--bg/--surface/--border/--text*`,
  statuts `--success/--warn/--error/--info` avec variantes `-50`.
- Espacement 8 pt (`--s-1`…`--s-9`), rayons `--r-sm/--r/--r-lg/--r-xl`, ombres, `--focus` visible au clavier.
- Typographie : Inter auto-hébergée puis pile système (`--font-sans`), chiffres tabulaires pour les montants.
- Composants : `.btn-*`, `.card`, `.stat`, `.badge-*`, `.input/.select/.textarea`, `.pin`, `.alert-*`,
  `.tabs`, `.list-item`, `.table`, `.kv`, `.modal`, `.drawer`, `.vcard` (carte virtuelle de marque), `.feature-off`.
- Utilisable dès 360 px ; impression des reçus via `@media print`.

## API utilisée (`/api/v1/cardholder` sauf mention)

Auth : `POST auth/login`, `auth/2fa/validate`, `auth/refresh`, `auth/register`, `auth/logout`,
`auth/forgot-password`, `auth/reset-password`, `auth/resend-verification`, `auth/change-password`,
`profile/change-password`, `auth/2fa/setup|verify|disable`, `GET auth/me`, `auth/verify-email`,
`auth/2fa/status`, `security/events`. Cartes : `GET card`, `PATCH card/status`, `POST card/pin`,
`GET cards/created`, `POST cards/create`, `DELETE cards/created/:id`, `GET cards`,
`PATCH cards/:id/default`, `DELETE cards/:id`, `gtp/status`, `gtp/cards`, `gtp/cards/:id`,
`gtp/cards/:id/transactions`, `gtp/issue`, `gtp/cards/:id/freeze|unfreeze|pin|payment|topup|unload`.
Opérations : `GET dashboard`, `GET transactions`, `POST payment`, `POST topup`, `POST unload` (410).
Aide : `GET/POST claims`, `GET/POST support/tickets`, `GET support/tickets/:id`, `POST support/tickets/:id/messages`.
Profil : `PATCH profile`, `GET kyc`, `POST kyc/documents`. Hors préfixe : `GET /api/v1/consent/check`,
`POST /api/v1/consent/accept`, `GET /api/v1/pay/:shortId/status` (lien de paiement public).

## API factice (`dev/mock-api.js`)

```bash
node dev/mock-api.js                      # http://127.0.0.1:4011 (PORT=… pour changer)
MOCK_GTP=1 MOCK_CONSENT=0 node dev/mock-api.js   # service cartes réseau actif, modale CGU affichée
REACT_APP_API_BASE_URL=http://127.0.0.1:4011 npm start
```

Comptes : `demo@c-pay.global / Demo1234` (compte riche en opérations), `mfa@c-pay.global / Demo1234`
(2FA, code `123456`), `temp@c-pay.global / Temp1234` (mot de passe temporaire). PIN des cartes : `1234`.
Lien de paiement de test : `ABC123`. Le mock pose le cookie `cp_rt_cardholder`, émet des JWT de 15 min,
répond `410 FEATURE_DISABLED` sur `topup`/`unload`/`payment/tokenized` et `503 GTP_NOT_CONFIGURED`
sur la création de carte quand `MOCK_GTP` n'est pas levé. Il ne doit jamais être déployé.
