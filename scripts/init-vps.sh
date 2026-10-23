#!/usr/bin/env bash
# ================================================================
# C-Pay 2.7 — initialisation d'un NOUVEAU serveur (Ubuntu 24.04 / 26.04, a lancer en root, relancable)
#
#   bash scripts/init-vps.sh [--import /root/cpay-migration-<date>.tgz] \
#                            [--repo https://github.com/norbertm09/Cpay.git | git@github.com:norbertm09/Cpay.git] \
#                            [--branch main] [--deploy-pubkey "ssh-ed25519 AAAA… cpay_deploy2"] \
#                            [--github-ssh-key] [--no-upgrade]
#
# Architecture de production C-Pay (depuis la 2.7.0) :
#   nginx HOTE (TLS Let's Encrypt, vhosts c-pay.global / api / app / merchant / admin / pay / card)
#     -> docker compose dans /opt/cplus/docker : api 127.0.0.1:3001, merchant :3002, cardholder :3003,
#        admin :3004, partners :3005, vitrine :3006 ; base PostgreSQL managee OVH (hors serveur).
#
# Etapes (chacune est idempotente) :
#   1. paquets systeme (nginx, certbot, postgresql-client, git, ufw, fail2ban…)
#   2. Docker Engine + Compose V2 (depot officiel Docker, repli sur les paquets Ubuntu)
#   3. pare-feu UFW (22, 80, 443), fail2ban, sysctl, limites, swap 4 Go
#   4. depot /opt/cplus (clone ou mise a jour), cles SSH (deploiement GitHub Actions, lecture GitHub)
#   5. import de l'archive de l'ancien serveur (nginx, Let's Encrypt, .env, dhparam, crons…)
#   6. nginx hote : vhost C-Pay, correction des proxy_pass vers 127.0.0.1, hook de renouvellement certbot
#   7. crons (sauvegarde DB, healthcheck) et logrotate
# Le deploiement applicatif lui-meme est fait ensuite par :  cd /opt/cplus && ./scripts/deploy.sh
# ================================================================
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[INIT]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
die()  { echo -e "${RED}[FAIL]${NC} $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Ce script doit etre execute en root"

IMPORT=""; REPO="https://github.com/norbertm09/Cpay.git"; BRANCH="main"; DEPLOY_PUBKEY=""; GITHUB_SSH_KEY=false; UPGRADE=true
while [ $# -gt 0 ]; do
  case "$1" in
    --import)        IMPORT="$2"; shift 2 ;;
    --repo)          REPO="$2"; shift 2 ;;
    --branch)        BRANCH="$2"; shift 2 ;;
    --deploy-pubkey) DEPLOY_PUBKEY="$2"; shift 2 ;;
    --github-ssh-key) GITHUB_SSH_KEY=true; shift ;;
    --no-upgrade)    UPGRADE=false; shift ;;
    -h|--help)       sed -n '2,24p' "$0"; exit 0 ;;
    *) die "option inconnue : $1" ;;
  esac
done

APP="${CPAY_ROOT:-/opt/cplus}"
DOMAIN="${DOMAIN:-c-pay.global}"
. /etc/os-release
CODENAME="${VERSION_CODENAME:-noble}"
ARCH="$(dpkg --print-architecture)"

log "═══════════════════════════════════════════════"
log "C-Pay 2.7 — initialisation serveur"
log "OS      : $PRETTY_NAME ($CODENAME, $ARCH)"
log "Depot   : $REPO ($BRANCH) -> $APP"
log "Import  : ${IMPORT:-aucun}"
log "═══════════════════════════════════════════════"
[ -z "$IMPORT" ] || [ -f "$IMPORT" ] || die "archive introuvable : $IMPORT"

# ─── 1. Paquets systeme ──────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
log "Paquets systeme…"
apt-get update -qq
[ "$UPGRADE" = true ] && apt-get upgrade -y -qq
apt-get install -y -qq \
  nginx certbot python3-certbot-nginx \
  postgresql-client \
  git curl wget rsync ca-certificates gnupg lsb-release openssl \
  ufw fail2ban logrotate cron \
  jq unzip htop ncdu tree
