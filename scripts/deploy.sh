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
#   4. images : recuperees depuis GHCR (ghcr.io/norbertm09/cpay/cplus-<svc>:<version>-<sha12>, publiees par la CI
#      sur main) et sinon construites sur place (docker compose build ; CPLUS_TAG=<version>-<sha12>)
#   5. migrations (docker compose run --rm --no-deps -e RUN_MIGRATIONS=false api-blue node src/config/migrate.js)
#   6. bascule bleu/vert de l'API sans coupure : demarrage de la couleur inactive avec la nouvelle image, attente
#      de /health, bascule du routeur (docker/api-router, 127.0.0.1:3001) par rechargement gracieux, drainage puis
#      arret gracieux (SIGTERM) de l'ancienne couleur ; meme bascule pour les quatre portails (tranche web,
#      docker/web-router sur 3002-3005) ; vitrine / cron par docker compose up -d
#   7. health checks via les routeurs : API 127.0.0.1:3001/health, vitrine 127.0.0.1:3006/, portails 3002-3005 (bloquants depuis le
#      hotfix du 2026-11-10 : un conteneur en boucle de redemarrage faisait passer le deploiement pour reussi)
# Lance par .github/workflows/deploy.yml via SSH, ou a la main depuis /opt/cplus.
# Les anciens scripts (deploy-ovh.sh, deploy-wave-2.sh, init-ovh.sh, *-tls.sh) sont dans scripts/legacy/ (lecture seule) ;
# deploy-prod.sh a ete supprime (lot 7).
# ================================================================
set -eu

# --no-pull (ou CPAY_PULL=false) : ne pas tenter GHCR ; CPAY_GHCR : prefixe des images publiees par la CI
PULL_IMAGES="${CPAY_PULL:-true}"; GHCR_PREFIX="${CPAY_GHCR:-ghcr.io/norbertm09/cpay}"
# Bascule bleu/vert : secondes laissees au routeur apres la bascule avant l'arret de l'ancienne couleur
DRAIN_SECONDS="${CPAY_DRAIN_SECONDS:-10}"

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
    --no-pull)         PULL_IMAGES=false ;;
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

# docker/.cron.env : le conteneur settlement-cron ne recoit que INTERNAL_TOKEN (reliquat 2026-11, audit § 5).
# Lecture sans « source » (une valeur contenant ( ) $ casserait le shell) : NOM=valeur ou NOM='valeur'.
read_env_value() { # read_env_value <fichier> <NOM>
  _raw="$(sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$2=//p" "$1" | tail -1 | tr -d '\r')"
  case "$_raw" in
    \'*\') _raw="${_raw#\'}"; _raw="${_raw%\'}" ;;
    \"*\") _raw="${_raw#\"}"; _raw="${_raw%\"}" ;;
    *) _raw="$(printf '%s' "$_raw" | sed 's/[[:space:]]*$//')" ;;
  esac
  printf '%s' "$_raw"
}
write_cron_env() {
  _tok="$(read_env_value "$ROOT/backend/.env" INTERNAL_TOKEN)"
  [ -n "$_tok" ] || die "INTERNAL_TOKEN absent de backend/.env (requis par settlement-cron)"
  umask 077
  printf 'INTERNAL_TOKEN=%s\n' "$_tok" > "$DOCKER_DIR/.cron.env"
  umask 022
}
write_cron_env

# Cles SSH d'administration (ops/admin-keys/*.pub) : ajoutees a ~/.ssh/authorized_keys de l'utilisateur de
# deploiement si elles manquent — seul chemin fiable vers le serveur quand l'acces interactif est perdu
# (ops/admin-keys/README.md). Non bloquant.
if [ -x "$ROOT/scripts/install-admin-keys.sh" ]; then
  "$ROOT/scripts/install-admin-keys.sh" 2>&1 | tee -a "$LOG_FILE" || warn "install-admin-keys.sh en echec (acces SSH d'administration non mis a jour)"
fi

