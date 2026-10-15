#!/usr/bin/env sh
# ================================================================
# C-Pay — deploiement production standard (serveur OVH, /opt/cplus, docker compose + nginx hote)
#
#   ./scripts/deploy.sh [--skip-backup] [--skip-build] [--skip-migrations]
#   ./scripts/deploy.sh --rollback          # revient au commit precedent (.deployed)
#
# Idempotent : relancable sur le meme commit. Etapes (docs/CI-CD.md) :
#   1. enregistre le commit en cours/precedent dans .deployed (pour --rollback)
#   2. verifie backend/.env (backend/scripts/check-production-env.js, dans l'image api)
#   3. sauvegarde PostgreSQL (scripts/backup-db.sh --label pre-<version>)
#   4. docker compose build (api + portails ; CPLUS_TAG=<version>)
#   5. migrations (docker compose run --rm --no-deps -e RUN_MIGRATIONS=false api node src/config/migrate.js)
#   6. docker compose up -d --remove-orphans
#   7. health checks : API 127.0.0.1:3001/health, vitrine 127.0.0.1:3006/, portails (non bloquants)
# Lance par .github/workflows/deploy.yml via SSH, ou a la main depuis /opt/cplus.
# Les scripts deploy-ovh.sh / deploy-prod.sh / deploy-wave-2.sh restent des scripts historiques.
# ================================================================
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT"
DOCKER_DIR="$ROOT/docker"
STATE_FILE="$ROOT/.deployed"
HISTORY_FILE="$ROOT/.deploy-history"
LOG_DIR="${CPAY_DEPLOY_LOG_DIR:-/var/log/cplus}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

SKIP_BACKUP=false; SKIP_BUILD=false; SKIP_MIGRATIONS=false; ROLLBACK=false
for arg in "$@"; do
  case "$arg" in
    --skip-backup)     SKIP_BACKUP=true ;;
    --skip-build)      SKIP_BUILD=true ;;
    --skip-migrations) SKIP_MIGRATIONS=true ;;
    --rollback)        ROLLBACK=true ;;
    -h|--help)         sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "option inconnue : $arg" >&2; exit 2 ;;
  esac
done