systemctl enable --now nginx cron fail2ban >/dev/null 2>&1 || true

# ─── 2. Docker Engine + Compose V2 ──────────────────────────────
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  log "Installation Docker…"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  DOCKER_CODENAME="$CODENAME"
  # Le depot Docker peut ne pas (encore) publier la toute derniere Ubuntu : repli sur la LTS precedente.
  if ! curl -fsSI "https://download.docker.com/linux/ubuntu/dists/$DOCKER_CODENAME/Release" >/dev/null 2>&1; then
    warn "download.docker.com ne publie pas '$DOCKER_CODENAME' : utilisation des paquets 'noble' (24.04 LTS)"
    DOCKER_CODENAME="noble"
  fi
  echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $DOCKER_CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  if apt-get update -qq && apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; then
    log "Docker (depot officiel, $DOCKER_CODENAME) installe"
  else
    warn "Depot Docker indisponible : repli sur les paquets Ubuntu (docker.io, docker-compose-v2)"
    rm -f /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker.io docker-compose-v2 docker-buildx || die "installation Docker impossible"
  fi
  systemctl enable --now docker
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose V2 absent"
log "Docker $(docker version --format '{{.Server.Version}}') / $(docker compose version --short)"
# Journaux Docker bornes (sinon le disque de 100 Go se remplit avec les logs des conteneurs)
if [ ! -f /etc/docker/daemon.json ]; then
  cat > /etc/docker/daemon.json <<'JSON'
{ "log-driver": "json-file", "log-opts": { "max-size": "20m", "max-file": "5" } }
JSON
  systemctl restart docker
fi

# ─── 3. Pare-feu, fail2ban, kernel, swap ─────────────────────────
log "UFW (22, 80, 443)…"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
log "UFW : $(ufw status | head -1)"

if [ ! -f /etc/fail2ban/jail.local ]; then
  cat > /etc/fail2ban/jail.local <<'F2B'
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5
backend  = systemd

[sshd]
enabled = true
maxretry = 3

[nginx-http-auth]
enabled = true

[nginx-botsearch]
enabled = true
F2B
fi
systemctl restart fail2ban || warn "fail2ban n'a pas redemarre (verifier /etc/fail2ban/jail.local)"

cat > /etc/sysctl.d/99-cpay.conf <<'SYSCTL'
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_keepalive_time = 300
net.ipv4.ip_local_port_range = 1024 65535
vm.swappiness = 10
vm.overcommit_memory = 1
fs.file-max = 2097152
net.ipv4.ip_forward = 1
SYSCTL
sysctl -q -p /etc/sysctl.d/99-cpay.conf || true
grep -q "cpay nofile" /etc/security/limits.conf 2>/dev/null || cat >> /etc/security/limits.conf <<'LIMITS'
# cpay nofile
* soft nofile 65535
* hard nofile 65535
LIMITS

if ! swapon --show | grep -q .; then
  log "Swap 4 Go (builds Vite des portails)…"
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ─── 4. Depot et cles SSH ───────────────────────────────────────
mkdir -p "$APP" /var/backups/cpay /var/log/cplus /root/nginx-backups /var/www/html
chmod 700 /var/backups/cpay
install -d -m 700 /root/.ssh

if [ "$GITHUB_SSH_KEY" = true ] && [ ! -f /root/.ssh/github_cpay ]; then
  ssh-keygen -t ed25519 -N "" -C "cpay-server-readonly@$(hostname)" -f /root/.ssh/github_cpay -q
  cat > /root/.ssh/config <<'SSHCFG'
Host github.com
  IdentityFile ~/.ssh/github_cpay
  IdentitiesOnly yes
SSHCFG
  chmod 600 /root/.ssh/config
  ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts 2>/dev/null || true
  warn "Cle de LECTURE GitHub generee. A declarer dans GitHub : Settings > Deploy keys (sans ecriture) :"
  cat /root/.ssh/github_cpay.pub
