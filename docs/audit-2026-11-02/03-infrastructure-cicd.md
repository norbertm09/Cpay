# Audit infrastructure et chaîne de livraison — C-Pay

Dépôt `/home/user/cpay`, branche `develop`, commit `e8a536e` (2026-11-02). Lecture seule : fichiers du dépôt,
`bash -n` / `sh -n` sur tous les scripts, `yaml.safe_load` sur les workflows et les fichiers compose,
`git show origin/feature/supervision-prod:scripts/setup-monitoring.sh` (PR 36),
`git show origin/feature/mobile-stores:.github/workflows/mobile-expo.yml` (PR en cours), `gh api repos/norbertm09/cpay`.

Hors périmètre (déjà connus, non repris) : branches `main`/`develop` non protégées, DNS `merchant.` sur l'ancien
serveur, TLS Postgres non vérifié, vhost nginx de production hors dépôt, supervision non activée, certificat
`partners` expiré.

Non vérifiable depuis le dépôt : le vhost nginx de production réel (en-têtes, `client_max_body_size`, zones de
limitation), les réglages de l'environnement GitHub `production` (required reviewers, deployment branches — l'API
`/environments` est bloquée par le proxy), les sauvegardes côté OVH Cloud DB.

## Synthèse

| # | Sév. | Constat |
|---|------|---------|
| 1 | P1 | Dépôt **public** : topologie, IP, chemins, crons et artefacts (APK debug, builds portails, APK/AAB release non signés) accessibles à tous |
| 2 | P1 | Déploiement GitHub Actions en **root** SSH sur la production, sans commande forcée |
| 3 | P1 | Sauvegardes : copie hors serveur non effective (rclone non installé), non chiffrées, échec silencieux, restauration jamais répétée |
| 4 | P1 | Chaîne d'alerte incomplète : `node-exporter`/`postgres-exporter` scrapés mais absents (3 alertes mortes), healthcheck et backup cron muets, rien sur le certificat |
| 5 | P1 | Rollback lent et images précédentes écrasées (même `CPLUS_TAG` tant que `VERSION` ne change pas, `image prune`) |
| 6 | P1 | Indisponibilité et charge à chaque déploiement : builds Vite sur le serveur de prod, `compose up` recrée l'API, vitrine bind-mount modifiée dès `git checkout`, double déploiement main + tag |
| 7 | P1 | Parsing de `backend/.env` incohérent : `restore-db.sh` et le runbook `source`nt le fichier (bug déjà corrigé dans `backup-db.sh`) |
| 8 | P2 | Conteneurs non durcis : nginx des portails en root, pas de limites CPU/RAM, `settlement-cron` reçoit tous les secrets |
| 9 | P2 | Images et runtimes non épinglés : tags flottants, `certbot:latest`, nginx 1.25 (fin de vie), Node 20 (EOL avril 2026) |
| 10 | P2 | Actions tierces épinglées par tag majeur, pas de Dependabot, `contents: write` + `actions: write` sur tout `release.yml` |
| 11 | P2 | Angles morts de la CI : image API jamais démarrée, migrations sur PGlite seulement, `docker compose config` non validé, `deploy.sh` jamais exécuté |
| 12 | P2 | Hôte : pas d'`unattended-upgrades`, pas de suivi de redémarrage noyau, sshd non durci par script, `daemon.json` non idempotent |
| 13 | P2 | Documentation désalignée et scripts hérités cassés (`deploy-prod.sh` cible un service `postgres` inexistant, `renew-tls.sh` cible le nginx conteneurisé, `backend/.env.example` absent) |

> **Suivi lot 7 (2026-11-09)** : § 8 à 13 traités (`CHANGELOG_AMELIORATIONS.md` 2.7.2-lot7). Exceptions assumées : actions
> GitHub toujours par tag majeur (Dependabot les suit, le jeton CI ne lit pas les dépôts tiers) ; images par tag mineur, pas
> par digest ; `settlement-cron` conserve `env_file: backend/.env` (le passage à un fichier dédié demande une action serveur,
> documentée dans `docs/EXPLOITATION.md`) ; `deploy.sh` reste hors CI.

