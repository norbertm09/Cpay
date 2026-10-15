#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "== CPlus 2.6.0 preflight =="

if [ ! -f backend/.env ]; then
  echo "backend/.env manquant. Copiez backend/.env.example puis renseignez les secrets." >&2
  exit 1
fi

cd backend
npm install
npm run check:prod
npm test

echo "Preflight OK."