fi

if [ ! -d "$APP/.git" ]; then
  log "Clone $REPO ($BRANCH)…"
  git clone --branch "$BRANCH" "$REPO" "$APP" || die "clone impossible — depot prive ? relancer avec --github-ssh-key et --repo git@github.com:norbertm09/Cpay.git"
else
  log "Depot deja present : fetch…"
  git -C "$APP" fetch --all --tags --prune -q || warn "fetch impossible (verifier l'acces GitHub)"
fi
git config --global --add safe.directory "$APP" >/dev/null 2>&1 || true

if [ -n "$DEPLOY_PUBKEY" ]; then
  touch /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys
  grep -qF "$DEPLOY_PUBKEY" /root/.ssh/authorized_keys || echo "$DEPLOY_PUBKEY" >> /root/.ssh/authorized_keys
  log "Cle de deploiement GitHub Actions autorisee"
fi

# ─── 5. Import de l'archive de l'ancien serveur ─────────────────
if [ -n "$IMPORT" ]; then
  log "Import de $IMPORT…"
  STAGE="$(mktemp -d /root/cpay-import.XXXXXX)"
  tar -C "$STAGE" -xzf "$IMPORT"
  [ -f "$STAGE/MANIFEST" ] && { log "Manifeste :"; sed 's/^/    /' "$STAGE/MANIFEST"; }

  # nginx : sauvegarde de la conf distribution, puis reprise de l'ancienne
  TS="$(date +%Y%m%d_%H%M%S)"
  tar -C / -czf "/root/nginx-backups/nginx-distrib-$TS.tgz" etc/nginx 2>/dev/null || true
  for p in etc/nginx/nginx.conf etc/nginx/conf.d etc/nginx/snippets etc/nginx/sites-available; do
    [ -e "$STAGE/$p" ] && { rsync -a "$STAGE/$p" "/$(dirname "$p")/"; log "  nginx : /$p"; }
  done
  # Les liens sites-enabled sont recrees (etape 6) ; on ne copie que la cible
  rm -f /etc/nginx/sites-enabled/default

  if [ -d "$STAGE/etc/letsencrypt" ]; then
    rsync -a "$STAGE/etc/letsencrypt/" /etc/letsencrypt/
    log "  Let's Encrypt : $(ls /etc/letsencrypt/live 2>/dev/null | grep -v README | tr '\n' ' ')"
  fi
  [ -d "$STAGE/var/www/html/.well-known" ] && rsync -a "$STAGE/var/www/html/.well-known" /var/www/html/

  for f in backend/.env docker/dhparam.pem .deployed .deploy-history; do
    if [ -f "$STAGE/opt/cplus/$f" ]; then
      install -m 600 "$STAGE/opt/cplus/$f" "$APP/$f"; log "  application : $f"
    fi
  done
  [ -f "$STAGE/etc/cron.d/cplus" ] && install -m 644 "$STAGE/etc/cron.d/cplus" /etc/cron.d/cplus.old-server && warn "  cron de l'ancien serveur conserve pour lecture dans /etc/cron.d/cplus.old-server (desactive : pas d'utilisateur)" && sed -i 's/^/# /' /etc/cron.d/cplus.old-server
  if [ -f "$STAGE/root/.ssh/authorized_keys" ]; then
    touch /root/.ssh/authorized_keys; chmod 600 /root/.ssh/authorized_keys
    while IFS= read -r k; do
      [ -n "$k" ] && ! grep -qF "$k" /root/.ssh/authorized_keys && echo "$k" >> /root/.ssh/authorized_keys
    done < "$STAGE/root/.ssh/authorized_keys"
    log "  authorized_keys fusionne ($(grep -c . /root/.ssh/authorized_keys) cles) — retirer les cles obsoletes (cpay_deploy sans '2')"
  fi
  LASTDUMP="$(ls "$STAGE"/var/backups/cpay/*.sql.gz 2>/dev/null | head -1 || true)"
  [ -n "$LASTDUMP" ] && install -m 600 "$LASTDUMP" /var/backups/cpay/ && log "  sauvegarde DB : $(basename "$LASTDUMP")"
  rm -rf "$STAGE"
