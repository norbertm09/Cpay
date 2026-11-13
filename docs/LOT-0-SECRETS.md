# Lot 0 — secrets de production : rotation, dépôt privé, certificat PostgreSQL

Audit du 2 novembre 2026, P0 #1 : le mot de passe PostgreSQL de `cplus_user` est lisible dans l'historique git d'un
dépôt **public** (commit `d880b8f`, `backend/reset-creds.js`). Le présent lot fournit l'outillage et l'ordre des
opérations ; les actions elles-mêmes (manager OVH, GitHub, serveur) sont à faire par un administrateur. Aucun secret
ne transite par un ticket, un chat ou un journal : les scripts n'affichent jamais les valeurs.

Outils livrés :

| Outil | Rôle |
|---|---|
| `scripts/rotate-secrets.sh` | `status`, `db-password`, `webhook-secret`, `mtn-token` (+ `--clear-previous`) : met à jour `backend/.env` de façon atomique après copie de secours `600` |
| `WEBHOOK_PATH_SECRET_PREVIOUS`, `MTN_WEBHOOK_TOKEN_PREVIOUS` | ancienne valeur acceptée **pendant** la rotation (les callbacks des paiements en cours arrivent sur l'ancienne URL / l'ancien jeton), retirée ensuite |
| `scripts/github-deploy-key.sh` | clé SSH de **lecture** pour que le serveur continue de `git fetch` un dépôt privé |
| `docker-compose.yml` (`x-api.volumes`) + `scripts/deploy.sh` | montage en lecture seule de `/etc/cplus/postgres-ca.pem` dans l'API quand le fichier existe |
| `scripts/tests/rotate-secrets.test.sh`, `backend/src/tests/lot0-rotation-secrets.test.js` | recette en CI |

Toutes les étapes ci-dessous se font sur le serveur de production (`/opt/cplus`, utilisateur qui lance les
déploiements) sauf mention contraire. Après chaque commande contenant un secret : `history -c`.

## 1. Mot de passe PostgreSQL (`cplus_user`) — 15 minutes, sans coupure

1. Manager OVH → Bases de données → instance PostgreSQL → **Utilisateurs** → `cplus_user` → **Réinitialiser le mot de
   passe**. Choisir un mot de passe d'au moins 16 caractères **sans guillemet simple** (non représentable dans `.env`).
   À partir de cet instant l'API en cours d'exécution garde ses connexions ouvertes mais ne peut plus en ouvrir de
   nouvelles : enchaîner tout de suite.
2. Sur le serveur :
   ```
   ./scripts/rotate-secrets.sh db-password      # saisie masquée, test de connexion, écriture de backend/.env
   ./scripts/deploy.sh --skip-backup --skip-migrations   # bascule bleu/vert sur le même commit : l'API relit .env
   sudo bash scripts/setup-monitoring.sh        # l'exporter PostgreSQL relit backend/.env
   ./scripts/backup-db.sh --label post-rotation # vérifie que pg_dump passe avec le nouveau mot de passe
   history -c
   ```
3. Contrôles : `curl -s https://api.c-pay.global/health`, `docker logs cplus-postgres-exporter --since 2m` (pas
   d'erreur d'authentification), tableau Grafana « caisse / API ». Supprimer `backend/.env.bak-*` une fois validé.

Si `PG_EXPORTER_USER` / `PG_EXPORTER_PASSWORD` désignent un rôle dédié (recommandé, `docs/EXPLOITATION.md` § 3),
ce rôle n'est pas concerné ; sinon l'exporter réutilise `DB_PASSWORD` et l'étape `setup-monitoring.sh` suffit.

## 2. Dépôt GitHub en privé — 10 minutes

Avant de basculer, préparer l'accès du serveur, sinon le prochain déploiement échoue au `git fetch` :

1. Serveur : `./scripts/github-deploy-key.sh --switch` → affiche la clé **publique** ; `origin` passe en SSH.
2. GitHub : dépôt → Settings → **Deploy keys** → Add deploy key, coller la clé, laisser « Allow write access »
   décoché.
3. Serveur : `./scripts/github-deploy-key.sh --check` doit afficher « acces en lecture OK ».
4. GitHub : Settings → General → Danger Zone → **Change repository visibility** → Private.
5. Images GHCR (`ghcr.io/norbertm09/cpay/cplus-*`) : vérifier dans l'onglet Packages la visibilité de chaque paquet.
   Soit les laisser/rendre **publics** (les images ne contiennent aucun secret, `.env` est exclu), soit faire une fois
   sur le serveur `docker login ghcr.io -u <compte GitHub>` avec un jeton classique `read:packages`, avec l'utilisateur
   qui lance `deploy.sh`. Sans l'un ni l'autre, `deploy.sh` avertit et reconstruit les images sur le VPS : plus lent,
   mais rien ne casse.
