#!/usr/bin/env bash
# Health check HTTPS (cron 5 min) — domaine lu dans docker/.env (CPAY_DOMAIN), défaut c-pay.global
# Lot 3 (audit 2026-11-02 infra P1-4) : tous les vhosts sont testés (plus d'arrêt à la première erreur), le résultat
# est publié en métriques node-exporter (cpay_healthcheck_up{target}) et une alerte Alertmanager est poussée quand
# une cible échoue — plus de journal que personne ne lit.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/lib/alert.sh"
DOMAIN="${CPAY_DOMAIN:-}"
if [ -z "$DOMAIN" ] && [ -f "$ROOT/docker/.env" ]; then
  DOMAIN="$(sed -n 's/^CPAY_DOMAIN=//p' "$ROOT/docker/.env" | tr -d '[:space:]"'"'" | head -1)"
fi
DOMAIN="${DOMAIN:-c-pay.global}"
FAILED=""
check() { # check <nom> <url> [motif]
  local name="$1" url="$2" expect="${3:-}" body code
  body="$(curl -sS --max-time 15 -o /dev/stdout -w '\n%{http_code}' "$url" 2>/dev/null || true)"
  code="${body##*$'\n'}"; body="${body%$'\n'*}"
  if [ "$code" = "200" ] && { [ -z "$expect" ] || printf '%s' "$body" | grep -q "$expect"; }; then
    printf '%-10s %-45s OK\n' "$name" "$url"; ops_metric cpay_healthcheck_up 1 "target=\"$name\""
  else
    printf '%-10s %-45s KO (HTTP %s)\n' "$name" "$url" "${code:-?}"; ops_metric cpay_healthcheck_up 0 "target=\"$name\""; FAILED="$FAILED $name"
  fi
}
check api       "https://api.$DOMAIN/health" '"status":"ok"'
check landing   "https://$DOMAIN/"            '<html'
check admin     "https://admin.$DOMAIN/"      '<html'
check merchant  "https://merchant.$DOMAIN/"   '<html'
check app       "https://app.$DOMAIN/"        '<html'
check card      "https://card.$DOMAIN/"       '<html'
check pay       "https://pay.$DOMAIN/health"  '"status":"ok"'
ops_metric cpay_healthcheck_last_run_timestamp_seconds "$(date +%s)"
if [ -n "$FAILED" ]; then
  ops_alert CPayHealthcheckFailed critical "Health check KO :$FAILED" "Domaine $DOMAIN, $(date -u +%FT%TZ)"
  exit 1
fi
