#!/usr/bin/env bash
# ================================================================
# Backup PostgreSQL — CPlus OVH
# Usage: ./scripts/backup-db.sh [--label <label>] [--restore <file>]
# ================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/cplus}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LABEL=""

for i in "$@"; do
  case $i in
    --label) LABEL="_${2}"; shift 2 ;;
    --restore) RESTORE_FILE="${2}"; shift 2 ;;
  esac
done

# ─── Restore mode ─────────────────────────────────────────────────
if [ -n "${RESTORE_FILE:-}" ]; then
  echo "RESTORE: $RESTORE_FILE"
  [ -f "$RESTORE_FILE" ] || { echo "Fichier introuvable: $RESTORE_FILE" >&2; exit 1; }
  source "$ROOT/backend/.env" 2>/dev/null || true
  gunzip -c "$RESTORE_FILE" | docker exec -i cplus-postgres psql \
    -U "${DB_USER:-cplus_user}" -d "${DB_NAME:-cplus_db}"
  echo "Restore terminé"
  exit 0
fi

# ─── Backup ───────────────────────────────────────────────────────
mkdir -p "$BACKUP_DIR"
source "$ROOT/backend/.env" 2>/dev/null || true

FILENAME="$BACKUP_DIR/cplus_${TIMESTAMP}${LABEL}.sql.gz"

echo "Backup PostgreSQL → $FILENAME"
docker exec cplus-postgres pg_dump \
  -U "${DB_USER:-cplus_user}" \
  -d "${DB_NAME:-cplus_db}" \
  --no-owner --no-acl \
  | gzip > "$FILENAME"

SIZE=$(du -sh "$FILENAME" | cut -f1)
echo "Backup OK — $SIZE"

# Nettoyage des anciens backups
find "$BACKUP_DIR" -name "cplus_*.sql.gz" -mtime "+$RETENTION_DAYS" -delete
COUNT=$(find "$BACKUP_DIR" -name "cplus_*.sql.gz" | wc -l)
echo "$COUNT backup(s) conservé(s) ($RETENTION_DAYS jours de rétention)"
