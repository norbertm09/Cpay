# Vague 5 — déploiement automatique et refonte des interfaces (branche `wave-5`)

Base : `main` (vagues 1 à 4). Détails : `docs/WAVE-5-VITRINE.md`, `docs/WAVE-5-ANDROID.md`, et les `README.md` de
`portal/merchant`, `portal/cardholder`, `portal/admin` (architecture, jetons de design, API simulée).

## 1. Déploiement automatique
`deploy.yml` se déclenche désormais dès que le pipeline CI est vert sur `main` (`workflow_run`), en plus du
déclenchement manuel et par release. L'environnement GitHub `production` reste le point de contrôle : avec des
« required reviewers », le déploiement attend une approbation ; sans, il part seul.

## 2. Refontes
### Vitrine c-pay.global
Navigation ramenée à 4 entrées (Solution, Pays & opérateurs, Développeurs, Contact), tarifs retirés du site public
(ils vivent dans le portail marchand), page `reclamation.html` dédiée, accueil recentré sur la caisse digitale des
commerçants, hub développeurs refondu (sommaire, onglets de code, webhooks, SDK). L'assistant ne cite plus de taux.

### Portail marchand (merchant.c-pay.global)
Fichier unique de 5 174 lignes remplacé par une application structurée (pages, composants, hooks, design system).
Architecture : Accueil 360 · Caisse (Encaisser, Retirer, Transférer) · Activité (Journal, Règlements) ·
Outils de vente (Liens & QR, Terminaux, Tap-to-Phone) · Intégrations (Clés API, Webhooks, Plugins, Connecteurs) ·
Compte (Profil & KYB, Comptes, **Tarifs & frais**, Sécurité, Support). Toutes les anciennes URL redirigent.

### Portail utilisateur (app.c-pay.global)
Accueil · Mes cartes (carte virtuelle, GTP, cartes externes) · Payer · Opérations · Aide · Profil, pensé pour le
téléphone (barre d'onglets), fonctions désactivées présentées honnêtement.

### Portail admin (admin.c-pay.global)
Tableau de bord avec files d'attente, Marchands (fiche à 9 onglets, actions avec motif), Porteurs, Opérations
(Transactions, Caisse, Règlements, Fraude & alertes, Rails), Support & CRM, Partenaires & distribution,
Configuration, Compte ; recherche globale Ctrl+K ; accès par rôle aligné sur le backend.

### App Android marchande
Material 3 aux couleurs C-Pay, 4 onglets (Caisse, Encaisser, Journal, Plus), encaissement en 4 écrans (montant,
client avec détection, attente, résultat), retrait et transferts avec confirmation forte en feuille basse, journal
avec en-têtes par jour et recherche, cache hors ligne, déverrouillage biométrique. Non compilée ici : la CI
GitHub compile ; plan de test sur appareil dans `docs/WAVE-5-ANDROID.md`.

## 3. Vérifications
Builds `merchant`, `cardholder`, `admin` : « Compiled successfully » sans avertissement. Vitrine : `check-landing.py`
OK (7 pages, 160 liens). Chaque interface a été parcourue sur une API simulée (`dev/mock-api.js`) avec captures
d'écran mobile et bureau, corrigées avant livraison.

## 4. Points ouverts remontés au backend (à traiter en vague 6)
- Agrégats serveur pour les tableaux de bord : `GET /merchant/stats/daily`, volumes admin par pays/méthode/période.
- `fees.collect` par moyen dans `GET /merchant/cash/summary` pour afficher les taux réels (grille indicative aujourd'hui).
- Routes admin porteurs (`GET /cardholders`, détail, KYC) absentes ; `refund` toujours 501.
- Portail porteur : `emailVerified` absent de `/auth/me`, pas de gel par `cardId`, pas de filtre date sur `/transactions`.
- Portail marchand : pas de liste/révocation de sessions, secret de connecteur jamais affiché, `GET /settlements/:id/transactions` absent.
- Android : `GET /pay/:shortId/status` à ajouter à `ApiService` pour suivre les liens carte.

## 6. Typographie unifiée
Une seule police pour toute la plateforme : **Inter** (variable 100–900, sous-ensemble latin, 48 Ko, auto-hébergée dans
`fonts/inter-latin.woff2` de la vitrine et de chaque portail, aucun appel à un service externe). Pile de repli :
system-ui, Segoe UI, Roboto, Arial. Jost et les dossiers de polices résiduels (`portal/_fonts*`) sont supprimés.
Portails CRA : `@font-face` déclaré dans `public/index.html` (CRA ne résout pas les URL absolues dans le CSS) ;
vitrine : déclaré en tête de `style.css`. L'app Android garde la police système (Roboto), cohérente avec Material 3.
