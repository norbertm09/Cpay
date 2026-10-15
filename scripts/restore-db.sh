#!/usr/bin/env sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: scripts/restore-db.sh backups/cplus-db-YYYYMMDD-HHMMSS.sql.gz" >&2
  exit 1
fi

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR/docker"

gzip -dc "$1" | docker compose --env-file ../backend/.env exec -T postgres sh -c \
  'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'

echo "Restauration terminee."
