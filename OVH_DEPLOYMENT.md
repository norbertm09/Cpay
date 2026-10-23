# C-Pay 2.7 — Déploiement production OVH

> Mode opératoire complet de migration et de go-live : `docs/GO-LIVE-CG.md`. Chaîne CI/CD : `docs/CI-CD.md`.

## Architecture

- **Serveur** : VPS OVH dédié (référence : VPS-3 2027, 6 vCores, 12 Go, 100 Go, Ubuntu 26.04), `/opt/cplus`.
- **nginx hôte** : TLS Let's Encrypt (`certbot.timer`), vhosts `c-pay.global`, `www`, `api`, `app`, `card`,
  `merchant`, `admin`, `pay` → conteneurs sur `127.0.0.1` (api :3001, merchant :3002, porteur :3003, admin :3004,
  partenaires :3005, vitrine :3006). Voir `docker/nginx-host/README.md`.
- **Base** : PostgreSQL managée OVH (Cloud DB), jamais sur le serveur ; IP du VPS dans les IP autorisées.
- **Déploiement** : GitHub Actions (`deploy.yml`) par SSH → `scripts/deploy.sh` (build séquentiel, migrations,
  sauvegarde, health checks, rollback).

## Nouveau serveur en quatre commandes

```sh
# 1. sur l'ANCIEN serveur : exporter nginx, certificats, .env, crons
bash /opt/cplus/scripts/vps-export.sh --with-backup && scp /root/cpay-migration-*.tgz root@<NOUVELLE_IP>:/root/

# 2. sur le NOUVEAU serveur (Ubuntu 24.04 / 26.04)
git clone --branch main https://github.com/norbertm09/Cpay.git /opt/cplus
bash /opt/cplus/scripts/init-vps.sh --import /root/cpay-migration-<date>.tgz --deploy-pubkey "ssh-ed25519 AAAA… cpay_deploy2"

# 3. OVH Cloud DB : ajouter <NOUVELLE_IP>/32 aux IP autorisées, puis
cd /opt/cplus && ./scripts/deploy.sh

# 4. tester avant la bascule DNS
curl --resolve api.c-pay.global:443:<NOUVELLE_IP> https://api.c-pay.global/health
```

Puis GitHub → secrets `OVH_SSH_HOST` / `OVH_KNOWN_HOSTS`, bascule DNS, arrêt de l'ancien (`docs/GO-LIVE-CG.md` § 2).

## Opérations courantes

```sh
cd /opt/cplus && ./scripts/deploy.sh              # déploiement du commit courant
cd /opt/cplus && ./scripts/deploy.sh --rollback   # retour au commit précédent
/opt/cplus/scripts/backup-db.sh                   # sauvegarde manuelle (/var/backups/cpay)
/opt/cplus/scripts/restore-db.sh <fichier.sql.gz> # restauration
cd /opt/cplus/docker && docker compose ps && docker compose logs -f api --tail=100
certbot renew --dry-run                           # test du renouvellement TLS
```

## Sécurité serveur

- UFW : 22, 80, 443 uniquement ; fail2ban (sshd, nginx) ; journaux Docker bornés.
- Aucun port applicatif exposé publiquement (tout sur `127.0.0.1`), `/metrics` et `/internal/` bloqués par nginx.
- Clé SSH de déploiement dédiée (`cpay_deploy2`), `StrictHostKeyChecking=yes` côté GitHub.
- Secrets uniquement dans `/opt/cplus/backend/.env` (mode 600), jamais dans git.

## Comptes initiaux

Aucun compte administrateur par défaut. Premier `super_admin` :
`FIRST_ADMIN_EMAIL=… FIRST_ADMIN_PASSWORD=… node scripts/create-first-admin.js` (dans l'image API), puis rotation du
mot de passe à la première connexion.

## Historique

`scripts/init-ovh.sh`, `scripts/deploy-ovh.sh`, `scripts/deploy-prod.sh`, `scripts/init-tls.sh` et le conteneur
`nginx` (profil `standalone-nginx`) correspondent à l'architecture 2.6 (nginx conteneurisé). Ils sont conservés pour
référence et ne sont plus utilisés en production.
