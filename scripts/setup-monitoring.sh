#!/usr/bin/env bash
# ================================================================
# C-Pay — activation de la supervision (Prometheus + Alertmanager SMTP) sur un serveur (a lancer en root)
#
#   1. Creer le fichier prive /etc/cplus/monitoring.env (modele : monitoring/monitoring.env.example) avec :
#        ALERT_SMTP_HOST=smtp.exemple.com     ALERT_SMTP_PORT=587      ALERT_SMTP_USER=alerts@c-pay.global
#        ALERT_SMTP_FROM=alerts@c-pay.global  ALERT_SMTP_TO=ops@c-pay.global
#        ALERT_SMTP_PASSWORD=le-mot-de-passe-smtp      (ou ALERT_SMTP_PASSWORD_FILE=/chemin/prive)
#   2. bash scripts/setup-monitoring.sh            # genere, valide, demarre
#      bash scripts/setup-monitoring.sh --test     # envoie une alerte de test (e-mail attendu sur ALERT_SMTP_TO)
#      bash scripts/setup-monitoring.sh --down     # arrete la pile
#
# Le token de scrape est lu dans backend/.env (METRICS_TOKEN) sans executer le fichier. La configuration
# Alertmanager est generee par scripts/configure-monitoring.cjs dans le conteneur api (pas de Node sur l'hote).
# Les secrets vivent dans /etc/cplus/monitoring/ (0700), lisibles par l'uid 65534 (image Alertmanager).
# ================================================================
set -euo pipefail
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[MON]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
die()  { echo -e "${RED}[FAIL]${NC} $*" >&2; exit 1; }
[ "$(id -u)" = "0" ] || die "a lancer en root"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${MONITORING_ENV_FILE:-/etc/cplus/monitoring.env}"
PRIV=/etc/cplus/monitoring
COMPOSE_ENV="$PRIV/compose.env"
MON_COMPOSE="$ROOT/monitoring/docker-compose.monitoring.yml"
MODE="up"
case "${1:-}" in --test) MODE=test ;; --down) MODE=down ;; ""|--up) MODE=up ;; -h|--help) sed -n '2,16p' "$0"; exit 0 ;; *) die "option inconnue : $1" ;; esac

mon() { docker compose -f "$MON_COMPOSE" --env-file "$COMPOSE_ENV" "$@"; }

if [ "$MODE" = down ]; then [ -f "$COMPOSE_ENV" ] || die "pile non configuree"; mon down; log "pile de supervision arretee"; exit 0; fi

