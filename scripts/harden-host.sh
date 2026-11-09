#!/usr/bin/env bash
# ================================================================
# C-Pay — durcissement de l'hote (lot 7, audit 2026-11-02 infra P2-12). Idempotent, a lancer en root :
#   bash scripts/harden-host.sh [--permit-root-login no|prohibit-password] [--no-auto-reboot] [--dry-run]
#
#   1. unattended-upgrades (correctifs de securite seulement) + needrestart : redemarrage automatique des services,
#      redemarrage de la machine a 04:30 (heure locale) si le noyau l'exige (--no-auto-reboot : alerte seulement)
#   2. metrique cpay_reboot_required (textfile node-exporter, cron horaire) -> alerte HostRebootRequired
#   3. sshd : /etc/ssh/sshd_config.d/00-cpay.conf (cles uniquement, root sans mot de passe ou interdit,
#      X11/agent forwarding coupes, 4 essais) — valide par `sshd -t` avant rechargement. Prefixe 00- : sshd garde la
#      PREMIERE valeur rencontree, le fichier doit donc passer avant tout autre (10-cpay-root.conf, 50-cloud-init.conf…) ;
#      les `PasswordAuthentication yes` / `PermitRootLogin yes` des autres fichiers sont neutralises.
#   4. fail2ban : jail nginx-limit-req (429 de l'API, docker/nginx.conf limit_req_status) en plus de sshd/nginx
#   5. /etc/docker/daemon.json : rotation des journaux imposee meme si le fichier existe deja (fusion jq)
# Appele par scripts/init-vps.sh ; peut etre relance seul apres toute modification.
# ================================================================
set -euo pipefail
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[HARDEN]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
die()  { echo -e "${RED}[FAIL]${NC} $*" >&2; exit 1; }

PERMIT_ROOT="prohibit-password"; AUTO_REBOOT=true; DRY=false
while [ $# -gt 0 ]; do
  case "$1" in
    --permit-root-login) PERMIT_ROOT="$2"; shift 2 ;;
    --no-auto-reboot)    AUTO_REBOOT=false; shift ;;
    --dry-run)           DRY=true; shift ;;
    -h|--help)           sed -n '2,14p' "$0"; exit 0 ;;
    *) die "option inconnue : $1" ;;
  esac
done
case "$PERMIT_ROOT" in no|prohibit-password) ;; *) die "--permit-root-login : no | prohibit-password" ;; esac
[ "$DRY" = true ] || [ "$(id -u)" = "0" ] || die "a lancer en root (ou --dry-run)"
APP="${CPAY_ROOT:-/opt/cplus}"
run() { if [ "$DRY" = true ]; then echo "  (dry-run) $*"; else "$@"; fi; }
write() { # write <mode> <fichier>  (contenu sur stdin) : n'ecrit que si different
  local mode="$1" f="$2" tmp; tmp="$(mktemp)"; cat > "$tmp"
  if [ -f "$f" ] && cmp -s "$tmp" "$f"; then rm -f "$tmp"; return 1; fi
  if [ "$DRY" = true ]; then echo "  (dry-run) ecrirait $f"; rm -f "$tmp"; return 0; fi
  install -m "$mode" "$tmp" "$f"; rm -f "$tmp"; return 0
}