Aucun P0 bloquant pour le pilote dans le périmètre infra ; les 7 P1 sont à traiter avant l'ouverture aux marchands.

---

## Constats détaillés

### 1. P1 — Dépôt public exposant l'infrastructure et les artefacts

**Preuve.** `gh api repos/norbertm09/cpay` → `"private": false, "visibility": "public"`. `docs/GO-LIVE-CG.md:317`
liste « dépôt en privé » comme point encore ouvert. Le dépôt publie en clair : IP de prod et de dev et chemins
(`scripts/init-vps.sh:5-13`, `scripts/vps-export.sh:96`, `docs/ENVIRONNEMENTS.md:8,51-52`), crons et emplacement
des sauvegardes (`scripts/init-vps.sh:271-279`), jails fail2ban (`:119-137`), la liste des ports internes, les routes
de paiement protégées par rate-limit (`docker/nginx.conf:149,164`) et le nom du secret de webhook dans l'URL
(`docs/GO-LIVE-CG.md:254-255`). Les artefacts de CI sont téléchargeables par tout compte GitHub : builds des 7
portails (`.github/workflows/ci.yml:97-102`), APK debug (`:226-231`) ; les Releases publient des APK/AAB **non
signés** si les secrets manquent (`.github/workflows/release.yml:115-123,192`). Le clone sur le serveur se fait en
HTTPS anonyme (`scripts/init-vps.sh:34,184`), ce qui est cohérent avec un dépôt public.
Aucun secret n'est versionné (`git grep` de motifs `PASSWORD=|SECRET=|TOKEN=` vide ; `.gitignore:11-13`).

**Impact.** Reconnaissance gratuite pour un attaquant (surfaces, versions, limites de rate, chemins) ; un APK « release »
non signé publié sous le nom C-Pay peut être repackagé et redistribué ; fuite accidentelle d'un secret dans un
commit devient immédiatement publique.

