#!/usr/bin/env bash
# Expiration des certificats TLS (lot 3, audit 2026-11-02 infra P1-4) — cron quotidien :
#   15 6 * * * root /opt/cplus/scripts/cert-expiry-metric.sh
# Publie cpay_cert_expiry_timestamp_seconds{cert="<nom>"} pour chaque certificat Let's Encrypt de l'hôte
# (/etc/letsencrypt/live/*/cert.pem) → alerte CertificateExpiringSoon (< 14 j) ; alerte immédiate sous 7 j.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/lib/alert.sh"
command -v openssl >/dev/null || exit 0
NOW=$(date +%s); SOON=""
for dir in /etc/letsencrypt/live/*/; do
  [ -f "$dir/cert.pem" ] || continue
  name="$(basename "$dir")"
  end="$(openssl x509 -enddate -noout -in "$dir/cert.pem" 2>/dev/null | cut -d= -f2)"
  [ -n "$end" ] || continue
  ts="$(date -d "$end" +%s 2>/dev/null || echo 0)"
  ops_metric cpay_cert_expiry_timestamp_seconds "$ts" "cert=\"$name\""
  days=$(( (ts - NOW) / 86400 ))
  printf '%-28s expire dans %3d j (%s)\n' "$name" "$days" "$end"
  [ "$days" -lt 7 ] && SOON="$SOON $name(${days}j)"
done
# état du renouvellement automatique
if systemctl is-enabled certbot.timer >/dev/null 2>&1; then ops_metric cpay_certbot_timer_enabled 1; else ops_metric cpay_certbot_timer_enabled 0; fi
[ -z "$SOON" ] || ops_alert CPayCertificateExpiring critical "Certificat(s) TLS expirant sous 7 jours :$SOON" "Vérifier certbot renew et systemctl status certbot.timer"
exit 0