# ─── Bascule bleu/vert de l'API (P1-6, 2026-11) ─────────────────
ROUTER_ACTIVE="$DOCKER_DIR/api-router/active/active.conf"
WEB_ACTIVE="$DOCKER_DIR/web-router/active/active.conf"
WEB_PORTALS="merchant cardholder admin partners"
color_running() { [ "$(docker inspect -f '{{.State.Running}}' "cplus-api-$1" 2>/dev/null)" = "true" ]; }
other_color() { if [ "$1" = blue ]; then echo green; else echo blue; fi; }
active_color() { # couleur servie par le routeur si elle tourne, sinon la couleur qui tourne, sinon rien
  _c="$(sed -n 's/^set \$cpay_api_upstream api-\([a-z]*\);.*/\1/p' "$ROUTER_ACTIVE" 2>/dev/null | head -1)"
  if [ -n "$_c" ] && color_running "$_c"; then echo "$_c"; return 0; fi
  for _c in blue green; do if color_running "$_c"; then echo "$_c"; return 0; fi; done
  return 0
}
write_active() { mkdir -p "$(dirname "$ROUTER_ACTIVE")"; printf 'set $cpay_api_upstream api-%s;\n' "$1" > "$ROUTER_ACTIVE"; }
api_healthy() { # api_healthy <couleur> <tentatives> : /health dans le conteneur (pas de port hote par couleur)
  _i=1
  while [ "$_i" -le "$2" ]; do
    if docker exec "cplus-api-$1" wget -qO- -T 5 http://127.0.0.1:3000/health 2>/dev/null | grep -q '"status":"ok"'; then return 0; fi
    _i=$((_i + 1)); sleep 2
  done
  return 1
}
router_switch() { # router_switch <couleur> : bascule gracieuse (nginx -t puis reload, aucune connexion perdue)
  write_active "$1"
  docker exec cplus-api-router nginx -t >/dev/null 2>&1 || die "configuration du routeur API invalide (docker/api-router)"
  docker exec cplus-api-router nginx -s reload >/dev/null 2>&1 || die "rechargement du routeur API impossible"
  log "routeur API bascule vers api-$1"
}
# ─── Tranche web (quatre portails) : memes couleurs, un seul routeur ───
web_color_running() { # web_color_running <couleur> : au moins un portail de cette couleur tourne
  for _p in $WEB_PORTALS; do [ "$(docker inspect -f '{{.State.Running}}' "cplus-$_p-$1" 2>/dev/null)" = "true" ] && return 0; done
  return 1
}
web_active_color() {
  _c="$(sed -n 's/^set \$cpay_web_color \([a-z]*\);.*/\1/p' "$WEB_ACTIVE" 2>/dev/null | head -1)"
  if [ -n "$_c" ] && web_color_running "$_c"; then echo "$_c"; return 0; fi
  for _c in blue green; do if web_color_running "$_c"; then echo "$_c"; return 0; fi; done
  return 0
}
web_write_active() { mkdir -p "$(dirname "$WEB_ACTIVE")"; printf 'set $cpay_web_color %s;\n' "$1" > "$WEB_ACTIVE"; }
web_services() { for _p in $WEB_PORTALS; do printf '%s-%s ' "$_p" "$1"; done; }
# 127.0.0.1 et non localhost : dans l'image nginx, « localhost » se resout d'abord en ::1 et nginx n'ecoute qu'en IPv4
# (busybox wget n'essaie pas la seconde adresse) — premier deploiement des portails bleu/vert echoue pour cette raison.
web_healthy() { # web_healthy <couleur> <tentatives> : chaque portail sert index.html sur 8080
  for _p in $WEB_PORTALS; do
    _i=1
    while [ "$_i" -le "$2" ]; do
      if docker exec "cplus-$_p-$1" wget -qO- -T 5 http://127.0.0.1:8080/ 2>/dev/null | grep -q '<html'; then break; fi
      _i=$((_i + 1)); sleep 2
    done
    [ "$_i" -le "$2" ] || { WEB_KO="$_p"; return 1; }
  done
  return 0
}
web_router_switch() {
  web_write_active "$1"
  docker exec cplus-web-router nginx -t >/dev/null 2>&1 || die "configuration du routeur web invalide (docker/web-router)"
  docker exec cplus-web-router nginx -s reload >/dev/null 2>&1 || die "rechargement du routeur web impossible"
  log "routeur web bascule vers la couleur $1"
}

