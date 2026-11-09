#!/usr/bin/env bash
# ================================================================
# Sauvegarde PostgreSQL — C-Pay (base managée OVH Cloud DB ou locale)
#   ./scripts/backup-db.sh [--label <label>] [--no-remote]
#
# Lot 3 (audit 2026-11-02 infra P1-3) :
#   * chiffrement AVANT toute copie : age (BACKUP_AGE_RECIPIENT, clé publique ops) ou, à défaut,
#     openssl AES-256 avec une passphrase lue dans un fichier (BACKUP_PASSPHRASE_FILE) ;
#   * copie hors serveur via rclone (BACKUP_REMOTE, ex. "ovh-s3:cpay-backups") — exigée en production
#     (BACKUP_REMOTE_REQUIRED=true, défaut quand NODE_ENV/CPAY_ENV = production) ; la purge de rétention
#     locale n'a lieu qu'après une copie distante réussie ;
#   * remontée d'état : métriques node-exporter (cpay_backup_*), alerte Alertmanager en échec, battement de
#     cœur optionnel (OPS_HEARTBEAT_URL) — voir scripts/lib/alert.sh.
#
# Configuration : /etc/cplus/backup.env (modèle : monitoring/backup.env.example), puis BACKUP_* de backend/.env
# (compatibilité). Les DB_* viennent de backend/.env. Aucun fichier n'est « sourcé » (scripts/lib/env.sh).
# ================================================================
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/lib/env.sh"
source "$ROOT/scripts/lib/alert.sh"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/cpay}"
BACKUP_CONF="${BACKUP_CONF:-/etc/cplus/backup.env}"
LABEL=""; NO_REMOTE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="_${2:-manual}"; shift 2 ;;
    --no-remote) NO_REMOTE=true; shift ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "option inconnue : $1" >&2; exit 2 ;;
  esac
done

BACKUP_VARS="BACKUP_REMOTE BACKUP_RETENTION_DAYS BACKUP_AGE_RECIPIENT BACKUP_PASSPHRASE_FILE BACKUP_REMOTE_REQUIRED OPS_HEARTBEAT_URL OPS_ALERTMANAGER_URL OPS_TEXTFILE_DIR"
[ -f "$BACKUP_CONF" ] && load_env_vars "$BACKUP_CONF" $BACKUP_VARS
load_env_vars "$ROOT/backend/.env" DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD DB_SSL PGSSLMODE NODE_ENV $BACKUP_VARS
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
REMOTE_REQUIRED="${BACKUP_REMOTE_REQUIRED:-$([ "${NODE_ENV:-}" = "production" ] && echo true || echo false)}"

fail() { # fail <message> : alerte + métrique + sortie 1
  echo "ERREUR : $*" >&2
  ops_metric cpay_backup_last_status 0
  ops_alert CPayBackupFailed critical "Sauvegarde PostgreSQL en échec sur $(hostname)" "$*"
  ops_heartbeat fail
  exit 1
}

: "${DB_HOST:?DB_HOST manquant}" "${DB_NAME:?DB_NAME manquant}" "${DB_USER:?DB_USER manquant}" "${DB_PASSWORD:?DB_PASSWORD manquant}"
command -v pg_dump >/dev/null || fail "pg_dump absent : apt install postgresql-client"

# ─── chiffrement : age (recommandé) ou openssl ──────────────────
ENCRYPT=""
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null || fail "age absent (apt install age) alors que BACKUP_AGE_RECIPIENT est défini"
  ENCRYPT=age
elif [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
  [ -r "$BACKUP_PASSPHRASE_FILE" ] || fail "BACKUP_PASSPHRASE_FILE illisible : $BACKUP_PASSPHRASE_FILE"
  command -v openssl >/dev/null || fail "openssl absent"
  ENCRYPT=openssl
fi
if [ -z "$ENCRYPT" ] && { [ -n "${BACKUP_REMOTE:-}" ] || [ "$REMOTE_REQUIRED" = "true" ]; }; then
  fail "aucune clé de chiffrement (BACKUP_AGE_RECIPIENT ou BACKUP_PASSPHRASE_FILE) : une sauvegarde ne quitte jamais le serveur en clair"
fi
if [ "$REMOTE_REQUIRED" = "true" ] && [ "$NO_REMOTE" = false ]; then
  [ -n "${BACKUP_REMOTE:-}" ] || fail "BACKUP_REMOTE obligatoire en production (rclone remote, ex. ovh-s3:cpay-backups)"
  command -v rclone >/dev/null || fail "rclone absent (apt install rclone) alors que BACKUP_REMOTE est défini"
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
BASE="$BACKUP_DIR/cpay_${DB_NAME}_${STAMP}${LABEL}.sql.gz"
case "$ENCRYPT" in age) FILE="$BASE.age" ;; openssl) FILE="$BASE.enc" ;; *) FILE="$BASE" ;; esac
export PGPASSWORD="$DB_PASSWORD"
[ "${DB_SSL:-false}" = "true" ] && export PGSSLMODE="${PGSSLMODE:-require}"

