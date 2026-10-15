# CI / CD — C-Pay

Pipelines GitHub Actions du monorepo (`.github/workflows/`), script de déploiement standard
(`scripts/deploy.sh`) et procédure de mise en production sur le VPS OVH (`/opt/cplus`, docker compose,
nginx de l'hôte). Règles de version : `docs/VERSIONING.md`.

## 1. Vue d'ensemble

```
branche wave-N ── PR ──▶ main ── tag vX.Y.Z ──▶ release.yml ──▶ deploy.yml (approbation) ──▶ OVH
     │                    │                        │
  ci.yml               ci.yml            GitHub Release + APK/AAB/zips
```

| Workflow | Déclencheur | Rôle |
|----------|-------------|------|
| `ci.yml` | `pull_request`, `push` sur `main` et `wave-*` | Qualité : backend (syntaxe, jest, audit), build des 7 portails, vitrine, PHP, SDK JS, Expo, Android debug, images Docker + `nginx -t`, cohérence des versions. |
| `release.yml` | push d'un tag `vX.Y.Z` | Vérifie `VERSION` = tag, tests backend, APK/AAB release (signés si secrets), archives SDK/plugin, **GitHub Release** avec la section du changelog, puis lance `deploy.yml` sur le tag. |
| `deploy.yml` | `workflow_dispatch` (ref, skip_backup), `release: published`, ou lancé par `release.yml` | SSH vers OVH : `git checkout --detach <ref>` puis `./scripts/deploy.sh` ; smoke test HTTPS depuis le runner. Protégé par l'environnement GitHub `production`. |

Les runs CI superflus sont annulés (`concurrency` par branche/PR) ; un déploiement n'est jamais annulé ni
exécuté en parallèle d'un autre (`concurrency: deploy-production`).

## 2. `ci.yml` — détail des jobs

| Job | Ce qu'il fait | Notes |
|-----|---------------|-------|
| `backend` | Node 22, `npm ci`, `scripts/check-js-syntax.sh src` (`node --check` sur `src/**/*.js`), `npm test` (jest, 475 tests, sans base de données), `npm audit --omit=dev --audit-level=critical` | L'audit est **informatif** (`continue-on-error`). |
| `portals` | Matrice `admin, merchant, cardholder, partners, bank, agency, agent` : Node 20 (comme `docker/Dockerfile.portal`), `npm ci` si `package-lock.json` existe sinon `npm install`, `CI=false INLINE_RUNTIME_CHUNK=false npm run build`, artefact `portal-<nom>` (7 jours) | Seuls `merchant` et `partners` ont un lockfile ; les autres sont installés en `npm install` (non reproductible, un `::notice::` le rappelle). |
| `landing` | `python3 -I scripts/check-landing.py portal/landing` | Équilibre des balises, `id` dupliqués, liens/ressources/ancres internes résolus comme `nginx-landing.conf` (`$uri`, `$uri/`, `$uri.html`), `sitemap.xml`, `node --check` sur `app.js`/`assistant.js`. |
| `php` | `php -l` sur `sdk/php` et `plugins/` en PHP 7.4 (minimum annoncé par le plugin) et 8.3 | `shivammathur/setup-php`. |
| `sdk-js` | `node --check` sur `sdk/javascript` | Le SDK JS a sa propre version (`1.1.0`). |
| `expo` | `npm install` dans `mobile/cpay-mobile`, transformation de `App.js` par `@babel/core` + `babel-preset-expo` | Pas de lockfile Expo ; pas de build natif (EAS). |
| `android` | JDK 17 (Temurin), `android-actions/setup-android` (platform 34, build-tools 34.0.0), `gradle/actions/setup-gradle`, `./gradlew :app:assembleDebug`, artefact `android-debug-apk` (7 jours) | `android/local.properties` (suivi dans git, `sdk.dir=/opt/android-sdk`) est réécrit avec `$ANDROID_HOME` sur le runner. Wrapper Gradle 8.5 (AGP 8.2.0) dans `android/gradle/wrapper`. |
| `docker` | `docker/Dockerfile.api`, `docker/Dockerfile.portal` (`APP_DIR=portal/merchant`) avec cache GHA, sans push ; `nginx -t` sur `nginx-landing.conf`, `nginx-spa.conf` et `nginx.conf` (certificats factices, upstreams résolus vers `127.0.0.1`) | |
| `version-check` | `scripts/check-version.sh` puis `sh -n`/`bash -n` sur tous les scripts | Voir `docs/VERSIONING.md` pour la liste des emplacements. |

Durée typique : les jobs sont parallèles ; le plus long est `android` (≈ 6-8 min à froid, moins avec le cache Gradle).

## 3. `release.yml`

1. `verify` : le tag `vX.Y.Z` doit être égal à `VERSION` (sinon échec explicite), `scripts/check-version.sh`,
   section `## X.Y.Z` présente dans `CHANGELOG_AMELIORATIONS.md`, `npm ci && npm test` dans `backend/`.
2. `android` : `./gradlew :app:assembleRelease :app:bundleRelease` (splits ABI + APK universel).
   Si les quatre secrets `ANDROID_KEYSTORE_*` sont présents : `zipalign` + `apksigner sign` pour chaque APK,
   `jarsigner` pour l'AAB (`cpay-<version>-<abi>.apk`, `cpay-<version>.aab`). Sinon les fichiers sont publiés
   **non signés** (`…-unsigned.apk/.aab`) et les notes de la release le disent. Le keystore n'est écrit que dans
   `$RUNNER_TEMP`, les mots de passe passent par `env:` (jamais sur la ligne de commande).
3. `archives` : `scripts/build-archives.sh <version> --out dist` — `cpay-android-sdk-v<version>.zip`
   (racine `cpay-android-sdk/`) et `cpay-payment-gateway-v<version>.zip` (racine `cplus-payment-gateway/`),
   `zip -r -X`, même disposition que les archives de la page développeurs.
4. `release` : `SHA256SUMS` sur tous les fichiers, notes = `scripts/changelog-section.sh <version>` + état de la
   signature + sommes, `gh release create` (ou `edit`/`upload --clobber` si la release existe déjà), puis
   `gh workflow run deploy.yml -f ref=vX.Y.Z`.

> Une release créée avec `GITHUB_TOKEN` ne déclenche pas l'événement `release: published` des autres workflows
> (règle GitHub). C'est pourquoi `release.yml` lance explicitement `deploy.yml` par `workflow_dispatch`.
> L'événement `release: published` reste utile pour une release créée à la main dans l'interface.

## 4. `deploy.yml` et environnement `production`

### Configuration à faire une fois (propriétaire du dépôt)

1. **Settings → Environments → New environment** : `production`.
   - **Required reviewers** : ajouter les personnes habilitées à approuver une mise en production
     (le job reste en attente tant qu'un relecteur n'a pas approuvé).
   - Optionnel : *Deployment branches and tags* → `main` et `v*` uniquement.
2. **Settings → Secrets and variables → Actions** (secrets d'environnement `production` ou de dépôt) :

| Secret | Obligatoire | Usage |
|--------|-------------|-------|
| `OVH_SSH_HOST` | oui | Hôte/IP du VPS OVH. |
| `OVH_SSH_PORT` | non (22) | Port SSH. |
| `OVH_SSH_USER` | oui | Utilisateur SSH (membre du groupe `docker`, droits d'écriture sur `/opt/cplus`). |
| `OVH_SSH_KEY` | oui | Clé privée OpenSSH (ed25519 recommandé) dédiée au déploiement ; la clé publique dans `~/.ssh/authorized_keys` du serveur. |
| `OVH_KNOWN_HOSTS` | recommandé | Sortie de `ssh-keyscan -p <port> <host>` ; sans lui, l'empreinte est acceptée au premier contact (avertissement dans le run). |
| `ANDROID_KEYSTORE_BASE64` | non | `base64 -w0 release.jks` — signature des APK/AAB de release. |
| `ANDROID_KEYSTORE_PASSWORD` | non | Mot de passe du keystore. |
| `ANDROID_KEY_ALIAS` | non | Alias de la clé. |
| `ANDROID_KEY_PASSWORD` | non | Mot de passe de la clé. |

`GITHUB_TOKEN` suffit pour créer la release et lancer `deploy.yml` (permissions `contents: write`,
`actions: write` déclarées dans `release.yml`).

### Ce que fait le job

1. Résout la référence (`inputs.ref` ou tag de la release) et la valide (`[A-Za-z0-9._/-]`, pas de `..`).
2. Écrit la clé privée dans `$RUNNER_TEMP/ssh/key` (`umask 077`), `known_hosts` depuis le secret ou `ssh-keyscan`.
3. `ssh` natif (aucune action tierce), `StrictHostKeyChecking=yes`, puis sur le serveur :
   ```sh
   cd /opt/cplus && git fetch --all --tags --prune && git checkout --detach <ref> && ./scripts/deploy.sh [--skip-backup]
   ```
   (une branche est déployée depuis `origin/<branche>`).
4. Smoke test depuis le runner : `https://api.c-pay.global/health` doit contenir `"status":"ok"`,
   `https://c-pay.global/` doit répondre, et pour un tag `vX.Y.Z` le champ `version` de `/health` doit valoir `X.Y.Z`.
5. Suppression de la clé (`if: always()`).

## 5. `scripts/deploy.sh` — déploiement standard sur le serveur

POSIX `sh`, idempotent, utilisable à la main depuis `/opt/cplus` :

```sh
./scripts/deploy.sh                    # déploiement complet du commit courant
./scripts/deploy.sh --skip-backup      # sans sauvegarde (déconseillé)
./scripts/deploy.sh --skip-build       # réutilise les images déjà construites
./scripts/deploy.sh --skip-migrations
./scripts/deploy.sh --rollback         # revient au commit précédent (voir § 6)
```

Étapes :

1. **État** : lit `/opt/cplus/.deployed` (commit courant/précédent), journal dans `/var/log/cplus/deploy_<date>.log`
   (ou à la racine du dépôt si non inscriptible). `.deployed` et `.deploy-history` sont ignorés par git.
2. **Build** : `docker compose build` avec `CPLUS_TAG=<VERSION>` → images `cplus-api:<version>`, `cplus-admin:<version>`, …
3. **Environnement** : `backend/scripts/check-production-env.js` exécuté dans l'image API fraîchement construite
   (`docker compose run … -v backend/scripts:/app/scripts:ro`) — pas besoin de Node ni de `node_modules` sur l'hôte.
4. **Sauvegarde** : `scripts/backup-db.sh --label pre-<version>` (échec = arrêt, sauf `--skip-backup`).
5. **Migrations** : `docker compose run --rm --no-deps -e RUN_MIGRATIONS=false api node src/config/migrate.js`.
6. **Démarrage** : `docker compose up -d --remove-orphans` (api, 4 portails, vitrine, settlement-cron), puis
   écriture de `.deployed`.
7. **Health checks** : `127.0.0.1:3001/health` (API, bloquant, 90 s), `127.0.0.1:3006/` (vitrine, bloquant),
   portails `3002`-`3005` (avertissement seulement). En cas d'échec le script indique la commande de rollback.

`scripts/deploy-ovh.sh`, `scripts/deploy-prod.sh` et le mode opératoire de `docs/WAVE-2.md` §3 restent des
procédures historiques ; `deploy.sh` est le standard à partir de la 2.7.0.

## 6. Procédure de mise en production

1. Développer sur une branche `wave-N` (ou `fix/…`) → la CI tourne à chaque push.
2. Ouvrir une PR vers `main` ; `main` est protégée (CI verte + relecture requises).
3. Avant le merge, passer la version : `./scripts/bump-version.sh X.Y.Z`, compléter la section `## X.Y.Z` du
   `CHANGELOG_AMELIORATIONS.md`, commit (`scripts/check-version.sh` est vérifié par la CI).
4. Merger, puis taguer le commit de `main` :
   ```sh
   git checkout main && git pull
   git tag -a vX.Y.Z -m "C-Pay X.Y.Z" && git push origin vX.Y.Z
   ```
5. `release.yml` crée la GitHub Release (APK/AAB, zips, `SHA256SUMS`) et lance `deploy.yml`.
6. Un relecteur de l'environnement `production` **approuve** le déploiement dans l'onglet Actions ;
   le job déploie puis exécute le smoke test. Les notes de la release indiquent si l'APK est signé.
7. Après coup : publier les archives sur la vitrine si besoin (`scripts/build-archives.sh X.Y.Z --update-landing`
   met à jour `portal/landing/downloads/` et les SHA-256 de `developers.html` ; `bump-version.sh` le fait déjà),
   soumettre l'AAB sur le Play Store, suivre `docs/WAVE-N.md` pour les actions manuelles (réconciliation, etc.).

Déploiement d'un correctif urgent sans release : **Actions → Deploy production → Run workflow** avec `ref` =
commit/branche, après approbation. Le smoke test ne vérifie la version exposée que pour un tag.

## 7. Rollback

Sur le serveur (ou via `deploy.yml` avec `ref` = tag précédent) :

```sh
cd /opt/cplus && ./scripts/deploy.sh --rollback
```

- Revient au commit `previous` de `.deployed`, reconstruit les images (`CPLUS_TAG` = ancienne `VERSION`),
  `docker compose up -d`, vérifie `/health`, puis inverse `current`/`previous` (un second `--rollback` revient donc
  en avant).
- Les **migrations ne sont pas annulées** : les migrations sont additives et compatibles avec la version précédente ;
  si une restauration de données est nécessaire, utiliser la sauvegarde `pre-<version>` :
  `scripts/restore-db.sh` (voir `docs/HOTFIX-V1.md`).
- Alternative sans rebuild : les images précédentes restent présentes (`docker images cplus-api`) ;
  `CPLUS_TAG=<ancienne version> docker compose up -d --no-build` depuis `docker/`.

## 8. Vérifier localement avant de pousser

```sh
bash scripts/check-version.sh                 # cohérence des versions
python3 -I scripts/check-landing.py           # vitrine
sh scripts/check-js-syntax.sh backend/src sdk/javascript
(cd backend && npm ci && npm test)
for f in scripts/*.sh; do bash -n "$f"; done
python3 -c "import yaml,sys;[yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/workflows/*.yml
```

## 9. Limites connues

- Les builds Android (debug en CI, release + signature dans `release.yml`) n'ont pas pu être exécutés hors GitHub
  (pas de SDK Android dans l'environnement de développement) : le premier run sur GitHub fait foi.
  `minifyEnabled true` en release peut nécessiter des règles ProGuard supplémentaires.
- Cinq portails n'ont pas de `package-lock.json` : leurs builds CI dépendent du registre npm au moment du run.
  Générer et committer un lockfile (`npm install --package-lock-only`) les rendrait reproductibles et plus rapides (`npm ci`).
- `docker/Dockerfile.api` ne copie pas `backend/scripts/` : `deploy.sh` monte ce dossier en lecture seule pour le
  contrôle d'environnement ; les commandes `docker compose run … node scripts/…` citées dans `docs/WAVE-2.md` /
  `docs/WAVE-3.md` nécessitent le même montage (`-v "$PWD/../backend/scripts:/app/scripts:ro"`).

## Déploiement automatique (depuis la vague 5)

Chaque fusion sur `main` déclenche le pipeline CI ; s'il est vert, `deploy.yml` se lance automatiquement
(`workflow_run`) et déploie le commit testé sur OVH. L'environnement GitHub `production` reste le point de
contrôle : sans « required reviewers », le déploiement part seul ; avec, il attend une approbation.
Le déploiement manuel (`workflow_dispatch`) et le déploiement par release restent disponibles.
