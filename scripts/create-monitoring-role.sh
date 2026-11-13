#!/usr/bin/env bash
# ============================================================================
# C-Pay — role PostgreSQL en LECTURE SEULE pour l'exporter Prometheus (lot exporter, 2026-11-13)
#
# L'exporter (prometheuscommunity/postgres-exporter) n'a besoin que des vues de statistiques (pg_stat_*) : le role
# predefini `pg_monitor` suffit. Jusqu'ici il tournait avec DB_USER, le role applicatif qui lit et ecrit toutes les
# tables : une fuite du fichier secret de l'exporter donnait acces aux donnees. Ce script cree (ou met a jour)
# un role dedie sans aucun droit sur les tables applicatives, puis inscrit ses identifiants dans
# /etc/cplus/monitoring.env (PG_EXPORTER_USER / PG_EXPORTER_PASSWORD) ; `setup-monitoring.sh` les relit.
#
#   sudo bash scripts/create-monitoring-role.sh                 # role cplus_monitor, mot de passe genere, monitoring.env mis a jour
#   sudo bash scripts/create-monitoring-role.sh --sql           # affiche seulement le SQL (mot de passe a remplacer) pour un DBA
#   sudo bash scripts/create-monitoring-role.sh --role <nom> --monitoring-env <fichier> --password-file <fichier 600>
#
# Connexion d'administration : DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD/DB_SSL de backend/.env (ou deja exportes).
# Sur OVH Cloud DB, si DB_USER n'a pas le droit CREATE ROLE / GRANT pg_monitor (« permission denied »), relancer avec
# le compte administrateur de l'instance : PGUSER=<admin> PGPASSWORD=<…> (ou PGPASSFILE) — ou remettre le SQL de
# `--sql` au support. Le script n'affiche jamais le mot de passe genere. `history -c` ensuite.
#
# Ensuite : sudo bash scripts/setup-monitoring.sh   puis   docker logs cplus-postgres-exporter --since 2m
# ============================================================================
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
# shellcheck source=lib/env.sh
. "$ROOT/scripts/lib/env.sh"

ROLE="cplus_monitor"; MON_ENV="${MONITORING_ENV_FILE:-/etc/cplus/monitoring.env}"; SQL_ONLY=false; PW_FILE=""; SKIP_WRITE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE="$2"; shift 2 ;;
    --monitoring-env) MON_ENV="$2"; shift 2 ;;
    --password-file) PW_FILE="$2"; shift 2 ;;
    --sql) SQL_ONLY=true; shift ;;
    --skip-write) SKIP_WRITE=true; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "option inconnue : $1" >&2; exit 2 ;;
  esac
done
log()  { printf '[monitoring-role] %s\n' "$*"; }
warn() { printf '[monitoring-role] WARN %s\n' "$*" >&2; }
die()  { printf '[monitoring-role] ERREUR %s\n' "$*" >&2; exit 1; }
case "$ROLE" in *[!a-z0-9_]*|'') die "nom de role invalide : $ROLE (minuscules, chiffres, _)" ;; esac

load_env_vars "$ROOT/backend/.env" DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD DB_SSL
: "${DB_HOST:?DB_HOST manquant (backend/.env)}" "${DB_NAME:?DB_NAME manquant}"
ADMIN_USER="${PGUSER:-${DB_USER:?DB_USER manquant}}"; ADMIN_PASS="${PGPASSWORD:-${DB_PASSWORD:-}}"
SSLMODE="${PGSSLMODE:-$([ "${DB_SSL:-false}" = "true" ] && echo require || echo prefer)}"

# SQL idempotent : creation si absent, mot de passe et garde-fous a chaque passage. Le mot de passe est passe par
# variable psql (:'pw'), jamais interpole dans le texte.
sql_body() {
  cat <<EOF
\\set ON_ERROR_STOP on
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$ROLE') THEN
    EXECUTE 'CREATE ROLE $ROLE NOLOGIN';
  END IF;
END \$\$;
-- (pas de NOSUPERUSER/NOREPLICATION/NOBYPASSRLS explicites : ce sont les valeurs de creation, et seul un superutilisateur
--  peut les poser — le compte administrateur d'une base managee OVH n'en est pas un)
ALTER ROLE $ROLE WITH LOGIN PASSWORD :'pw' INHERIT CONNECTION LIMIT 3;
ALTER ROLE $ROLE SET statement_timeout = '5s';
ALTER ROLE $ROLE SET default_transaction_read_only = on;
GRANT pg_monitor TO $ROLE;
GRANT CONNECT ON DATABASE "$DB_NAME" TO $ROLE;
-- aucun droit sur les tables applicatives : on retire ce qu'un GRANT PUBLIC anterieur aurait pu laisser
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM $ROLE;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM $ROLE;
REVOKE CREATE ON SCHEMA public FROM $ROLE;
EOF
}

