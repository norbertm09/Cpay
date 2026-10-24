# Go-live Congo-Brazzaville (MTN MoMo + Airtel Money) et migration vers le VPS dédié

Date : 2026-10-22 · Version : 2.7.0 · Périmètre : encaissement et retrait Mobile Money au Congo (CG, XAF)
sur le nouveau serveur **VPS-3 2027 (6 vCores, 12 Go, 100 Go, Ubuntu 26.04, 137.74.46.246)**.

Ce document est le mode opératoire complet, dans l'ordre d'exécution. Chaque étape est marquée
**[serveur]** (commande sur un VPS), **[GitHub]** (interface GitHub), **[OVH]** (manager OVH) ou
**[partenaire]** (action avec MTN / Airtel). Les commandes se lancent en `root`.

Rappel de l'architecture 2.7 : nginx **hôte** (TLS Let's Encrypt) → conteneurs Docker sur `127.0.0.1`
(api :3001, merchant :3002, porteur :3003, admin :3004, partenaires :3005, vitrine :3006) → base PostgreSQL
**managée OVH** (hors serveur, partagée par l'ancien et le nouveau VPS pendant la migration).

---

## 0. Pré-requis et décisions

| Point | Décision |
|---|---|
| Ancien serveur | `51.91.98.115`, `/opt/cplus` : devient le **serveur de développement** (`dev.c-pay.global`, base dédiée, voir `docs/ENVIRONNEMENTS.md`) et héberge toujours Toonah et LincPay ; il n'est **pas** résilié |
| Nouveau serveur | `137.74.46.246`, mêmes chemins (`/opt/cplus`), déploiement GitHub Actions en `root` |
| Base de données | **inchangée** pour la production (OVH Cloud DB `cplus_db`) : ajouter l'IP du nouveau VPS aux IP autorisées. L'ancien serveur doit être basculé sur une base de **développement** `cplus_db_dev` avant ou au moment de la bascule DNS (`docs/ENVIRONNEMENTS.md` § 3) |
| Certificats TLS | copiés de l'ancien serveur (valables jusqu'à leur date d'expiration), renouvelés ensuite par `certbot.timer` sur le nouveau |
| DNS | TTL abaissé à 300 s **24 h avant** la bascule ; bascule des enregistrements A en une fois |
| Fenêtre | heure creuse (nuit), 30 min d'indisponibilité maximale des paiements |

Prérequis à avoir sous la main :

- accès `root` SSH aux deux serveurs ;
- la clé **publique** de déploiement GitHub Actions (`cpay_deploy2.pub`, sur votre PC) ;
- accès au manager OVH (Cloud DB → IP autorisées, zone DNS) ;
- accès aux paramètres du dépôt GitHub (secrets `OVH_SSH_HOST`, `OVH_KNOWN_HOSTS`) ;
- les identifiants **de production** MTN MoMo (collection + disbursement : API user, API key, subscription key primaire)
  et Airtel Money (client id / client secret collection et disbursement, secret de webhook).

---

## 1. Préparer le nouveau serveur (sans toucher à la production)

### 1.1 [serveur ancien] Exporter ce qui n'est pas dans git

```sh
ssh root@51.91.98.115
cd /opt/cplus && git fetch origin main && git checkout -q origin/main -- scripts/vps-export.sh
bash scripts/vps-export.sh --with-backup
#  → /root/cpay-migration-<date>.tgz  (nginx, Let's Encrypt, backend/.env, dhparam, crons, authorized_keys, dernier dump)
scp /root/cpay-migration-<date>.tgz root@137.74.46.246:/root/
shred -u /root/cpay-migration-<date>.tgz
```

### 1.2 [serveur nouveau] Initialiser Ubuntu 26.04 et importer

```sh
ssh root@137.74.46.246
apt-get update && apt-get install -y git
git clone --branch main https://github.com/norbertm09/Cpay.git /opt/cplus
bash /opt/cplus/scripts/init-vps.sh \
  --import /root/cpay-migration-<date>.tgz \
  --deploy-pubkey "$(cat <<'K'
ssh-ed25519 AAAA…collez ici le contenu de cpay_deploy2.pub…
K
)"
shred -u /root/cpay-migration-<date>.tgz
```

Le script installe nginx + certbot + Docker + UFW + fail2ban + swap 4 Go, reprend la configuration nginx et les
certificats, corrige les `proxy_pass` qui visaient l'IP interne d'un conteneur, pose les crons (sauvegarde 01:00,
healthcheck) et le hook de rechargement nginx après renouvellement TLS. Il est relançable.

> Dépôt privé ? Relancer avec `--github-ssh-key --repo git@github.com:norbertm09/Cpay.git`, puis déclarer la clé
> affichée dans GitHub → Settings → Deploy keys (lecture seule). Le déploiement automatique fait un `git fetch`
> sur le serveur : il a besoin de cet accès.

### 1.2 bis [serveur nouveau] Si l'ancien serveur hébergeait d'autres projets

L'export reprend **tout** nginx et **tous** les certificats de l'ancien serveur. Si celui-ci est mutualisé (autres
projets), retirer leurs traces avec `bash scripts/cleanup-foreign-vhosts.sh --pattern 'autreprojet1|autreprojet2'`
(`--dry-run` pour prévisualiser). Le script déplace les vhosts étrangers vers `/root/nginx-backups/autres-projets/`,
ne supprime que les certificats correspondant au motif et jamais ceux dont le nom contient `c-pay`. Incident du
2026-10-23 : une première version détectait les certificats utilisés sans suivre les liens de `sites-enabled` et a
supprimé les certificats C-Pay ; ils ont été restaurés depuis l'archive de migration. **Ne supprimer l'archive
qu'après le premier déploiement réussi.**

### 1.3 [OVH] Autoriser le nouveau serveur sur la base

Manager OVH → Cloud Databases → instance PostgreSQL → **IP autorisées** → ajouter `137.74.46.246/32`
(garder `51.91.98.115/32` jusqu'à la fin de la migration). Vérifier depuis le nouveau serveur :

```sh
cd /opt/cplus && set -a && . backend/.env && set +a
PGPASSWORD="$DB_PASSWORD" PGSSLMODE=require psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" -c 'select now(), current_user;'
```

### 1.4 [serveur nouveau] Compléter `backend/.env` pour le Congo

Le fichier importé est celui de l'ancien serveur. Ajouter ou vérifier :

```ini
# Environnement MTN : UN SEUL interrupteur (go-live CG). sandbox tant que les tests réels ne sont pas faits.
MTN_ENV=sandbox                    # passer à production à l'étape 3.3
# (facultatif) MTN_CG_TARGET_ENV=mtncongo et MTN_CG_BASE_URL=https://proxy.momoapi.mtn.com sont dérivés automatiquement
MTN_CG_COLL_API_USER=…             # collection (encaissement)
MTN_CG_COLL_API_KEY=…
MTN_CG_COLL_SUB_KEY_PRIMARY=…
MTN_CG_DISB_API_USER=…             # disbursement (retrait vers le wallet marchand)
MTN_CG_DISB_API_KEY=…
MTN_CG_DISB_SUB_KEY_PRIMARY=…
MTN_CG_CALLBACK_URL=https://api.c-pay.global/api/v1/momo/webhooks/mtn
MTN_TLS_INSECURE=false

# Airtel Money Congo
AIRTEL_CG_ENV=production           # ou sandbox
AIRTEL_CG_BASE_URL=https://openapi.airtel.africa        # sandbox : https://openapiuat.airtel.africa
AIRTEL_CG_COLL_CLIENT_ID=…
AIRTEL_CG_COLL_CLIENT_SECRET=…
AIRTEL_CG_DISB_CLIENT_ID=…
AIRTEL_CG_DISB_CLIENT_SECRET=…
AIRTEL_WEBHOOK_SECRET=…            # OBLIGATOIRE : sans lui les callbacks Airtel sont refusés

# Garde des capacités : report pendant le pilote (journalise sans bloquer), enforce ensuite
CAPABILITY_ENFORCE=report
CAPABILITY_PILOT_CG=true           # ouverture restreinte du pays pendant le pilote

# Hygiène (points ouverts des vagues précédentes)
DB_SSL=true
DB_SSL_CA_FILE=/opt/cplus/backend/ovh-ca.pem          # certificat CA téléchargé depuis le manager OVH
DB_SSL_REJECT_UNAUTHORIZED=true                        # retirer l'ancien false
# NODE_TLS_REJECT_UNAUTHORIZED=0  ← à SUPPRIMER
```

Les gateways du routeur Mobile Money (`mtn_cg`, `airtel_cg`) se configurent aussi par l'admin
(`PUT /api/v1/admin/api-configs/<gateway>` : `baseUrl`, `apiKey`, `apiSecret`, `extra_params`) ; pour MTN,
`extra_params.targetEnvironment` prime sur `MTN_ENV` si vous voulez un réglage par gateway.

Contrôle : `cd /opt/cplus/docker && docker compose run --rm --no-deps -T -e RUN_MIGRATIONS=false -v "$PWD/../backend/scripts:/app/scripts:ro" api node scripts/check-production-env.js`
(l'image doit être construite : voir 1.5 ; l'état MTN résolu est visible sur `GET /api/v1/admin/api-configs/env-status`).

### 1.5 [serveur nouveau] Premier déploiement, à blanc

```sh
cd /opt/cplus && ./scripts/deploy.sh
```

Le script construit les images une par une (12 Go suffisent largement), vérifie l'environnement, sauvegarde la base,
applique les migrations (déjà appliquées : idempotent) et démarre les conteneurs. **Attention** : à partir de là
le conteneur `settlement-cron` du nouveau serveur tourne aussi contre la base partagée. Le règlement J+1 est
idempotent, mais pour éviter tout doublon pendant la préparation, l'arrêter jusqu'à la bascule :

```sh
cd /opt/cplus/docker && docker compose stop settlement-cron
```

### 1.6 [PC] Tester le nouveau serveur avant la bascule DNS

```sh
IP=137.74.46.246
curl -sS --resolve api.c-pay.global:443:$IP https://api.c-pay.global/health
curl -sSI --resolve c-pay.global:443:$IP https://c-pay.global/ | head -3
curl -sSI --resolve merchant.c-pay.global:443:$IP https://merchant.c-pay.global/ | head -1
curl -sSI --resolve app.c-pay.global:443:$IP https://app.c-pay.global/ | head -1
curl -sSI --resolve admin.c-pay.global:443:$IP https://admin.c-pay.global/ | head -1
```

Attendu : `"status":"ok"` et `"version":"2.7.0"` sur `/health`, `HTTP/2 200` partout, certificat valide (il est
celui de l'ancien serveur). Sous Windows, utiliser Git Bash ou WSL pour `curl --resolve`.

---

## 2. Bascule

### 2.1 [OVH] 24 h avant : abaisser le TTL DNS

Zone `c-pay.global` : TTL **300** sur les enregistrements A de `@`, `www`, `api`, `app`, `card`, `merchant`,
`admin`, `pay`.

### 2.2 [GitHub] Pointer le déploiement automatique sur le nouveau serveur

Settings → Secrets and variables → Actions (environnement `production`) :

| Secret | Nouvelle valeur |
|---|---|
| `OVH_SSH_HOST` | `137.74.46.246` (secret de l'environnement `production` ; l'environnement `development` garde `51.91.98.115`) |
| `OVH_KNOWN_HOSTS` | `137.74.46.246 ssh-ed25519 AAAA…` — obtenu par `ssh root@137.74.46.246 'echo 137.74.46.246 $(cut -d" " -f1-2 /etc/ssh/ssh_host_ed25519_key.pub)'` |
| `OVH_SSH_USER`, `OVH_SSH_KEY` | inchangés (`root`, clé `cpay_deploy2`) |

Vérifier par **Actions → Deploy production → Run workflow** (`ref` = `main`) : le job doit réussir sur le nouveau
serveur. Le smoke test HTTPS du runner touche encore l'ancien serveur tant que le DNS n'a pas basculé : c'est
normal et sans effet.

### 2.3 [serveur ancien] Geler l'ancien serveur

```sh
ssh root@51.91.98.115
cd /opt/cplus/docker && docker compose stop settlement-cron    # plus de règlement depuis l'ancien
/opt/cplus/scripts/backup-db.sh --label avant-bascule
```

### 2.4 [OVH] Basculer le DNS

Remplacer `51.91.98.115` par `137.74.46.246` sur les 8 enregistrements A. Propagation : 5 min (TTL 300).

### 2.5 [serveur nouveau] Démarrer le règlement et vérifier

```sh
ssh root@137.74.46.246
cd /opt/cplus/docker && docker compose start settlement-cron
docker compose ps
curl -sS https://api.c-pay.global/health
certbot renew --dry-run          # le renouvellement doit réussir sur le nouveau serveur
```

Puis depuis le PC : `nslookup api.c-pay.global` doit renvoyer `137.74.46.246`, et les cinq URL de l'étape 1.6
sans `--resolve`.

### 2.6 [serveur ancien] Couper l'ancien serveur de la base de production

Si le serveur de dev n'est pas encore configuré (`docs/ENVIRONNEMENTS.md` § 3), éteindre les conteneurs C-Pay pour
qu'aucun traitement (règlement, rapprochement, callbacks retardataires) ne touche plus `cplus_db` depuis l'ancien
serveur ; Toonah et LincPay ne sont pas concernés :

```sh
ssh root@51.91.98.115 'cd /opt/cplus/docker && docker compose down'
```

S'il est déjà configuré en dev (`backend/.env` sur `cplus_db_dev`), il n'y a rien à éteindre : désactiver seulement le
vhost de production devenu inutile (`bash scripts/setup-dev-server.sh --disable-prod-vhost`).

Repli en cas de problème dans l'heure qui suit : rebasculer le DNS sur `51.91.98.115` et, si les conteneurs ont été
éteints, `docker compose up -d` sur l'ancien serveur avec son `backend/.env` **de production** ; la base n'a pas bougé.

### 2.7 Après 48 h sans incident

- [GitHub] supprimer les secrets de dépôt `OVH_SSH_HOST` / `OVH_KNOWN_HOSTS` (seuls ceux des environnements comptent) ;
- [serveur nouveau] retirer les clés obsolètes de `/root/.ssh/authorized_keys` (l'ancienne `cpay_deploy` sans « 2 ») et
  effacer l'archive de migration (`shred -u /root/cpay-migration-*.tgz`) ;
- [serveur ancien] vérifier que plus aucun processus n'utilise les identifiants de `cplus_db` (`grep DB_ /opt/cplus/backend/.env`).

---

## 3. Activer MTN et Airtel en production

### 3.1 [partenaire] Déclarer les callbacks et obtenir les plages d'adresses

| Opérateur | URL de callback à déclarer | Authentification | À demander |
|---|---|---|---|
| MTN MoMo CG | `https://api.c-pay.global/api/v1/momo/webhooks/mtn` | re-interrogation systématique du statut (`requesttopay/{ref}`) ; jeton `MTN_WEBHOOK_TOKEN` optionnel | plages IP des callbacks, délai max de confirmation, politique de rejeu, fichier de rapprochement |
| Airtel Money CG | `https://api.c-pay.global/api/v1/webhooks/airtel` | `AIRTEL_WEBHOOK_SECRET` obligatoire | idem + confirmation que le préfixe **04** est bien Airtel Money (entrée `verified:false`) |

Dès réception des plages, les inscrire dans `/etc/nginx/snippets/cpay-webhook-allowlist.conf`, passer `default 1`,
`nginx -t && systemctl reload nginx` (voir `docker/nginx-host/README.md`).

### 3.2 [serveur] Tests sandbox de bout en bout (si non faits)

Pour chaque opérateur : encaissement sandbox → callback → `transactions.status='authorized'` → règlement ; puis un
callback coupé volontairement et `node scripts/reconcile-pending.js --json` (ou `POST /api/v1/admin/reconcile`)
qui finalise la transaction.

### 3.3 [serveur] Passage en production

```ini
MTN_ENV=production
AIRTEL_CG_ENV=production
AIRTEL_CG_BASE_URL=https://openapi.airtel.africa
```

```sh
cd /opt/cplus/docker && docker compose up -d api && docker compose logs --tail=50 api | grep -i "MTN-ENV\|listening"
```

Aucune ligne `[MTN-ENV]` ne doit apparaître (elles signalent une incohérence sandbox/production).
`GET /api/v1/admin/api-configs/env-status` doit montrer `mtn_momo_cg.env = production`, `target = mtncongo`,
`baseUrl = https://proxy.momoapi.mtn.com`, `warnings = []`.

### 3.4 Pilote réel (marchand interne, petits montants)

| # | Test | Attendu | OK |
|---|---|---|---|
| 1 | 10 encaissements MTN de 100 à 500 XAF depuis un vrai numéro MTN Congo | `authorized` en < 60 s, callback reçu, visible dans le portail marchand | ☐ |
| 2 | 10 encaissements Airtel (dont un numéro en 04 et un en 05) | idem | ☐ |
| 3 | 1 encaissement refusé par le client (annulation sur le téléphone) | `failed`, motif opérateur, aucun montant réservé | ☐ |
| 4 | 1 encaissement avec callback bloqué (règle UFW temporaire) puis `reconcile` | passe de `pending` à `authorized` par re-interrogation | ☐ |
| 5 | 1 retrait MTN vers le wallet du marchand (confirmation forte) | `completed`, wallet marqué vérifié | ☐ |
| 6 | 1 retrait Airtel | `completed` (ou `processing` + statut rafraîchi par `GET /cash/transfers/:id`) | ☐ |
| 7 | Règlement J+1 | ligne de règlement correcte, montants nets = bruts − frais | ☐ |
| 8 | Export CSV de la caisse et historique dans l'app Android | cohérents avec la base | ☐ |
| 9 | Alertes : un retrait laissé `unknown` plus de 30 min | e-mail d'alerte reçu | ☐ |

Après 48 h sans anomalie : `CAPABILITY_ENFORCE=enforce`, puis ouverture à 5 marchands réels pendant 2 à 4 semaines
avant l'ouverture commerciale.

---

## 4. Exploitation du nouveau serveur

| Tâche | Où |
|---|---|
| Sauvegarde PostgreSQL quotidienne (01:00, 30 j) | `/etc/cron.d/cpay` → `/var/backups/cpay` ; copie hors serveur en renseignant `BACKUP_REMOTE` (rclone) dans `backend/.env` |
| Health check 5 min | `/var/log/cplus/healthcheck.log` |
| Renouvellement TLS | `certbot.timer` + hook de rechargement nginx |
| Journaux conteneurs | bornés à 5 × 20 Mo par conteneur (`/etc/docker/daemon.json`) |
| Supervision | `monitoring/docker-compose.monitoring.yml` (Prometheus + Alertmanager SMTP) : à activer, voir `docs/LOT-5B-ALERTES.md` |
| Déploiement | automatique après CI verte sur `main` ; manuel : `cd /opt/cplus && ./scripts/deploy.sh` ; retour arrière : `./scripts/deploy.sh --rollback` |

## 5. Points toujours ouverts (hors périmètre technique)

- contrats marchand / agrégateur signés avec MTN et Airtel, compte de règlement où atterrissent les encaissements ;
- règle de reversement aux marchands (délai, frais) publiée dans le portail marchand (« Tarifs & frais ») ;
- KYB des marchands pilotes, CGU et politique de remboursement ;
- rotation du mot de passe Cloud DB, révocation de l'ancien jeton GitHub, dépôt en privé, nouveau `WEBHOOK_PATH_SECRET`.
