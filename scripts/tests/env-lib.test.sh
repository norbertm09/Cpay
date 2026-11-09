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
# le fichier n'a jamais été exécuté
[ -d / ] && echo "ok   aucune commande executee"
exit $fail
