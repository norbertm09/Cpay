#!/usr/bin/env bash
# Test de scripts/lib/env.sh : valeurs piégées (parenthèses, #, $, guillemets, espaces, CRLF, export).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../lib/env.sh"
F="$(mktemp)"; trap 'rm -f "$F"' EXIT
printf '%s\n' \
  "# commentaire" \
  "DB_HOST=db.example.net" \
  "DB_PASSWORD='p(a)ss#w\$ord \"quoted\" ; rm -rf /'" \
  'JWT_SECRET="abc def"' \
  "export DB_PORT=35534" \
  $'WIN_VALUE=crlf\r' \
  "SPACED=  valeur avec espaces   " \
  "DUP=premier" \
  "DUP=dernier" \
  "EMPTY=" \
  > "$F"
fail=0
check() { # check <nom> <attendu>
  local got; got="$(read_env_var "$F" "$1")"
  if [ "$got" = "$2" ]; then echo "ok   $1"; else echo "FAIL $1 : attendu [$2] obtenu [$got]"; fail=1; fi
}
check DB_HOST 'db.example.net'
check DB_PASSWORD 'p(a)ss#w$ord "quoted" ; rm -rf /'
check JWT_SECRET 'abc def'
check DB_PORT '35534'
check WIN_VALUE 'crlf'
check SPACED '  valeur avec espaces'
check DUP 'dernier'
check EMPTY ''
check ABSENT ''
# load_env_vars : n'écrase pas une variable déjà définie, exporte les absentes
export DB_HOST=deja.defini
unset DB_PORT || true
load_env_vars "$F" DB_HOST DB_PORT DB_PASSWORD
[ "$DB_HOST" = "deja.defini" ] && echo "ok   load_env_vars conserve l'existant" || { echo "FAIL load_env_vars a ecrase DB_HOST"; fail=1; }
[ "$DB_PORT" = "35534" ] && echo "ok   load_env_vars exporte DB_PORT" || { echo "FAIL DB_PORT=$DB_PORT"; fail=1; }
[ "$DB_PASSWORD" = 'p(a)ss#w$ord "quoted" ; rm -rf /' ] && echo "ok   valeur piegee intacte" || { echo "FAIL DB_PASSWORD"; fail=1; }
# --- write_env_var / remove_env_var (lot exporter 2026-11-13 : ecriture atomique partagee)
chmod 640 "$F"
write_env_var "$F" DB_PASSWORD 'nouveau (mot) #de$passe "ok"' || { echo "FAIL write_env_var DB_PASSWORD"; fail=1; }
check DB_PASSWORD 'nouveau (mot) #de$passe "ok"'
[ "$(grep -c '^DB_PASSWORD=' "$F")" -eq 1 ] && echo "ok   write_env_var : une seule ligne DB_PASSWORD" || { echo "FAIL write_env_var : doublons"; fail=1; }
write_env_var "$F" DUP simple || fail=1
[ "$(grep -c '^DUP=' "$F")" -eq 1 ] && check DUP simple
write_env_var "$F" NOUVELLE 'a b' || fail=1; check NOUVELLE 'a b'
grep -q "^NOUVELLE='a b'$" "$F" && echo "ok   write_env_var : valeur quotee" || { echo "FAIL write_env_var : quote"; fail=1; }
write_env_var "$F" HEX 0123abcd || fail=1; grep -q '^HEX=0123abcd$' "$F" && echo "ok   write_env_var : valeur simple sans quote" || { echo "FAIL write_env_var : simple"; fail=1; }
write_env_var "$F" BAD "avec'quote" 2>/dev/null && { echo "FAIL write_env_var : guillemet simple accepte"; fail=1; } || echo "ok   write_env_var : guillemet simple refuse"
grep -q '^BAD=' "$F" && { echo "FAIL write_env_var : BAD ecrite"; fail=1; }
remove_env_var "$F" DB_PORT || fail=1
grep -q 'DB_PORT=' "$F" && { echo "FAIL remove_env_var"; fail=1; } || echo "ok   remove_env_var"
[ "$(stat -c %a "$F")" = "640" ] && echo "ok   droits conserves (640)" || { echo "FAIL droits : $(stat -c %a "$F")"; fail=1; }
check DB_HOST 'db.example.net'
# --- cpay_export_deployed_tag : tag de l'image deployee (VERSION + sha12 de .deployed), sans depot git
R="$(mktemp -d)"; printf '2.7.2\n' > "$R/VERSION"; printf 'current 9201056dff6305420ab2f3517a66adc41c88ec93 v2.7.2-3-g9201056 2026-11-16T13:39:00Z\nprevious 171476b725d8db55838ab6bc92441e9992702af2\n' > "$R/.deployed"
( unset CPLUS_TAG; cpay_export_deployed_tag "$R"; [ "${CPLUS_TAG:-}" = "2.7.2-9201056dff63" ] ) && echo "ok   cpay_export_deployed_tag" || { echo "FAIL cpay_export_deployed_tag : [$(unset CPLUS_TAG; cpay_export_deployed_tag "$R"; echo "${CPLUS_TAG:-}")]"; fail=1; }
( CPLUS_TAG=deja; cpay_export_deployed_tag "$R"; [ "$CPLUS_TAG" = deja ] ) && echo "ok   cpay_export_deployed_tag : CPLUS_TAG existant conserve" || { echo "FAIL CPLUS_TAG ecrase"; fail=1; }
( unset CPLUS_TAG; cpay_export_deployed_tag "$R/absent"; [ -z "${CPLUS_TAG:-}" ] ) && echo "ok   cpay_export_deployed_tag : sans .deployed, inchange" || { echo "FAIL sans .deployed"; fail=1; }
rm -rf "$R"
# le fichier n'a jamais été exécuté
[ -d / ] && echo "ok   aucune commande executee"
exit $fail
