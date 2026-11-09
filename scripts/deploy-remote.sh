#!/usr/bin/env bash
# ============================================================================
# C-Pay — point d'entrée SSH du déploiement GitHub Actions (lot 3, audit 2026-11-02 infra P1-2 / P1-6)
#
# Installé comme COMMANDE FORCÉE de la clé de déploiement de l'utilisateur `deploy` :
#   restrict,command="/opt/cplus/scripts/deploy-remote.sh" ssh-ed25519 AAAA… cpay_deploy
# (scripts/setup-deploy-user.sh). Le runner envoie `REF='<ref>' DEPLOY_ARGS='<args>'` comme commande SSH : elle
# n'est JAMAIS exécutée, seulement lue dans SSH_ORIGINAL_COMMAND et validée (liste blanche) avant :
#   1. git fetch --all --tags --prune --force ; checkout --detach de la ref (branche → origin/<branche>) ;
#   2. si le commit est déjà déployé (.deployed) et que --force n'est pas demandé : sortie 0 sans rien faire
#      (évite le double déploiement main + tag) ;
#   3. ./scripts/deploy.sh <args>.
# Fonctionne aussi sans commande forcée (root historique) : REF / DEPLOY_ARGS lus dans l'environnement.
# ============================================================================
set -euo pipefail
APP="${CPAY_APP_DIR:-/opt/cplus}"
cd "$APP"

cmd="${SSH_ORIGINAL_COMMAND:-}"
if [ -n "$cmd" ]; then
  # Forme attendue : REF='…' DEPLOY_ARGS='…'  (tout autre contenu est refusé)
  if [[ "$cmd" =~ ^REF=\'([A-Za-z0-9._/-]{1,120})\'[[:space:]]+DEPLOY_ARGS=\'([A-Za-z0-9 ._-]{0,200})\'[[:space:]]*$ ]]; then
    REF="${BASH_REMATCH[1]}"; DEPLOY_ARGS="${BASH_REMATCH[2]}"
  else
    echo "deploy-remote: commande refusée (forme attendue : REF='<ref>' DEPLOY_ARGS='<options>')" >&2; exit 2
  fi
fi
REF="${REF:-}"; DEPLOY_ARGS="${DEPLOY_ARGS:-}"
[ -n "$REF" ] || { echo "deploy-remote: REF requis" >&2; exit 2; }
FORCE=false; CLEAN_ARGS=""
for a in $DEPLOY_ARGS; do
  case "$a" in
    --skip-backup|--skip-build|--skip-migrations|--rollback) CLEAN_ARGS="$CLEAN_ARGS $a" ;;
    --force) FORCE=true ;;
    *) echo "deploy-remote: option refusée : $a" >&2; exit 2 ;;
  esac
done

echo "== $(hostname) : $(git rev-parse --short HEAD) -> $REF ($(id -un))"
# --force : un tag déplacé (release relancée) ne doit pas bloquer (« would clobber existing tag »)
git fetch --all --tags --prune --force
TARGET="$REF"
if git rev-parse -q --verify "refs/remotes/origin/$REF" >/dev/null 2>&1; then TARGET="origin/$REF"; fi
TARGET_SHA="$(git rev-parse "$TARGET^{commit}")"
CURRENT_DEPLOYED="$(sed -n 's/^current \([0-9a-f]\{7,40\}\).*/\1/p' .deployed 2>/dev/null | head -1 || true)"
if [ "$FORCE" = false ] && [ -n "$CURRENT_DEPLOYED" ] && [ "$CURRENT_DEPLOYED" = "$TARGET_SHA" ] && [[ "$CLEAN_ARGS" != *--rollback* ]]; then
  echo "== commit $TARGET_SHA déjà déployé (.deployed) : rien à faire (ajouter --force pour redéployer)"
  exit 0
fi
git -c advice.detachedHead=false checkout --detach "$TARGET"
echo "== commit $(git rev-parse HEAD) — version $(cat VERSION)"
# shellcheck disable=SC2086
exec ./scripts/deploy.sh $CLEAN_ARGS