fi

# ─── 6. nginx hote ──────────────────────────────────────────────
log "nginx hote…"
VHOST=""
for cand in /etc/nginx/sites-available/cpay /etc/nginx/sites-available/c-pay.global /etc/nginx/sites-available/cplus; do
  [ -f "$cand" ] && { VHOST="$cand"; break; }
done
if [ -n "$VHOST" ]; then
  # Les anciens proxy_pass pointaient parfois vers l'IP interne d'un conteneur (172.x) : non portable.
  if grep -qE 'proxy_pass +http://172\.[0-9.]+:3000' "$VHOST"; then
    sed -i -E 's#proxy_pass +http://172\.[0-9.]+:3000#proxy_pass http://127.0.0.1:3001#g' "$VHOST"
    log "  proxy_pass 172.x:3000 -> 127.0.0.1:3001 corrige dans $VHOST"
  fi
  ln -sfn "$VHOST" "/etc/nginx/sites-enabled/$(basename "$VHOST")"
else
  warn "  aucun vhost C-Pay dans /etc/nginx/sites-available : importer l'archive (--import) ou copier docker/nginx-host/cpay.conf.example"
fi
# Extrait d'allowlist des callbacks operateurs (vide par defaut = tout autorise) — voir docker/nginx-host/README.md
install -d /etc/nginx/snippets
[ -f /etc/nginx/snippets/cpay-webhook-allowlist.conf ] || install -m 644 "$APP/docker/nginx-host/snippets/cpay-webhook-allowlist.conf" /etc/nginx/snippets/cpay-webhook-allowlist.conf
# Renouvellement Let's Encrypt : recharge nginx apres chaque renouvellement (timer systemd certbot.timer)
install -d /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'HOOK'
#!/bin/sh
systemctl reload nginx
HOOK
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
systemctl enable --now certbot.timer >/dev/null 2>&1 || warn "certbot.timer indisponible : planifier 'certbot renew' en cron"
if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx; log "  nginx -t OK, recharge"
else
  warn "  nginx -t en echec (normal si aucun certificat n'est encore present) :"; nginx -t 2>&1 | sed 's/^/    /' || true
fi

# ─── 7. Crons et logrotate ──────────────────────────────────────
cat > /etc/cron.d/cpay <<CRON
# C-Pay 2.7 — taches planifiees (root : /opt/cplus appartient a root, deploiement GitHub Actions en root)
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# Sauvegarde PostgreSQL quotidienne 01:00 (retention 30 j, copie distante si BACKUP_REMOTE)
0 1 * * * root $APP/scripts/backup-db.sh >> /var/log/cplus/backup.log 2>&1
# Health check toutes les 5 minutes
*/5 * * * * root $APP/scripts/healthcheck-prod.sh >> /var/log/cplus/healthcheck.log 2>&1
CRON
cat > /etc/logrotate.d/cpay <<'LR'
/var/log/cplus/*.log {
  daily
  rotate 30
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
}
LR

log "═══════════════════════════════════════════════"
log "Serveur pret. Etapes suivantes (voir docs/GO-LIVE-CG.md) :"
log "  1. OVH Cloud DB > IP autorisees : ajouter $(curl -4 -fsS --max-time 5 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
log "  2. Verifier/completer $APP/backend/.env (MTN_ENV, AIRTEL_*, DB_*, CAPABILITY_ENFORCE…)"
log "  3. cd $APP && ./scripts/deploy.sh          # build, migrations, demarrage, health checks"
log "  4. Test avant bascule DNS :"
log "     curl --resolve api.$DOMAIN:443:<IP> https://api.$DOMAIN/health"
log "  5. GitHub > Secrets : OVH_SSH_HOST=<IP>, OVH_KNOWN_HOSTS=\"<IP> $(cat /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null | cut -d' ' -f1-2)\""
log "═══════════════════════════════════════════════"
