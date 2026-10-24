# Environnements C-Pay : développement et production

Date : 2026-10-24 · Objectif : pilote en production le **01.11.2026**, développement continu sans risque pour la
production.

| | Développement | Production |
|---|---|---|
| Serveur | `51.91.98.115` (ancien serveur, mutualisé avec Toonah et LincPay) | `137.74.46.246` (VPS-3 2027 dédié, Ubuntu 26.04) |
| Domaines | `dev.c-pay.global`, `api.dev.`, `merchant.dev.`, `app.dev.`, `card.dev.`, `admin.dev.`, `pay.dev.`, `www.dev.` | `c-pay.global`, `api.`, `merchant.`, `app.`, `card.`, `admin.`, `pay.`, `www.` |
| Branche git | `develop` | `main` (+ tags `vX.Y.Z`) |
| Environnement GitHub | `development` (déploiement automatique) | `production` (relecteur obligatoire recommandé) |
| Base de données | base **dédiée** `cplus_db_dev` sur l'instance OVH Cloud DB (ou locale) | `cplus_db` (OVH Cloud DB) |
| Opérateurs | MTN / Airtel **sandbox** (`MTN_ENV=sandbox`) | MTN / Airtel **production** |
| Portails | compilés avec `CPAY_API_BASE_URL=https://api.dev.c-pay.global` (`docker/.env`) | valeur par défaut `https://api.c-pay.global` |
| Secrets | `backend/.env` propre à chaque serveur ; `WEBHOOK_PATH_SECRET`, `JWT_*`, clés opérateurs **différents** | |

Règle d'or : **aucun serveur de développement ne se connecte à la base de production.** Jusqu'à la mise en place
de la base de dev, l'ancien serveur pointe encore sur `cplus_db` : c'est la première chose à changer (§ 3).

## 1. Flux de livraison

```
feature/xxx ── PR ──▶ develop ──(CI verte)──▶ déploiement automatique sur dev.c-pay.global
                         │
                         │  validation fonctionnelle sur dev (marchand pilote, opérateurs sandbox)
                         ▼
                 PR develop ──▶ main ──(CI verte)──▶ déploiement production (approbation) ──▶ c-pay.global
                                  │
                                  └── tag vX.Y.Z ──▶ release.yml (APK/AAB, GitHub Release) ──▶ déploiement production
```

1. Développer sur une branche `feature/…` ou `fix/…`, ouvrir une PR vers `develop`. La CI tourne (tests, builds,
   audit).
2. Fusionner dans `develop` : `deploy.yml` déploie automatiquement sur le serveur de dev (`workflow_run` → environnement
   `development`). Vérifier sur `https://dev.c-pay.global`.
3. Quand le lot est validé : PR `develop` → `main` (changer la version avec `scripts/bump-version.sh X.Y.Z` et compléter le
   changelog dans cette PR). Fusionner : déploiement production, avec approbation si un relecteur est configuré.
4. Taguer `main` (`git tag -a vX.Y.Z && git push origin vX.Y.Z`) pour produire la GitHub Release et les APK/AAB.
5. Correctif urgent en production : branche `hotfix/…` depuis `main`, PR vers `main`, puis **reporter sur `develop`**
   (PR `main` → `develop`) pour ne pas perdre le correctif.

Garde-fous dans `deploy.yml` : la production n'accepte en déploiement manuel que `main` ou un tag `vX.Y.Z` ; un run par
environnement à la fois ; `develop` ne peut pas atteindre la production.

## 2. Configuration GitHub (une fois)

### 2.1 Environnements (Settings → Environments)

| Environnement | Secrets (mêmes noms dans les deux) | Variables | Règles |
|---|---|---|---|
| `production` | `OVH_SSH_HOST=137.74.46.246`, `OVH_SSH_USER=root`, `OVH_KNOWN_HOSTS=<empreinte 137.74.46.246>`, `OVH_SSH_KEY` (ou au niveau dépôt) | `CPAY_DOMAIN=c-pay.global` | Required reviewers : vous ; Deployment branches and tags : `main` et `v*` |
| `development` | `OVH_SSH_HOST=51.91.98.115`, `OVH_SSH_USER=root`, `OVH_KNOWN_HOSTS=<empreinte 51.91.98.115>`, `OVH_SSH_KEY` (ou au niveau dépôt) | `CPAY_DOMAIN=dev.c-pay.global` | aucune (déploiement automatique) |

`OVH_SSH_KEY` peut rester un secret de dépôt : la même clé `cpay_deploy2` est autorisée sur les deux serveurs. Les secrets
`OVH_SSH_HOST` / `OVH_KNOWN_HOSTS` **de dépôt** deviennent inutiles : les supprimer évite toute ambiguïté.

Empreinte d'un serveur : `ssh root@<ip> 'echo <ip> $(cut -d" " -f1-2 /etc/ssh/ssh_host_ed25519_key.pub)'`.

### 2.2 Branches (Settings → Branches ou Rulesets)

- `main` : « Require a pull request before merging » (0 approbation si vous êtes seul), « Require status checks to pass »
  avec les jobs de la CI (au minimum « Backend (syntaxe, jest, audit) », « Versions et scripts », « Images Docker +
  nginx -t », les portails), « Do not allow bypassing » désactivé pour vous permettre les urgences.