start_stack() { # demarre les nouvelles couleurs (API, portails), bascule, met a jour le reste, arrete les anciennes
  ACTIVE="$(active_color)"; LEGACY=false
  if [ -z "$ACTIVE" ] && docker inspect cplus-api >/dev/null 2>&1; then LEGACY=true; fi
  if [ -n "$ACTIVE" ]; then NEXT="$(other_color "$ACTIVE")"; else NEXT=blue; fi
  if [ -n "$ACTIVE" ] && color_running "$NEXT"; then
    warn "api-$NEXT tourne encore (deploiement precedent interrompu apres la bascule) : arret avant de repartir"
    compose stop -t 45 "api-$NEXT" >/dev/null 2>&1 || true; compose rm -f "api-$NEXT" >/dev/null 2>&1 || true
  fi
  log "API : couleur active ${ACTIVE:-aucune}$([ "$LEGACY" = true ] && echo ' (conteneur historique cplus-api)') -> demarrage de api-$NEXT ($CPLUS_TAG)"
  # Les deux couleurs peuvent cohabiter le temps de la bascule ; la couleur active n'est jamais listee dans un
  # « compose up » (elle ne serait pas recreee de toute facon, mais autant ne pas y toucher).
  CPAY_API_BLUE=0; CPAY_API_GREEN=0
  if [ "$NEXT" = blue ] || [ "$ACTIVE" = blue ]; then CPAY_API_BLUE=1; fi
  if [ "$NEXT" = green ] || [ "$ACTIVE" = green ]; then CPAY_API_GREEN=1; fi
  export CPAY_API_BLUE CPAY_API_GREEN
  # tranche web
  WEB_ACTIVE_COLOR="$(web_active_color)"; WEB_LEGACY=false
  if [ -z "$WEB_ACTIVE_COLOR" ] && docker inspect cplus-merchant-portal >/dev/null 2>&1; then WEB_LEGACY=true; fi
  if [ -n "$WEB_ACTIVE_COLOR" ]; then WEB_NEXT="$(other_color "$WEB_ACTIVE_COLOR")"; else WEB_NEXT=blue; fi
  if [ -n "$WEB_ACTIVE_COLOR" ] && web_color_running "$WEB_NEXT"; then
    warn "portails $WEB_NEXT encore en marche (deploiement precedent interrompu apres la bascule) : arret avant de repartir"
    # shellcheck disable=SC2046
    compose stop -t 10 $(web_services "$WEB_NEXT") >/dev/null 2>&1 || true; compose rm -f $(web_services "$WEB_NEXT") >/dev/null 2>&1 || true
  fi
  log "Portails : couleur active ${WEB_ACTIVE_COLOR:-aucune}$([ "$WEB_LEGACY" = true ] && echo ' (conteneurs historiques cplus-*-portal)') -> demarrage de la couleur $WEB_NEXT ($CPLUS_TAG)"
  CPAY_WEB_BLUE=0; CPAY_WEB_GREEN=0
  if [ "$WEB_NEXT" = blue ] || [ "$WEB_ACTIVE_COLOR" = blue ]; then CPAY_WEB_BLUE=1; fi
  if [ "$WEB_NEXT" = green ] || [ "$WEB_ACTIVE_COLOR" = green ]; then CPAY_WEB_GREEN=1; fi
  export CPAY_WEB_BLUE CPAY_WEB_GREEN
  compose up -d --no-deps "api-$NEXT" || die "demarrage de api-$NEXT impossible"
  # shellcheck disable=SC2046
  compose up -d --no-deps $(web_services "$WEB_NEXT") || die "demarrage des portails $WEB_NEXT impossible"
  if ! api_healthy "$NEXT" 45; then
    docker logs --tail 40 "cplus-api-$NEXT" 2>&1 | sed "s/^/  [api-$NEXT] /" | tee -a "$LOG_FILE" >&2 || true
    # shellcheck disable=SC2046
    compose stop -t 10 "api-$NEXT" $(web_services "$WEB_NEXT") >/dev/null 2>&1 || true; compose rm -f "api-$NEXT" $(web_services "$WEB_NEXT") >/dev/null 2>&1 || true
    die "api-$NEXT KO apres 90 s — l'API et les portails actifs (${ACTIVE:-historique}) n'ont pas ete touches ; rien a annuler"
  fi
  log "  api-$NEXT OK ($(docker exec "cplus-api-$NEXT" wget -qO- -T 5 http://127.0.0.1:3000/health 2>/dev/null | head -c 160))"
  WEB_KO=""
  if ! web_healthy "$WEB_NEXT" 20; then
    docker logs --tail 30 "cplus-$WEB_KO-$WEB_NEXT" 2>&1 | sed "s/^/  [$WEB_KO-$WEB_NEXT] /" | tee -a "$LOG_FILE" >&2 || true
    # shellcheck disable=SC2046
    compose stop -t 10 $(web_services "$WEB_NEXT") "api-$NEXT" >/dev/null 2>&1 || true; compose rm -f $(web_services "$WEB_NEXT") "api-$NEXT" >/dev/null 2>&1 || true
    die "portail $WEB_KO ($WEB_NEXT) KO apres 40 s — API et portails actifs intacts ; rien a annuler"
  fi
  log "  portails $WEB_NEXT OK ($WEB_PORTALS)"
  if [ "$LEGACY" = true ]; then
    log "Premiere bascule API : arret du conteneur historique cplus-api (il tient le port 3001 ; derniere coupure de quelques secondes)"
    docker stop -t 30 cplus-api >/dev/null 2>&1 || true
  fi
  if [ "$WEB_LEGACY" = true ]; then
    log "Premiere bascule des portails : arret des conteneurs historiques cplus-*-portal (ils tiennent 3002-3005 ; derniere coupure de quelques secondes)"
    for _p in $WEB_PORTALS; do docker stop -t 10 "cplus-$_p-portal" >/dev/null 2>&1 || true; done
  fi
  [ -s "$ROUTER_ACTIVE" ] || write_active "$NEXT"
  [ -n "$ACTIVE" ] || write_active "$NEXT"
  [ -s "$WEB_ACTIVE" ] || web_write_active "$WEB_NEXT"
  [ -n "$WEB_ACTIVE_COLOR" ] || web_write_active "$WEB_NEXT"
  OTHERS="$(compose config --services | grep -v '^api-blue$' | grep -v '^api-green$' | grep -v -- '-blue$' | grep -v -- '-green$' | tr '\n' ' ')"
  log "docker compose up -d --remove-orphans (routeurs, vitrine, cron)…"
  # shellcheck disable=SC2086
  compose up -d --remove-orphans $OTHERS || die "docker compose up en echec"
  if [ -n "$ACTIVE" ] && [ "$ACTIVE" != "$NEXT" ]; then router_switch "$NEXT"; fi
  if [ -n "$WEB_ACTIVE_COLOR" ] && [ "$WEB_ACTIVE_COLOR" != "$WEB_NEXT" ]; then web_router_switch "$WEB_NEXT"; fi
  wait_http http://127.0.0.1:3001/health 30 '"status":"ok"' || die "API KO derriere le routeur (127.0.0.1:3001/health) — ./scripts/deploy.sh --rollback"
  wait_http http://127.0.0.1:3002/ 15 '<html' || die "portails KO derriere le routeur web (127.0.0.1:3002) — ./scripts/deploy.sh --rollback"
  if [ -n "$ACTIVE" ] && [ "$ACTIVE" != "$NEXT" ]; then
    log "Drainage ${DRAIN_SECONDS}s puis arret gracieux de api-$ACTIVE (SIGTERM, requetes en cours terminees)…"
    sleep "$DRAIN_SECONDS"
    compose stop -t 45 "api-$ACTIVE" >/dev/null 2>&1 || warn "arret de api-$ACTIVE en echec (a verifier : docker ps)"
    compose rm -f "api-$ACTIVE" >/dev/null 2>&1 || true
  fi
  if [ -n "$WEB_ACTIVE_COLOR" ] && [ "$WEB_ACTIVE_COLOR" != "$WEB_NEXT" ]; then
    [ -n "$ACTIVE" ] && [ "$ACTIVE" != "$NEXT" ] || sleep "$DRAIN_SECONDS"
    log "Arret des portails $WEB_ACTIVE_COLOR…"
    # shellcheck disable=SC2046
    compose stop -t 10 $(web_services "$WEB_ACTIVE_COLOR") >/dev/null 2>&1 || warn "arret des portails $WEB_ACTIVE_COLOR en echec (docker ps)"
    compose rm -f $(web_services "$WEB_ACTIVE_COLOR") >/dev/null 2>&1 || true
  fi
  log "API servie par api-$NEXT ; portails servis par la couleur $WEB_NEXT"
}