# ─── 1. Mises a jour automatiques ────────────────────────────────
log "unattended-upgrades + needrestart…"
if [ "$DRY" = false ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq unattended-upgrades needrestart apt-listchanges >/dev/null
fi
REBOOT_LINE='Unattended-Upgrade::Automatic-Reboot "false";'
[ "$AUTO_REBOOT" = true ] && REBOOT_LINE='Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";'
write 644 /etc/apt/apt.conf.d/52cpay-unattended <<CONF && log "  /etc/apt/apt.conf.d/52cpay-unattended ecrit" || true
// C-Pay (scripts/harden-host.sh) : correctifs de securite seulement, nettoyage, redemarrage planifie si le noyau l'exige
Unattended-Upgrade::Allowed-Origins {
  "\${distro_id}:\${distro_codename}-security";
  "\${distro_id}ESMApps:\${distro_codename}-apps-security";
  "\${distro_id}ESM:\${distro_codename}-infra-security";
  "Docker:\${distro_codename}";
};
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
$REBOOT_LINE
Unattended-Upgrade::SyslogEnable "true";
CONF
write 644 /etc/apt/apt.conf.d/20auto-upgrades <<'CONF' && log "  /etc/apt/apt.conf.d/20auto-upgrades ecrit" || true
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Download-Upgradeable-Packages "1";
APT::Periodic::AutocleanInterval "7";
APT::Periodic::Unattended-Upgrade "1";
CONF
# needrestart : redemarre les services sans poser de question (sinon apt bloque en attente d'une reponse)
install -d /etc/needrestart/conf.d 2>/dev/null || true
write 644 /etc/needrestart/conf.d/50-cpay.conf <<'CONF' && log "  needrestart : mode automatique" || true
# C-Pay : redemarrage automatique des services apres mise a jour de bibliotheques (pas d'invite)
$nrconf{restart} = 'a';
$nrconf{kernelhints} = -1;
CONF
run systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
if [ "$DRY" = false ] && command -v unattended-upgrade >/dev/null; then
  unattended-upgrade --dry-run -d >/tmp/cpay-unattended-check.log 2>&1 && log "  unattended-upgrade --dry-run OK" || warn "  unattended-upgrade --dry-run en echec : voir /tmp/cpay-unattended-check.log"
fi

# ─── 2. Metrique « redemarrage requis » ──────────────────────────
write 755 /usr/local/sbin/cpay-reboot-required-metric <<METRIC && log "  metrique cpay_reboot_required installee" || true
#!/usr/bin/env bash
# Publie cpay_reboot_required (1 si /var/run/reboot-required existe) pour node-exporter -> alerte HostRebootRequired
set -u
ROOT="\${CPAY_ROOT:-$APP}"
[ -f "\$ROOT/scripts/lib/alert.sh" ] || exit 0
source "\$ROOT/scripts/lib/alert.sh"
if [ -f /var/run/reboot-required ]; then ops_metric cpay_reboot_required 1; else ops_metric cpay_reboot_required 0; fi
METRIC
write 644 /etc/cron.d/cpay-reboot-required <<'CRON' || true
# C-Pay (harden-host.sh) : etat « redemarrage requis » toutes les heures -> Prometheus (alerte HostRebootRequired)
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
7 * * * * root /usr/local/sbin/cpay-reboot-required-metric >/dev/null 2>&1
CRON
[ "$DRY" = true ] || /usr/local/sbin/cpay-reboot-required-metric || true

# ─── 3. sshd ─────────────────────────────────────────────────────
log "sshd (PermitRootLogin $PERMIT_ROOT)…"
if [ "$PERMIT_ROOT" = "no" ] && [ "$DRY" = false ] && ! id deploy >/dev/null 2>&1; then
  die "PermitRootLogin no demande mais l'utilisateur deploy n'existe pas : lancer d'abord scripts/setup-deploy-user.sh"
fi
install -d /etc/ssh/sshd_config.d 2>/dev/null || true
if write 644 /etc/ssh/sshd_config.d/00-cpay.conf <<CONF
# C-Pay (scripts/harden-host.sh) — connexions par cle uniquement
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PubkeyAuthentication yes
PermitEmptyPasswords no
PermitRootLogin $PERMIT_ROOT
MaxAuthTries 4
MaxSessions 10
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding no
ClientAliveInterval 300
ClientAliveCountMax 2
CONF
then
  if [ "$DRY" = false ]; then
    if sshd -t 2>/tmp/cpay-sshd-t.log; then
      systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || warn "  sshd non recharge (systemctl reload ssh)"
      log "  /etc/ssh/sshd_config.d/00-cpay.conf applique (sshd -t OK)"
    else
      rm -f /etc/ssh/sshd_config.d/00-cpay.conf
      die "sshd -t refuse la configuration (fichier retire) : $(cat /tmp/cpay-sshd-t.log)"
    fi
  fi
fi
# Ancien nom du fichier (lot 7 initial) : 10-cpay.conf etait trie APRES 10-cpay-root.conf (tiret avant point) et perdait.
[ -f /etc/ssh/sshd_config.d/10-cpay.conf ] && run rm -f /etc/ssh/sshd_config.d/10-cpay.conf
# cloud-init / OVH / anciennes migrations laissent des fichiers avec PasswordAuthentication yes ou PermitRootLogin yes :
# neutralises explicitement (la premiere valeur gagne, mais on ne laisse pas de directive contradictoire derriere).
for f in /etc/ssh/sshd_config.d/*.conf; do
  [ "$f" = /etc/ssh/sshd_config.d/00-cpay.conf ] && continue
  if grep -qsiE '^(PasswordAuthentication|KbdInteractiveAuthentication|ChallengeResponseAuthentication) +yes|^PermitRootLogin +yes' "$f"; then
    if [ "$DRY" = true ]; then echo "  (dry-run) neutraliserait les directives permissives de $f"; else
      sed -i -E 's/^(PasswordAuthentication|KbdInteractiveAuthentication|ChallengeResponseAuthentication) +yes/\1 no/I; s/^PermitRootLogin +yes/PermitRootLogin prohibit-password/I' "$f"
      warn "  $f : mots de passe / root par mot de passe desactives (directives neutralisees)"
    fi
  fi
done
if [ "$DRY" = false ]; then
  if sshd -t 2>/dev/null; then systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true; fi
  eff="$(sshd -T 2>/dev/null | grep -iE '^(passwordauthentication|permitrootlogin) ' | tr '\n' ' ')"
  log "  sshd effectif : ${eff:-indisponible}"
  printf '%s' "$eff" | grep -q 'passwordauthentication no' || warn "  passwordauthentication n'est PAS a no : verifier /etc/ssh/sshd_config et sshd_config.d"
fi

# ─── 4. fail2ban ─────────────────────────────────────────────────
log "fail2ban : jail nginx-limit-req…"
write 644 /etc/fail2ban/jail.d/cpay-nginx.conf <<'F2B' && log "  /etc/fail2ban/jail.d/cpay-nginx.conf ecrit" || true
# C-Pay (harden-host.sh) : clients qui declenchent le limit_req de nginx (429 API / webhooks) a repetition
[nginx-limit-req]
enabled  = true
port     = http,https
filter   = nginx-limit-req
logpath  = /var/log/nginx/error.log
maxretry = 30
findtime = 300
bantime  = 1800
F2B
if [ "$DRY" = false ]; then
  if fail2ban-client -t >/dev/null 2>&1; then systemctl reload fail2ban || systemctl restart fail2ban; log "  fail2ban recharge"
  else warn "  fail2ban-client -t en echec : jail non chargee (verifier /etc/fail2ban/jail.d/cpay-nginx.conf)"; fi
fi

# ─── 5. Docker : rotation des journaux imposee ───────────────────
if command -v jq >/dev/null 2>&1; then
  cur='{}'; [ -f /etc/docker/daemon.json ] && cur="$(cat /etc/docker/daemon.json)"
  want="$(printf '%s' "$cur" | jq -S '. + {"log-driver":"json-file","log-opts":((."log-opts" // {}) + {"max-size":"20m","max-file":"5"})}')"
  if [ "$(printf '%s' "$cur" | jq -S . 2>/dev/null)" != "$want" ]; then
    if [ "$DRY" = true ]; then echo "  (dry-run) mettrait a jour /etc/docker/daemon.json"; else
      printf '%s\n' "$want" > /etc/docker/daemon.json
      systemctl reload docker 2>/dev/null || warn "  docker non recharge : la rotation s'appliquera aux conteneurs recrees apres 'systemctl restart docker'"
      log "  /etc/docker/daemon.json : rotation des journaux (20m x 5) imposee"
    fi
  fi
else
  warn "  jq absent : /etc/docker/daemon.json non verifie"
fi

if [ -f /var/run/reboot-required ]; then
  warn "Redemarrage requis par le systeme ($(cat /var/run/reboot-required.pkgs 2>/dev/null | tr '\n' ' ')) — $( [ "$AUTO_REBOOT" = true ] && echo 'automatique a 04:30' || echo 'a planifier')"
fi
log "Durcissement termine."
