#!/usr/bin/env bash
# ================================================================
# Reconstruit les archives distribuees aux integrateurs :
#   cpay-android-sdk-v<version>.zip      (racine cpay-android-sdk/      <- sdk/android)
#   cpay-payment-gateway-v<version>.zip  (racine cplus-payment-gateway/ <- plugins/woocommerce)
# Meme disposition que les archives publiees en 2.7.0 (docs/WAVE-3.md §6), `zip -r -X`.
#
#   ./scripts/build-archives.sh [<version>] [--out <dir>] [--update-landing]
#     <version>        defaut : contenu de VERSION
#     --out <dir>      ecrit les zips + SHA256SUMS dans <dir> (defaut : sdk/ et plugins/
#                      comme les archives historiques)
#     --update-landing copie aussi les zips dans portal/landing/downloads/ (en retirant
#                      les versions precedentes) et met a jour liens, tailles et SHA-256
#                      dans portal/landing/developers.html
# ================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION=""; OUT=""; UPDATE_LANDING=false
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --update-landing) UPDATE_LANDING=true; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) VERSION="$1"; shift ;;
  esac
done
[ -n "$VERSION" ] || VERSION="$(tr -d '[:space:]' < VERSION)"
command -v zip >/dev/null || { echo "zip absent (apt install zip)" >&2; exit 1; }

SDK_ZIP="cpay-android-sdk-v$VERSION.zip"
PLUGIN_ZIP="cpay-payment-gateway-v$VERSION.zip"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Disposition identique aux archives existantes : un dossier racine nomme, sans fichiers macOS/.git
build_zip() { # build_zip <source-dir> <root-name> <zip-path>
  local src="$1" root="$2" zip_path="$3"
  rm -rf "$STAGE/$root"
  cp -R "$src" "$STAGE/$root"
  find "$STAGE/$root" \( -name '.DS_Store' -o -name '*.bak' -o -name 'node_modules' -o -name 'build' -o -name '.gradle' \) -prune -exec rm -rf {} + 2>/dev/null || true
  rm -f "$zip_path"
  (cd "$STAGE" && zip -r -X -q "$zip_path" "$root")
  echo "  $(du -k "$zip_path" | cut -f1) Ko  $zip_path"
}

if [ -n "$OUT" ]; then
  mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
  SDK_OUT="$OUT/$SDK_ZIP"; PLUGIN_OUT="$OUT/$PLUGIN_ZIP"
else
  SDK_OUT="$ROOT/sdk/$SDK_ZIP"; PLUGIN_OUT="$ROOT/plugins/$PLUGIN_ZIP"
fi

echo "Archives $VERSION :"
build_zip "$ROOT/sdk/android"        cpay-android-sdk      "$SDK_OUT"
build_zip "$ROOT/plugins/woocommerce" cplus-payment-gateway "$PLUGIN_OUT"

SDK_SHA="$(sha256sum "$SDK_OUT" | cut -d' ' -f1)"
PLUGIN_SHA="$(sha256sum "$PLUGIN_OUT" | cut -d' ' -f1)"
if [ -n "$OUT" ]; then
  (cd "$OUT" && sha256sum "$SDK_ZIP" "$PLUGIN_ZIP" > SHA256SUMS)
  echo "  SHA256SUMS -> $OUT/SHA256SUMS"
fi
echo "  sha256 $SDK_ZIP    $SDK_SHA"
echo "  sha256 $PLUGIN_ZIP $PLUGIN_SHA"

if [ "$UPDATE_LANDING" = true ]; then
  DL="$ROOT/portal/landing/downloads"
  mkdir -p "$DL"
  find "$DL" -name 'cpay-android-sdk-v*.zip' -delete
  find "$DL" -name 'cpay-payment-gateway-v*.zip' -delete
  cp "$SDK_OUT" "$DL/$SDK_ZIP"; cp "$PLUGIN_OUT" "$DL/$PLUGIN_ZIP"
  # Les anciennes archives a la racine de sdk/ et plugins/ sont remplacees par la version courante
  if [ -z "$OUT" ]; then
    find "$ROOT/sdk" -maxdepth 1 -name 'cpay-android-sdk-v*.zip' ! -name "$SDK_ZIP" -delete
    find "$ROOT/plugins" -maxdepth 1 -name 'cpay-payment-gateway-v*.zip' ! -name "$PLUGIN_ZIP" -delete
  fi
  SDK_KB=$(( ($(stat -c %s "$SDK_OUT") + 1023) / 1024 ))
  PLUGIN_KB=$(( ($(stat -c %s "$PLUGIN_OUT") + 1023) / 1024 ))
  export VERSION SDK_ZIP PLUGIN_ZIP SDK_SHA PLUGIN_SHA SDK_KB PLUGIN_KB
  python3 - "$ROOT/portal/landing/developers.html" <<'PY'
import os, re, sys
path = sys.argv[1]; env = os.environ
s = open(path, encoding='utf-8').read()
def one(pattern, repl, text):
    text, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    if n != 1: sys.exit(f"developers.html : motif introuvable {pattern!r}")
    return text
s = one(r'(Les archives ci-dessous sont celles de la version )[0-9]+(\.[0-9]+)*', r'\g<1>' + env['VERSION'], s)
for zip_name, sha, kb, title in ((env['PLUGIN_ZIP'], env['PLUGIN_SHA'], env['PLUGIN_KB'], 'Extension WooCommerce'),
                                 (env['SDK_ZIP'], env['SDK_SHA'], env['SDK_KB'], 'SDK Android')):
    base = zip_name.rsplit('-v', 1)[0]
    # bloc <div class="dl-card"> contenant le titre : SHA-256, lien et taille
    start = s.index('<h3>' + title + '</h3>'); end = s.index('</div>\n          <pre', start)
    block = s[start:end]
    block = one(r'(SHA-256 : <code>)[0-9a-f]+', r'\g<1>' + sha, block)
    block = one(r'href="/downloads/' + re.escape(base) + r'-v[0-9.]+\.zip">Télécharger \([0-9]+ Ko\)', f'href="/downloads/{zip_name}">Télécharger ({kb} Ko)', block)
    s = s[:start] + block + s[end:]
open(path, 'w', encoding='utf-8').write(s)
print('  developers.html mis a jour (liens, tailles, SHA-256)')
PY
fi
