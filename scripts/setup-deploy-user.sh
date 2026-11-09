#!/usr/bin/env bash
# ============================================================================
# C-Pay — utilisateur de déploiement dédié (lot 3, audit 2026-11-02 infra P1-2)
#
#   sudo bash /opt/cplus/scripts/setup-deploy-user.sh --pubkey "ssh-ed25519 AAAA… cpay_deploy" [--remove-root-key]
#   sudo bash /opt/cplus/scripts/setup-deploy-user.sh --pubkey-file /root/cpay_deploy.pub
#
# Crée l'utilisateur `deploy` (groupe docker, sans sudo), lui confie /opt/cplus, /var/log/cplus et /var/backups/cpay,
# et autorise la clé GitHub Actions avec une COMMANDE FORCÉE : `restrict,command="/opt/cplus/scripts/deploy-remote.sh"`.
# La clé ne peut alors rien faire d'autre que lancer un déploiement d'une ref validée. --remove-root-key retire la
# même clé de /root/.ssh/authorized_keys. Ensuite : secret GitHub OVH_SSH_USER=deploy (environnements production et
# development). Les crons (/etc/cron.d/cpay) restent exécutés par root.
# ============================================================================
set -euo pipefail
APP="${CPAY_APP_DIR:-/opt/cplus}"
USER_NAME="${DEPLOY_USER:-deploy}"
PUBKEY=""; REMOVE_ROOT=false
while [ $# -gt 0 ]; do
  case "$1" in
    --pubkey) PUBKEY="$2"; shift 2 ;;
    --pubkey-file) PUBKEY="$(cat "$2")"; shift 2 ;;
    --remove-root-key) REMOVE_ROOT=true; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "option inconnue : $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "à lancer en root (sudo)" >&2; exit 1; }
[ -n "$PUBKEY" ] || { echo "--pubkey ou --pubkey-file requis (clé publique de déploiement GitHub Actions)" >&2; exit 2; }
PUBKEY="$(printf '%s' "$PUBKEY" | sed -E 's/^(restrict,|command=[^ ]+ )//; s/[[:space:]]+$//')"
[[ "$PUBKEY" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256)\ [A-Za-z0-9+/=]+( .*)?$ ]] || { echo "clé publique invalide" >&2; exit 2; }
KEY_ID="$(printf '%s' "$PUBKEY" | awk '{print $2}')"

getent group docker >/dev/null || groupadd docker
if ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$USER_NAME" --shell /bin/bash --groups docker "$USER_NAME"
  echo "utilisateur $USER_NAME créé"
else
  usermod -aG docker "$USER_NAME"; echo "utilisateur $USER_NAME existant (groupe docker vérifié)"
fi
passwd -l "$USER_NAME" >/dev/null 2>&1 || true   # jamais de connexion par mot de passe

# propriété des répertoires d'exploitation
for d in "$APP" /var/log/cplus /var/backups/cpay; do
  mkdir -p "$d"; chown -R "$USER_NAME:$USER_NAME" "$d"
done
chmod 700 /var/backups/cpay
[ -f "$APP/backend/.env" ] && chmod 600 "$APP/backend/.env"
git config --system --add safe.directory "$APP" >/dev/null 2>&1 || true
sudo -u "$USER_NAME" git -C "$APP" config --global --add safe.directory "$APP" >/dev/null 2>&1 || true
[ -x "$APP/scripts/deploy-remote.sh" ] || chmod +x "$APP/scripts/deploy-remote.sh"

# clé autorisée avec commande forcée
SSH_DIR="/home/$USER_NAME/.ssh"; AK="$SSH_DIR/authorized_keys"
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$SSH_DIR"
touch "$AK"; chown "$USER_NAME:$USER_NAME" "$AK"; chmod 600 "$AK"
LINE="restrict,command=\"$APP/scripts/deploy-remote.sh\" $PUBKEY"
if grep -qF "$KEY_ID" "$AK"; then
  grep -vF "$KEY_ID" "$AK" > "$AK.tmp" || true; echo "$LINE" >> "$AK.tmp"; install -m 600 -o "$USER_NAME" -g "$USER_NAME" "$AK.tmp" "$AK"; rm -f "$AK.tmp"
  echo "clé déjà présente : commande forcée (re)posée"
else
  echo "$LINE" >> "$AK"; echo "clé de déploiement autorisée avec commande forcée"
fi

if [ "$REMOVE_ROOT" = true ] && [ -f /root/.ssh/authorized_keys ] && grep -qF "$KEY_ID" /root/.ssh/authorized_keys; then
  cp -a /root/.ssh/authorized_keys "/root/.ssh/authorized_keys.bak.$(date +%Y%m%d-%H%M%S)"
  grep -vF "$KEY_ID" /root/.ssh/authorized_keys > /root/.ssh/authorized_keys.tmp || true
  install -m 600 /root/.ssh/authorized_keys.tmp /root/.ssh/authorized_keys; rm -f /root/.ssh/authorized_keys.tmp
  echo "clé de déploiement retirée de root (sauvegarde conservée)"
fi

cat <<MSG

Terminé. Côté GitHub : Settings → Environments → production (et development) → secret OVH_SSH_USER=$USER_NAME.
Test depuis votre poste (doit répondre « commande refusée », preuve que seule la commande forcée est possible) :
  ssh -i <clé privée> $USER_NAME@$(hostname -I | awk '{print $1}') "id"
MSG
