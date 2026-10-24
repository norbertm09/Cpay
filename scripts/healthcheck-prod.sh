#!/usr/bin/env sh
# Health check HTTPS (cron 5 min) — domaine lu dans docker/.env (CPAY_DOMAIN), defaut c-pay.global
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
DOMAIN="${CPAY_DOMAIN:-}"
if [ -z "$DOMAIN" ] && [ -f "$ROOT/docker/.env" ]; then
  DOMAIN="$(sed -n 's/^CPAY_DOMAIN=//p' "$ROOT/docker/.env" | tr -d '[:space:]"' | head -1)"
fi
DOMAIN="${DOMAIN:-c-pay.global}"
for url in \
  "https://api.$DOMAIN/health" \
  "https://admin.$DOMAIN" \
  "https://merchant.$DOMAIN"; do
  printf "%s ... " "$url"
  curl -fsS "$url" >/dev/null
  echo "OK"
done
