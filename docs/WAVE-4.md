# Vague 4 — CI/CD GitHub, versions 2.7.0, caisse marchande (branche `wave-4`)

Base : `wave-3` + `main`. Backend : **22 suites / 526 tests verts**. Détails par domaine :
`docs/CI-CD.md`, `docs/VERSIONING.md`, `docs/CAISSE-API.md` (contrat), `docs/WAVE-4-BACKEND.md`, `docs/WAVE-4-APPS.md`.

## 1. Vocation produit réaffirmée
C-Pay aide le marchand à **collecter digitalement ses recettes** par carte et par les opérateurs de Mobile Money,
et à tenir sa **caisse** : Encaisser, Retirer, Transférer (wallet → banque, banque → wallet), Journal.
La vitrine, le portail marchand, le portail admin et les deux apps sont désormais organisés autour de ces
quatre opérations.

## 2. Ce qui change
### CI/CD (GitHub Actions)
- `ci.yml` à chaque PR et push sur `main`/`wave-*` : tests backend, build des 7 portails, contrôle de la vitrine,
  `php -l`, SDK JS, app Expo, build Android debug (wrapper Gradle 8.5 ajouté), images Docker, cohérence des versions.
- `release.yml` sur tag `vX.Y.Z` : vérifications, APK/AAB Android (signés si les secrets `ANDROID_*` existent),
  archives SDK/plugin, release GitHub avec la section du changelog et les empreintes, puis déclenchement du déploiement.
- `deploy.yml` : déploiement vers OVH par SSH (environnement GitHub `production` avec approbateurs), `scripts/deploy.sh`
  (sauvegarde, build, migrations, relance, contrôles, `--rollback`).
- Secrets à créer : `OVH_SSH_HOST`, `OVH_SSH_USER`, `OVH_SSH_KEY`, `OVH_SSH_PORT`, `OVH_KNOWN_HOSTS`, et en option
  `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.

### Versions
- Produit en **2.7.0** partout (`VERSION`, backend, 7 portails, apps, compose) ; `scripts/bump-version.sh X.Y.Z`
  met tout à jour (dont `versionCode` Android/Expo et le changelog), `scripts/check-version.sh` vérifie en CI.
- Règles : correctif → patch, fonctionnalité/vague → mineure, rupture d'API ou de données → majeure (`docs/VERSIONING.md`).
- `/health` et `/live` exposent la version.

### Caisse marchande (backend)
- Routes `/api/v1/merchant/cash/*` et `/api/v1/admin/cash/*`, service `cash.service.js`, migration `009_wave4_cash.sql`
  (crée aussi `merchant_transfers`, `bank_accounts`, `financial_institutions`, utilisées par le code mais absentes
  des migrations jusqu'ici).
- Encaisser : Mobile Money par détection de l'opérateur depuis le numéro (tous pays connus), carte par lien
  hébergé **uniquement** si une passerelle MIGS ou MPGS est configurée pour le pays (sinon 410). Paiement carte
  réellement exécutable sur `pay.c-pay.global` via redirection hébergée, retour signé, statut interrogeable.
- Retirer : vers le wallet enregistré du marchand, confirmation forte (TOTP ou mot de passe), limite journalière par
  niveau KYB, rail de paiement sortant vérifié avant toute réservation (MTN Congo aujourd'hui ; les autres opérateurs
  dès qu'un rail de payout est configuré, sinon 410).
- Transférer : wallet → banque vers un compte vérifié (exécution manuelle par les opérations, `pending_manual`,
  aucun rail bancaire automatique n'existe) ; banque → wallet par **ordre d'approvisionnement** référencé `FND-`,
  confirmé par les opérations dans l'admin, qui crédite le solde.
- Journal unifié et export CSV ; base de connaissances de l'assistant enrichie.

### Portails, vitrine, apps
- Portail marchand : module Caisse en page d'accueil (Accueil, Encaisser, Retirer, Transférer, Journal), pensé pour
  le téléphone, confirmation forte intégrée.
- Portail admin : tableau de caisse, files d'attente (ordres à confirmer, virements à exécuter), comptes de collecte
  par devise, onglet Caisse sur la fiche marchand.
- Vitrine : accueil et sections recentrés sur la caisse digitale, API Caisse documentée sur la page développeurs,
  CGU complétées (art. 7.5).
- Apps Android et Expo : mêmes écrans de caisse (non compilés ici, voir `docs/WAVE-4-APPS.md`).

## 3. Variables d'environnement
| Variable | Rôle |
|---|---|
| `CASH_WITHDRAW_DAILY_L0/L1/L2` | limites de retrait journalières par niveau KYB (défauts 100 000 / 500 000 / 2 000 000) |
| `MIGS_MERCHANT_ID`, `MIGS_ACCESS_CODE`, `MIGS_SECURE_HASH` (+ `MIGS_HOST`, `MIGS_PATH`, `MIGS_HASH_TYPE`) | carte par lien hébergé (MIGS) |
| `MPGS_MERCHANT_ID`, `MPGS_API_PASSWORD` (+ `MPGS_HOST`, `MPGS_API_VERSION` ≥ 57) | carte par lien hébergé (MPGS) |
| `MTN_CG_DISB_*` | payouts MTN Congo (retraits) |

## 4. Déploiement
1. Fusionner la PR, puis `./scripts/bump-version.sh` n'est pas nécessaire (déjà 2.7.0) ; créer le tag `v2.7.0`
   sur `main` → release → déploiement après approbation (ou `./scripts/deploy.sh` sur le serveur).
2. Migration 009 appliquée automatiquement par `deploy.sh`.
3. Dans l'admin : créer les **comptes de collecte** par devise (Caisse → Comptes de collecte) avant d'annoncer les
   approvisionnements banque → wallet.
4. Configurer MIGS ou MPGS (recette avec la banque) pour activer la carte ; sans cela la carte reste annoncée
   « selon le pays » et répond 410.

## 5. Points ouverts
- Aucun webhook opérateur ne met à jour `merchant_transfers` : l'état des retraits est rafraîchi par interrogation
  du statut (MTN) ou par les opérations ; Airtel, Orange, Wave B2C, Vodacom n'ont pas d'endpoint de statut.
- MPGS sans webhook : un client qui ferme la page de paiement laisse la transaction `pending` (réconciliation à prévoir).
- Compteur d'échecs de confirmation forte et limiteurs en mémoire (un seul nœud API).
- Apps Android et Expo à compiler et tester sur appareil ; Tap-to-Phone toujours « bientôt ».
- `calc_fee()` / `merchant_fees` référencés par l'ancien code marchand n'existent dans aucune migration.
