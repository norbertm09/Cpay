#!/usr/bin/env bash
# ================================================================
# CPlus 2.6 — Script de déploiement OVH
# Usage: ./scripts/deploy-ovh.sh [--skip-build] [--rollback]
# ================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKER_DIR="$ROOT/docker"
BACKEND_DIR="$ROOT/backend"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="/var/log/cplus/deploy_$TIMESTAMP.log"

# Couleurs
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

log()  { echo -e "${GREEN}[$(date +%H:%M:%S)]${NC} $*" | tee -a "$LOG_FILE" 2>/dev/null || echo "$*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*" | tee -a "$LOG_FILE" 2>/dev/null || echo "$*"; }
die()  { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

SKIP_BUILD=false
ROLLBACK=false
for arg in "$@"; do
  case $arg in
    --skip-build) SKIP_BUILD=true ;;
    --rollback)   ROLLBACK=true ;;
  esac
done

# ─── Rollback ─────────────────────────────────────────────────────
if [ "$ROLLBACK" = true ]; then
  log "ROLLBACK: arrêt des services actuels..."
  cd "$DOCKER_DIR"
  # Les images sont taguées 2.6.0-<timestamp> à chaque déploiement : on reprend l'avant-dernière
  PREV_IMAGE=$(docker images cplus-api --format "{{.Tag}}" | grep -E '^2\.6\.0-[0-9_]+$' | sort -r | sed -n '2p')
  [ -n "$PREV_IMAGE" ] || die "Pas d'image précédente trouvée pour le rollback"
  log "ROLLBACK: redémarrage de l'API sur $PREV_IMAGE (sans coupure des portails)..."
  CPLUS_TAG="$PREV_IMAGE" docker compose up -d --no-build api
  log "Rollback terminé vers $PREV_IMAGE (la base de données n'est pas restaurée : voir scripts/restore-db.sh)"
  exit 0
fi

# ─── Prérequis ────────────────────────────────────────────────────
log "Vérification des prérequis..."
command -v docker >/dev/null 2>&1 || die "Docker non trouvé"
docker compose version >/dev/null 2>&1 || die "Docker Compose V2 requis"
[ -f "$BACKEND_DIR/.env" ] || die "backend/.env manquant — copier .env.production.example"

# ─── Vérification de l'environnement ──────────────────────────────
log "Vérification de l'environnement production..."
cd "$BACKEND_DIR"
node scripts/check-production-env.js || die "Variables d'environnement incorrectes"
set -a
. "$BACKEND_DIR/.env"
set +a

# ─── Snapshot DB avant déploiement ────────────────────────────────
log "Snapshot base de données avant déploiement..."
"$ROOT/scripts/backup-db.sh" --label "pre-deploy-$TIMESTAMP" || warn "Backup pré-deploy échoué"

# ─── Build des images ─────────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  log "Build des images Docker..."
  cd "$DOCKER_DIR"
  docker compose build api admin-portal merchant-portal cardholder-portal partners-portal
  docker tag "cplus-api:${CPLUS_TAG:-2.6.0}" "cplus-api:2.6.0-$TIMESTAMP"
  log "Images buildées avec succès (api taguée 2.6.0-$TIMESTAMP)"
else
  warn "Build ignoré (--skip-build)"
fi

# ─── Déploiement rolling ──────────────────────────────────────────
log "Déploiement rolling sans downtime..."
cd "$DOCKER_DIR"

# 1. Démarrer/mettre à jour l'infra (postgres, nginx)
mkdir -p "$DOCKER_DIR/secrets"
printf '%s' "${METRICS_TOKEN:?METRICS_TOKEN required}" > "$DOCKER_DIR/secrets/metrics_token"
chmod 600 "$DOCKER_DIR/secrets/metrics_token"

# 2. Base managée OVH Cloud DB : vérifier la joignabilité (pas de conteneur postgres)
log "Vérification PostgreSQL ($DB_HOST:${DB_PORT:-5432})..."
if command -v pg_isready >/dev/null 2>&1; then
  pg_isready -h "$DB_HOST" -p "${DB_PORT:-5432}" -U "$DB_USER" -d "$DB_NAME" >/dev/null || die "PostgreSQL injoignable"
else
  timeout 5 bash -c "</dev/tcp/$DB_HOST/${DB_PORT:-5432}" || die "PostgreSQL injoignable (port fermé)"
fi

# 3. Lancer les migrations (via l'entrypoint de l'API)
log "Exécution des migrations DB..."
docker compose run --rm --no-deps -e RUN_MIGRATIONS=false api node src/config/migrate.js
node "$BACKEND_DIR/scripts/check-pilot-readiness.js" || warn "Pilot readiness check failed (non bloquant)"

# 4. Démarrer le nouvel API
log "Démarrage API..."
docker compose up -d api
sleep 10

# 5. Health check API
log "Health check API..."
for i in $(seq 1 30); do
  if docker compose exec -T api wget -qO- http://localhost:3000/health | grep -q '"status":"ok"'; then
    log "API OK (tentative $i)"
    break
  fi
  if [ $i -eq 30 ]; then
    die "Health check API échoué après 30 tentatives — rollback manuel requis"
  fi
  sleep 2
done

# 6. Démarrer les portails
log "Démarrage des portails..."
docker compose up -d admin-portal merchant-portal cardholder-portal partners-portal

# 7. Services optionnels : démarrés seulement s'ils existent dans le compose
log "Démarrage des services annexes..."
for svc in settlement-cron nginx prometheus alertmanager grafana loki promtail node-exporter; do
  if docker compose config --services 2>/dev/null | grep -qx "$svc"; then
    docker compose up -d "$svc" || warn "Service $svc non démarré"
  fi
done

# ─── Vérification finale ──────────────────────────────────────────
log "Vérification finale des services..."
docker compose ps

log "Test health checks externes..."
for url in "http://127.0.0.1/health" "http://127.0.0.1/ready"; do
  if curl -fsS "$url" > /dev/null 2>&1; then
    log "  ✓ $url"
  else
    warn "  ✗ $url (non critique via nginx)"
  fi
done

# ─── Nettoyage images anciennes ───────────────────────────────────
log "Nettoyage des images Docker orphelines..."
docker image prune -f --filter "until=24h" || true

log "═══════════════════════════════════════════════"
log "Déploiement CPlus 2.6 terminé avec succès ✓"
log "Timestamp: $TIMESTAMP"
log "═══════════════════════════════════════════════"
