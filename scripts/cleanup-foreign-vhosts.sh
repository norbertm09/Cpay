#!/usr/bin/env bash
# ================================================================
# C-Pay — retire d'un serveur les vhosts nginx et certificats d'AUTRES projets importes par erreur
# (ex. : export complet d'un ancien serveur mutualise). A lancer en root. Ne supprime aucun fichier nginx
# (deplacement vers /root/nginx-backups/autres-projets), retour arriere automatique si nginx -t echoue.
#
#   bash scripts/cleanup-foreign-vhosts.sh [--pattern 'toonah|lincpay'] [--dry-run]
#
# Garde-fous (lecon de la migration du 2026-10-23) :
#   - les certificats utilises sont detectes en SUIVANT les liens symboliques de sites-enabled (grep -R) ;
#   - un certificat dont le nom contient le domaine C-Pay (c-pay) n'est JAMAIS supprime ;
#   - si aucun certificat utilise n'est detecte, le script s'arrete au lieu de tout supprimer.
# ================================================================
set -euo pipefail
[ "$(id -u)" = "0" ] || { echo "a lancer en root" >&2; exit 1; }
PATTERN='toonah|lincpay'; DRY=false; KEEP_DOMAIN="${CPAY_DOMAIN:-c-pay}"
while [ $# -gt 0 ]; do
  case "$1" in
    --pattern) PATTERN="$2"; shift 2 ;;
    --dry-run) DRY=true; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "option inconnue : $1" >&2; exit 2 ;;
  esac
done
run() { if [ "$DRY" = true ]; then echo "  [dry-run] $*"; else "$@"; fi; }

DEST=/root/nginx-backups/autres-projets; mkdir -p "$DEST"
SNAP="/root/nginx-backups/avant-nettoyage-$(date +%Y%m%d_%H%M%S).tgz"
tar -C / -czf "$SNAP" etc/nginx etc/letsencrypt 2>/dev/null && echo "Instantane nginx + letsencrypt : $SNAP"

echo "== Fichiers nginx etrangers (motif : $PATTERN) =="
for f in /etc/nginx/conf.d/* /etc/nginx/sites-available/*; do
  [ -f "$f" ] || continue
  b="$(basename "$f")"
  case "$b" in cpay|cpay.conf|00-cpay-hardening.conf) continue ;; esac
  if grep -qiE "$PATTERN" "$f" || [[ "$b" == *.bak* ]] || [ "$b" = default ]; then
    [ -L "/etc/nginx/sites-enabled/$b" ] && run rm -f "/etc/nginx/sites-enabled/$b"
    run mv "$f" "$DEST/"; echo "  -> $f"
  fi
done
run rm -f /etc/nginx/sites-enabled/default

if [ "$DRY" = false ]; then
  if nginx -t 2>/dev/null; then systemctl reload nginx; echo "nginx -t OK, recharge"
  else echo "nginx -t EN ECHEC : retour arriere"; nginx -t 2>&1 | tail -5; tar -C / -xzf "$SNAP" etc/nginx; systemctl reload nginx; exit 1; fi
fi

echo "== Certificats =="
# -R (et non -r) : sites-enabled ne contient que des liens symboliques
USED="$(grep -RhoE '/etc/letsencrypt/live/[^/]+' /etc/nginx/nginx.conf /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null | sort -u || true)"
if [ -z "$USED" ]; then
  echo "  AUCUN certificat reference par nginx : aucune suppression (verifier la configuration)"; exit 0
fi
echo "  references par nginx :"; echo "$USED" | sed 's#.*/#    #'
for d in /etc/letsencrypt/live/*/; do
  n="$(basename "$d")"; [ "$n" = README ] && continue
  if grep -qx "/etc/letsencrypt/live/$n" <<<"$USED" || [[ "$n" == *"$KEEP_DOMAIN"* ]]; then
    echo "  conserve : $n"
  elif grep -qiE "$PATTERN" <<<"$n"; then
    echo "  supprime du renouvellement : $n"
    run certbot delete --cert-name "$n" --non-interactive >/dev/null 2>&1 || echo "    (certbot delete a echoue pour $n)"
  else
    echo "  non reference, hors motif : conserve par prudence : $n"
  fi
done

echo "== Reste =="
ls /etc/nginx/sites-available/ /etc/nginx/conf.d/
certbot certificates 2>/dev/null | grep -E 'Certificate Name|Domains|Expiry Date' | sed 's/^ */  /'
