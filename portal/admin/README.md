# C-Pay Admin — back-office (`portal/admin`)

Portail d’administration de la plateforme C-Pay (`admin.c-pay.global`). Vite 5 + React 18, react-router 6, axios ; CSS pur (aucune bibliothèque d’interface, aucun Tailwind, aucune police d’icônes).

```bash
npm ci                                       # lockfile versionné
npm run dev                                  # http://localhost:3004, proxy /api → http://localhost:3000 (vite.config.js)
npm run build                                # build/ (non versionné, vite build)
npm test                                     # vitest (jsdom)
REACT_APP_API_BASE_URL=http://127.0.0.1:4012 npm run build && MOCK_STATIC=build npm run mock   # app + API simulée sur une seule origine
```

Variables (lues au build via `import.meta.env`, préfixe `REACT_APP_` conservé dans `vite.config.js`) : `REACT_APP_API_BASE_URL` (origine de l’API, vide = même origine), `REACT_APP_VERSION` (affichée dans le menu, sinon version de `package.json`).

## Architecture de l’information

Chaque tâche opérationnelle est à un ou deux clics. Les groupes de navigation sont filtrés par rôle (`src/layout/nav.js`) et les pages réservées sont de plus protégées par `RequireRole` (`src/layout/guards.jsx`), aligné sur les `requireRole(...)` des routes backend.

| Groupe | Page | Route | Rôles | Endpoints |
|---|---|---|---|---|
| Pilotage | Tableau de bord | `/` | tous | `GET /stats/global`, `/activity/live`, `/health`, `/cash/stats`¹, `/crm/stats`², `/settlements/summary`³, `/support/tickets?status=open`, `/alerts?resolved=false`, `/audit-logs`⁴ (dernière réconciliation) |
| Clients | Marchands | `/marchands` | tous (écriture ¹) | `GET /merchants`, `POST /merchants`, `PATCH /merchants/:id/status` |
| | Fiche marchand | `/marchands/:id?tab=` | tous (écriture ¹) | `GET /merchants/:id`, `PATCH …/kyb`, `GET …/kyb`, `PATCH …/kyb/documents/:docId`, `POST …/kyb/documents`, `PUT …/fees`, `PUT …/velocity`, `GET /integrations/merchant/:id`, `POST …/test-event`, `GET /pilot/merchants/:id`, `GET /transactions?merchant_id`, `GET /cash/transfers?merchantId`¹, `GET /finance/settlements?merchantId`³, `GET /users` (filtré client), `GET /audit-logs`⁴ (filtré client) |
| | Utilisateurs marchands | `/marchands/utilisateurs` | tous (écriture ¹) | `GET/POST /users`, `PATCH /users/:id/status`, `POST /users/:id/reset-password` (mot de passe temporaire affiché une fois) |
| | Porteurs | `/porteurs` | tous | `GET /notifications` (dépôts KYC), `PATCH /cardholders/:id/kyc/documents/:docId`, `GET /claims`, `GET /incidents` |
| Opérations | Transactions | `/operations/transactions` | tous (réconciliation ¹) | `GET /transactions`, `GET /transactions/:id`, `POST /reconcile` |
| | Caisse | `/operations/caisse?tab=files\|transferts\|comptes` | ¹ | `GET /cash/stats`, `GET /cash/transfers`, `GET /cash/transfers/:id`, `POST …/confirm-funds`, `…/mark-executed`, `…/reject`, `GET/POST/PATCH /cash/platform-accounts` |
| | Règlements | `/operations/reglements?tab=lots\|virements` | ³ | `GET /finance/settlements`, `PATCH …/validate`, `…/reject`, `GET …/export`, `POST /settlement/run`, `GET /settlements`, `GET /settlements/summary`, `POST /settlements/:id/complete`, `…/reject` |
| | Fraude & alertes | `/operations/fraude?tab=evenements\|regles\|alertes` | tous (écriture ¹) | `GET /fraud/events`, `PATCH …/review`, `GET/POST /fraud/rules`, `PUT /fraud/rules/:id`, `GET /alerts`, `PATCH /alerts/:id/resolve` |
| | Rails | `/operations/rails` | ¹ | `GET /api/v1/rails/visa-direct/transaction-query`, `…/visa-payouts/v3/account-balance`, `…/payouts`, `…/mastercard-developers/services`, `…/projects` |
| Support & CRM | Tickets | `/support/tickets?id=` | tous | `GET /support/tickets`, `GET …/:id`, `POST …/messages`, `PATCH …/status`, `PATCH …/assign`, `POST …/escalate`, `GET /support/agents` |
| | Réclamations | `/support/reclamations` | ² (+ porteurs : tous) | `GET /crm/claims`, `PATCH /crm/claims/:id`, `GET /claims` |
| | Leads | `/support/leads` | ² | `GET /crm/leads`, `PATCH /crm/leads/:id` |
| | Conversations | `/support/conversations?id=` | ² | `GET /crm/conversations`, `GET …/:id` |
| Partenaires | Banques, fiche | `/partenaires/banques[/:id]` | ¹ (création ⁴) | `GET /partners/banks`, `…/:id`, `…/agencies`, `…/agents`, `POST /partners/banks`, `PATCH …/:id`, `…/status` |
| | Agences / Agents | `/partenaires/agences`, `/partenaires/agents` | ¹ | `GET /partners/agencies/all`, `GET /partners/agents/all` |
| | Tenants | `/partenaires/tenants` | ¹ (écriture ⁴) | `GET/POST /tenants`, `PATCH /tenants/:id` |
| Configuration | Connecteurs opérateurs | `/configuration/connecteurs` | ¹ | `GET /api-configs`, `GET …/:id`, `PUT …/:key`, `POST …/:key/test`, `GET …/env-status`, `GET /country-defaults` |
| | Notifications | `/configuration/notifications` | ¹ | `GET/POST /notification-configs`, `POST …/test`, `…/send-test` |
| | Terminaux | `/configuration/terminaux` | tous (écriture ¹) | `GET /terminals`, `PATCH …/status`, `…/unblock` |
| | Fonctionnalités & pilote | `/configuration/fonctionnalites` | ¹ | `GET /pilot/features`, `PUT …/:flagKey`, `GET /pilot/programs`, `GET /pilot/readiness` |
| | Administrateurs | `/configuration/administrateurs` | ⁴ | `GET/POST /admin-users`, `PATCH …/:id`, `POST /users/:id/reset-password?type=admin` |
| | Journal d’audit | `/configuration/audit` | ⁴ | `GET /audit-logs` |
| | Monitoring | `/configuration/monitoring` | tous | `GET /activity/live`, `GET /health` |
| Compte | Profil, sécurité | `/compte?tab=profil\|securite` | tous | `GET /auth/me`, `POST /auth/change-password`, `GET /auth/2fa/status`, `POST /auth/2fa/setup`, `…/verify`, `…/disable`, `POST /auth/logout` |

