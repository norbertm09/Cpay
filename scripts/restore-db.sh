#!/usr/bin/env bash
# Restauration PostgreSQL — C-Pay (base managée OVH ou locale)
#   ./scripts/restore-db.sh <fichier.sql.gz | .sql.gz.age | .sql.gz.enc> [--yes] [--db <base>] [--identity <clé age>]
# ATTENTION : écrase les objets existants. Arrêter l'API avant (docker compose stop api).
# Lot 3 (audit 2026-11-02 infra P1-3/P1-7) : --yes (scriptable, test de restauration mensuel), déchiffrement age /
# openssl, cible --db (ex. base de test), lecture de backend/.env sans l'exécuter (scripts/lib/env.sh).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/lib/env.sh"
FILE=""; YES=false; TARGET_DB=""; IDENTITY="${BACKUP_AGE_IDENTITY_FILE:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=true; shift ;;
    --db) TARGET_DB="$2"; shift 2 ;;
    --identity) IDENTITY="$2"; shift 2 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) FILE="$1"; shift ;;
  esac
done
[ -n "$FILE" ] && [ -f "$FILE" ] || { echo "Usage : $0 <fichier.sql.gz[.age|.enc]> [--yes] [--db <base>]" >&2; exit 1; }
[ -f "${BACKUP_CONF:-/etc/cplus/backup.env}" ] && load_env_vars "${BACKUP_CONF:-/etc/cplus/backup.env}" BACKUP_PASSPHRASE_FILE BACKUP_AGE_IDENTITY_FILE
load_env_vars "$ROOT/backend/.env" DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD DB_SSL PGSSLMODE BACKUP_PASSPHRASE_FILE
IDENTITY="${IDENTITY:-${BACKUP_AGE_IDENTITY_FILE:-}}"
DB="${TARGET_DB:-$DB_NAME}"
: "${DB_HOST:?}" "${DB:?}" "${DB_USER:?}" "${DB_PASSWORD:?}"
command -v psql >/dev/null || { echo "psql absent : apt install postgresql-client" >&2; exit 1; }
if [ -f "$FILE.sha256" ]; then (cd "$(dirname "$FILE")" && sha256sum -c "$(basename "$FILE").sha256" >/dev/null) || { echo "Empreinte SHA-256 invalide pour $FILE" >&2; exit 1; }; fi
if [ "$YES" != true ]; then
  read -r -p "Restaurer $FILE dans $DB@$DB_HOST ? (oui/non) " ans; [ "$ans" = "oui" ] || exit 1
fi
decrypt() {
  case "$FILE" in
    *.age) [ -n "$IDENTITY" ] && [ -r "$IDENTITY" ] || { echo "clé privée age requise (--identity ou BACKUP_AGE_IDENTITY_FILE)" >&2; exit 1; }
           age -d -i "$IDENTITY" "$FILE" ;;
    *.enc) [ -n "${BACKUP_PASSPHRASE_FILE:-}" ] && [ -r "$BACKUP_PASSPHRASE_FILE" ] || { echo "BACKUP_PASSPHRASE_FILE requis pour un .enc" >&2; exit 1; }
           openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$BACKUP_PASSPHRASE_FILE" -in "$FILE" ;;
    *)     cat "$FILE" ;;
  esac
}
export PGPASSWORD="$DB_PASSWORD"; [ "${DB_SSL:-false}" = "true" ] && export PGSSLMODE="${PGSSLMODE:-require}"
decrypt | gzip -dc | psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB" -v ON_ERROR_STOP=1 -q
unset PGPASSWORD
echo "Restauration terminée dans $DB@$DB_HOST."
