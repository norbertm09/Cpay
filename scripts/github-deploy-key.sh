#!/usr/bin/env bash
# ============================================================================
# C-Pay — acces en LECTURE au depot GitHub depuis le serveur (lot 0 : passage du depot en prive)
#
# Une fois le depot prive, `git fetch` dans /opt/cplus (scripts/deploy-remote.sh) et `docker pull` depuis GHCR
# (scripts/deploy.sh) ont besoin d'une identite. Ce script prepare la partie git pour l'utilisateur qui lance les
# deploiements (root aujourd'hui, `deploy` apres setup-deploy-user.sh) ; il n'ecrit aucune cle privee ailleurs que
# dans ~/.ssh de cet utilisateur et n'affiche que la cle PUBLIQUE.
#
#   ./scripts/github-deploy-key.sh            # genere ~/.ssh/github_cpay (si absente), ~/.ssh/config, known_hosts ; affiche la cle publique
#   ./scripts/github-deploy-key.sh --switch   # idem + origin -> git@github.com:norbertm09/Cpay.git
#   ./scripts/github-deploy-key.sh --check    # git ls-remote origin (verifie l'acces apres declaration de la cle)
#
# Cote GitHub : depot > Settings > Deploy keys > Add deploy key, coller la cle publique, NE PAS cocher « Allow write ».
# GHCR (images) : soit garder les paquets publics (Packages > Package settings > Change visibility ; les images ne
# contiennent aucun secret), soit `docker login ghcr.io -u <compte> ` avec un jeton classique read:packages,
# avec le meme utilisateur que les deploiements (docs/EXPLOITATION.md § 4). Sans l'un ni l'autre, deploy.sh
# reconstruit les images sur le VPS : plus lent, mais rien ne casse.
# ============================================================================
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
REPO_SSH="${CPAY_REPO_SSH:-git@github.com:norbertm09/Cpay.git}"
KEY="$HOME/.ssh/github_cpay"
log()  { printf '[github-key] %s\n' "$*"; }
die()  { printf '[github-key] ERREUR %s\n' "$*" >&2; exit 1; }

case "${1:-}" in
  --check)
    log "origin = $(git -C "$ROOT" remote get-url origin)"
    if git -C "$ROOT" ls-remote --heads origin main >/dev/null 2>&1; then log "acces en lecture OK"; exit 0
    else die "acces refuse : la cle publique est-elle declaree dans Settings > Deploy keys ? (origin doit etre $REPO_SSH)"; fi ;;
  --switch|'') ;;
  -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
  *) die "option inconnue : $1" ;;
esac

install -d -m 700 "$HOME/.ssh"
if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -N "" -C "cpay-server-readonly@$(hostname)-$(id -un)" -f "$KEY" -q
  chmod 600 "$KEY"; log "cle generee : $KEY"
else
  log "cle existante : $KEY"
fi
if ! grep -qs "IdentityFile $KEY" "$HOME/.ssh/config" 2>/dev/null; then
  printf 'Host github.com\n  IdentityFile %s\n  IdentitiesOnly yes\n' "$KEY" >> "$HOME/.ssh/config"
  chmod 600 "$HOME/.ssh/config"; log "~/.ssh/config : entree github.com ajoutee"
fi
if ! grep -qs "^github.com ssh-ed25519" "$HOME/.ssh/known_hosts" 2>/dev/null; then
  ssh-keyscan -t ed25519 github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null || die "ssh-keyscan github.com impossible (reseau ?)"
  log "known_hosts : github.com ajoute"
fi
if [ "${1:-}" = "--switch" ]; then
  git -C "$ROOT" remote set-url origin "$REPO_SSH"; log "origin -> $REPO_SSH"
fi
log "Cle PUBLIQUE a declarer dans GitHub > Settings > Deploy keys (lecture seule) :"
cat "$KEY.pub"
log "Puis : ./scripts/github-deploy-key.sh --check"