CURRENT_SHA="$(git rev-parse HEAD)"
VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
# Lot 3 (audit 2026-11-02 infra P1-5) : une image par commit (VERSION-sha12). Deux deploiements successifs avec la
# meme VERSION n'ecrasent plus la meme etiquette : le rollback redemarre l'image precedente SANS rebuild.
tag_for() { echo "$VERSION-$(git rev-parse --short=12 "$1")"; }
export CPLUS_TAG="$(tag_for HEAD)"
compose_images() { compose config --images 2>/dev/null | grep '^cplus-' | sed 's/:.*//' | sort -u; }
images_present() { # images_present <tag> : toutes les images cplus-* du compose existent pour ce tag
  for img in $(compose_images); do
    docker image inspect "$img:$1" >/dev/null 2>&1 || return 1
  done
  return 0
}
# Reliquat 2026-11 : la CI publie sur GHCR les images de chaque commit de main (ci.yml, job docker). Les recuperer
# evite de reconstruire sur le VPS (memoire, duree) et garantit que l'image deployee est celle testee en CI.
# Paquets prives : « docker login ghcr.io » une fois sur le serveur avec un jeton read:packages (docs/EXPLOITATION.md § 4).
pull_images() { # pull_images <tag> : 0 si toutes les images ont ete recuperees et retiquetees localement
  [ "$PULL_IMAGES" = true ] || return 1
  for img in $(compose_images); do
    _remote="$GHCR_PREFIX/$img:$1"
    if docker pull -q "$_remote" >/dev/null 2>&1; then
      docker tag "$_remote" "$img:$1" || return 1
      log "image $img:$1 recuperee depuis GHCR"
    else
      warn "image $_remote indisponible (non publiee, ou docker login ghcr.io requis)"; return 1
    fi
  done
  return 0
}

