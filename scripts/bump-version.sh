#!/usr/bin/env bash
# ================================================================
# Passe tout le depot a une nouvelle version produit (docs/VERSIONING.md).
#   ./scripts/bump-version.sh <X.Y.Z> [--no-archives]
#
# Met a jour : VERSION, backend (package.json + lock), les 7 portails (+ lock si present),
# Expo (package.json, app.json version + android.versionCode = M*100+m*10+p),
# Android natif (versionName, versionCode +1), SDK Android (versionName, README),
# plugin WooCommerce (en-tete, CPAY_VERSION, Stable tag), tags d'images docker-compose,
# titre du README, archives + page developpeurs de la vitrine (sauf --no-archives),
# et ajoute un stub `## <version> (<date>)` en tete de CHANGELOG_AMELIORATIONS.md s'il manque.
# Les SDK JavaScript (@c-pay/sdk) et PHP ont leur propre numero : non touches.
# Termine par scripts/check-version.sh.
# ================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

NEW="${1:-}"; ARCHIVES=true
[ "${2:-}" = "--no-archives" ] && ARCHIVES=false
case "$NEW" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "usage: $0 <X.Y.Z> [--no-archives]" >&2; exit 2 ;;
esac
echo "$NEW" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "version semver attendue (X.Y.Z) : $NEW" >&2; exit 2; }
IFS=. read -r MAJOR MINOR PATCH <<<"$NEW"
EXPO_CODE=$((MAJOR * 100 + MINOR * 10 + PATCH))
OLD="$(tr -d '[:space:]' < VERSION)"
echo "Version : $OLD -> $NEW (versionCode Expo $EXPO_CODE)"

npm_version() { # npm_version <dir>  (champ "version" de package.json et de package-lock.json s'il existe,
                #  sans reformater les fichiers comme le ferait `npm version`)
  local dir="$1"
  python3 - "$dir" "$NEW" <<'PY'
import json, re, sys, os
d, new = sys.argv[1:3]
def set_version(path, pattern, count):
    s = open(path, encoding='utf-8').read()
    s2, n = re.subn(pattern, lambda m: m.group(1) + new + m.group(2), s, count=count, flags=re.M)
    if n != count: sys.exit(f"{path}: {n} champ(s) version modifie(s), {count} attendu(s)")
    open(path, 'w', encoding='utf-8').write(s2)
    json.loads(s2)  # reste un JSON valide
pkg = os.path.join(d, 'package.json')
set_version(pkg, r'^(\s*"version": ")[^"]+(")', 1)
lock = os.path.join(d, 'package-lock.json')
if os.path.exists(lock):
    # lockfile v2/v3 : "version" racine (ligne 3) puis packages[""].version ; les deux sont les
    # deux premieres occurrences du champ dans le fichier
    set_version(lock, r'^(\s*"version": ")[^"]+(")', 2)
    j = json.load(open(lock, encoding='utf-8'))
    if j.get('version') != new or j.get('packages', {}).get('', {}).get('version') != new:
        sys.exit(f"{lock}: version non appliquee")
PY
  echo "  $dir/package.json$([ -f "$dir/package-lock.json" ] && printf ' + package-lock.json')"
}
replace() { # replace <file> <python-regex> <replacement>  (exactement 1 occurrence attendue)
  python3 - "$1" "$2" "$3" <<'PY'
import re, sys
path, pattern, repl = sys.argv[1:4]
s = open(path, encoding='utf-8').read()
s2, n = re.subn(pattern, repl, s, count=1, flags=re.M)
if n != 1: sys.exit(f"{path}: motif introuvable : {pattern}")
open(path, 'w', encoding='utf-8').write(s2)
PY
  echo "  $1"
}

# --- VERSION --------------------------------------------------------------
printf '%s\n' "$NEW" > VERSION; echo "  VERSION"

# --- Backend + portails ---------------------------------------------------
npm_version backend
for p in admin merchant cardholder partners bank agency agent; do npm_version "portal/$p"; done

# --- Expo -----------------------------------------------------------------
npm_version mobile/cpay-mobile
replace mobile/cpay-mobile/app.json '^(\s*"version": ")[0-9.]+(",)' "\g<1>$NEW\g<2>"
replace mobile/cpay-mobile/app.json '^(\s*"versionCode": )[0-9]+(,)' "\g<1>$EXPO_CODE\g<2>"

# --- Android natif : versionName + versionCode +1 -------------------------
APP_CODE="$(sed -n -E 's/^[[:space:]]*versionCode[[:space:]]+([0-9]+).*/\1/p' android/app/build.gradle | head -1)"
replace android/app/build.gradle '^(\s*versionCode )[0-9]+' "\g<1>$((APP_CODE + 1))"
replace android/app/build.gradle '^(\s*versionName ")[0-9.]+(")' "\g<1>$NEW\g<2>"
echo "    versionCode Android $APP_CODE -> $((APP_CODE + 1))"

# --- SDK Android (suit la version produit) --------------------------------
replace sdk/android/build.gradle '^(\s*versionName ")[0-9.]+(")' "\g<1>$NEW\g<2>"
replace sdk/android/README.md '^(# C-Pay Android SDK v)[0-9.]+' "\g<1>$NEW"

# --- Plugin WooCommerce ---------------------------------------------------
replace plugins/woocommerce/cplus-payment-gateway.php '^( \* Version:\s+)[0-9.]+' "\g<1>$NEW"
replace plugins/woocommerce/cplus-payment-gateway.php "^(define\('CPAY_VERSION',\s*')[0-9.]+(')" "\g<1>$NEW\g<2>"
replace plugins/woocommerce/readme.txt '^(Stable tag:\s*)[0-9.]+' "\g<1>$NEW"

# --- Docker Compose + README ---------------------------------------------
for svc in api admin merchant partners cardholder; do
  replace docker/docker-compose.yml "^(\s*image: cplus-$svc:\\\$\\{CPLUS_TAG:-)[0-9.]+(\\})" "\g<1>$NEW\g<2>"
done
replace README.md '^(# C-Pay )[0-9.]+' "\g<1>$NEW"

# --- Changelog : stub en tete si absent -----------------------------------
ESCAPED="$(printf '%s' "$NEW" | sed 's/\./\\./g')"
if ! grep -q -E "^## $ESCAPED([^0-9]|$)" CHANGELOG_AMELIORATIONS.md; then
  python3 - "$NEW" "$(date +%Y-%m-%d)" <<'PY'
import sys
version, date = sys.argv[1:3]
path = 'CHANGELOG_AMELIORATIONS.md'
lines = open(path, encoding='utf-8').read().split('\n')
stub = [f'## {version} ({date})', '', '- (a completer)', '']
# apres le titre de premier niveau et sa ligne vide
i = 0
if lines and lines[0].startswith('# '):
    i = 1
    while i < len(lines) and lines[i].strip() == '': i += 1
lines[i:i] = stub
open(path, 'w', encoding='utf-8').write('\n'.join(lines))
PY
  echo "  CHANGELOG_AMELIORATIONS.md : stub '## $NEW' ajoute"
fi

# --- Archives SDK/plugin + page developpeurs ------------------------------
if [ "$ARCHIVES" = true ]; then
  "$ROOT/scripts/build-archives.sh" "$NEW" --update-landing
else
  echo "  (archives non reconstruites : lancer ./scripts/build-archives.sh $NEW --update-landing)"
fi

echo
"$ROOT/scripts/check-version.sh"
echo
echo "Reste a faire : completer la section '## $NEW' du changelog, puis commit + tag v$NEW apres merge (docs/VERSIONING.md)."
