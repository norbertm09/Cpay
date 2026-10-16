# Vague 5 — Vitrine c-pay.global : recentrage marchand et hub développeurs

Périmètre : `portal/landing/` uniquement (statique, nginx `landing`, aucune dépendance externe, une seule
feuille `style.css`, scripts `app.js` + `assistant.js`, aucun attribut `style=`/`on*=` ni `<script>` inline).

Brief du propriétaire : « la page développeurs doit être redessinée… il y a trop de menus sur la vitrine…
pas besoin d'afficher les tarifs — ils seront dans le portail marchand — faire de C-Pay la solution
optimale pour une activité de commerçant ».

## 1. Accueil (`index.html`)

### Navigation
| Avant (9 liens) | Après (4 liens) |
|---|---|
| Caisse, Démo, Produits, Pays, Tarifs, Sécurité, FAQ, Développeurs, Contact | **Solution** (`#caisse`), **Pays & opérateurs** (`#pays`), **Développeurs** (`/developers.html`), **Contact** (`#contact`) |

CTA inchangés : « Se connecter » → `https://merchant.c-pay.global`, « Ouvrir un compte » →
`https://merchant.c-pay.global/register`. Hamburger mobile conservé (`#nav-toggle`, logique `app.js`).
Le même en-tête et le même pied de page sont repris sur `developers.html`, `reclamation.html` et `legal/*.html`.

### Déroulé de la page
| Avant | Après |
|---|---|
| Hero (carte « exemple de détection » statique) | **Hero** « La caisse digitale des commerçants » — 4 opérations (Encaisser, Retirer, Transférer, Suivre) ; la carte de droite est désormais la **démo de détection interactive** (formulaire `#detect-form`, puces d'exemples, résultat `#detect-result` pré-rempli avec l'exemple +237) |
| `#caisse` Quatre opérations | `#caisse` **Votre caisse** — 4 cartes (Encaisser, Retirer, Transférer, Suivre) + formule du solde disponible |
| `#demo` Démo interactive (section dédiée) | fusionnée dans le hero |
| `#simulateur` Estimez vos frais | **supprimé** |
| `#fonctionnement` Trois étapes (saisir / détecter / confirmer) | remplacé par `#demarrer` **Comment démarrer** : compte → KYB → premier encaissement |
| `#produits` Les briques de votre caisse (6 cartes) | **supprimé** ; les éléments utiles sont repris dans `#pourquoi` (liens & QR, app Android, WooCommerce, API) et sur la page développeurs |
| — | `#pourquoi` **Pourquoi C-Pay pour votre commerce** — 6 bénéfices : aucun choix d'opérateur, un seul solde, règlements J+1 ouvré, reçus et journal, application Android / liens / QR (+ WooCommerce, API), support |
| `#pays` Cinq pays, trois devises | `#pays` **Pays & opérateurs** — tableau inchangé |
| `#securite` (7 items) | `#securite` **Sécurité** — 6 items, claims honnêtes conservés (aucune certification PCI DSS revendiquée, Tap-to-Phone après certification, OVH UE, TLS, 2FA, step-up, security.txt) |
| `#tarifs` Une commission par transaction (tableau de taux) | **supprimé** |
| `#faq` 13 questions | `#faq` **6 questions** (opérateur, coût → portail marchand, règlement/retraits, ouverture de compte, cartes, réclamation) |
| `#contact` Formulaire lead | `#contact` conservé (`#lead-form` → `POST /api/v1/public/leads`) + lien vers la réclamation |
| `#reclamation` Formulaire de réclamation | déplacé vers **`reclamation.html`** |

Pied de page : colonnes « Solution » (Votre caisse, Pourquoi C-Pay, Pays & opérateurs, Développeurs),
« Accès » (Portail marchand, Ouvrir un compte, Contact, Réclamation → `/reclamation.html`), « Légal »
(inchangée). Les anciens liens `/#produits`, `/#tarifs`, `/#reclamation` n'existent plus nulle part.

