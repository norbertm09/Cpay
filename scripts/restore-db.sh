#!/usr/bin/env bash
# Restauration PostgreSQL — C-Pay (base managée OVH ou locale)
#   ./scripts/restore-db.sh /var/backups/cpay/cpay_cplus_db_YYYYMMDD_HHMMSS.sql.gz
# ATTENTION : écrase les objets existants. Arrêter l'API avant (docker compose stop api).
set -euo pipefail
[ "$#" -eq 1 ] && [ -f "$1" ] || { echo "Usage : $0 <fichier.sql.gz>" >&2; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$ROOT/backend/.env" ]; then set -a; . "$ROOT/backend/.env"; set +a; fi
: "${DB_HOST:?}" "${DB_NAME:?}" "${DB_USER:?}" "${DB_PASSWORD:?}"
command -v psql >/dev/null || { echo "psql absent : apt install postgresql-client" >&2; exit 1; }
read -r -p "Restaurer $1 dans $DB_NAME@$DB_HOST ? (oui/non) " ans; [ "$ans" = "oui" ] || exit 1
export PGPASSWORD="$DB_PASSWORD"; [ "${DB_SSL:-false}" = "true" ] && export PGSSLMODE="${PGSSLMODE:-require}"
gzip -dc "$1" | psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q
unset PGPASSWORD
echo "Restauration terminée."