- `develop` : « Require status checks to pass » seulement.
- Créer `develop` depuis `main` une fois cette PR fusionnée et l'environnement `development` configuré :
  `git checkout main && git pull && git checkout -b develop && git push -u origin develop`.
  Changer la branche par défaut du dépôt en `develop` (Settings → General) pour que les PR la ciblent par défaut.

## 3. Mise en place du serveur de développement (ancien serveur)

À faire **avant** la bascule DNS de `c-pay.global` vers la production, pour que l'ancien serveur cesse de partager la
base de production.

1. **Base de dev** : manager OVH → Cloud Databases → l'instance PostgreSQL → Bases de données → ajouter `cplus_db_dev`
   et un utilisateur `cplus_dev` avec un mot de passe distinct. (Alternative : un conteneur PostgreSQL local sur le
   serveur de dev, non couvert ici.)
2. **DNS** : 8 enregistrements A vers `51.91.98.115` : `dev`, `www.dev`, `api.dev`, `admin.dev`, `merchant.dev`,
   `app.dev`, `card.dev`, `pay.dev` (TTL 300).
3. Sur l'ancien serveur, récupérer le code et lancer le script :
   ```sh
   cd /opt/cplus && git fetch origin main && git checkout origin/main -- scripts/setup-dev-server.sh
   bash scripts/setup-dev-server.sh --domain dev.c-pay.global
   ```
   Il obtient le certificat Let's Encrypt des 8 noms, dérive le vhost `cpay-dev` du vhost de production (mêmes blocs,
   noms et certificats remplacés), écrit `docker/.env` (URL d'API des portails) et liste les clés de `backend/.env` à
   modifier.
4. `nano /opt/cplus/backend/.env` : `DB_NAME=cplus_db_dev`, `DB_USER=cplus_dev`, `DB_PASSWORD=…`, `ALLOWED_ORIGINS`,
   `PAY_LINK_BASE_URL`, `MTN_CG_CALLBACK_URL` (valeurs affichées par le script), `MTN_ENV=sandbox`,
   `AIRTEL_CG_ENV=sandbox`, et de **nouvelles valeurs** pour `WEBHOOK_PATH_SECRET` et les secrets JWT / chiffrement
   (`openssl rand -hex 32`) : les secrets de dev ne doivent pas être ceux de la production.
5. `cd /opt/cplus && ./scripts/deploy.sh` : les migrations créent le schéma de `cplus_db_dev`, les portails sont recompilés
   avec l'URL `api.dev`. Puis créer le premier admin de dev (`scripts/create-first-admin.js`) et un marchand de test.
6. Vérifier : `https://dev.c-pay.global`, `https://api.dev.c-pay.global/health`, connexion marchand sur
   `https://merchant.dev.c-pay.global`.
7. Après la bascule DNS de la production (voir `GO-LIVE-CG.md` § 2), désactiver sur le serveur de dev le vhost de
   production devenu inutile : `bash scripts/setup-dev-server.sh --disable-prod-vhost` (ou `rm
   /etc/nginx/sites-enabled/cpay && nginx -t && systemctl reload nginx`), puis retirer `51.91.98.115` des IP autorisées de
   la **base** `cplus_db` si l'instance le permet par base, sinon vérifier simplement que `backend/.env` de dev ne la
   référence plus.

## 4. Ce qui diffère entre les deux serveurs, et pourquoi

| Élément | Développement | Production | Mécanisme |
|---|---|---|---|
| URL d'API des portails | `api.dev.c-pay.global` | `api.c-pay.global` | `docker/.env` → `CPAY_API_BASE_URL` → `args` de build dans `docker-compose.yml` |
| URL d'API de la vitrine | déduite du nom d'hôte (`dev.` → `api.dev.`) | `<meta name="cpay-api">` | `portal/landing/app.js`, `assistant.js` |
| Smoke test GitHub, health check cron | `dev.c-pay.global` | `c-pay.global` | variable d'environnement GitHub `CPAY_DOMAIN`, `docker/.env` pour `healthcheck-prod.sh` |
| CORS, liens de paiement, callbacks | `*.dev.c-pay.global` | `*.c-pay.global` | `backend/.env` (`ALLOWED_ORIGINS`, `PAY_LINK_BASE_URL`, `MTN_CG_CALLBACK_URL`) |
| nginx | vhost `cpay-dev` dérivé | vhost `cpay` | `scripts/setup-dev-server.sh` |
| Apps mobiles | build de dev à pointer sur `api.dev` (`REACT_APP_API_BASE_URL` / `apiBaseUrl` Expo, URL debug Android) | release | non automatisé pour l'instant |

## 5. Calendrier proposé jusqu'au pilote

| Date | Action |
|---|---|
| J | fusion de cette PR ; environnement `development` + variable `CPAY_DOMAIN` sur les deux environnements ; branche `develop` |
| J | base `cplus_db_dev`, DNS `*.dev.c-pay.global`, `setup-dev-server.sh`, `backend/.env` de dev, déploiement dev |
| J+1 | bascule DNS `c-pay.global` → 137.74.46.246 (GO-LIVE-CG § 2), identifiants MTN/Airtel de production sur la prod |
| J+1 → 31.10 | pilote interne sur la prod (checklist GO-LIVE-CG § 3.4), développements courants sur `develop` |
| 01.11.2026 | ouverture du pilote marchands sur `c-pay.global` |
