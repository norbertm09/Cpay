#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR/docker"

DOMAIN="${DOMAIN:-c-pay.global}"
EMAIL="${LETSENCRYPT_EMAIL:?LETSENCRYPT_EMAIL required}"
LIVE_DIR="certbot/conf/live/$DOMAIN"

mkdir -p "certbot/www" "$LIVE_DIR"

if [ ! -f "$LIVE_DIR/fullchain.pem" ] || [ ! -f "$LIVE_DIR/privkey.pem" ]; then
  echo "Creation d'un certificat temporaire auto-signe pour demarrer Nginx..."
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout "$LIVE_DIR/privkey.pem" \
    -out "$LIVE_DIR/fullchain.pem" \
    -subj "/CN=$DOMAIN"
fi

docker compose --env-file ../backend/.env up -d nginx

echo "Demande certificat Let's Encrypt pour $DOMAIN et ses sous-domaines..."
docker compose --env-file ../backend/.env run --rm certbot certonly \
  --webroot \
  --webroot-path /var/www/certbot \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  -d "$DOMAIN" \
  -d "api.$DOMAIN" \
  -d "admin.$DOMAIN" \
  -d "merchant.$DOMAIN" \
  -d "pay.$DOMAIN"

docker compose --env-file ../backend/.env exec nginx nginx -s reload
echo "TLS pret."
