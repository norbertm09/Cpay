#!/usr/bin/env bash
# ============================================================================
# C-Pay — etat du backlog serveur (lot 0, role exporter, durcissement, supervision, assistant), depuis l'hote.
#
#   ./scripts/check-backlog-hote.sh            # tableau OK / KO / AVERT / INFO + commande a lancer pour chaque point
#   ./scripts/check-backlog-hote.sh --db       # en plus : 2FA des administrateurs (via l'image API, lecture seule)
#   ./scripts/check-backlog-hote.sh --go-live  # en plus : scripts/check-go-live-cg.sh (Congo + assistant)
#
# Lecture seule, aucun secret affiche. Certains points exigent root (sshd, /root/.ssh) : sans, ils sont « non lisible ».
# Chemins surchargeables pour les tests : CPAY_ENV_FILE, MONITORING_ENV_FILE, CPAY_NGINX_VHOST, CPAY_ALLOWLIST,
# CPAY_BACKUP_DIR, CPAY_ROOT_AUTH_KEYS, CPAY_PG_CA_FILE, CPAY_DOCKER_CONFIG, CPAY_SKIP_NET=true (pas de reseau).
# ============================================================================
set -u
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
# shellcheck source=lib/env.sh
. "$ROOT/scripts/lib/env.sh"
ENV_FILE="${CPAY_ENV_FILE:-$ROOT/backend/.env}"
MON_ENV="${MONITORING_ENV_FILE:-/etc/cplus/monitoring.env}"
VHOST="${CPAY_NGINX_VHOST:-/etc/nginx/sites-available/cpay}"
ALLOWLIST="${CPAY_ALLOWLIST:-/etc/nginx/snippets/cpay-webhook-allowlist.conf}"
BACKUP_DIR="${CPAY_BACKUP_DIR:-/var/backups/cpay}"
ROOT_KEYS="${CPAY_ROOT_AUTH_KEYS:-/root/.ssh/authorized_keys}"
PG_CA="${CPAY_PG_CA_FILE:-/etc/cplus/postgres-ca.pem}"
DOCKER_CFG="${CPAY_DOCKER_CONFIG:-$HOME/.docker/config.json}"
WITH_DB=false; WITH_GOLIVE=false
for a in "$@"; do case "$a" in --db) WITH_DB=true ;; --go-live) WITH_GOLIVE=true ;; -h|--help) sed -n '2,12p' "$0"; exit 0 ;; *) echo "option inconnue : $a" >&2; exit 2 ;; esac; done

KO=0; WARN=0
row() { # row <niveau> <libelle> <detail> [commande]
  local lvl="$1" label="$2" detail="$3" cmd="${4:-}"
  case "$lvl" in KO) KO=$((KO+1)) ;; AVERT) WARN=$((WARN+1)) ;; esac
  printf '%-5s %-46s %s\n' "$lvl" "$label" "$detail"
  if [ -n "$cmd" ]; then printf '      -> %s\n' "$cmd"; fi
  return 0
}
v() { read_env_var "$ENV_FILE" "$1"; }
readable() { [ -r "$1" ]; }

echo "Backlog serveur C-Pay — etat au $(date +%Y-%m-%d) sur $(hostname) ($(id -un))"; echo

# ── Lot 0 ──
if readable "$ENV_FILE"; then
  if [ "$(v DB_SSL_REJECT_UNAUTHORIZED | tr '[:upper:]' '[:lower:]')" = "false" ]; then
    row KO "TLS PostgreSQL" "DB_SSL_REJECT_UNAUTHORIZED=false : certificat non verifie" "LOT-0 § 4 : deposer $PG_CA, DB_SSL_CA_FILE=$PG_CA, retirer la variable, ./scripts/deploy.sh --skip-backup --skip-migrations"
  elif [ -s "$PG_CA" ] && [ "$(v DB_SSL_CA_FILE)" = "$PG_CA" ]; then row OK "TLS PostgreSQL" "CA OVH deposee et referencee ($PG_CA)"
  elif [ "$(v DB_SSL)" = "true" ]; then row AVERT "TLS PostgreSQL" "verifie avec le magasin systeme ; CA OVH absente ($PG_CA)" "LOT-0 § 4 (controle strict avec la CA de l'instance)"
  else row KO "TLS PostgreSQL" "DB_SSL absent ou false" "LOT-0 § 4"; fi
  for p in WEBHOOK_PATH_SECRET MTN_WEBHOOK_TOKEN; do
    if [ -n "$(v ${p}_PREVIOUS)" ]; then row AVERT "Rotation $p" "ancienne valeur encore acceptee (${p}_PREVIOUS)" "./scripts/rotate-secrets.sh $([ "$p" = WEBHOOK_PATH_SECRET ] && echo webhook-secret || echo mtn-token) --clear-previous (apres 24 h)"; fi
  done
  [ -n "$(v WEBHOOK_PATH_SECRET)" ] && row OK "WEBHOOK_PATH_SECRET" "renseigne (rotation : ./scripts/rotate-secrets.sh webhook-secret)" || row KO "WEBHOOK_PATH_SECRET" "absent" "./scripts/rotate-secrets.sh webhook-secret"
  row INFO "Mot de passe cplus_user" "rotation non verifiable d'ici ; backend/.env modifie le $(date -r "$ENV_FILE" +%Y-%m-%d 2>/dev/null || echo ?) (fuite du 2026-10-15)" "LOT-0 § 1 : OVH puis ./scripts/rotate-secrets.sh db-password"
  if [ -n "$(v ANTHROPIC_API_KEY)" ]; then row OK "Assistant virtuel" "ANTHROPIC_API_KEY renseignee"; else row AVERT "Assistant virtuel" "desactive (ANTHROPIC_API_KEY absente)" "./scripts/rotate-secrets.sh set ANTHROPIC_API_KEY puis ./scripts/deploy.sh --skip-backup --skip-migrations (ASSISTANT-API § 5)"; fi