mkdir -p "$LOG_DIR" 2>/dev/null || LOG_DIR="$ROOT"
LOG_FILE="$LOG_DIR/deploy_$TIMESTAMP.log"
log()  { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG_FILE"; }
warn() { printf '[%s] WARN %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG_FILE" >&2; }
die()  { printf '[%s] ERREUR %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG_FILE" >&2; exit 1; }

state_get() { # state_get <key>   (current|previous) -> sha
  [ -f "$STATE_FILE" ] && sed -n "s/^$1 \([0-9a-f]\{7,40\}\).*/\1/p" "$STATE_FILE" | head -1 || true
}
state_write() { # state_write <current-sha> <previous-sha>
  {
    echo "current $1 $(git describe --tags --always 2>/dev/null) $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    [ -n "$2" ] && echo "previous $2"
  } > "$STATE_FILE"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $1 $(git describe --tags --always 2>/dev/null)" >> "$HISTORY_FILE"
}

compose() { (cd "$DOCKER_DIR" && docker compose "$@"); }

wait_http() { # wait_http <url> <attempts> <expected-substring>
  _url="$1"; _n="$2"; _expect="${3:-}"; _i=1
  while [ "$_i" -le "$_n" ]; do
    _body="$(curl -fsS --max-time 5 "$_url" 2>/dev/null || true)"
    if [ -n "$_body" ] && { [ -z "$_expect" ] || printf '%s' "$_body" | grep -q "$_expect"; }; then
      return 0
    fi
    _i=$((_i + 1)); sleep 2
  done
  return 1
}

# ─── Prerequis ──────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || die "docker introuvable"
docker compose version >/dev/null 2>&1 || die "Docker Compose V2 requis"
command -v git >/dev/null 2>&1 || die "git introuvable"
command -v curl >/dev/null 2>&1 || die "curl introuvable"
[ -f "$ROOT/backend/.env" ] || die "backend/.env manquant"

CURRENT_SHA="$(git rev-parse HEAD)"
VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
export CPLUS_TAG="$VERSION"

# ─── Rollback : revenir au commit precedent ─────────────────────
if [ "$ROLLBACK" = true ]; then
  PREV="$(state_get previous)"
  [ -n "$PREV" ] || die "Pas de commit precedent dans $STATE_FILE — rollback impossible"
  log "ROLLBACK : $CURRENT_SHA -> $PREV"
  git -c advice.detachedHead=false checkout --detach "$PREV" || die "git checkout $PREV impossible"
  VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"; export CPLUS_TAG="$VERSION"
  log "Version restauree : $VERSION ; reconstruction des images"
  compose build
  log "Les migrations ne sont pas annulees (schema compatible ascendant) ; restauration DB manuelle : scripts/restore-db.sh"
  compose up -d --remove-orphans
  wait_http http://127.0.0.1:3001/health 45 '"status":"ok"' || die "API KO apres rollback (127.0.0.1:3001/health)"
  state_write "$PREV" "$CURRENT_SHA"
  log "Rollback termine sur $PREV ($VERSION)"
  exit 0
fi

# ─── 1. Etat de deploiement ─────────────────────────────────────
PREVIOUS_SHA="$(state_get current)"
if [ "$PREVIOUS_SHA" = "$CURRENT_SHA" ]; then
  PREVIOUS_SHA="$(state_get previous)"
  log "Meme commit que le deploiement precedent ($CURRENT_SHA) : redeploiement idempotent"
fi
log "Deploiement C-Pay $VERSION — commit $CURRENT_SHA (precedent : ${PREVIOUS_SHA:-aucun})"
log "Journal : $LOG_FILE"

# ─── 2. Build des images (necessaire pour la verification d'env dans l'image) ───
if [ "$SKIP_BUILD" = false ]; then
  log "docker compose build (CPLUS_TAG=$CPLUS_TAG)…"
  BUILD_STATUS="$LOG_DIR/.build_status_$TIMESTAMP"
  { compose build 2>&1; echo "$?" > "$BUILD_STATUS"; } | tee -a "$LOG_FILE"
  _st="$(cat "$BUILD_STATUS")"; rm -f "$BUILD_STATUS"
  [ "$_st" = "0" ] || die "docker compose build en echec (code $_st)"
  log "Images construites"
else
  warn "Build ignore (--skip-build)"
fi

# ─── 3. Verification de l'environnement production ──────────────
log "Verification de backend/.env (check-production-env.js)…"
compose run --rm --no-deps -T -e RUN_MIGRATIONS=false \
  -v "$ROOT/backend/scripts:/app/scripts:ro" api node scripts/check-production-env.js \
  || die "Variables d'environnement production incompletes"

# ─── 4. Sauvegarde PostgreSQL ───────────────────────────────────
if [ "$SKIP_BACKUP" = false ]; then
  log "Sauvegarde de la base (label pre-$VERSION)…"
  "$ROOT/scripts/backup-db.sh" --label "pre-$VERSION" || die "Sauvegarde echouee — deploiement interrompu (utiliser --skip-backup pour forcer)"
else
  warn "Sauvegarde ignoree (--skip-backup)"
fi

# ─── 5. Migrations ──────────────────────────────────────────────
if [ "$SKIP_MIGRATIONS" = false ]; then
  log "Migrations (src/config/migrate.js)…"
  compose run --rm --no-deps -T -e RUN_MIGRATIONS=false api node src/config/migrate.js || die "Migrations echouees"
else
  warn "Migrations ignorees (--skip-migrations)"
fi

# ─── 6. Demarrage ───────────────────────────────────────────────
log "docker compose up -d --remove-orphans…"
compose up -d --remove-orphans
state_write "$CURRENT_SHA" "$PREVIOUS_SHA"

# ─── 7. Health checks ───────────────────────────────────────────
log "Health check API (127.0.0.1:3001/health)…"
if wait_http http://127.0.0.1:3001/health 45 '"status":"ok"'; then
  log "  API OK : $(curl -fsS --max-time 5 http://127.0.0.1:3001/health)"
else
  compose ps | tee -a "$LOG_FILE"
  die "API KO apres 90 s — ./scripts/deploy.sh --rollback pour revenir a ${PREVIOUS_SHA:-<aucun>}"
fi
log "Health check vitrine (127.0.0.1:3006/)…"
wait_http http://127.0.0.1:3006/ 15 '<html' || die "Vitrine KO (127.0.0.1:3006)"
log "  vitrine OK"
for portal in "merchant 3002" "cardholder 3003" "admin 3004" "partners 3005"; do
  set -- $portal
  if wait_http "http://127.0.0.1:$2/" 10 '<html'; then log "  portail $1 OK (:$2)"; else warn "  portail $1 injoignable (:$2)"; fi
done

log "Nettoyage des images obsoletes…"
docker image prune -f --filter "until=168h" >/dev/null 2>&1 || true

compose ps | tee -a "$LOG_FILE"
log "Deploiement $VERSION termine (commit $CURRENT_SHA). Rollback : ./scripts/deploy.sh --rollback"