### Contenu retiré du site
- Tableau de tarifs, simulateur de frais (`#sim-form`, fonction `simulator()` et table `RATES` d'`app.js`),
  **tout chiffre de commission** (`grep -nE "[0-9],[0-9] ?%" portal/landing/*.html` → vide).
- La réponse FAQ « Combien coûte C-Pay ? » devient : *aucun abonnement ni frais d'ouverture ; vos tarifs et les
  frais de chaque opération sont affichés dans votre portail marchand avant confirmation* — cohérent avec la
  base de connaissances du chatbot (`backend/src/services/assistant/knowledge.js`, section Tarifs).
- Section Produits, section Démo autonome, FAQ redondantes (délais de retrait, sécurité des confirmations,
  intégration, données personnelles — l'information reste dans `#caisse`, `#securite`, la page développeurs
  et la politique de confidentialité).
- Règles CSS devenues inutiles : `.sim*`, `.pricing*`, `.card--soon`, `.badge--alt`, `.badge--ok`, `.endpoint`,
  `.confirm-table`, anciennes règles `.hero-card .ex-row`.

## 2. Réclamation (`reclamation.html`, nouvelle page)
Même en-tête/pied de page, bandeau `page-hero`, formulaire `#claim-form` inchangé (champs, ids, consentement),
toujours piloté par `bindForm()` d'`app.js` → `POST /api/v1/public/claims` (payload `category`,
`transactionRef`, `description`, référence `REC-XXXXXX` affichée en retour). Liée depuis le pied de page de
toutes les pages, la FAQ, l'encart contact et l'article 7.4 des CGU. Ajoutée au `sitemap.xml` (priorité 0.4).

## 3. Hub développeurs (`developers.html`, refonte complète)
Mise en page documentation : sommaire **collant à gauche** sur bureau (`.toc`, section active surlignée au
défilement), **repliable** sur mobile (bouton `#toc-toggle`, ≤ 960 px). Contenu dans `.devdoc-main.doc`.

Sections (ids) :
1. `#demarrage` **Démarrage rapide** — compte → clé API dans le portail → premier lien de paiement en 3 appels
   cURL (vérifier la clé, créer le lien, retrouver le paiement).
2. `#auth` **Authentification et conventions** — tableau des en-têtes `X-API-Key`, `X-API-Secret`,
   `Idempotency-Key` (8–128 caractères, `409 IDEMPOTENCY_CONFLICT`, `409 IDEMPOTENCY_IN_PROGRESS`,
   `400 INVALID_IDEMPOTENCY_KEY`, TTL 24 h), `Content-Type`, `Authorization` ; base URL, montants entiers,
   format d'erreur, permissions, limites de débit.
3. `#endpoints` **Référence des endpoints publics** — uniquement ceux qui existent :
   `POST /merchant/public/pay-links` (`#ep-pay-links`), `GET /merchant/public/transactions`
   (`#ep-transactions`), `POST /detect/phone` (`#ep-detect`), et `POST /merchant/public/collect` (`#ep-collect`)
   marqué « bientôt », `410 FEATURE_DISABLED` aujourd'hui. Tableaux de paramètres, exemples en onglets
   **cURL / Node / PHP / Python**, réponses JSON.
4. `#caisse-api` **API Caisse** — badge « session marchand », tableau des endpoints `/merchant/cash/*`
   (summary, collect, collect/:txnId, wallet, withdraw, transfers, history + export CSV), objet `confirm`
   (TOTP / mot de passe, `428 STEP_UP_REQUIRED`), exemples cURL. Source : `docs/CAISSE-API.md`.
5. `#webhooks` **Webhooks sortants** — en-têtes `X-CPay-Event`, `X-CPay-Signature` (`sha256=<hex>`),
   `X-CPay-Timestamp` (non signé), `X-CPlus-*` de transition ; corps `payment.*` ; vérification HMAC en onglets
   Node / PHP / Python reprise de `docs/WEBHOOKS-SORTANTS.md` ; retries 3× (5 s, 10 s), délai 10 s.
