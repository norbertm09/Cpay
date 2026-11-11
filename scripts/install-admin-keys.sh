#!/usr/bin/env sh
# ================================================================
# C-Pay — installe les cles SSH publiques d'administration (ops/admin-keys/*.pub) dans ~/.ssh/authorized_keys
# de l'utilisateur courant. Appele par scripts/deploy.sh ; utilisable a la main :
#   ./scripts/install-admin-keys.sh            # ajoute les cles manquantes
#   ./scripts/install-admin-keys.sh --prune    # retire aussi les lignes dont le commentaire designe un .pub supprime
# Idempotent : comparaison sur le materiel de cle (2e champ), jamais de doublon, dossier 700 et fichier 600.
# Voir ops/admin-keys/README.md.
# ================================================================
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
KEYS_DIR="$ROOT/ops/admin-keys"
PRUNE=false; [ "${1:-}" = "--prune" ] && PRUNE=true
[ -d "$KEYS_DIR" ] || { echo "install-admin-keys: aucun dossier $KEYS_DIR"; exit 0; }
HOME_DIR="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"
SSH_DIR="$HOME_DIR/.ssh"; AUTH="$SSH_DIR/authorized_keys"
umask 077
mkdir -p "$SSH_DIR"; chmod 700 "$SSH_DIR"; touch "$AUTH"; chmod 600 "$AUTH"
KEY_RE='^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]+'
added=0; skipped=0
for f in "$KEYS_DIR"/*.pub; do
  [ -f "$f" ] || continue
  line="$(grep -E "$KEY_RE" "$f" | head -1 | tr -d '\r')"
  [ -n "$line" ] || { echo "install-admin-keys: $f ignore (format invalide)" >&2; continue; }
  material="$(printf '%s' "$line" | awk '{print $2}')"
  if grep -qF -- " $material" "$AUTH"; then skipped=$((skipped + 1)); continue; fi
  printf '%s\n' "$line" >> "$AUTH"; added=$((added + 1))
  echo "install-admin-keys: cle $(basename "$f" .pub) ajoutee pour $(id -un)"
done
if [ "$PRUNE" = true ]; then
  tmp="$AUTH.tmp.$$"; : > "$tmp"
  while IFS= read -r l; do
    c="$(printf '%s' "$l" | awk '{print $3}')"
    if [ -n "$c" ] && [ ! -f "$KEYS_DIR/$c.pub" ] && printf '%s' "$l" | grep -qE "$KEY_RE"; then
      echo "install-admin-keys: cle $c retiree (--prune)"; continue
    fi
    printf '%s\n' "$l" >> "$tmp"
  done < "$AUTH"
  mv "$tmp" "$AUTH"; chmod 600 "$AUTH"
fi
echo "install-admin-keys: $added ajoutee(s), $skipped deja presente(s) dans $AUTH"
