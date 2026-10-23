#!/usr/bin/env bash
# ================================================================
# C-Pay — export de l'ANCIEN serveur avant migration (a lancer en root sur l'ancien VPS)
#
#   bash scripts/vps-export.sh [--out /root/cpay-migration-<date>.tgz] [--with-backup]
#
# Rassemble tout ce qui n'est PAS dans le depot git et que le nouveau serveur doit recevoir :
#   - nginx hote      : /etc/nginx/nginx.conf, conf.d/, snippets/, sites-available/, sites-enabled/
#   - Let's Encrypt   : /etc/letsencrypt (certificats, renouvellement) — evite d'attendre la bascule DNS
#   - secrets         : /opt/cplus/backend/.env, /opt/cplus/docker/dhparam.pem
#   - exploitation    : /etc/cron.d/cplus, /etc/fail2ban/jail.local, /root/.ssh/authorized_keys
#   - etat deploiement: /opt/cplus/.deployed, /opt/cplus/.deploy-history
#   - option          : derniere sauvegarde PostgreSQL de /var/backups/cpay (--with-backup)
# L'archive est chiffree-par-permissions (0600) : la transferer avec scp puis la SUPPRIMER des deux cotes.
# ================================================================
set -euo pipefail
umask 077

[ "$(id -u)" = "0" ] || { echo "a lancer en root" >&2; exit 1; }
OUT="/root/cpay-migration-$(date +%Y%m%d_%H%M%S).tgz"
WITH_BACKUP=false
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --with-backup) WITH_BACKUP=true; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "option inconnue : $1" >&2; exit 2 ;;
  esac
done

APP="${CPAY_ROOT:-/opt/cplus}"
STAGE="$(mktemp -d /root/cpay-export.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

copy() { # copy <chemin absolu> (fichier ou dossier) — ignore s'il n'existe pas
  local src="$1"
  if [ -e "$src" ]; then
    mkdir -p "$STAGE$(dirname "$src")"
    cp -a "$src" "$STAGE$(dirname "$src")/"
    echo "  + $src"
  else
    echo "  - $src (absent, ignore)"
  fi
}

echo "Export C-Pay depuis $(hostname) ($(hostname -I 2>/dev/null | awk '{print $1}'))"
echo "nginx hote :"
copy /etc/nginx/nginx.conf
copy /etc/nginx/conf.d
copy /etc/nginx/snippets
copy /etc/nginx/sites-available
copy /etc/nginx/sites-enabled
echo "Let's Encrypt :"
copy /etc/letsencrypt
copy /var/www/html/.well-known
echo "Secrets application :"
copy "$APP/backend/.env"
copy "$APP/docker/dhparam.pem"
copy "$APP/.deployed"
copy "$APP/.deploy-history"
echo "Exploitation :"
copy /etc/cron.d/cplus
copy /etc/fail2ban/jail.local
copy /root/.ssh/authorized_keys
copy /etc/ssh/sshd_config.d
if [ "$WITH_BACKUP" = true ]; then
  echo "Sauvegarde PostgreSQL :"
  if [ -x "$APP/scripts/backup-db.sh" ]; then
    "$APP/scripts/backup-db.sh" --label migration || echo "  ! sauvegarde impossible (la base managee reste accessible depuis le nouveau serveur)"
  fi
  LAST="$(ls -t /var/backups/cpay/cpay_*.sql.gz 2>/dev/null | head -1 || true)"
  [ -n "$LAST" ] && copy "$LAST"
fi

# Inventaire utile au nouveau serveur
{
  echo "exported_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "source_host=$(hostname)"
  echo "source_ip=$(hostname -I 2>/dev/null | awk '{print $1}')"
  echo "os=$(. /etc/os-release && echo "$PRETTY_NAME")"
  echo "nginx=$(nginx -v 2>&1 | sed 's/.*nginx\///')"
  echo "docker=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo ?)"
  echo "git_head=$(git -C "$APP" rev-parse HEAD 2>/dev/null || echo ?)"
  echo "git_remote=$(git -C "$APP" remote get-url origin 2>/dev/null || echo ?)"
  echo "version=$(tr -d '[:space:]' < "$APP/VERSION" 2>/dev/null || echo ?)"
  echo "certs=$(ls /etc/letsencrypt/live 2>/dev/null | tr '\n' ' ')"
  echo "containers=$(docker ps --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')"
} > "$STAGE/MANIFEST"
cat "$STAGE/MANIFEST"

tar -C "$STAGE" -czf "$OUT" .
chmod 600 "$OUT"
echo
echo "Archive : $OUT ($(du -sh "$OUT" | cut -f1))"
echo "Transfert vers le nouveau serveur, puis suppression ici :"
echo "  scp $OUT root@137.74.46.246:/root/"
echo "  shred -u $OUT"