if [ "$SQL_ONLY" = true ]; then
  echo "-- a executer avec un compte administrateur : psql -v pw='<mot de passe>' -f ce_fichier.sql"
  sql_body; exit 0
fi

[ -w "$(dirname "$MON_ENV")" ] || [ -w "$MON_ENV" ] || [ "$SKIP_WRITE" = true ] || die "$MON_ENV non inscriptible : lancer avec sudo (ou --skip-write)"
if [ -n "$PW_FILE" ]; then PW="$(tr -d '\r\n' < "$PW_FILE")"; [ "${#PW}" -ge 16 ] || die "mot de passe trop court (16 minimum)"
else PW="$(openssl rand -hex 24)"; fi

psql_cmd() { # psql_cmd <user> <pass> <args…> : psql de l'hote, sinon l'image postgres (meme majeure que la CI)
  local u="$1" p="$2"; shift 2
  if command -v psql >/dev/null 2>&1; then
    PGPASSWORD="$p" PGSSLMODE="$SSLMODE" PGCONNECT_TIMEOUT=10 psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$u" -d "$DB_NAME" -q -X "$@"
  else
    docker run --rm -i --network host -e PGPASSWORD="$p" -e PGSSLMODE="$SSLMODE" -e PGCONNECT_TIMEOUT=10 postgres:16-alpine \
      psql -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$u" -d "$DB_NAME" -q -X "$@"
  fi
}

log "Creation / mise a jour du role $ROLE sur $DB_HOST:${DB_PORT:-5432}/$DB_NAME (compte $ADMIN_USER)…"
if ! out="$(sql_body | psql_cmd "$ADMIN_USER" "$ADMIN_PASS" -v pw="$PW" -f - 2>&1)"; then
  printf '%s\n' "$out" | grep -v -i "password" >&2 || true
  case "$out" in
    *"permission denied"*|*"must have admin option"*|*"must be superuser"*)
      die "droits insuffisants pour $ADMIN_USER : relancer avec le compte administrateur de l'instance (PGUSER=… PGPASSWORD=…) ou remettre le SQL de '--sql' a l'administrateur de la base" ;;
    *) die "echec SQL (voir ci-dessus) ; monitoring.env inchange" ;;
  esac
fi

log "Verification avec le role $ROLE…"
n="$(psql_cmd "$ROLE" "$PW" -tAc 'SELECT count(*) FROM pg_stat_activity' 2>&1 | tr -d '[:space:]')" || true
case "$n" in ''|*[!0-9]*) die "connexion ou lecture de pg_stat_activity impossible avec $ROLE ($n)" ;; esac
log "pg_stat_activity lisible ($n sessions)"
if psql_cmd "$ROLE" "$PW" -tAc 'SELECT 1 FROM merchants LIMIT 1' >/dev/null 2>&1; then
  die "le role $ROLE peut lire la table merchants : un GRANT PUBLIC subsiste, verifier les droits avant d'utiliser ce role"
fi
log "aucun acces aux tables applicatives (merchants refusee) : OK"

if [ "$SKIP_WRITE" = true ]; then log "--skip-write : $MON_ENV non modifie"; exit 0; fi
[ -f "$MON_ENV" ] || { install -m 600 /dev/null "$MON_ENV"; warn "$MON_ENV cree (vide) : completer les variables ALERT_* avant setup-monitoring.sh"; }
write_env_var "$MON_ENV" PG_EXPORTER_USER "$ROLE" || die "ecriture impossible dans $MON_ENV"
write_env_var "$MON_ENV" PG_EXPORTER_PASSWORD "$PW" || die "ecriture impossible dans $MON_ENV"
chmod 600 "$MON_ENV" 2>/dev/null || true
log "$MON_ENV : PG_EXPORTER_USER / PG_EXPORTER_PASSWORD inscrits (mot de passe non affiche)"
log "Ensuite : sudo bash scripts/setup-monitoring.sh   puis   docker logs cplus-postgres-exporter --since 2m ; history -c"