6. Vérification : lancer `Deploy` à la main (workflow_dispatch, ref `main`) ou attendre la prochaine fusion ; le
   journal doit montrer `git fetch` puis « images … recuperees depuis GHCR ».

À faire dans la foulée côté compte GitHub : révoquer le jeton personnel qui avait été collé en clair (Settings →
Developer settings → Personal access tokens), supprimer la branche `ovh-prod-snapshot` si elle existe encore. La purge
de l'historique (`git filter-repo`) reste souhaitable mais n'est plus urgente une fois le mot de passe changé et le
dépôt privé : elle réécrit tous les SHA (tags, `.deployed`, liens de PR) et se planifie à part.

## 3. Segment secret des webhooks et jeton MTN — 5 minutes + 24 h de tolérance

```
./scripts/rotate-secrets.sh webhook-secret      # nouveau segment, ancien → WEBHOOK_PATH_SECRET_PREVIOUS, URLs affichées
./scripts/rotate-secrets.sh mtn-token           # nouveau jeton, ancien → MTN_WEBHOOK_TOKEN_PREVIOUS, MTN_CG_CALLBACK_URL mise à jour
./scripts/deploy.sh --skip-backup --skip-migrations
history -c
```

- Opérateurs utilisant le chemin secret (Orange, Wave, Africell, Express Union, Free Money, Moov) : déclarer la
  nouvelle URL `https://api.c-pay.global/api/v1/webhooks/<nouveau segment>/<provider>` dans leur portail. MTN envoie
  `X-Callback-Url` à chaque requête : rien à déclarer. Airtel signe (HMAC) : non concerné.
- Pendant la tolérance, un callback reçu sur l'ancienne valeur est accepté et journalisé une fois
  (`webhook reçu sur l'ANCIEN segment secret` / `callback MTN reçu avec l'ANCIEN jeton`).
- Après 24 h (tous les paiements lancés avant la rotation sont terminés ou expirés) :
  ```
  ./scripts/rotate-secrets.sh webhook-secret --clear-previous
  ./scripts/rotate-secrets.sh mtn-token --clear-previous
  ./scripts/deploy.sh --skip-backup --skip-migrations
  ```
- `./scripts/rotate-secrets.sh status` rappelle les tolérances encore actives.

## 4. Certificat CA PostgreSQL (fin du mode `DB_SSL_REJECT_UNAUTHORIZED=false`) — 10 minutes

1. Manager OVH → instance PostgreSQL → Informations générales → **Certificat CA** → télécharger (PEM).
2. Serveur : déposer le fichier en `/etc/cplus/postgres-ca.pem` (`root:root`, `644` : il ne contient que la partie
   publique). `openssl x509 -in /etc/cplus/postgres-ca.pem -noout -subject -enddate` doit répondre.
3. `backend/.env` : `DB_SSL=true`, `DB_SSL_CA_FILE=/etc/cplus/postgres-ca.pem`, **supprimer**
   `DB_SSL_REJECT_UNAUTHORIZED`. Si `DB_HOST` est une IP ou un alias, ajouter `DB_SSL_SERVERNAME=<nom du certificat>`.
4. `./scripts/deploy.sh --skip-backup --skip-migrations` : le journal affiche « CA PostgreSQL : /etc/cplus/postgres-ca.pem
   montee dans l'API » ; le démarrage de l'API ne doit plus montrer l'avertissement « certificat serveur NON vérifié ».
   En cas d'échec de connexion (CA erronée), `./scripts/deploy.sh --rollback` ne suffit pas : remettre l'ancien `.env`
   (`backend/.env.bak-*`) puis redéployer.
5. Scripts hôte (`backup-db.sh`, `restore-db.sh`) : ajouter dans `backend/.env` `PGSSLMODE=verify-full` et
   `PGSSLROOTCERT=/etc/cplus/postgres-ca.pem` pour que `pg_dump` vérifie lui aussi le certificat (optionnel).

## 5. Ordre recommandé et état

| # | Action | Où | Durée | État |
|---|---|---|---|---|
| 1 | Mot de passe `cplus_user` | OVH + serveur | 15 min | à faire |
| 2 | Clé de lecture puis dépôt privé, visibilité GHCR | serveur + GitHub | 10 min | à faire |
| 3 | Révocation du PAT, branche `ovh-prod-snapshot` | GitHub | 5 min | à faire |
| 4 | Rotation `WEBHOOK_PATH_SECRET` + `MTN_WEBHOOK_TOKEN`, déclaration chez les opérateurs, `--clear-previous` à J+1 | serveur + portails opérateurs | 5 min + 24 h | à faire |
| 5 | Certificat CA PostgreSQL | OVH + serveur | 10 min | à faire |
| 6 | Purge de l'historique git (`git filter-repo`) | GitHub | à planifier | optionnel |
