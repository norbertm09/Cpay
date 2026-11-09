#!/usr/bin/env bash
# ================================================================
# Test de restauration (lot 3, audit 2026-11-02 infra P1-3) — à planifier chaque mois sur le serveur de DEV :
#   0 3 1 * * root /opt/cplus/scripts/restore-test.sh >> /var/log/cplus/restore-test.log 2>&1
# Récupère la sauvegarde la plus récente (BACKUP_REMOTE via rclone, sinon /var/backups/cpay), la restaure dans
# une base DÉDIÉE (RESTORE_TEST_DB, jamais la base applicative), compte les tables et remonte le résultat
# (métrique cpay_restore_test_*, alerte, battement de cœur OPS_RESTORE_HEARTBEAT_URL).
# Prérequis : RESTORE_TEST_DB existe et DB_USER y a tous les droits ; clé age privée ou passphrase disponible.
# ================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/lib/env.sh"; source "$ROOT/scripts/lib/alert.sh"
BACKUP_CONF="${BACKUP_CONF:-/etc/cplus/backup.env}"
[ -f "$BACKUP_CONF" ] && load_env_vars "$BACKUP_CONF" BACKUP_REMOTE RESTORE_TEST_DB BACKUP_AGE_IDENTITY_FILE BACKUP_PASSPHRASE_FILE OPS_RESTORE_HEARTBEAT_URL OPS_ALERTMANAGER_URL OPS_TEXTFILE_DIR
load_env_vars "$ROOT/backend/.env" DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD DB_SSL PGSSLMODE
OPS_HEARTBEAT_URL="${OPS_RESTORE_HEARTBEAT_URL:-}"
RESTORE_TEST_DB="${RESTORE_TEST_DB:-cplus_restore_test}"
[ "$RESTORE_TEST_DB" != "${DB_NAME:-}" ] || { echo "RESTORE_TEST_DB ne doit jamais être la base applicative" >&2; exit 2; }
fail() { echo "ERREUR : $*" >&2; ops_metric cpay_restore_test_last_status 0; ops_alert CPayRestoreTestFailed warning "Test de restauration en échec sur $(hostname)" "$*"; ops_heartbeat fail; exit 1; }
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
if [ -n "${BACKUP_REMOTE:-}" ]; then
  command -v rclone >/dev/null || fail "rclone absent"
  LATEST="$(rclone lsf --include 'cpay_*.sql.gz*' --exclude '*.sha256' "$BACKUP_REMOTE/" | sort | tail -1)"
  [ -n "$LATEST" ] || fail "aucune sauvegarde sur $BACKUP_REMOTE"
  rclone copy "$BACKUP_REMOTE/$LATEST" "$WORK/" || fail "téléchargement de $LATEST en échec"
  rclone copy "$BACKUP_REMOTE/$LATEST.sha256" "$WORK/" >/dev/null 2>&1 || true
  FILE="$WORK/$LATEST"
else
  FILE="$(ls -1t /var/backups/cpay/cpay_*.sql.gz* 2>/dev/null | grep -v '\.sha256$' | head -1)"
  [ -n "$FILE" ] || fail "aucune sauvegarde locale"
fi
echo "Sauvegarde testée : $FILE ($(du -sh "$FILE" | cut -f1))"
export PGPASSWORD="$DB_PASSWORD"; [ "${DB_SSL:-false}" = "true" ] && export PGSSLMODE="${PGSSLMODE:-require}"
# base de test vidée puis restaurée
psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$RESTORE_TEST_DB" -v ON_ERROR_STOP=1 -q -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' || fail "préparation de $RESTORE_TEST_DB impossible"
unset PGPASSWORD
START=$(date +%s)
"$ROOT/scripts/restore-db.sh" "$FILE" --yes --db "$RESTORE_TEST_DB" || fail "restauration en échec"
export PGPASSWORD="$DB_PASSWORD"
TABLES="$(psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$RESTORE_TEST_DB" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
TXN="$(psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$RESTORE_TEST_DB" -tAc "SELECT count(*) FROM transactions" 2>/dev/null || echo 0)"
unset PGPASSWORD
[ "${TABLES:-0}" -ge 20 ] || fail "restauration suspecte : $TABLES table(s) seulement"
echo "OK — $TABLES tables, $TXN transactions, $(( $(date +%s) - START )) s"
ops_metric cpay_restore_test_last_status 1
ops_metric cpay_restore_test_last_success_timestamp_seconds "$(date +%s)"
ops_metric cpay_restore_test_tables "$TABLES"
ops_heartbeat ok