**Correction.** Passer le dépôt en privé (prévu) et basculer `init-vps.sh`/`deploy.yml` sur la clé de lecture
GitHub déjà prévue (`--github-ssh-key`). Ne publier dans les Releases que des APK signés (échouer si
`ANDROID_KEYSTORE_*` manquent au lieu d'avertir). Restreindre la rétention des artefacts CI de portails à 1 jour ou
les supprimer.

### 2. P1 — Déploiement en root SSH depuis GitHub Actions

**Preuve.** `docs/ENVIRONNEMENTS.md:51-52` : `OVH_SSH_USER=root` pour les deux environnements ;
`scripts/init-vps.sh:191-195` ajoute la clé de déploiement dans `/root/.ssh/authorized_keys` sans
`command=`/`restrict` ; `scripts/init-vps.sh:272` : « deploiement GitHub Actions en root ».
`.github/workflows/deploy.yml:142-156` : le runner exécute un script arbitraire via `sh -s` sur l'hôte.
`docs/CI-CD.md:74` décrit pourtant un utilisateur « membre du groupe docker ».

**Impact.** La compromission d'un seul secret GitHub (`OVH_SSH_KEY`) ou d'un workflow (action tierce, cf. #10)
donne root sur le serveur de paiement et sur la base (via `backend/.env`). Pas de trace d'audit séparée des actions
humaines et automatiques.

**Correction.** Créer un utilisateur `deploy` (groupe `docker`, propriétaire de `/opt/cplus`) et, dans
`authorized_keys`, forcer la commande : `restrict,command="/opt/cplus/scripts/deploy-remote.sh" ssh-ed25519 …`,
le script lisant `REF`/`DEPLOY_ARGS` depuis `SSH_ORIGINAL_COMMAND` après validation. Mettre à jour
`init-vps.sh`, `ENVIRONNEMENTS.md` et le secret `OVH_SSH_USER`.

### 3. P1 — Sauvegardes : ni hors serveur, ni chiffrées, ni testées, échec silencieux

**Preuve.** `scripts/backup-db.sh:46-48` : la copie distante ne se fait que si `BACKUP_REMOTE` est défini **et**
`rclone` présent ; `scripts/init-vps.sh:67-72` n'installe pas `rclone` et `check-production-env.js` ne vérifie
pas `BACKUP_REMOTE` → en l'état, aucune copie hors du VPS. Le dump est un `.sql.gz` en clair (`:41`), protégé par
`umask 077` et `chmod 700` seulement (`:10`, `init-vps.sh:166`). La purge de rétention (`:50`) s'exécute même si la
copie distante a échoué. Cron `0 1 * * *` redirigé vers un fichier sans notification (`init-vps.sh:276`).
`scripts/restore-db.sh:11` est interactif (`read -p … (oui/non)`) : non scriptable, donc jamais répété
automatiquement ; aucune procédure de test de restauration dans `docs/GO-LIVE-CG.md §4` ni `OVH_DEPLOYMENT.md`.
`scripts/vps-export.sh:14` qualifie l'archive de migration (contenant `.env`, clés privées TLS, `authorized_keys`)
de « chiffrée-par-permissions » : elle ne l'est pas.

**Impact.** Perte du VPS (ou chiffrement par rançongiciel) = perte de toutes les sauvegardes applicatives ; on
dépend alors uniquement des sauvegardes OVH Cloud DB, non vérifiées. Une sauvegarde cassée depuis des semaines ne
serait remarquée qu'au moment d'en avoir besoin.

**Correction.** Installer `rclone` dans `init-vps.sh`, rendre `BACKUP_REMOTE` obligatoire en prod (vérification
dans `deploy.sh`), chiffrer avant envoi (`age -r <clé ops>` ou `gpg`) et ne purger qu'après copie réussie.
Ajouter un `--yes` à `restore-db.sh` et un test mensuel de restauration dans `cplus_db_dev` (cron sur le serveur
de dev). Envoyer un battement de cœur (healthchecks.io ou `POST` Alertmanager) à la fin de chaque sauvegarde.

### 4. P1 — Chaîne d'alerte incomplète : règles mortes, crons muets, certificat non surveillé

**Preuve.** `monitoring/prometheus/prometheus.yml:25-31` scrape `node-exporter:9100` et `postgres-exporter:9187`
mais `monitoring/docker-compose.monitoring.yml:28-70` ne définit que `prometheus` et `alertmanager` ;
`scripts/setup-monitoring.sh` (PR 36) ne les ajoute pas non plus. Les alertes `DiskSpaceLow`, `HighMemory`,
`PostgreSQLDown` (`monitoring/prometheus/alerts.yml:16-30`) ne peuvent donc jamais s'évaluer, et aucune règle
`up == 0` ne couvre ces jobs (`APIDown` ne cible que `cplus-api`, `:4-6`). Aucune alerte sur l'expiration du
certificat ou sur l'échec de `certbot.timer`. `scripts/healthcheck-prod.sh:3,10-17` : `set -e` arrête à la
première URL en échec, ne teste ni `app.`/`card.`/`pay.` ni la vitrine, et écrit dans
`/var/log/cplus/healthcheck.log` (`init-vps.sh:278`) sans notifier qui que ce soit. Idem pour la sauvegarde (#3).

**Impact.** Une fois la supervision activée, disque plein, mémoire saturée ou base injoignable ne déclencheront
aucun e-mail ; les deux crons « d'exploitation » ne font que remplir des fichiers que personne ne lit.

**Correction.** Ajouter `prom/node-exporter` et `prometheuscommunity/postgres-exporter` (DSN lecture seule) au
compose de supervision, ou retirer les règles ; ajouter `up == 0` générique et une alerte
`probe_ssl_earliest_cert_expiry` (blackbox-exporter) ou un cron `certbot certificates` → mail. Faire émettre par
`healthcheck-prod.sh` et `backup-db.sh` une alerte (`curl -XPOST 127.0.0.1:9093/api/v2/alerts`, ou `mail`) en cas
d'échec, et étendre le healthcheck à tous les vhosts.

### 5. P1 — Rollback lent et images précédentes non conservées

**Preuve.** `scripts/deploy.sh:80-81` : `CPLUS_TAG` = contenu de `VERSION` ; `docker/docker-compose.yml:10,41,58,107,127` :
`image: cplus-*:${CPLUS_TAG:-2.7.0}`. Deux commits successifs avec la même `VERSION` (cas général entre deux
releases, p. ex. tous les merges sur `main` → déploiement automatique) écrasent la **même** étiquette ; l'ancienne
image devient `<none>` et `docker image prune -f --filter until=168h` (`deploy.sh:169`) la supprime au bout de 7 j.
`deploy.sh --rollback` reconstruit donc toutes les images (`:91`) avant de redémarrer — plusieurs minutes de
build Vite sur le VPS — et `docs/CI-CD.md:162-163` (« alternative sans rebuild : `CPLUS_TAG=<ancienne version> …
--no-build` ») est fausse quand la version n'a pas changé. Les migrations ne sont pas annulées (`:92`), assumé.

**Impact.** Temps de rétablissement de l'ordre de 10 à 15 min au lieu de secondes ; en cas d'échec de build sur
l'ancien commit (dépendance npm disparue, réseau), pas de retour arrière possible.

**Correction.** Étiqueter les images avec le SHA : `CPLUS_TAG="$VERSION-$(git rev-parse --short HEAD)"` dans
`deploy.sh`, mémoriser le tag dans `.deployed`, et faire du rollback un `compose up -d --no-build` sur le tag
précédent ; ne purger que les images plus anciennes que les 3 derniers tags. Corriger `docs/CI-CD.md §7`.

### 6. P1 — Indisponibilité et charge à chaque déploiement, double déploiement

**Preuve.** Builds sur le serveur de production : `scripts/deploy.sh:109-119` construit séquentiellement 5 images
dont 4 builds Vite avec `NODE_OPTIONS=--max-old-space-size=2048` (`docker/Dockerfile.portal:10`) et
`npm ci` complet à chaque fois (`:12`), pendant que l'API de paiement sert le trafic. `compose up -d` (`:149`)
recrée le conteneur `api` dès que l'image change : nginx hôte renvoie 502 jusqu'au démarrage (migrations rejouées
au boot, `docker-compose.yml:20` + `docker/api-entrypoint.sh:4-6`, `start_period: 60s` `:28`) ; pas de
blue/green ni de second réplica. La vitrine est un bind-mount du checkout (`docker-compose.yml:143`) : le
`git checkout --detach` fait par le runner (`deploy.yml:153`) la modifie **avant** le build, les tests
d'environnement et la sauvegarde. Enfin, un commit de `main` est déployé deux fois : par `workflow_run` après la CI
(`deploy.yml:36-39,71-76`) puis, s'il est tagué, par `release.yml:195` (`gh workflow run deploy.yml`) — deux
rebuilds et deux redémarrages de l'API pour le même code.

**Impact.** Fenêtre de 502 à chaque mise en production (callbacks opérateurs MTN/Airtel perdus → dépendance au
rapprochement), latence dégradée pendant les builds, vitrine potentiellement cassée si le déploiement échoue avant
`compose up`.

**Correction.** Construire les images en CI (`docker/build-push-action` avec `push: true` vers GHCR, tag SHA) et
remplacer le build serveur par `compose pull` ; démarrer la nouvelle API à côté de l'ancienne (second service
`api-next` ou plugin `docker rollout`) avec `proxy_next_upstream` côté nginx hôte avant de retirer l'ancienne ;
copier la vitrine dans une image (`COPY portal/landing`) au lieu du bind-mount ; dans `deploy.yml`, ignorer le
`workflow_run` quand `.deployed` contient déjà le SHA (ou ne déployer la prod que par tag).

### 7. P1 — Parsing de `backend/.env` incohérent entre les outils

**Preuve.** `scripts/backup-db.sh:18-29` lit le fichier ligne à ligne précisément parce que « une valeur contenant
( ) # $ ' " ou un espace faisait échouer la sauvegarde, donc le déploiement ». Mais `scripts/restore-db.sh:8`
(`set -a; . "$ROOT/backend/.env"; set +a`) et le runbook `docs/GO-LIVE-CG.md:90` (`set -a && . backend/.env`)
continuent de **sourcer** le fichier ; Compose (`docker-compose.yml:16-17,158-159`) applique ses propres règles
(interpolation `${…}`, guillemets) et `dotenv` (`backend/scripts/check-production-env.js:4`) les siennes.
`docs/GO-LIVE-CG.md:120` recommande d'ailleurs des guillemets simples pour les clés MTN.

**Impact.** Le jour d'un incident, `restore-db.sh` peut échouer ou — pire — exécuter une valeur comme commande
shell ; une même variable peut être lue différemment par l'API, la sauvegarde et la restauration (ex. `$` ou `#`
dans un mot de passe).

**Correction.** Extraire `read_env_var` dans `scripts/lib/env.sh` et l'utiliser dans `restore-db.sh`, `GO-LIVE-CG.md`
et `setup-monitoring.sh` (qui a déjà sa copie, `:49`) ; ajouter un test shell (`bats` ou `node --test`) avec une
valeur piégée. Documenter une seule règle d'écriture (toujours entre guillemets simples, pas d'interpolation).