if [ "$MODE" = test ]; then
  [ -f "$COMPOSE_ENV" ] || die "pile non configuree : lancer d'abord sans option"
  log "Alerte de test envoyee a Alertmanager (resolution automatique dans 2 min)…"
  END="$(date -u -d '+2 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  curl -fsS -XPOST http://127.0.0.1:9093/api/v2/alerts -H 'Content-Type: application/json' \
    -d "[{\"labels\":{\"alertname\":\"CPayTestAlert\",\"severity\":\"warning\",\"service\":\"cpay-api\"},\"annotations\":{\"summary\":\"Test de la chaine d'alerte C-Pay\",\"description\":\"Envoye par scripts/setup-monitoring.sh --test le $(date -u +%FT%TZ)\"},\"endsAt\":\"$END\"}]" \
    && log "acceptee — verifier la boite $(sed -n 's/^ALERT_SMTP_TO=//p' "$ENV_FILE" | tr -d "\"'") d'ici 1 a 2 min"
  echo "Journal Alertmanager (erreurs SMTP eventuelles) :"; docker logs --since 2m cplus-alertmanager 2>&1 | grep -iE "smtp|error|notify" | tail -5 || true
  exit 0
fi

# ─── lecture des reglages ───────────────────────────────────────
[ -f "$ENV_FILE" ] || die "fichier $ENV_FILE absent — le creer a partir de monitoring/monitoring.env.example (voir en-tete)"
source "$ROOT/scripts/lib/env.sh"   # lot 3 : lecteur .env partagé (jamais sourcé)
read_var() { read_env_var "$1" "$2"; }
for v in ALERT_SMTP_HOST ALERT_SMTP_PORT ALERT_SMTP_USER ALERT_SMTP_FROM ALERT_SMTP_TO ALERT_SMTP_PASSWORD ALERT_SMTP_PASSWORD_FILE ALERT_SMTP_CA_FILE; do
  printf -v "$v" '%s' "$(read_var "$ENV_FILE" "$v")"
done
ALERT_SMTP_PORT="${ALERT_SMTP_PORT:-587}"
for v in ALERT_SMTP_HOST ALERT_SMTP_USER ALERT_SMTP_FROM ALERT_SMTP_TO; do [ -n "${!v}" ] || die "$v manquant dans $ENV_FILE"; done
METRICS_TOKEN="$(read_var "$ROOT/backend/.env" METRICS_TOKEN)"
[ -n "$METRICS_TOKEN" ] || die "METRICS_TOKEN absent de backend/.env"
GRAFANA_PASSWORD="$(read_var "$ROOT/backend/.env" GRAFANA_PASSWORD)"
[ -n "$GRAFANA_PASSWORD" ] || die "GRAFANA_PASSWORD absent de backend/.env (mot de passe admin de Grafana, lot hygiene 2026-11)"

# ─── fichiers secrets (lisibles par l'uid 65534 des images Prometheus/Alertmanager) ─────
install -d -m 0750 -o root -g 65534 "$PRIV"
if [ -z "$ALERT_SMTP_PASSWORD_FILE" ]; then
  [ -n "$ALERT_SMTP_PASSWORD" ] || die "ALERT_SMTP_PASSWORD ou ALERT_SMTP_PASSWORD_FILE requis"
  ALERT_SMTP_PASSWORD_FILE="$PRIV/smtp_password"
  printf '%s' "$ALERT_SMTP_PASSWORD" > "$ALERT_SMTP_PASSWORD_FILE"
fi
chown root:65534 "$ALERT_SMTP_PASSWORD_FILE"; chmod 0440 "$ALERT_SMTP_PASSWORD_FILE"
METRICS_FILE="$PRIV/metrics_token"; printf '%s' "$METRICS_TOKEN" > "$METRICS_FILE"; chown root:65534 "$METRICS_FILE"; chmod 0440 "$METRICS_FILE"
# Grafana tourne sous l'uid 472 : son secret vit dans un dossier a part (le dossier $PRIV n'est lisible que par 65534)
PRIV_GRAFANA="$PRIV-grafana"; install -d -m 0750 -o root -g 472 "$PRIV_GRAFANA"
GRAFANA_FILE="$PRIV_GRAFANA/admin_password"; printf '%s' "$GRAFANA_PASSWORD" > "$GRAFANA_FILE"; chown root:472 "$GRAFANA_FILE"; chmod 0440 "$GRAFANA_FILE"
TEMPLATE_DIR="$ROOT/monitoring/alertmanager"
AM_CONFIG="$PRIV/alertmanager.yml"

# ─── lot 3 : postgres-exporter (identifiants dans des fichiers 0440 root:65534) et node-exporter (textfile) ─────
for v in DB_HOST DB_PORT DB_NAME DB_USER DB_PASSWORD DB_SSL; do printf -v "$v" '%s' "$(read_var "$ROOT/backend/.env" "$v")"; done
PGX_USER="${PG_EXPORTER_USER:-$(read_var "$ENV_FILE" PG_EXPORTER_USER)}"; PGX_PASS="${PG_EXPORTER_PASSWORD:-$(read_var "$ENV_FILE" PG_EXPORTER_PASSWORD)}"
[ -n "$PGX_USER" ] || { PGX_USER="$DB_USER"; PGX_PASS="$DB_PASSWORD"; warn "PG_EXPORTER_USER absent de $ENV_FILE : l'exporter utilise DB_USER (créer un rôle lecture seule est recommandé, docs/EXPLOITATION.md)"; }
[ -n "$DB_HOST" ] && [ -n "$DB_NAME" ] || die "DB_HOST / DB_NAME absents de backend/.env"
PGX_URI="$DB_HOST:${DB_PORT:-5432}/$DB_NAME?sslmode=$([ "${DB_SSL:-false}" = "true" ] && echo require || echo disable)"
printf '%s' "$PGX_USER" > "$PRIV/pg_exporter_user"; printf '%s' "$PGX_PASS" > "$PRIV/pg_exporter_pass"
chown root:65534 "$PRIV/pg_exporter_user" "$PRIV/pg_exporter_pass"; chmod 0440 "$PRIV/pg_exporter_user" "$PRIV/pg_exporter_pass"
TEXTFILE_DIR="${OPS_TEXTFILE_DIR:-/var/lib/node_exporter/textfile}"; install -d -m 0755 "$TEXTFILE_DIR"

# ─── generation de la configuration Alertmanager dans l'image api (service api-blue depuis la bascule bleu/vert, memes chemins absolus) ─────
# L'image api tourne sous l'utilisateur cplus (lot 7) : il ne peut pas lire les fichiers secrets 0440 root:65534 de $PRIV
# (« Configuration invalide : ALERT_SMTP_PASSWORD_FILE »). Le conteneur ephemere de generation tourne donc en root,
# comme ce script sur l'hote ; il ne monte que scripts/ et monitoring/ en lecture seule et $PRIV.
# Le generateur refuse d'ecraser un fichier existant (garde-fou) : la configuration precedente est conservee en .prev
if [ -f "$AM_CONFIG" ]; then mv -f "$AM_CONFIG" "$AM_CONFIG.prev"; chmod 0400 "$AM_CONFIG.prev" 2>/dev/null || true; log "configuration precedente conservee : $AM_CONFIG.prev"; fi
log "Generation de $AM_CONFIG (scripts/configure-monitoring.cjs)…"
( cd "$ROOT/docker" && docker compose run --rm --no-deps -T --user 0:0 \
    -v "$ROOT/scripts:$ROOT/scripts:ro" -v "$ROOT/monitoring:$ROOT/monitoring:ro" -v "$PRIV:$PRIV" \
    ${ALERT_SMTP_CA_FILE:+-v "$ALERT_SMTP_CA_FILE:$ALERT_SMTP_CA_FILE:ro"} \
    -e ALERT_SMTP_HOST="$ALERT_SMTP_HOST" -e ALERT_SMTP_PORT="$ALERT_SMTP_PORT" -e ALERT_SMTP_USER="$ALERT_SMTP_USER" \
    -e ALERT_SMTP_FROM="$ALERT_SMTP_FROM" -e ALERT_SMTP_TO="$ALERT_SMTP_TO" -e ALERT_SMTP_PASSWORD_FILE="$ALERT_SMTP_PASSWORD_FILE" \
    -e MONITORING_METRICS_TOKEN_FILE="$METRICS_FILE" -e MONITORING_TEMPLATE_DIR="$TEMPLATE_DIR" ${ALERT_SMTP_CA_FILE:+-e ALERT_SMTP_CA_FILE="$ALERT_SMTP_CA_FILE"} \
    -e RUN_MIGRATIONS=false --entrypoint node api-blue "$ROOT/scripts/configure-monitoring.cjs" --output "$AM_CONFIG" ) \
  || die "generation de la configuration Alertmanager en echec (verifier $ENV_FILE)"
chown root:65534 "$AM_CONFIG"; chmod 0440 "$AM_CONFIG"

# ─── fichier d'environnement compose ──────────────────────────────
NET="$(docker network ls --format '{{.Name}}' | grep -m1 'cplus-internal' || echo docker_cplus-internal)"
cat > "$COMPOSE_ENV" <<ENV
MONITORING_METRICS_TOKEN_FILE=$METRICS_FILE
MONITORING_GRAFANA_PASSWORD_FILE=$GRAFANA_FILE
ALERTMANAGER_CONFIG_FILE=$AM_CONFIG
ALERT_SMTP_PASSWORD_FILE=$ALERT_SMTP_PASSWORD_FILE
MONITORING_TEMPLATE_DIR=$TEMPLATE_DIR
CPLUS_NETWORK=$NET
POSTGRES_EXPORTER_URI=$PGX_URI
POSTGRES_EXPORTER_USER_FILE=$PRIV/pg_exporter_user
POSTGRES_EXPORTER_PASS_FILE=$PRIV/pg_exporter_pass
OPS_TEXTFILE_DIR=$TEXTFILE_DIR
ENV
chmod 0600 "$COMPOSE_ENV"

# ─── validation puis demarrage ──────────────────────────────────
mon config -q || die "docker compose config en echec"
# Les images prom/* ont le binaire du service en entrypoint : promtool / amtool passent par --entrypoint
mon run --rm --no-deps -T --entrypoint promtool prometheus check config /etc/prometheus/prometheus.yml >/dev/null || die "promtool : configuration Prometheus invalide"
mon run --rm --no-deps -T --entrypoint amtool alertmanager check-config /etc/alertmanager/alertmanager.yml >/dev/null || die "amtool : configuration Alertmanager invalide ($AM_CONFIG)"
mon up -d
sleep 5
log "Etat :"; mon ps --format 'table {{.Name}}\t{{.Status}}'
if curl -fsS http://127.0.0.1:9090/-/ready >/dev/null && curl -fsS http://127.0.0.1:9093/-/ready >/dev/null; then
  log "Prometheus et Alertmanager prets (127.0.0.1:9090 / :9093, non exposes publiquement)"
else
  warn "un composant ne repond pas encore : docker logs cplus-prometheus / cplus-alertmanager"
fi
sleep 10
TARGET="$(curl -fsS 'http://127.0.0.1:9090/api/v1/targets' | python3 -c "import sys,json; t=[x for x in json.load(sys.stdin)['data']['activeTargets'] if x['labels'].get('job','').startswith('cpay') or 'api' in x['scrapeUrl']]; print(', '.join(f\"{x['scrapeUrl']} {x['health']}\" for x in t) or 'aucune cible api')" 2>/dev/null || echo "?")"
log "Cible API : $TARGET"
log "Test de la chaine d'alerte : bash scripts/setup-monitoring.sh --test"