¹ `super_admin`, `ops_admin` · ² `super_admin`, `ops_admin`, `support_agent` · ³ `super_admin`, `finance_admin` · ⁴ `super_admin`.
Toutes les routes sont préfixées `/api/v1/admin` sauf `/health` et `/api/v1/rails/*`.

### Authentification
`POST /auth/login` → `{ mfaRequired, mfaToken }` (étape TOTP `POST /auth/2fa/validate`) ou `{ access_token, mustChangePassword, admin }`. L’access token (15 min) est en `localStorage` (`admin_token`), le refresh dans le cookie HttpOnly `cp_rt_admin` (`POST /auth/refresh`, single-flight sur 401, `src/services/api.js`). `mustChangePassword` force la page de changement de mot de passe avant tout accès ; `POST /auth/change-password` révoque toutes les sessions → reconnexion.

### Anciennes routes
Redirigées avec paramètres et query (`LEGACY_REDIRECTS` dans `src/layout/nav.js`) : `/merchants(/:id)`, `/users`, `/cardholders(/:id)`, `/transactions`, `/finance`, `/fraud`, `/alerts`, `/monitoring`, `/audit`, `/tickets`, `/crm/*`, `/cash(/transfers|/platform-accounts)`, `/banks(/:id)`, `/partners-agencies`, `/partners-agents`, `/tenants`, `/api-configs`, `/terminals`, `/admin-users`.

## Arborescence

```
src/
  App.jsx                 routeur fin (garde de session, garde de rôles, redirections)
  services/api.js         axios + refresh single-flight ; un objet d'API par domaine
  hooks/                  useAuth (session/profil), useQuery (chargement + relance + rafraîchissement), useUrlState (filtres ↔ query string)
  utils/                  format (montants, dates FR), status (statut → libellé/ton), roles (droits), errors (messages), toast
  components/             Icon (SVG inline), ui.jsx (Button, Card, Stat, Badge, Field/Input/Select, Tabs, PageHeader, Modal, Drawer, ConfirmDialog, EmptyState, Skeleton…),
                          DataTable (tri, pagination, colonnes masquables, repli cartes < 768 px), charts (aire, barres, anneau SVG), CommandPalette (Ctrl+K), Toaster
  layout/                 AppShell (barre latérale repliable + barre haute), nav.js (IA + rôles), NotificationBell, guards
  pages/<domaine>/        auth, dashboard, merchants (liste, fiche + onglets, utilisateurs), cardholders, operations, support, partners, settings, account
  styles/                 tokens.css, base.css, components.css, layout.css
dev/mock-api.js           API simulée (Node http pur) + serveur statique du build
dev/screenshots/          captures de référence
```

