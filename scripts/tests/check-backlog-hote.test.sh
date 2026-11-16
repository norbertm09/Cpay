#!/usr/bin/env bash
# Test de scripts/check-backlog-hote.sh sur une arborescence simulee (chemins surcharges, sans reseau) :
# etat « serveur d'aujourd'hui » (KO attendus) puis etat « backlog termine » (0 KO), sans secret dans la sortie.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
D="$(mktemp -d)"; trap 'rm -rf "$D"' EXIT
fail=0; ok() { echo "ok   $1"; }; ko() { echo "FAIL $1"; fail=1; }
run() { CPAY_SKIP_NET=true CPAY_ENV_FILE="$D/env" MONITORING_ENV_FILE="$D/monitoring.env" CPAY_NGINX_VHOST="$D/cpay" \
        CPAY_ALLOWLIST="$D/allowlist.conf" CPAY_BACKUP_DIR="$D/backups" CPAY_ROOT_AUTH_KEYS="$D/authorized_keys" \
        CPAY_PG_CA_FILE="$D/postgres-ca.pem" CPAY_DOCKER_CONFIG="$D/docker.json" bash "$ROOT/scripts/check-backlog-hote.sh" "$@"; }

# --- etat actuel : TLS non verifie, exporter sur DB_USER, cle root, pas de sauvegarde distante, allowlist inactive
printf 'DB_SSL=true\nDB_SSL_REJECT_UNAUTHORIZED=false\nWEBHOOK_PATH_SECRET=seg-ultra-secret\nWEBHOOK_PATH_SECRET_PREVIOUS=ancien-seg\nDB_PASSWORD=motdepasse-secret\n' > "$D/env"
printf 'ALERT_SMTP_HOST=x\n' > "$D/monitoring.env"
printf 'ssh-ed25519 AAAA cpay_deploy\n' > "$D/authorized_keys"
printf 'geo $cpay_webhook_denied {\n  default 0;\n}\n' > "$D/allowlist.conf"
mkdir -p "$D/backups"
set +e; run > "$D/out1" 2>&1; rc=$?; set -e
[ "$rc" -ne 0 ] && ok "etat actuel : code de sortie non nul" || ko "etat actuel : code 0"
grep -q "^KO    TLS PostgreSQL" "$D/out1" && ok "TLS non verifie detecte" || ko "TLS"
grep -q "^KO    Role PostgreSQL de l'exporter" "$D/out1" && ok "exporter sur DB_USER detecte" || ko "exporter"
grep -q "^AVERT Cle de deploiement sur root" "$D/out1" && ok "cle root detectee" || ko "cle root"
grep -q "^AVERT Rotation WEBHOOK_PATH_SECRET" "$D/out1" && ok "rotation en cours detectee" || ko "rotation"
grep -q "^KO    Sauvegarde hors serveur" "$D/out1" && ok "BACKUP_REMOTE absent detecte" || ko "backup remote"
grep -q "^KO    Derniere sauvegarde locale" "$D/out1" && ok "aucune sauvegarde detectee" || ko "backup local"
grep -q "^AVERT Allowlist" "$D/out1" && ok "allowlist inactive detectee" || ko "allowlist"
grep -q "^AVERT Assistant virtuel" "$D/out1" && ok "assistant desactive detecte" || ko "assistant"
grep -q "rotate-secrets.sh webhook-secret --clear-previous" "$D/out1" && ok "commande proposee" || ko "commande"
grep -q "seg-ultra-secret\|ancien-seg\|motdepasse-secret" "$D/out1" && ko "secret affiche" || ok "aucun secret affiche"

# --- backlog termine
printf 'DB_SSL=true\nDB_SSL_CA_FILE=%s\nWEBHOOK_PATH_SECRET=seg-ultra-secret\nANTHROPIC_API_KEY=sk-ant-x\nBACKUP_REMOTE=ovh-s3:cpay\n' "$D/postgres-ca.pem" > "$D/env"
printf -- '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n' > "$D/postgres-ca.pem"
printf 'ALERT_SMTP_HOST=x\nPG_EXPORTER_USER=cplus_monitor\n' > "$D/monitoring.env"
printf 'ssh-ed25519 AAAA autre\n' > "$D/authorized_keys"
printf 'geo $cpay_webhook_denied {\n  default 1;\n}\n' > "$D/allowlist.conf"
printf '{"auths":{"ghcr.io":{}}}\n' > "$D/docker.json"
: > "$D/backups/cplus_db-$(date +%Y%m%d).sql.gz.age"
cp "$ROOT/docker/nginx-host/cpay.conf.example" "$D/cpay"
set +e; run > "$D/out2" 2>&1; rc=$?; set -e
grep -q "^KO" "$D/out2" && { ko "backlog termine : KO restant"; grep "^KO" "$D/out2"; } || ok "backlog termine : aucun KO"
grep -q "^OK    TLS PostgreSQL" "$D/out2" && ok "TLS avec CA" || ko "TLS CA"
grep -q "^OK    Role PostgreSQL de l'exporter" "$D/out2" && ok "role exporter" || ko "role exporter"
grep -q "^OK    Vhost nginx hote" "$D/out2" && ok "vhost identique" || ko "vhost"
grep -q "^OK    Derniere sauvegarde locale" "$D/out2" && ok "sauvegarde recente" || ko "sauvegarde recente"
grep -q "^OK    Images GHCR" "$D/out2" && ok "login ghcr" || ko "ghcr"
grep -q "^OK    Assistant virtuel" "$D/out2" && ok "assistant actif" || ko "assistant actif"

[ "$fail" -eq 0 ] && echo "check-backlog-hote.sh : OK" || { echo "check-backlog-hote.sh : ECHEC"; exit 1; }