### 8. P2 — Conteneurs non durcis

**Preuve.** `docker/Dockerfile.portal:20-25` et `portal/partners/Dockerfile:15-18` : image `nginx:1.25-alpine`
sans `USER` (processus maître root), et `partners` sans `HEALTHCHECK` ; `landing` idem (`docker-compose.yml:138-150`).
Aucun `mem_limit`/`cpus`/`deploy.resources`, `cap_drop`, `security_opt: no-new-privileges` ni `read_only` dans
`docker/docker-compose.yml` (grep vide). `settlement-cron` (`:153-163`) charge **tout** `backend/.env`
(mots de passe DB, JWT, clés opérateurs) dans un conteneur `alpine` dont la seule mission est un `wget` nocturne,
et `INTERNAL_TOKEN` figure dans la ligne de commande (`docker inspect`). DNS forcé sur 8.8.8.8/1.1.1.1 (`:13-15`).
Positif : l'API tourne sous `cplus` avec `tini` (`Dockerfile.api:7-9,20,24`).

**Impact.** Un build Vite emballé ou une fuite mémoire de l'API peut saturer l'hôte (12 Go partagés avec nginx) ;
une faille nginx dans un portail donne root dans le conteneur ; surface de fuite de secrets élargie.

**Correction.** Passer les portails sur `nginxinc/nginx-unprivileged:1.28-alpine` (port 8080) ; ajouter
`mem_limit`/`cpus` par service et `security_opt: [no-new-privileges:true]`, `cap_drop: [ALL]` (+ `NET_BIND_SERVICE`
si nécessaire) ; pour `settlement-cron`, remplacer `env_file` par `environment: INTERNAL_TOKEN=${INTERNAL_TOKEN}`
lu depuis un fichier dédié.