else
  row INFO "backend/.env" "non lisible par $(id -un) : points TLS, rotations, assistant non evalues" "relancer avec sudo"
fi
origin="$(git -C "$ROOT" remote get-url origin 2>/dev/null || echo ?)"
case "$origin" in
  git@github.com:*|ssh://*) row OK "Acces git du serveur" "origin en SSH ($origin)" ;;
  *) row AVERT "Acces git du serveur" "origin en HTTPS ($origin) : cassera des que le depot sera prive" "./scripts/github-deploy-key.sh --switch puis declarer la cle (Settings > Deploy keys), --check" ;;
esac
if [ "${CPAY_SKIP_NET:-false}" != "true" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://github.com/norbertm09/Cpay 2>/dev/null || echo 000)"
  case "$code" in
    200) row KO "Visibilite du depot GitHub" "PUBLIC (historique avec secret lisible)" "GitHub > Settings > General > Change repository visibility > Private (apres l'acces git SSH)" ;;
    404) row OK "Visibilite du depot GitHub" "prive (404 anonyme)" ;;
    *) row INFO "Visibilite du depot GitHub" "non determinee (HTTP $code)" ;;
  esac
fi
if [ -r "$DOCKER_CFG" ] && grep -q '"ghcr.io"' "$DOCKER_CFG" 2>/dev/null; then row OK "Images GHCR" "docker login ghcr.io present pour $(id -un)"
else row INFO "Images GHCR" "aucun login ghcr.io pour $(id -un) : images reconstruites sur le VPS si les paquets deviennent prives" "docker login ghcr.io -u <compte> (jeton read:packages) ou paquets publics"; fi

echo
# ── Supervision ──
if readable "$MON_ENV"; then
  if [ -n "$(read_env_var "$MON_ENV" PG_EXPORTER_USER)" ]; then row OK "Role PostgreSQL de l'exporter" "$(read_env_var "$MON_ENV" PG_EXPORTER_USER) (lecture seule)"
  else row KO "Role PostgreSQL de l'exporter" "l'exporter utilise DB_USER (role applicatif)" "sudo bash scripts/create-monitoring-role.sh && sudo bash scripts/setup-monitoring.sh"; fi
else row INFO "Role PostgreSQL de l'exporter" "$MON_ENV non lisible par $(id -un)" "relancer avec sudo"; fi
if [ "${CPAY_SKIP_NET:-false}" != "true" ]; then
  for svc in "Prometheus|http://127.0.0.1:9090/-/ready" "Alertmanager|http://127.0.0.1:9093/-/ready" "Grafana|http://127.0.0.1:3007/api/health"; do
    n="${svc%%|*}"; u="${svc#*|}"
    if curl -fsS --max-time 5 "$u" >/dev/null 2>&1; then row OK "$n" "pret (${u#http://})"; else row KO "$n" "ne repond pas (${u#http://})" "sudo bash scripts/setup-monitoring.sh ; docker ps | grep cplus-"; fi
  done
fi
row INFO "Alerte de test par e-mail" "reception sur la boite ALERT_SMTP_TO a confirmer a la main" "sudo bash scripts/setup-monitoring.sh --test"

echo
# ── Hote ──
if readable "$ROOT_KEYS"; then
  if grep -q "cpay_deploy" "$ROOT_KEYS" 2>/dev/null; then row AVERT "Cle de deploiement sur root" "encore dans $ROOT_KEYS" "sudo bash scripts/setup-deploy-user.sh --pubkey-file <cle> --remove-root-key ; secret GitHub OVH_SSH_USER=deploy"
  else row OK "Cle de deploiement sur root" "absente de $ROOT_KEYS"; fi