# ─── Rollback : revenir au commit precedent ─────────────────────
if [ "$ROLLBACK" = true ]; then
  PREV="$(state_get previous)"
  [ -n "$PREV" ] || die "Pas de commit precedent dans $STATE_FILE — rollback impossible"
  log "ROLLBACK : $CURRENT_SHA -> $PREV"
  git -c advice.detachedHead=false checkout --detach "$PREV" || die "git checkout $PREV impossible"
  VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"; export CPLUS_TAG="$(tag_for HEAD)"
  if images_present "$CPLUS_TAG"; then
    log "Version restauree : $VERSION ($CPLUS_TAG) ; images presentes, redemarrage sans rebuild"
  else
    # ancien deploiement (etiquette = VERSION seule) ou images purgees : reconstruction
    if images_present "$VERSION"; then export CPLUS_TAG="$VERSION"; log "Images historiques $VERSION presentes, redemarrage sans rebuild"
    elif pull_images "$CPLUS_TAG"; then log "Images $CPLUS_TAG recuperees depuis GHCR, redemarrage sans rebuild"
    else log "Images $CPLUS_TAG absentes : reconstruction"; compose build; fi
  fi
  log "Les migrations ne sont pas annulees (schema compatible ascendant) ; restauration DB manuelle : scripts/restore-db.sh"
  start_stack   # meme bascule bleu/vert : le rollback ne coupe pas l'API non plus
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

# ─── 2. Images : GHCR d'abord, construction locale sinon (necessaires pour la verification d'env dans l'image) ───
if [ "$SKIP_BUILD" = false ] && images_present "$CPLUS_TAG"; then
  log "Images $CPLUS_TAG deja presentes localement : ni pull ni build"
elif [ "$SKIP_BUILD" = false ] && pull_images "$CPLUS_TAG"; then
  log "Images $CPLUS_TAG recuperees depuis GHCR (construites et testees par la CI) : pas de build sur le VPS"
elif [ "$SKIP_BUILD" = false ]; then
  log "docker compose build (CPLUS_TAG=$CPLUS_TAG) — un service a la fois pour menager la memoire du VPS…"
  BUILD_STATUS="$LOG_DIR/.build_status_$TIMESTAMP"
  for svc in $(compose config --services); do
    log "build $svc"
    # set +e dans le sous-shell : avec set -e, un echec de build sortait avant d'ecrire le statut
    ( set +e; compose build "$svc" 2>&1; echo "$?" > "$BUILD_STATUS" ) | tee -a "$LOG_FILE"
    _st="$(cat "$BUILD_STATUS" 2>/dev/null || echo 1)"; rm -f "$BUILD_STATUS"
    [ "$_st" = "0" ] || die "docker compose build $svc en echec (code $_st) — voir $LOG_FILE"
  done
  log "Images construites"
