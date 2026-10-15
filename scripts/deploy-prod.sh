#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f backend/.env ]; then
  echo "backend/.env manquant. Copiez backend/.env.example puis renseignez les secrets." >&2
  exit 1
fi

echo "Verification environnement production..."
cd backend
npm install
npm run check:prod
cd "$ROOT_DIR/docker"

echo "Build et demarrage Docker Compose..."
docker compose --env-file ../backend/.env up -d --build postgres api admin-portal merchant-portal nginx

echo "Etat des services:"
docker compose --env-file ../backend/.env ps

echo "Healthcheck API:"
curl -fsS https://api.c-pay.global/health || curl -fsS http://127.0.0.1/health