else row INFO "Cle de deploiement sur root" "$ROOT_KEYS non lisible" "relancer avec sudo"; fi
if id deploy >/dev/null 2>&1; then row OK "Utilisateur deploy" "present"; else row AVERT "Utilisateur deploy" "absent : deploiements en root" "sudo bash scripts/setup-deploy-user.sh --pubkey-file <cle>"; fi
if command -v sshd >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then
  prl="$(sshd -T 2>/dev/null | awk '$1=="permitrootlogin"{print $2}')"
  case "$prl" in
    no) row OK "PermitRootLogin" "no" ;;
    prohibit-password) row AVERT "PermitRootLogin" "prohibit-password (root par cle encore possible)" "apres bascule sur deploy : sudo bash scripts/harden-host.sh --permit-root-login no" ;;
    '') row INFO "PermitRootLogin" "non determine" ;;
    *) row KO "PermitRootLogin" "$prl" "sudo bash scripts/harden-host.sh --permit-root-login no" ;;
  esac
else row INFO "PermitRootLogin" "sshd -T exige root" "relancer avec sudo"; fi
if readable "$ENV_FILE" || [ -r "$ROOT/monitoring/backup.env" ]; then
  remote="$(v BACKUP_REMOTE)"; [ -z "$remote" ] && [ -r "$ROOT/monitoring/backup.env" ] && remote="$(read_env_var "$ROOT/monitoring/backup.env" BACKUP_REMOTE)"
  if [ -n "$remote" ]; then row OK "Sauvegarde hors serveur" "BACKUP_REMOTE=$remote"; else row KO "Sauvegarde hors serveur" "BACKUP_REMOTE absent (copie distante exigee en production)" "EXPLOITATION § 2 : rclone config puis BACKUP_REMOTE=<remote:bucket> dans backend/.env"; fi
fi
if [ -d "$BACKUP_DIR" ]; then
  last="$(ls -t "$BACKUP_DIR"/*.sql.gz* 2>/dev/null | grep -v '\.sha256$' | head -1)"
  if [ -n "$last" ]; then
    age=$(( ( $(date +%s) - $(stat -c %Y "$last") ) / 3600 ))
    if [ "$age" -le 26 ]; then row OK "Derniere sauvegarde locale" "$(basename "$last"), il y a ${age} h"; else row KO "Derniere sauvegarde locale" "$(basename "$last"), il y a ${age} h (> 26 h)" "./scripts/backup-db.sh ; verifier /etc/cron.d/cpay"; fi
  else row KO "Derniere sauvegarde locale" "aucun fichier dans $BACKUP_DIR" "./scripts/backup-db.sh"; fi
fi
if readable "$VHOST"; then
  if diff -q "$VHOST" "$ROOT/docker/nginx-host/cpay.conf.example" >/dev/null 2>&1; then row OK "Vhost nginx hote" "identique a docker/nginx-host/cpay.conf.example"
  else row AVERT "Vhost nginx hote" "differe de l'exemple versionne ($(diff "$VHOST" "$ROOT/docker/nginx-host/cpay.conf.example" 2>/dev/null | grep -c '^[<>]') lignes)" "diff $VHOST docker/nginx-host/cpay.conf.example ; reporter les ecarts voulus dans le depot"; fi
else row INFO "Vhost nginx hote" "$VHOST non lisible ou absent"; fi
if readable "$ALLOWLIST"; then
  if grep -qE '^\s*default\s+1\s*;' "$ALLOWLIST"; then row OK "Allowlist des callbacks operateurs" "active (default 1)"
  else row AVERT "Allowlist des callbacks operateurs" "inactive (default 0) : en attente des plages MTN / Airtel" "GO-LIVE § 3.1 : inscrire les plages, default 1, nginx -t && systemctl reload nginx"; fi
fi

if [ "$WITH_DB" = true ]; then
  echo
  cpay_export_deployed_tag "$ROOT"
  out="$(cd "$ROOT/docker" && docker compose run --rm --no-deps --no-build -T -e RUN_MIGRATIONS=false api-blue node -e "
    const { query, pool } = require('./src/config/database');
    query(\"SELECT email, role, mfa_enabled FROM admin_users WHERE is_active = TRUE ORDER BY role, email\").then(r => {
      for (const a of r.rows) console.log((a.mfa_enabled ? 'OK   ' : 'AVERT') + ' 2FA admin ' + a.email + ' (' + a.role + ') : ' + (a.mfa_enabled ? 'activee' : 'NON activee -> Mon compte > Securite > Activer la double authentification'));
    }).catch(e => console.log('INFO  2FA admin : lecture impossible (' + e.message + ')')).finally(() => pool.end());
  " 2>/dev/null)"
  printf '%s\n' "$out" | sed 's/^AVERT/AVERT/'; WARN=$((WARN + $(printf '%s\n' "$out" | grep -c '^AVERT')))
fi
if [ "$WITH_GOLIVE" = true ]; then echo; "$ROOT/scripts/check-go-live-cg.sh" --no-fail || true; fi

echo
row INFO "Hors serveur" "GitHub : regle de tag v* sur l'environnement Production ; jeton personnel a revoquer ; Google Play : release 2.7.2 ; textes legaux ; EAS iOS" ""
echo "$KO KO, $WARN avertissement(s)."
[ "$KO" -eq 0 ]