else
  warn "Build ignore (--skip-build)"
fi

# ─── 3. Verification de l'environnement production ──────────────
# Lot 0 (2026-11-13) : CA PostgreSQL de l'hote montee dans l'API (docker-compose.yml, x-api.volumes)
PG_CA_HOST="${CPAY_PG_CA_FILE:-/etc/cplus/postgres-ca.pem}"
if [ -s "$PG_CA_HOST" ]; then export CPAY_PG_CA_FILE="$PG_CA_HOST"; log "CA PostgreSQL : $PG_CA_HOST montee dans l'API"
else
  unset CPAY_PG_CA_FILE
  [ -n "$(read_env_value "$ROOT/backend/.env" DB_SSL_CA_FILE)" ] && warn "DB_SSL_CA_FILE est renseigne dans backend/.env mais $PG_CA_HOST est absent de l'hote : l'API verifiera le certificat avec le magasin systeme (docs/LOT-0-SECRETS.md § 4)"
fi
log "Verification de backend/.env (check-production-env.js)…"
compose run --rm --no-deps -T -e RUN_MIGRATIONS=false \
  -v "$ROOT/backend/scripts:/app/scripts:ro" api-blue node scripts/check-production-env.js \
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
  compose run --rm --no-deps -T -e RUN_MIGRATIONS=false api-blue node src/config/migrate.js || die "Migrations echouees"
else
  warn "Migrations ignorees (--skip-migrations)"
fi

# ─── 6. Demarrage : bascule bleu/vert de l'API, puis le reste ───
start_stack
state_write "$CURRENT_SHA" "$PREVIOUS_SHA"

# ─── 7. Health checks ───────────────────────────────────────────
log "Health check API via le routeur (127.0.0.1:3001/health)…"
if wait_http http://127.0.0.1:3001/health 15 '"status":"ok"'; then
  log "  API OK : $(curl -fsS --max-time 5 http://127.0.0.1:3001/health)"
else
  compose ps | tee -a "$LOG_FILE"
  die "API KO derriere le routeur — ./scripts/deploy.sh --rollback pour revenir a ${PREVIOUS_SHA:-<aucun>}"
fi
log "Health check vitrine (127.0.0.1:3006/)…"
wait_http http://127.0.0.1:3006/ 15 '<html' || die "Vitrine KO (127.0.0.1:3006)"
log "  vitrine OK"
PORTALS_KO=""
for portal in "merchant 3002" "cardholder 3003" "admin 3004" "partners 3005"; do
  set -- $portal
  if wait_http "http://127.0.0.1:$2/" 20 '<html'; then log "  portail $1 OK (:$2)"; else warn "  portail $1 injoignable (:$2)"; PORTALS_KO="$PORTALS_KO $1"; fi
done
if [ -n "$PORTALS_KO" ]; then
  compose ps 2>/dev/null | tee -a "$LOG_FILE" >&2 || true
  for p in $PORTALS_KO; do docker logs --tail 20 "cplus-$p-$(web_active_color)" 2>&1 | sed "s/^/  [$p] /" | tee -a "$LOG_FILE" >&2 || true; done
  die "Portail(s) KO :$PORTALS_KO — conteneur(s) en echec (voir journaux ci-dessus). ./scripts/deploy.sh --rollback pour revenir a ${PREVIOUS_SHA:-<aucun>}"
fi

log "Nettoyage des images obsoletes (les 3 derniers deploiements sont conserves pour le rollback)…"
KEEP_TAGS="$(tail -n 3 "$HISTORY_FILE" 2>/dev/null | awk '{print $2}' | while read -r sha; do [ -n "$sha" ] && echo "$VERSION-$(git rev-parse --short=12 "$sha" 2>/dev/null || echo "$sha")"; done | tr '\n' ' ')"
for ref in $(docker images --format '{{.Repository}}:{{.Tag}}' | grep '^cplus-' || true); do
  tag="${ref#*:}"
  case " $KEEP_TAGS $VERSION $CPLUS_TAG " in *" $tag "*) ;; *) docker image rm "$ref" >/dev/null 2>&1 || true ;; esac
done
docker image prune -f >/dev/null 2>&1 || true

compose ps | tee -a "$LOG_FILE"
log "Deploiement $VERSION termine (commit $CURRENT_SHA). Rollback : ./scripts/deploy.sh --rollback"
