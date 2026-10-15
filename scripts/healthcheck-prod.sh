#!/usr/bin/env sh
set -eu

for url in \
  "https://api.c-pay.global/health" \
  "https://admin.c-pay.global" \
  "https://merchant.c-pay.global"; do
  printf "%s ... " "$url"
  curl -fsS "$url" >/dev/null
  echo "OK"
done