echo "Sauvegarde $DB_NAME@$DB_HOST → $FILE (chiffrement : ${ENCRYPT:-aucun})"
set -o pipefail
case "$ENCRYPT" in
  age)     pg_dump -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl | gzip -9 | age -r "$BACKUP_AGE_RECIPIENT" -o "$FILE" || fail "pg_dump/age en échec" ;;
  openssl) pg_dump -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl | gzip -9 | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$BACKUP_PASSPHRASE_FILE" -out "$FILE" || fail "pg_dump/openssl en échec" ;;
  *)       pg_dump -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl | gzip -9 > "$FILE" || fail "pg_dump en échec" ;;
esac
unset PGPASSWORD
SIZE="$(stat -c %s "$FILE" 2>/dev/null || stat -f %z "$FILE")"
[ "${SIZE:-0}" -gt 1024 ] || fail "fichier de sauvegarde anormalement petit ($SIZE octets)"
# contrôle d'intégrité : déchiffrement en mémoire + test gzip (sans écrire le clair sur disque)
case "$ENCRYPT" in
  age)     [ -n "${BACKUP_AGE_IDENTITY_FILE:-}" ] && { age -d -i "$BACKUP_AGE_IDENTITY_FILE" "$FILE" | gzip -t || fail "contrôle age/gzip en échec"; } || true ;;
  openssl) openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$FILE" | gzip -t || fail "contrôle openssl/gzip en échec" ;;
  *)       gzip -t "$FILE" || fail "contrôle gzip en échec" ;;
esac
echo "OK — $(du -sh "$FILE" | cut -f1)"
sha256sum "$FILE" > "$FILE.sha256"

# ─── copie hors serveur ─────────────────────────────────────────
REMOTE_OK=false
if [ -n "${BACKUP_REMOTE:-}" ] && [ "$NO_REMOTE" = false ]; then
  command -v rclone >/dev/null || fail "rclone absent"
  if rclone copy --no-traverse "$FILE" "$BACKUP_REMOTE/" && rclone copy --no-traverse "$FILE.sha256" "$BACKUP_REMOTE/"; then
    REMOTE_OK=true; echo "Copie distante OK ($BACKUP_REMOTE)"
    rclone delete --min-age "${RETENTION_DAYS}d" --include 'cpay_*.sql.gz*' "$BACKUP_REMOTE/" >/dev/null 2>&1 || true
  else
    fail "copie distante vers $BACKUP_REMOTE en échec (la sauvegarde locale est conservée)"
  fi
elif [ "$REMOTE_REQUIRED" = "true" ] && [ "$NO_REMOTE" = true ]; then
  echo "AVERTISSEMENT : --no-remote en production, la sauvegarde reste sur le serveur" >&2
fi

# ─── rétention locale : seulement si la copie distante a réussi (ou n'est pas configurée) ───
if [ "$REMOTE_OK" = true ] || [ -z "${BACKUP_REMOTE:-}" ]; then
  find "$BACKUP_DIR" -name "cpay_*.sql.gz*" -mtime "+$RETENTION_DAYS" -delete
fi
echo "$(find "$BACKUP_DIR" -name 'cpay_*.sql.gz*' ! -name '*.sha256' | wc -l) sauvegarde(s) conservée(s) localement, rétention $RETENTION_DAYS j"

ops_metric cpay_backup_last_status 1
ops_metric cpay_backup_last_success_timestamp_seconds "$(date +%s)"
ops_metric cpay_backup_last_size_bytes "$SIZE"
ops_metric cpay_backup_remote_copied "$([ "$REMOTE_OK" = true ] && echo 1 || echo 0)"
ops_heartbeat ok