6. `#sdk` **SDK & plugin** — `@c-pay/sdk` 1.1.0, `calculus-plus/cpay-sdk` 1.1.0 (snippets conformes aux
   constructeurs réels : pas d'option `apiSecret`), SDK Android 2.7.0 et extension WooCommerce 2.7.0 avec
   **liens, tailles et SHA-256 inchangés** (`b71c8c66…5b89e`, 83 Ko ; `52bbf97d…8c77`, 13 Ko).
7. `#sandbox` — sur demande à developers@c-pay.global ; bouton « Tester » des webhooks en production.
8. `#erreurs` **Codes d'erreur** — tableau HTTP / code / signification (API publique + caisse), puis cartes
   Swagger `https://api.c-pay.global/api/v1/docs/`, support, sécurité.

Interactions (`app.js`, aucun JS inline) : onglets accessibles (`role=tablist`, flèches ←/→) **synchronisés par
langage** via `data-lang` (choisir PHP dans un bloc bascule tous les blocs) ; **boutons « Copier »** injectés sur
chaque `pre` de `.devdoc` (Clipboard API avec repli `execCommand`, état « Copié ! » 1,6 s) ; sommaire mobile
repliable ; surlignage de la section active au défilement.

## 4. Légal, sitemap, robots
- `legal/cgu.html` : version 1.3 du 16 octobre 2026. **Article 6** : aucun pourcentage ; la grille dépend de la
  méthode, du niveau du compte et de la convention, elle est consultable dans le portail marchand et *le montant
  des frais de chaque opération est affiché dans le portail marchand avant confirmation*. Article 7.4 → lien
  `/reclamation.html`. Encarts jaunes « À COMPLÉTER » conservés.
- `legal/*.html` : en-tête (4 liens) et pied de page alignés sur l'accueil.
- `sitemap.xml` : `reclamation.html` ajouté, `lastmod` 2026-10-16 sur l'accueil, développeurs et CGU.
  `robots.txt` inchangé (`Disallow: /downloads/`).

## 5. Liste des affirmations publiques (à garder vraies)
- Pays : Sénégal (+221, XOF), Côte d'Ivoire (+225, XOF), Cameroun (+237, XAF), Congo-Brazzaville (+242, XAF),
  RDC (+243, CDF) ; opérateurs du tableau `#pays` ; Wave et Express Union « au choix du client » ; activation
  effective selon accords locaux.
- Détection automatique pays / devise / opérateur depuis le numéro ; `POST /detect/phone` public, 30 req/min.
- Encaissement carte uniquement par lien/QR hébergé (pay.c-pay.global) lorsqu'une passerelle carte est active ;
  Tap-to-Phone « bientôt », après certification ; **aucune certification PCI DSS revendiquée** ; aucun PAN stocké.
- Retrait vers le seul wallet enregistré, limite journalière selon niveau KYB, confirmation forte (TOTP ou mot de
  passe), blocage temporaire après 5 échecs / 15 min ; transfert wallet → banque vers compte vérifié, en règle
  générale sous 1 jour ouvré ; approvisionnement banque → wallet par ordre référencé (FND-), crédit à réception.
- Règlement des encaissements en règle générale à J+1 ouvré ; délais indicatifs.
- Tarifs : aucun abonnement ni frais d'ouverture ; grille et frais de chaque opération affichés dans le portail
  marchand avant confirmation ; **aucun chiffre sur le site**.
- Secrets d'API et de webhook affichés une seule fois ; `X-CPlus-*` retirés au plus tôt 90 jours après annonce.
- Hébergement OVH SAS (Roubaix, France) ; TLS 1.2/1.3 + HSTS ; 2FA disponible.
- Sandbox sur demande (pas de libre-service) ; `POST /merchant/public/collect` répond 410 aujourd'hui.
- SDK 1.1.0 : n'envoient pas `X-API-Secret` (à utiliser avec une clé sans secret, ou appeler l'API directement).
- Réclamation : numéro de dossier immédiat (REC-XXXXXX), première réponse sous 1 jour ouvré en règle générale.

## 6. Vérifications
```bash
python3 scripts/check-landing.py          # 7 pages, 160 liens internes, 2 JS : « Vitrine OK. »
node --check portal/landing/app.js portal/landing/assistant.js
grep -nE 'style=|\son[a-z]+=' portal/landing/*.html portal/landing/legal/*.html   # vide
grep -nE "[0-9],[0-9] ?%" portal/landing/*.html                                   # vide
grep -n "<script>" portal/landing/*.html portal/landing/legal/*.html              # vide
grep -n "CPlus" portal/landing/ -r | grep -v "X-CPlus-"                           # vide
```
Captures (Chromium headless 1366×900 et 390×844 via iframe) : accueil haut, « Votre caisse », « Pourquoi »,
FAQ, développeurs haut, `#ep-pay-links` (onglets de code + bouton Copier), `#webhooks`, `#sdk`, réclamation.

## 7. Points ouverts
- Publication effective de `@c-pay/sdk` sur npm et de `calculus-plus/cpay-sdk` sur Packagist à confirmer ; les
  SDK 1.1.0 ne gèrent pas `X-API-Secret` (évolution SDK souhaitable, hors périmètre vitrine).
- `POST /merchant/public/pay-links` ne passe pas par le middleware `idempotency` côté backend : la page présente
  `Idempotency-Key` comme « recommandé » sur ce endpoint, « obligatoire » sur les opérations de caisse.
- La suggestion « Quels sont vos tarifs ? » du widget assistant est conservée : la base de connaissances renvoie
  vers le portail marchand sans citer de chiffre.
