#!/usr/bin/env bash
# ================================================================
# C-Pay — transforme l'ancien serveur de production en serveur de DEVELOPPEMENT (a lancer en root)
#
#   bash scripts/setup-dev-server.sh [--domain dev.c-pay.global] [--email admin@c-pay.global]
#                                    [--from /etc/nginx/sites-available/cpay] [--disable-prod-vhost]
#
# Etapes (relancables) :
#   1. vhost HTTP minimal pour les noms de dev (ACME + redirection) puis certificat Let's Encrypt
#      (webroot /var/www/html) pour <domaine>, www., api., admin., merchant., app., card., pay.
#   2. vhost HTTPS de dev DERIVE du vhost de production (--from) : memes blocs, memes en-tetes, memes
#      ports de conteneurs, noms et certificats remplaces (c-pay.global -> <domaine>)
#   3. docker/.env : CPAY_API_BASE_URL=https://api.<domaine>, CPAY_DOMAIN=<domaine>
#      (les portails sont recompiles avec cette URL au prochain ./scripts/deploy.sh)
#   4. rappel des cles de backend/.env a modifier a la main (base de donnees de dev, origines, URLs)
# Pre-requis : enregistrements DNS A de <domaine> et de ses 7 sous-domaines vers CE serveur.
# ================================================================
set -euo pipefail
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[DEV]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
die()  { echo -e "${RED}[FAIL]${NC} $*" >&2; exit 1; }
[ "$(id -u)" = "0" ] || die "a lancer en root"

DOMAIN="dev.c-pay.global"; EMAIL="admin@c-pay.global"; FROM="/etc/nginx/sites-available/cpay"; DISABLE_PROD=false
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    --disable-prod-vhost) DISABLE_PROD=true; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) die "option inconnue : $1" ;;
  esac
done
APP="${CPAY_ROOT:-/opt/cplus}"
PROD_DOMAIN="c-pay.global"
SUBS="www api admin merchant app card pay"
NAMES="$DOMAIN"; for s in $SUBS; do NAMES="$NAMES $s.$DOMAIN"; done
VHOST="/etc/nginx/sites-available/cpay-dev"
[ -f "$FROM" ] || die "vhost de production introuvable : $FROM (option --from)"
command -v certbot >/dev/null || die "certbot absent (apt-get install -y certbot)"

log "Serveur de developpement C-Pay — domaine $DOMAIN"
log "Noms : $NAMES"

# ─── 0. DNS : chaque nom doit viser ce serveur ───────────────────
MYIP="$(curl -4 -fsS --max-time 5 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
for n in $NAMES; do
  r="$(getent ahostsv4 "$n" 2>/dev/null | awk '{print $1}' | head -1 || true)"
  if [ "$r" != "$MYIP" ]; then warn "DNS : $n -> ${r:-aucune reponse} (attendu $MYIP)"; DNS_KO=1; fi
done
[ "${DNS_KO:-0}" = 1 ] && die "corriger la zone DNS (enregistrements A vers $MYIP) puis relancer"

# ─── 1. Certificat ──────────────────────────────────────────────
mkdir -p /var/www/html
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  log "Vhost HTTP provisoire pour la validation ACME…"
  cat > "$VHOST" <<NGX
server {
    listen 80;
    listen [::]:80;
    server_name $NAMES;
    location ^~ /.well-known/acme-challenge/ { root /var/www/html; default_type "text/plain"; }
    location / { return 301 https://\$host\$request_uri; }
}
NGX
  ln -sfn "$VHOST" /etc/nginx/sites-enabled/cpay-dev
  nginx -t && systemctl reload nginx
  D_ARGS=""; for n in $NAMES; do D_ARGS="$D_ARGS -d $n"; done
  log "certbot certonly (webroot) pour $DOMAIN et 7 sous-domaines…"
  # shellcheck disable=SC2086
  certbot certonly --webroot -w /var/www/html --cert-name "$DOMAIN" $D_ARGS \
    --email "$EMAIL" --agree-tos --no-eff-email --non-interactive || die "certbot a echoue (DNS ? port 80 ?)"
else
  log "Certificat $DOMAIN deja present"
fi

# ─── 2. Vhost HTTPS derive de la production ─────────────────────
log "Vhost de dev derive de $FROM…"
cp -a "$FROM" "/root/nginx-backups/prod-vhost-$(date +%Y%m%d_%H%M%S).conf" 2>/dev/null || true
sed -e "s/$(printf '%s' "$PROD_DOMAIN" | sed 's/\./\\./g')/$DOMAIN/g" \
    -e "s#/etc/letsencrypt/live/$DOMAIN-[0-9]*/#/etc/letsencrypt/live/$DOMAIN/#g" \
    -e "s#/etc/letsencrypt/live/$DOMAIN/#/etc/letsencrypt/live/$DOMAIN/#g" \
    "$FROM" > "$VHOST"
# Les deux vhosts (prod et dev) partagent le meme serveur : un seul doit porter les zones/maps globales.
# Les directives "limit_req_zone", "map" ou "log_format" au niveau http sont dans nginx.conf/conf.d, pas ici.
if grep -qE '^\s*(limit_req_zone|map|log_format)\b' "$VHOST"; then
  warn "directives de niveau http detectees dans le vhost : elles seraient dupliquees. Elles sont commentees dans cpay-dev."
  sed -i -E 's/^(\s*)(limit_req_zone|map|log_format)\b/\1# [dev] \2/' "$VHOST"
fi
ln -sfn "$VHOST" /etc/nginx/sites-enabled/cpay-dev
if [ "$DISABLE_PROD" = true ]; then
  rm -f /etc/nginx/sites-enabled/cpay; log "vhost de production desactive sur ce serveur (sites-enabled/cpay retire)"
fi
if nginx -t; then systemctl reload nginx; log "nginx recharge"
else die "nginx -t en echec : corriger $VHOST (le vhost de prod est intact dans $FROM)"; fi

# ─── 3. docker/.env ─────────────────────────────────────────────
cat > "$APP/docker/.env" <<ENV
# genere par scripts/setup-dev-server.sh — serveur de developpement
CPAY_API_BASE_URL=https://api.$DOMAIN
CPAY_DOMAIN=$DOMAIN
ENV
log "docker/.env ecrit (CPAY_API_BASE_URL=https://api.$DOMAIN) — les portails seront recompiles au prochain deploy.sh"

# ─── 4. backend/.env : rappels ──────────────────────────────────
ORIGINS="https://$DOMAIN,https://www.$DOMAIN,https://admin.$DOMAIN,https://merchant.$DOMAIN,https://card.$DOMAIN,https://app.$DOMAIN,http://localhost:3001,http://localhost:3002"
log "═══════════════════════════════════════════════"
log "A modifier A LA MAIN dans $APP/backend/.env (nano), puis cd $APP && ./scripts/deploy.sh :"
log "  DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD  → base de DEVELOPPEMENT (jamais la base de production)"
log "  ALLOWED_ORIGINS=$ORIGINS"
log "  PAY_LINK_BASE_URL=https://pay.$DOMAIN"
log "  MTN_CG_CALLBACK_URL=https://api.$DOMAIN/api/v1/momo/webhooks/mtn"
log "  MTN_ENV=sandbox   AIRTEL_CG_ENV=sandbox   CAPABILITY_ENFORCE=report"
log "  (URLs de webhook declarees chez les operateurs en sandbox : https://api.$DOMAIN/api/v1/webhooks/<secret>/<operateur>)"
log "Verification : curl -sS https://api.$DOMAIN/health  et  https://$DOMAIN/"
log "═══════════════════════════════════════════════"
