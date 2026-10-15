#!/usr/bin/env sh
# ================================================================
# Extrait la section d'une version de CHANGELOG_AMELIORATIONS.md (corps de la GitHub Release).
#   ./scripts/changelog-section.sh <version>      ex. 2.7.0  (ou v2.7.0)
# Une section commence par `## <version>` (suffixe autorise : `## 2.7.0-wave-3 (date) — titre`)
# et s'arrete au titre `## ` suivant. Code 1 si la section est introuvable.
# ================================================================
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
VERSION="${1:-}"
[ -n "$VERSION" ] || { echo "usage: $0 <version>" >&2; exit 2; }
VERSION="${VERSION#v}"
FILE="$ROOT/CHANGELOG_AMELIORATIONS.md"
ESCAPED="$(printf '%s' "$VERSION" | sed 's/\./\\./g')"

SECTION="$(awk -v re="^## $ESCAPED([^0-9]|$)" '
  found && /^## / { exit }
  $0 ~ re { found = 1 }
  found { print }
' "$FILE")"

[ -n "$SECTION" ] || { echo "Section '## $VERSION' introuvable dans CHANGELOG_AMELIORATIONS.md" >&2; exit 1; }
printf '%s\n' "$SECTION"
