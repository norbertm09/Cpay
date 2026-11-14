#!/usr/bin/env bash
# ============================================================================
# C-Pay — go / no-go du lancement Congo-Brazzaville et de l'assistant virtuel, depuis l'hôte de production.
#
#   ./scripts/check-go-live-cg.sh [--json] [--no-db] [--no-fail]
#
# Lance backend/scripts/check-go-live-cg.js dans l'image API (meme mecanisme que la verification d'environnement de
# deploy.sh : backend/.env de l'hote, scripts/ monte en lecture seule, CA PostgreSQL montee si presente), puis
# complete avec les controles qui ne se voient que depuis l'hote : allowlist nginx des callbacks, couleur active.
# N'affiche aucun secret. Code de sortie 1 s'il reste un KO (sauf --no-fail).
# ============================================================================
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT/docker"
PG_CA="${CPAY_PG_CA_FILE:-/etc/cplus/postgres-ca.pem}"; [ -s "$PG_CA" ] && export CPAY_PG_CA_FILE="$PG_CA" || unset CPAY_PG_CA_FILE
docker compose run --rm --no-deps -T -e RUN_MIGRATIONS=false \
  -v "$ROOT/backend/scripts:/app/scripts:ro" api-blue node scripts/check-go-live-cg.js "$@"
rc=$?
AL=/etc/nginx/snippets/cpay-webhook-allowlist.conf
if [ -r "$AL" ]; then
  if grep -qE '^\s*default\s+1\s*;' "$AL"; then echo "OK    Allowlist nginx des callbacks : active (default 1)"
  else echo "AVERT Allowlist nginx des callbacks : inactive (default 0) — activer des reception des plages MTN / Airtel (GO-LIVE § 3.1)"; fi
fi
[ -f "$ROOT/docker/api-router/active/active.conf" ] && echo "INFO  API servie par $(sed -n 's/.*api-\([a-z]*\);.*/\1/p' "$ROOT/docker/api-router/active/active.conf")"
exit $rc
