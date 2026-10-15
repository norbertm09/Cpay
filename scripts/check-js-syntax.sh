#!/usr/bin/env sh
# ================================================================
# `node --check` sur tous les fichiers .js d'un ou plusieurs dossiers (node_modules, build, dist ignores).
#   ./scripts/check-js-syntax.sh backend/src sdk/javascript portal/landing
# Code 1 si un fichier ne compile pas. Utilise par la CI (jobs backend, sdk-js).
# ================================================================
set -eu
[ $# -gt 0 ] || { echo "usage: $0 <dir>..." >&2; exit 2; }
status=0; count=0
for dir in "$@"; do
  [ -d "$dir" ] || { echo "dossier introuvable : $dir" >&2; exit 2; }
  for f in $(find "$dir" -type f -name '*.js' \
      -not -path '*/node_modules/*' -not -path '*/build/*' -not -path '*/dist/*' | sort); do
    count=$((count + 1))
    node --check "$f" || { echo "ERREUR de syntaxe : $f" >&2; status=1; }
  done
done
echo "$count fichier(s) JS verifie(s) (node --check)"
exit $status
