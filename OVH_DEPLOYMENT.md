# CPlus 2.6 — Déploiement Production OVH

## Prérequis

- VPS OVH : **VPS SSD 3** minimum (4 vCPU, 8GB RAM, 160GB SSD) ou **SP-32** (bare metal)
- OS : Ubuntu 22.04 LTS (Jammy)
- DNS : 4 enregistrements A pointant vers l'IP du VPS :
  - `api.c-pay.global`
  - `admin.c-pay.global`
  - `merchant.c-pay.global`
  - `pay.c-pay.global`

## Étape 1 — Provisionnement OVH (root, une seule fois)

```bash
# Depuis le Manager OVH : activer l'accès SSH root temporairement
ssh root@<IP_OVH>

# Télécharger et lancer le script d'initialisation
curl -fsSL https://raw.githubusercontent.com/your-org/cplus/main/scripts/init-ovh.sh | \
  DOMAIN=c-pay.global CERTBOT_EMAIL=admin@c-pay.global bash

# Le script installe : Docker, UFW, Fail2ban, swap, crons, optimise le kernel
```

## Étape 2 — Déployer le code (user cplus)

```bash
su - cplus
git clone https://github.com/your-org/cplus.git /opt/cplus
cd /opt/cplus

# Configurer l'environnement
cp backend/.env.production.example backend/.env
nano backend/.env
# → Remplir TOUS les CHANGE_ME

# Vérifier la config
cd backend && node scripts/check-production-env.js && cd ..
```

## Étape 3 — Certificats TLS (Let's Encrypt)

```bash
cd /opt/cplus/docker

# Démarrer nginx en mode HTTP pour la validation ACME
docker compose up -d nginx

# Obtenir les certificats
docker compose --profile certbot run --rm certbot

# Redémarrer nginx avec TLS
docker compose restart nginx
```

## Étape 4 — Premier déploiement

```bash
cd /opt/cplus
bash scripts/deploy-ovh.sh
```

## Étape 5 — Vérifications post-déploiement

```bash
# Status services
cd /opt/cplus/docker && docker compose ps

# Logs API
docker compose logs -f api --tail=50

# Health checks
curl https://api.c-pay.global/health
curl https://api.c-pay.global/ready

# Métriques Prometheus (avec token)
curl -H "Authorization: Bearer $METRICS_TOKEN" https://api.c-pay.global/metrics | head -20
```

## Stack complète déployée

| Service | Port interne | Accessible |
|---|---|---|
| API Node.js | 3000 | https://api.c-pay.global |
| Admin Portal | 80 (nginx) | https://admin.c-pay.global |
| Merchant Portal | 80 (nginx) | https://merchant.c-pay.global |
| PostgreSQL 16 | 5432 | 127.0.0.1:5432 uniquement |
| Prometheus | 9090 | 127.0.0.1:9090 |
| Grafana | 3003 | 127.0.0.1:3003 |
| Loki | 3100 | interne |

## Opérations courantes

```bash
# Rollback (si problème post-déploiement)
bash scripts/deploy-ovh.sh --rollback

# Backup manuel
bash scripts/backup-db.sh

# Restaurer un backup
bash scripts/backup-db.sh --restore /var/backups/cplus/cplus_20240115_020000.sql.gz

# Logs en temps réel
docker compose -f docker/docker-compose.yml logs -f

# Renouveler le TLS manuellement
bash scripts/renew-tls.sh

# Settlement manuel
curl -X POST http://127.0.0.1:3000/internal/settlement/run \
  -H "x-internal-token: $INTERNAL_TOKEN"
```

## Sizing recommandé OVH

| Usage | VPS | Spec | Prix/mois |
|---|---|---|---|
| Pilot (< 1000 txn/j) | VPS SSD 3 | 4 vCPU, 8GB, 160GB | ~30€ |
| Production (< 10k txn/j) | VPS Elite | 8 vCPU, 30GB, 400GB | ~60€ |
| Scale (> 10k txn/j) | SP-32 (bare metal) | 8c/16t, 32GB, 2×SSD | ~120€ |

## Sécurité OVH

- UFW activé : seuls les ports 22, 80, 443 sont ouverts
- Fail2ban actif : ban après 3 échecs SSH, 5 erreurs 401
- Grafana accessible uniquement en local (127.0.0.1:3003)
- PostgreSQL jamais exposé publiquement
- TLS 1.3 uniquement, HSTS preload, dhparam 2048 bits

## Comptes initiaux

Aucun compte administrateur par defaut ne doit etre livre en production.
Creer le premier `super_admin` avec une procedure one-shot controlee, puis forcer la rotation du mot de passe a la premiere connexion.

| Role | Initialisation |
|---|---|
| Admin plateforme | `FIRST_ADMIN_EMAIL=... FIRST_ADMIN_PASSWORD=... npm run create:first-admin` |
| Grafana | `GRAFANA_USER` et `GRAFANA_PASSWORD` dans `backend/.env` |
