#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/docker"

docker compose --profile certbot run --rm certbot renew --quiet
docker compose exec nginx nginx -s reload

echo "TLS renewed: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