### 9. P2 — Images et runtimes non épinglés, versions en fin de vie

**Preuve.** Tags flottants sans digest : `node:22-alpine` (`Dockerfile.api:1,6`), `node:20-alpine`
(`Dockerfile.portal:1`, `portal/partners/Dockerfile:1`), `nginx:1.25-alpine` (portails) vs `nginx:1.27-alpine`
(vitrine, `docker-compose.yml:139`), `alpine:3.21` (`:154`), `certbot/certbot:latest` (`:85`). Node 20 est en fin
de vie depuis le 30/04/2026 et reste le builder des 5 portails et de la CI (`ci.yml:83,187`) ; nginx 1.25 n'est
plus maintenu. Pas de `.github/dependabot.yml` ni `renovate.json`.

**Impact.** Builds non reproductibles (un `docker compose build` demain peut produire une image différente, et le
rollback de #5 en dépend), correctifs de sécurité nginx/Node non suivis.

**Correction.** Épingler par digest (`node:22-alpine@sha256:…`) et laisser Dependabot (`package-ecosystem: docker,
github-actions, npm`) proposer les montées ; aligner les portails sur Node 22 et `nginx:1.28-alpine`.

### 10. P2 — Actions tierces par tag majeur, permissions larges dans `release.yml`

**Preuve.** `shivammathur/setup-php@v2` (`ci.yml:155`), `android-actions/setup-android@v3` (`ci.yml:209`,
`release.yml:72`), `gradle/actions/setup-gradle@v4`, `docker/build-push-action@v6`, `expo/expo-github-action@v8`
avec `eas-version: latest` (`mobile-expo.yml:51-53`) : tags mutables, pas de SHA. `release.yml:14-16` déclare
`contents: write` et `actions: write` **au niveau du workflow**, donc aussi pour les jobs `android` et `archives`
qui exécutent ces actions et les plugins Gradle. `ci.yml:15-16`, `deploy.yml:41-42` et `mobile-expo.yml:27-28`
sont correctement en `contents: read`. Aucune variable `inputs.*` n'est interpolée directement dans un `run:` de
`deploy.yml` (passage par `env:`, `:57-64`) ; `mobile-expo.yml:64,70-72` interpole `${{ inputs.platform }}` et
`${{ inputs.profile }}` mais ce sont des `choice`, donc sans injection possible.

**Impact.** Un tag d'action détourné (incident `tj-actions` 2025) dans `release.yml` obtient un `GITHUB_TOKEN`
capable de réécrire les Releases (remplacer l'APK publié) et de lancer `deploy.yml` vers la production.

**Correction.** Épingler toutes les actions par SHA (Dependabot `github-actions` les maintient) ; dans
`release.yml`, descendre `permissions` au niveau du job `release` seul et laisser `contents: read` par défaut ;
fixer `eas-version`.

### 11. P2 — Angles morts de la CI

**Preuve.** L'image API est construite mais jamais démarrée (`ci.yml:240-248`, `push: false`, aucun `docker run`
ni `/health`) : `api-entrypoint.sh`, `tini`, les droits `cplus` et `npm ci --omit=dev` ne sont validés qu'en
production. Les migrations ne sont rejouées que sur **PGlite** (`backend/src/tests/migrations-fresh-db.test.js:10`),
pas sur PostgreSQL (aucun `services:` dans `ci.yml`), alors que `migrate.js` les applique en une transaction unique
(`backend/src/config/migrate.js:13,51,55`) dont le comportement diffère sur un vrai serveur (verrous, extensions,
`CONCURRENTLY`). `docker compose config` n'est jamais exécuté en CI ; `deploy.sh`, `backup-db.sh`, `restore-db.sh`
ne passent que `sh -n` (`ci.yml:301-308`). Le `nginx -t` porte sur `docker/nginx.conf` (profil `standalone-nginx`,
`:270-288`), qui n'est pas le reverse proxy de production. La recette navigateur (`:105-133`) tourne avec
`REACT_APP_API_BASE_URL=''` : aucun parcours ne traverse l'API réelle.

**Impact.** Une image API qui ne démarre pas, une migration valide en PGlite mais refusée par PostgreSQL ou un
`compose.yml` invalide ne sont détectés qu'au déploiement, pendant la fenêtre d'indisponibilité (#6).

**Correction.** Job `backend` : `services: postgres:16` et `node src/config/migrate.js` + `npm test` avec `DB_*` ;
job `docker` : `docker compose -f docker/docker-compose.yml config -q`, puis `docker run --rm cplus-api:ci` avec un
`.env` factice et `wget /health` ; job e2e optionnel API + portail (compose en CI).

### 12. P2 — Hôte : mises à jour, redémarrages, sshd

**Preuve.** `scripts/init-vps.sh:65-72` fait un `apt-get upgrade` une fois ; aucun `unattended-upgrades`,
`needrestart` ou vérification de `/var/run/reboot-required` dans les scripts ou crons (grep vide). Le script
n'écrit aucun `sshd_config.d/*.conf` (`vps-export.sh:65` copie celui de l'ancien serveur s'il existe) ; le
déploiement en root (#2) impose `PermitRootLogin` au moins `prohibit-password`. fail2ban couvre `sshd`,
`nginx-http-auth`, `nginx-botsearch` (`:127-135`) mais pas les 401/429 de l'API (`limit_req_status 429`,
`docker/nginx.conf:151`). `/etc/docker/daemon.json` n'est écrit que s'il est absent (`:102-107`) : une rotation
de logs différente sur un serveur déjà installé ne sera pas corrigée. Ubuntu 26.04 n'est pas une LTS (`:3`,
`docs/GO-LIVE-CG.md:4`) : support 9 mois.

**Impact.** Correctifs noyau/OpenSSL/nginx non appliqués entre deux interventions manuelles ; serveur de paiement
sur une version d'Ubuntu qui cessera d'être supportée avant la fin du pilote étendu.

**Correction.** `apt-get install unattended-upgrades needrestart` + `/etc/apt/apt.conf.d/50unattended-upgrades`
(sécurité seulement, redémarrage automatique dans une fenêtre nocturne ou alerte « reboot requis » via #4) ;
`sshd_config.d/10-cpay.conf` (`PasswordAuthentication no`, `PermitRootLogin prohibit-password` puis `no` après #2) ;
jail fail2ban `nginx-limit-req` ; planifier la migration vers 26.04 → 28.04 LTS ou réinstaller en 24.04 LTS.

### 13. P2 — Documentation désalignée et scripts hérités cassés

**Preuve.**
- `docs/CI-CD.md:28` : audit npm `critical` et « informatif (`continue-on-error`) » ; `ci.yml:64-65` : `high`, bloquant.
- `docs/CI-CD.md:17` : CI sur `main` et `wave-*` ; `ci.yml:8` inclut `develop`.
- `docs/CI-CD.md:181-182` : « cinq portails n'ont pas de `package-lock.json` » ; `ci.yml:86-87` : tous en `npm ci`.
- `docs/CI-CD.md:183-185` : « `Dockerfile.api` ne copie pas `backend/scripts/` » ; `docker/Dockerfile.api:14` le copie
  (et `deploy.sh:128` monte encore le dossier par-dessus).
- `backend/.env.example` n'existe pas (`ls` vide ; `.gitignore:13` l'autorise) mais est cité par `README.md:83,92`,
  `scripts/deploy-prod.sh:8`, `scripts/preflight.sh:10`.
- `scripts/deploy-prod.sh:19` démarre un service `postgres` absent de `docker-compose.yml` → échec garanti.
- `scripts/renew-tls.sh:7-8` et `scripts/init-tls.sh:21,36` pilotent le nginx **conteneurisé** (profil
  `standalone-nginx`) : lancés sur la prod 2.7, ils échouent ; `deploy-ovh.sh`, `init-ovh.sh`, `deploy-wave-2.sh`
  restent exécutables à la racine de `scripts/`.
- `docker/nginx-host/README.md:23` promet `docker/nginx-host/cpay.conf` et `init-vps.sh:251` renvoie vers
  `docker/nginx-host/cpay.conf.example` : aucun des deux n'existe (connu : vhost hors dépôt, mais les deux noms
  divergent).
- Étapes manuelles non scriptées : IP autorisées OVH Cloud DB, zone DNS, secrets GitHub, `nano backend/.env`
  (`docs/ENVIRONNEMENTS.md:91-94`, `docs/GO-LIVE-CG.md:84-131`) — acceptable, mais sans checklist de vérification
  automatisée (`check-production-env.js` ne couvre ni `BACKUP_REMOTE`, ni `DB_SSL`, ni `CAPABILITY_*`).

**Impact.** Un opérateur de garde qui suit la mauvaise page ou lance le mauvais script (`renew-tls.sh` un soir de
certificat expiré, `deploy-prod.sh` à la place de `deploy.sh`) perd du temps ou casse la prod.

**Correction.** Déplacer les scripts historiques dans `scripts/legacy/` (ou les supprimer, l'historique git suffit) ;
créer `backend/.env.example` à partir de `backend/src/config/env.js` ou retirer les références ; corriger les quatre
lignes de `docs/CI-CD.md` ; unifier le nom du futur vhost versionné.

---

## Points positifs vérifiés

1. **API conteneurisée proprement** : utilisateur non root `cplus`, `tini`, `npm ci --omit=dev`, `HEALTHCHECK`,
   aucun secret copié dans l'image (`docker/Dockerfile.api:7-9,20-24`) ; tous les ports publiés sur `127.0.0.1`
   uniquement (`docker/docker-compose.yml:30,47,64,116,133,148`) ; `/metrics` et `/internal/` bloqués et
   `METRICS_TOKEN` fail-closed (`docker/nginx.conf:145-146`, `backend/src/config/metrics.js:98-99`).
2. **Déploiement SSH sans action tierce et entrées maîtrisées** : `ssh` natif avec `StrictHostKeyChecking=yes`,
   clé dans `$RUNNER_TEMP` avec `umask 077` et suppression `if: always()`, `inputs.ref` passé par `env:` puis validé
   par expression régulière sans `..` (`deploy.yml:57-90,112-156,177-179`) ; garde-fou prod = `main` ou `vX.Y.Z` ;
   garde-fou `CPAY_DOMAIN` contre un déploiement de `develop` sur la prod (`:134-136`) ; concurrence par
   environnement sans annulation (`:97-99`).
3. **Séquence de déploiement défensive** : vérification de l'environnement dans l'image, **sauvegarde bloquante
   avant migration**, migrations en transaction unique avec somme de contrôle par fichier, health check bloquant de
   l'API, état `.deployed`/`.deploy-history` pour le retour arrière (`scripts/deploy.sh:125-158`,
   `backend/src/config/migrate.js:13-55`).
4. **Hôte initialisé de façon idempotente** : UFW `deny incoming` + 22/80/443, fail2ban, swap, rotation des logs
   Docker (`20m × 5`) et logrotate `/var/log/cplus`, `certbot.timer` avec hook `reload nginx`
   (`scripts/init-vps.sh:101-138,256-290`) ; `cleanup-foreign-vhosts.sh` a des garde-fous tirés d'un incident réel
   (`:9-12,43-53`).
5. **CI large et secrets bien traités** : tests Alertmanager/Prometheus (`promtool check` + `test rules`), 7 portails
   en `npm ci`, recette navigateur Playwright, PHP 7.4/8.3, Android debug, images Docker, syntaxe de tous les scripts
   (`ci.yml`) ; `release.yml` signe avec mots de passe en `env:` jamais en ligne de commande, keystore en
   `$RUNNER_TEMP` effacé (`:97-112`), `SHA256SUMS` publié ; `permissions: contents: read` partout sauf release.

## Note de maturité

| Axe | Note | Justification |
|-----|------|---------------|
| Infrastructure | **B** | Bases saines (non-root API, localhost-only, UFW/fail2ban, TLS auto, DB managée) ; manque le durcissement des portails et des limites de ressources (#8), l'épinglage des versions (#9), l'hygiène hôte (#12). |
| CI/CD | **B-** | Pipeline complet, entrées validées, sauvegarde avant migration ; mais dépôt public (#1), root SSH (#2), actions non épinglées et permissions larges (#10), image API et migrations réelles non testées (#11), rollback et déploiement non atomiques (#5, #6). |
| Exploitation | **C** | Aucune alerte n'atteint un humain aujourd'hui, et une partie des règles ne le pourra jamais (#4) ; sauvegardes locales non testées (#3) ; pas de mises à jour automatiques (#12) ; documentation et scripts hérités trompeurs (#13). |

Ordre de traitement conseillé avant l'ouverture aux marchands : #4 et #3 (être prévenu, pouvoir restaurer),
#2 et #1 (réduire le rayon d'explosion), #5 puis #6 (rétablir vite, déployer sans coupure), #7 (restauration fiable).