## Design system (`src/styles/tokens.css`)

- Couleurs : marine `#12306e` (barre latérale), primaire `#1d4f92`, accent orange `#f07800` (actions principales), cyan `#00b4c8`, neutres `--bg #f4f6fa` / `--surface #fff` / `--border #dde3ec` / `--text #1b2433`, sémantiques succès `#138a4b`, avertissement `#b45309`, erreur `#c62828`. Les badges utilisent fond clair + texte foncé (contraste AA).
- Graphiques : palette `--series-1…4` (`#1d4f92`, `#f07800`, `#00b4c8`, `#7c3aed`) validée pour les daltonismes ; une série par graphique, étiquettes et vue tableau systématiques.
- Espacement 8 pt (`--s1` 4 px … `--s7` 48 px), rayons 6/10/14 px, police système, focus visible (`--focus`), densité « admin » (13 px).
- Composants : états de chargement (squelettes), vides et erreur avec relance, confirmations avec motif obligatoire quand l’API le prend (`reason`), secrets affichés une seule fois (`SecretOnce`), montants formatés avec devise, dates FR.
- Réactivité : pleine largeur à 1024 px (barre latérale repliée automatiquement sous 1100 px), tiroir mobile et tableaux en cartes sous 768 px.

## API simulée (`dev/mock-api.js`)

Serveur Node sans dépendance qui reproduit les contrats des routes backend utilisées (données réalistes, latence 60–180 ms, transitions d’état réelles pour la caisse, les tickets, le CRM…).

| Variable | Effet |
|---|---|
| `PORT` | port (défaut 4012) |
| `MOCK_STATIC=build` | sert aussi le build Vite (SPA) : app et API sur la même origine |
| `MOCK_SESSION=none` | `/auth/refresh` répond 401 (affiche la page de connexion) |
| `MOCK_ROLE=ops_admin` | rôle du compte (défaut `super_admin`) pour vérifier les gardes |
| `MOCK_MFA=1` | login en deux étapes (tout code à 6 chiffres passe) |
| `MOCK_TEMP=1` | `mustChangePassword` (page de changement forcé) |

Compte : `admin@c-pay.global` / `Admin-2026!`. Captures : `/opt/pw-browsers/chromium-1194/chrome-linux/chrome --headless=new --no-sandbox --screenshot=… --window-size=1440,900 --virtual-time-budget=12000 http://127.0.0.1:4012/…` (voir `dev/screenshots/`).

## Points ouverts (fonctions sans endpoint)

- **Porteurs** : aucune route admin `GET /cardholders`, `GET /cardholders/:id`, `GET /cardholders/:id/kyc-documents` ni `PATCH /cardholders/:id/kyc` (l’ancien portail les appelait, elles n’existent pas). La page Porteurs repose sur les notifications KYC, `GET /claims` et `GET /incidents` ; la revue d’un document demande son `doc_id`.
- **Remboursement** : `POST /transactions/:id/refund` répond toujours `501 REFUND_NOT_IMPLEMENTED` ; aucun bouton n’est proposé.
- **Utilisateurs d’un marchand** : `GET /users` n’a pas de filtre `merchant_id` ; l’onglet filtre côté client les 100 derniers comptes.
- **Journal d’audit d’un marchand** : `GET /audit-logs` n’a pas de filtre `entity_id` ; filtrage client sur 100 entrées.
- **Notes KYB** : `PATCH /merchants/:id/kyb` ne persiste que `kybLevel`/`kybStatus` (`kyb_notes` est en lecture seule).
- **Clés API marchand** : non exposées côté admin (seules les intégrations/webhooks masqués le sont via `/integrations/merchant/:id`).
- **Volumes par pays / méthode** : pas d’agrégat serveur ; le tableau de bord les calcule sur `GET /activity/live` (100 dernières transactions, 24 h). Les totaux `stats/global.today.volume` et `cash/stats` additionnent toutes les devises.
- **Rôle `support_admin`** : présent dans deux `requireRole` backend (`PATCH /support/tickets/:id`, `POST /integrations/…/test-event`) mais absent de la liste des rôles créables ; le portail s’appuie sur `PATCH /support/tickets/:id/status` (tous rôles) à la place.
- **Tickets porteurs** : `GET /support/tickets/:id` fait une jointure stricte sur `merchants` ; le détail d’un ticket déposé par un porteur répond 404 (message affiché).
- **Alertes AML** : `GET /alerts` est accessible à tous les rôles mais la résolution est réservée à ¹.
