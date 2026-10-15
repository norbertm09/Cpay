# Versions — C-Pay

Une seule version produit pour tout le monorepo (backend, 7 portails, vitrine, apps Android/Expo, SDK Android,
plugin WooCommerce, images Docker), définie dans le fichier racine `VERSION` (ex. `2.7.0`) et vérifiée par
`scripts/check-version.sh` (job CI `version-check`). Pipelines et déploiement : `docs/CI-CD.md`.

## 1. Semver appliqué au produit

| Incrément | Quand | Exemples |
|-----------|-------|----------|
| **patch** `X.Y.(Z+1)` | corrections sans nouvelle fonctionnalité : hotfix de production, sécurité, bug d'un portail, texte | 2.7.0 → 2.7.1 |
| **minor** `X.(Y+1).0` | nouvelles fonctionnalités, une « vague » (`wave-N`), nouvel opérateur, nouveau portail, migration additive | 2.6.0 → 2.7.0 (vague 3) |
| **major** `(X+1).0.0` | rupture de l'API publique (`/api/v1`, webhooks sortants, SDK) ou du modèle de données nécessitant une migration non rétrocompatible | 2.x → 3.0.0 (`ROADMAP_CPLUS_3_0.md`) |

- Les migrations SQL (`backend/database/NNN_*.sql`) sont additives dans une version mineure ou patch : la version
  précédente doit pouvoir tourner sur le schéma migré (c'est ce qui rend `deploy.sh --rollback` possible sans
  restauration de base).
- Les suffixes du changelog (`## 2.7.0-wave-3 (date) — titre`) sont descriptifs ; le tag git est toujours
  `vX.Y.Z` sans suffixe, et `VERSION` contient uniquement `X.Y.Z`.
- Les SDK **JavaScript** (`@c-pay/sdk`, `sdk/javascript`) et **PHP** (`calculus-plus/cpay-sdk`, `sdk/php`) ont leur
  propre numéro (`1.1.0`) : ils suivent leur API, pas la version produit, et ne sont pas touchés par `bump-version.sh`.
  Le SDK Android et le plugin WooCommerce, distribués en archives depuis la page développeurs, suivent la version produit.

## 2. Branches, PR, tags

```
wave-N / fix/xxx ──PR──▶ main (protégée) ──tag vX.Y.Z──▶ release.yml ──▶ deploy.yml
```

1. Une vague de développement vit sur `wave-N` ; la CI (`ci.yml`) tourne sur chaque push de `wave-*` et sur
   chaque pull request.
2. `main` est protégée : merge par PR uniquement, CI verte et relecture requises, pas de push direct.
3. La version est montée **sur la branche, avant le merge** (`./scripts/bump-version.sh X.Y.Z` + changelog), de sorte
   que `main` contienne toujours une version cohérente.
4. **Le tag est posé après le merge, sur le commit de `main`** : `git tag -a vX.Y.Z -m "C-Pay X.Y.Z" && git push origin vX.Y.Z`.
   `release.yml` refuse un tag dont la version diffère de `VERSION`.
5. Un tag n'est jamais déplacé. Une erreur se corrige par un patch (`vX.Y.Z+1`).

## 3. Emplacements synchronisés

`scripts/bump-version.sh <X.Y.Z>` met tout à jour ; `scripts/check-version.sh` vérifie que tout vaut `VERSION`.

| Emplacement | Champ | Remarque |
|-------------|-------|----------|
| `VERSION` | `X.Y.Z` | source de vérité |
| `backend/package.json`, `backend/package-lock.json` | `version` (racine et `packages[""]`) | `/health`, `/live` et Swagger lisent `package.json` |
| `portal/{admin,merchant,cardholder,partners,bank,agency,agent}/package.json` (+ `package-lock.json` si présent) | `version` | modification du seul champ, sans reformater le fichier |
| `mobile/cpay-mobile/package.json`, `app.json` | `version`, `expo.version`, `expo.android.versionCode` | voir § 4 |
| `android/app/build.gradle` | `versionName`, `versionCode` | voir § 4 |
| `sdk/android/build.gradle`, `sdk/android/README.md` | `versionName`, titre `# C-Pay Android SDK vX.Y.Z` | |
| `plugins/woocommerce/cplus-payment-gateway.php`, `readme.txt` | en-tête `Version:`, `CPAY_VERSION`, `Stable tag:` | |
| `docker/docker-compose.yml` | `image: cplus-*:${CPLUS_TAG:-X.Y.Z}` | `deploy.sh` exporte `CPLUS_TAG=$VERSION` |
| `README.md` | titre `# C-Pay X.Y.Z — …` | |
| `portal/landing/developers.html`, `portal/landing/downloads/` | liens `cpay-android-sdk-vX.Y.Z.zip`, `cpay-payment-gateway-vX.Y.Z.zip`, SHA-256, tailles | `scripts/build-archives.sh X.Y.Z --update-landing` (appelé par `bump-version.sh`) |
| `CHANGELOG_AMELIORATIONS.md` | section `## X.Y.Z…` | stub `## X.Y.Z (date)` ajouté par `bump-version.sh` si absent ; corps de la GitHub Release |

Non synchronisés volontairement : commentaires d'en-tête historiques (`CPlus 2.6.0 — …` dans les sources et
migrations), `docs/audit-prod-2.6.0/`, `OVH_DEPLOYMENT.md`/`PILOT_CONTROL_RUNBOOK.md` (documents datés),
`DB_APPLICATION_NAME` (`cplus-2.6.0-api`, identifiant de connexion PostgreSQL), SDK JS/PHP.

## 4. Codes de version des stores (Android)

Les stores exigent un entier strictement croissant à chaque envoi, indépendant de `versionName`.

- **App Android native** (`android/app/build.gradle`) : `versionCode` est incrémenté de **1** à chaque
  `bump-version.sh` (2.7.0 → `2`, prochaine version → `3`). Si plusieurs envois Play Store ont lieu pour une même
  version produit, incrémenter `versionCode` à la main et committer. Les APK de release sont produits avec splits ABI
  (`arm64-v8a`, `armeabi-v7a`, `x86_64`) + universel ; un seul `versionCode` pour tous (pas de `versionCodeOverride`).
- **App Expo** (`mobile/cpay-mobile/app.json`) : `expo.android.versionCode` est **dérivé** de la version :
  `M×100 + m×10 + p` (2.7.0 → `270`, 2.7.1 → `271`, 2.8.0 → `280`). Contrainte : garder `m` et `p` < 10 avant de
  passer à la mineure/majeure suivante (2.9.9 → 299, 2.10.0 → 300 reste croissant, mais 2.9.10 entrerait en
  collision). `eas.json` (`production.autoIncrement`) prend le relais si l'on publie plusieurs fois la même version.
- iOS (`CFBundleVersion`) : géré par EAS (`autoIncrement`) ; non suivi dans le dépôt.

## 5. Commandes

```sh
./scripts/bump-version.sh 2.8.0            # tout mettre à 2.8.0 + archives + stub changelog + vérification
./scripts/bump-version.sh 2.8.0 --no-archives
./scripts/check-version.sh                 # ce que fait la CI
./scripts/changelog-section.sh 2.8.0       # section utilisée comme notes de release
./scripts/build-archives.sh 2.8.0 --out dist   # zips + SHA256SUMS sans toucher au dépôt (release.yml)
```
