#!/usr/bin/env bash
# ================================================================
# Verifie que toutes les versions du depot sont egales a `VERSION`.
#   ./scripts/check-version.sh            -> code 0 si tout est coherent
# Utilise par la CI (job version-check) et par scripts/bump-version.sh.
# Liste des emplacements : docs/VERSIONING.md.
# ================================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(tr -d '[:space:]' < VERSION)"
case "$VERSION" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "VERSION invalide : '$VERSION' (attendu X.Y.Z)" >&2; exit 1 ;;
esac
# versionCode Expo attendu : M*100 + m*10 + p (2.7.0 -> 270), voir docs/VERSIONING.md
IFS=. read -r MAJOR MINOR PATCH <<<"$VERSION"
EXPECTED_EXPO_CODE=$((MAJOR * 100 + MINOR * 10 + PATCH))

ERRORS=0
ok()   { printf '  ok   %-55s %s\n' "$1" "$2"; }
fail() { printf '  FAIL %-55s %s (attendu %s)\n' "$1" "$2" "$3"; ERRORS=$((ERRORS + 1)); }
check() { # check <label> <actual>
  if [ "$2" = "$VERSION" ]; then ok "$1" "$2"; else fail "$1" "${2:-<absent>}" "$VERSION"; fi
}
json_field() { node -p "const j=require('$ROOT/$1'); ($2) ?? ''"; }

echo "VERSION = $VERSION"

# --- Backend --------------------------------------------------------------
check "backend/package.json"      "$(json_field backend/package.json 'j.version')"
check "backend/package-lock.json" "$(json_field backend/package-lock.json 'j.version')"
check "backend/package-lock.json (packages[\"\"])" "$(json_field backend/package-lock.json 'j.packages[""].version')"

# --- Portails React (7) ---------------------------------------------------
for p in admin merchant cardholder partners bank agency agent; do
  check "portal/$p/package.json" "$(json_field "portal/$p/package.json" 'j.version')"
  if [ -f "portal/$p/package-lock.json" ]; then
    check "portal/$p/package-lock.json" "$(json_field "portal/$p/package-lock.json" 'j.version')"
    check "portal/$p/package-lock.json (packages[\"\"])" "$(json_field "portal/$p/package-lock.json" 'j.packages[""].version')"
  fi
done

# --- Expo -----------------------------------------------------------------
check "mobile/cpay-mobile/package.json" "$(json_field mobile/cpay-mobile/package.json 'j.version')"
check "mobile/cpay-mobile/app.json (expo.version)" "$(json_field mobile/cpay-mobile/app.json 'j.expo.version')"
EXPO_CODE="$(json_field mobile/cpay-mobile/app.json 'String(j.expo.android.versionCode)')"
if [ "$EXPO_CODE" = "$EXPECTED_EXPO_CODE" ]; then ok "mobile/cpay-mobile/app.json (android.versionCode)" "$EXPO_CODE"
else fail "mobile/cpay-mobile/app.json (android.versionCode)" "$EXPO_CODE" "$EXPECTED_EXPO_CODE"; fi

# --- Android natif + SDK Android -----------------------------------------
gradle_version_name() { sed -n -E 's/^[[:space:]]*versionName[[:space:]]+"([^"]+)".*/\1/p' "$1" | head -1; }
gradle_version_code() { sed -n -E 's/^[[:space:]]*versionCode[[:space:]]+([0-9]+).*/\1/p' "$1" | head -1; }
check "android/app/build.gradle (versionName)" "$(gradle_version_name android/app/build.gradle)"
APP_CODE="$(gradle_version_code android/app/build.gradle)"
if [ -n "$APP_CODE" ]; then ok "android/app/build.gradle (versionCode)" "$APP_CODE"
else fail "android/app/build.gradle (versionCode)" "<absent>" "entier"; fi
check "sdk/android/build.gradle (versionName)" "$(gradle_version_name sdk/android/build.gradle)"
check "sdk/android/README.md (titre)" "$(sed -n -E '1s/^# C-Pay Android SDK v([0-9.]+).*/\1/p' sdk/android/README.md)"

# --- Plugin WooCommerce ---------------------------------------------------
PLUGIN=plugins/woocommerce/cplus-payment-gateway.php
check "$PLUGIN (Version:)"     "$(sed -n -E 's/^ \* Version:[[:space:]]+([0-9.]+).*/\1/p' "$PLUGIN" | head -1)"
check "$PLUGIN (CPAY_VERSION)" "$(sed -n -E "s/^define\('CPAY_VERSION',[[:space:]]*'([0-9.]+)'\).*/\1/p" "$PLUGIN" | head -1)"
check "plugins/woocommerce/readme.txt (Stable tag)" "$(sed -n -E 's/^Stable tag:[[:space:]]*([0-9.]+).*/\1/p' plugins/woocommerce/readme.txt | head -1)"

# --- Docker Compose (tag par defaut des images) ---------------------------
for svc in api admin merchant partners cardholder; do
  check "docker-compose.yml (image cplus-$svc)" "$(sed -n -E "s/^[[:space:]]*image: cplus-$svc:\\\$\\{CPLUS_TAG:-([0-9.]+)\\}.*/\1/p" docker/docker-compose.yml | head -1)"
done

# --- Vitrine : archives SDK/plugin publiees -------------------------------
for z in cpay-android-sdk cpay-payment-gateway; do
  if grep -q "/downloads/$z-v$VERSION.zip" portal/landing/developers.html; then ok "developers.html (lien $z)" "$VERSION"
  else fail "developers.html (lien $z)" "$(grep -o "$z-v[0-9.]*\.zip" portal/landing/developers.html | head -1)" "$z-v$VERSION.zip"; fi
  if [ -f "portal/landing/downloads/$z-v$VERSION.zip" ]; then ok "portal/landing/downloads/$z-v$VERSION.zip" "present"
  else fail "portal/landing/downloads/$z-v$VERSION.zip" "<absent>" "present"; fi
done

# --- Changelog ------------------------------------------------------------
if grep -q -E "^## $(printf '%s' "$VERSION" | sed 's/\./\\./g')([^0-9]|$)" CHANGELOG_AMELIORATIONS.md; then
  ok "CHANGELOG_AMELIORATIONS.md (section ## $VERSION)" "present"
else
  fail "CHANGELOG_AMELIORATIONS.md (section ## $VERSION)" "<absent>" "## $VERSION ..."
fi

echo
if [ "$ERRORS" -gt 0 ]; then
  echo "$ERRORS incoherence(s) de version — lancer ./scripts/bump-version.sh $VERSION" >&2
  exit 1
fi
echo "Versions coherentes ($VERSION)."
