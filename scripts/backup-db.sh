#!/usr/bin/env bash
# ================================================================
# Sauvegarde PostgreSQL — C-Pay (base managée OVH Cloud DB ou locale)
#   ./scripts/backup-db.sh [--label <label>]
# Lit DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD (+ DB_SSL) dans backend/.env.
# Exige pg_dump (apt install postgresql-client). Exporte en .sql.gz, rétention 30 j,
# et copie optionnelle hors serveur via BACKUP_REMOTE (rclone, ex. "ovh-s3:cpay-backups").
# ================================================================
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/cpay}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
LABEL=""
[ "${1:-}" = "--label" ] && LABEL="_${2:-manual}"

if [ -f "$ROOT/backend/.env" ]; then
  set -a; # shellcheck disable=SC1091
  . "$ROOT/backend/.env"; set +a
fi
: "${DB_HOST:?DB_HOST manquant}" "${DB_NAME:?DB_NAME manquant}" "${DB_USER:?DB_USER manquant}" "${DB_PASSWORD:?DB_PASSWORD manquant}"
command -v pg_dump >/dev/null || { echo "pg_dump absent : apt install postgresql-client" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/cpay_${DB_NAME}_$(date +%Y%m%d_%H%M%S)${LABEL}.sql.gz"
export PGPASSWORD="$DB_PASSWORD"
[ "${DB_SSL:-false}" = "true" ] && export PGSSLMODE="${PGSSLMODE:-require}"

echo "Sauvegarde $DB_NAME@$DB_HOST → $FILE"
pg_dump -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl | gzip -9 > "$FILE"
unset PGPASSWORD
gzip -t "$FILE"
echo "OK — $(du -sh "$FILE" | cut -f1)"

if [ -n "${BACKUP_REMOTE:-}" ] && command -v rclone >/dev/null; then
  rclone copy "$FILE" "$BACKUP_REMOTE/" && echo "Copie distante OK ($BACKUP_REMOTE)"
fi

find "$BACKUP_DIR" -name "cpay_*.sql.gz" -mtime "+$RETENTION_DAYS" -delete
echo "$(find "$BACKUP_DIR" -name 'cpay_*.sql.gz' | wc -l) sauvegarde(s) conservée(s), rétention $RETENTION_DAYS j"
