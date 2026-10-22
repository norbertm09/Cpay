#!/usr/bin/env bash
# ================================================================
# CPlus 2.6 — Initialisation VPS OVH  (HISTORIQUE : nginx conteneurise, Ubuntu 22.04)
# Depuis la 2.7.0 utiliser scripts/init-vps.sh (nginx hote + certbot, Ubuntu 24.04/26.04, import d'un ancien serveur).
# Ubuntu 22.04 LTS — À exécuter en root UNE SEULE FOIS
#
# Usage :
#   curl -fsSL https://raw.githubusercontent.com/your-org/cplus/main/scripts/init-ovh.sh | bash
#   ou
#   bash scripts/init-ovh.sh
#
# Ce script :
#   1. Met à jour le système
#   2. Configure le pare-feu UFW
#   3. Installe Docker + Docker Compose V2
#   4. Crée l'utilisateur cplus avec les bonnes permissions
#   5. Configure les crons (backup, renouvellement TLS)
#   6. Optimise le kernel pour la production
#   7. Configure logrotate
#   8. Génère le dhparam.pem pour TLS
# ================================================================
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[INIT]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
die()  { echo -e "${RED}[FAIL]${NC} $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Ce script doit être exécuté en root"
[ "$(lsb_release -cs 2>/dev/null)" = "jammy" ] || warn "Testé sur Ubuntu 22.04 uniquement"

CPLUS_USER="${CPLUS_USER:-cplus}"
DOMAIN="${DOMAIN:-c-pay.global}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-admin@c-pay.global}"

log "═══════════════════════════════════════════════"
log "CPlus 2.6 — Init VPS OVH"
log "User:   $CPLUS_USER"
log "Domain: $DOMAIN"
log "═══════════════════════════════════════════════"

# ─── 1. Mise à jour système ───────────────────────────────────────
log "Mise à jour du système..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq \
  postgresql-client \
  curl wget gnupg2 ca-certificates lsb-release \
  apt-transport-https software-properties-common \
  htop iotop ncdu tree unzip git \
  fail2ban ufw \
  logrotate cron \
  jq bc openssl

# ─── 2. Pare-feu UFW ──────────────────────────────────────────────
log "Configuration UFW..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
# Grafana (accès restreint — adapter l'IP)
# ufw allow from YOUR_OFFICE_IP to any port 3003
ufw --force enable
log "UFW actif: $(ufw status | head -1)"

# ─── 3. Fail2ban ─────────────────────────────────────────────────
log "Configuration Fail2ban..."
cat > /etc/fail2ban/jail.local << 'FAIL2BAN'
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5
backend  = systemd

[sshd]
enabled = true
port    = ssh
maxretry = 3

[nginx-http-auth]
enabled = true

[nginx-botsearch]
enabled = true
FAIL2BAN
systemctl enable fail2ban && systemctl restart fail2ban

# ─── 4. Optimisation kernel ──────────────────────────────────────
log "Optimisation kernel (sysctl)..."
cat > /etc/sysctl.d/99-cplus.conf << 'SYSCTL'
# TCP optimisations
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 65535
net.ipv4.tcp_fin_timeout = 30
net.ipv4.tcp_keepalive_time = 300
net.ipv4.tcp_keepalive_probes = 5
net.ipv4.tcp_keepalive_intvl = 15
net.ipv4.ip_local_port_range = 1024 65535

# Memory
vm.swappiness = 10
vm.overcommit_memory = 1

# File descriptors
fs.file-max = 2097152
fs.nr_open = 1048576

# Docker
net.bridge.bridge-nf-call-iptables = 1
net.ipv4.ip_forward = 1
SYSCTL
sysctl -p /etc/sysctl.d/99-cplus.conf >/dev/null

# Limits
cat >> /etc/security/limits.conf << 'LIMITS'
* soft nofile 65535
* hard nofile 65535
cplus soft nproc 65535
cplus hard nproc 65535
LIMITS

# ─── 5. Installation Docker ───────────────────────────────────────
log "Installation Docker..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable docker
  systemctl start docker
else
  log "Docker déjà installé: $(docker version --format '{{.Server.Version}}')"
fi

# ─── 6. Utilisateur cplus ─────────────────────────────────────────
log "Création utilisateur $CPLUS_USER..."
if ! id "$CPLUS_USER" &>/dev/null; then
  useradd -m -s /bin/bash -G docker,sudo "$CPLUS_USER"
  log "Utilisateur $CPLUS_USER créé"
else
  usermod -aG docker,sudo "$CPLUS_USER"
  log "Utilisateur $CPLUS_USER mis à jour"
fi

# ─── 7. Structure répertoires ─────────────────────────────────────
log "Création des répertoires..."
DIRS=(
  "/opt/cplus"
  "/var/backups/cplus"
  "/var/log/cplus"
  "/etc/cplus"
)
for dir in "${DIRS[@]}"; do
  mkdir -p "$dir"
  chown "$CPLUS_USER:$CPLUS_USER" "$dir"
done

# ─── 8. Crons ────────────────────────────────────────────────────
log "Configuration des crons..."
cat > /etc/cron.d/cplus << 'CRONS'
# CPlus 2.6 — Tâches planifiées

# Backup DB quotidien à 01h00
0 1 * * * cplus /opt/cplus/scripts/backup-db.sh >> /var/log/cplus/backup.log 2>&1

# Renouvellement TLS (Let's Encrypt) bi-mensuel
0 3 1,15 * * root /opt/cplus/scripts/renew-tls.sh >> /var/log/cplus/tls.log 2>&1

# Health check toutes les 5 minutes
*/5 * * * * cplus /opt/cplus/scripts/healthcheck-prod.sh >> /var/log/cplus/healthcheck.log 2>&1
CRONS

# ─── 9. Logrotate ─────────────────────────────────────────────────
cat > /etc/logrotate.d/cplus << 'LOGROTATE'
/var/log/cplus/*.log {
  daily
  rotate 30
  compress
  delaycompress
  missingok
  notifempty
  sharedscripts
  postrotate
    systemctl reload docker > /dev/null 2>&1 || true
  endscript
}
LOGROTATE

# ─── 10. dhparam TLS ─────────────────────────────────────────────
log "Génération dhparam TLS (2048 bits)..."
DHPARAM_FILE="/opt/cplus/docker/dhparam.pem"
mkdir -p "$(dirname "$DHPARAM_FILE")"
if [ ! -f "$DHPARAM_FILE" ]; then
  openssl dhparam -out "$DHPARAM_FILE" 2048 2>/dev/null
  log "dhparam généré: $DHPARAM_FILE"
else
  log "dhparam existant conservé"
fi

# ─── 11. Script renouvellement TLS ───────────────────────────────
cat > /opt/cplus/scripts/renew-tls.sh << 'RENEW'
#!/usr/bin/env bash
set -eu
cd /opt/cplus/docker
docker compose --profile certbot run --rm certbot renew --quiet
docker compose exec nginx nginx -s reload
echo "TLS renouvelé: $(date)"
RENEW
chmod +x /opt/cplus/scripts/renew-tls.sh

# ─── 12. Monitoring swap ─────────────────────────────────────────
log "Configuration swap (2GB)..."
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  log "Swap 2GB créé"
else
  log "Swap déjà configuré"
fi

log "═══════════════════════════════════════════════"
log "Initialisation OVH terminée ✓"
log ""
log "Prochaines étapes :"
log "  1. Su vers $CPLUS_USER : su - $CPLUS_USER"
log "  2. Cloner le dépôt : git clone <repo> /opt/cplus"
log "  3. Configurer .env : cp backend/.env.production.example backend/.env"
log "  4. Obtenir TLS :     docker compose --profile certbot run --rm certbot"
log "  5. Déployer :        bash scripts/deploy-ovh.sh"
log "═══════════════════════════════════════════════"
