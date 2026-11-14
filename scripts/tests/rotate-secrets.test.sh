#!/usr/bin/env bash
# Test de scripts/rotate-secrets.sh sur un .env temporaire (lot 0) : rotation du segment webhook et du jeton MTN
# avec conservation de l'ancienne valeur en _PREVIOUS, refus d'une double rotation, --clear-previous, mot de passe
# DB lu dans un fichier (test de connexion desactive), ecriture atomique (droits 600 conserves, valeurs piegees).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../lib/env.sh"
D="$(mktemp -d)"; trap 'rm -rf "$D"' EXIT
F="$D/.env"
printf '%s\n' \
  "API_BASE_URL=https://api.example.test/" \
  "DB_HOST=db.example.net" "DB_PORT=20184" "DB_NAME=cplus_db" "DB_USER=cplus_user" "DB_SSL=true" \
  "DB_PASSWORD='ancien(mot)#de passe'" \
  "WEBHOOK_PATH_SECRET=segment-initial" \
  "MTN_WEBHOOK_TOKEN=jeton-initial" \
  "MTN_CG_CALLBACK_URL=https://api.example.test/api/v1/webhooks/mtn?token=jeton-initial" \
  "AUTRE=inchange" \
  > "$F"
chmod 600 "$F"
R="$HERE/../rotate-secrets.sh"
fail=0
ok()   { echo "ok   $1"; }
ko()   { echo "FAIL $1"; fail=1; }
val()  { read_env_var "$F" "$1"; }
run()  { CPAY_ENV_FILE="$F" bash "$R" "$@"; }

# --- status
run status >"$D/out0" 2>&1; grep -q "WEBHOOK_PATH_SECRET : renseigne" "$D/out0" && ok "status" || ko "status"

# --- webhook-secret
run webhook-secret >"$D/out1" 2>&1 || ko "webhook-secret (code retour)"
NEW="$(val WEBHOOK_PATH_SECRET)"
[ "${#NEW}" -eq 48 ] && [ "$NEW" != "segment-initial" ] && ok "webhook-secret : nouveau segment hex 48" || ko "webhook-secret : nouveau segment [$NEW]"
[ "$(val WEBHOOK_PATH_SECRET_PREVIOUS)" = "segment-initial" ] && ok "webhook-secret : ancien en _PREVIOUS" || ko "webhook-secret : _PREVIOUS [$(val WEBHOOK_PATH_SECRET_PREVIOUS)]"
grep -q "https://api.example.test/api/v1/webhooks/$NEW/orange" "$D/out1" && ok "webhook-secret : URL orange affichee" || ko "webhook-secret : URL affichee"
grep -q "jeton-initial\|segment-initial" "$D/out1" && ko "webhook-secret : secret ancien affiche" || ok "webhook-secret : aucun ancien secret affiche"
[ "$(grep -c '^WEBHOOK_PATH_SECRET=' "$F")" -eq 1 ] && ok "webhook-secret : une seule ligne" || ko "webhook-secret : lignes dupliquees"
run webhook-secret >/dev/null 2>&1 && ko "webhook-secret : double rotation acceptee" || ok "webhook-secret : double rotation refusee"
run webhook-secret --clear-previous >/dev/null 2>&1 || ko "--clear-previous (code retour)"
[ -z "$(val WEBHOOK_PATH_SECRET_PREVIOUS)" ] && [ "$(val WEBHOOK_PATH_SECRET)" = "$NEW" ] && ok "--clear-previous : _PREVIOUS retire, nouveau conserve" || ko "--clear-previous"

# --- mtn-token
run mtn-token >"$D/out2" 2>&1 || ko "mtn-token (code retour)"
T="$(val MTN_WEBHOOK_TOKEN)"
[ "${#T}" -eq 48 ] && [ "$(val MTN_WEBHOOK_TOKEN_PREVIOUS)" = "jeton-initial" ] && ok "mtn-token : nouveau jeton, ancien en _PREVIOUS" || ko "mtn-token"
[ "$(val MTN_CG_CALLBACK_URL)" = "https://api.example.test/api/v1/webhooks/mtn?token=$T" ] && ok "mtn-token : MTN_CG_CALLBACK_URL mise a jour" || ko "mtn-token : URL [$(val MTN_CG_CALLBACK_URL)]"
grep -q "jeton-initial" "$D/out2" && ko "mtn-token : ancien jeton affiche" || ok "mtn-token : ancien jeton non affiche"
run mtn-token --clear-previous >/dev/null 2>&1 && [ -z "$(val MTN_WEBHOOK_TOKEN_PREVIOUS)" ] && ok "mtn-token --clear-previous" || ko "mtn-token --clear-previous"

# --- db-password (fichier, sans test de connexion)
printf '%s\n' 'nouveau (mot) #de$passe "ok" 2026' > "$D/pw"; chmod 600 "$D/pw"
CPAY_SKIP_DB_TEST=true CPAY_NEW_DB_PASSWORD_FILE="$D/pw" run db-password >"$D/out3" 2>&1 || ko "db-password (code retour)"
[ "$(val DB_PASSWORD)" = 'nouveau (mot) #de$passe "ok" 2026' ] && ok "db-password : valeur piegee ecrite et relue" || ko "db-password : [$(val DB_PASSWORD)]"
grep -q "nouveau (mot)" "$D/out3" && ko "db-password : mot de passe affiche" || ok "db-password : mot de passe non affiche"
printf 'court\n' > "$D/pw2"
CPAY_SKIP_DB_TEST=true CPAY_NEW_DB_PASSWORD_FILE="$D/pw2" run db-password >/dev/null 2>&1 && ko "db-password : mot de passe court accepte" || ok "db-password : mot de passe court refuse"
printf "%s\n" "avec'quote-et-seize-caracteres" > "$D/pw3"
CPAY_SKIP_DB_TEST=true CPAY_NEW_DB_PASSWORD_FILE="$D/pw3" run db-password >/dev/null 2>&1 && ko "db-password : guillemet simple accepte" || ok "db-password : guillemet simple refuse"

# --- set / unset (ANTHROPIC_API_KEY et autres secrets simples)
printf 'sk-ant-api03-EXEMPLE_cle (test)\n' > "$D/key"; chmod 600 "$D/key"
CPAY_SET_VALUE_FILE="$D/key" run set ANTHROPIC_API_KEY >"$D/out4" 2>&1 || ko "set (code retour)"
[ "$(val ANTHROPIC_API_KEY)" = "sk-ant-api03-EXEMPLE_cle (test)" ] && ok "set : valeur ecrite et relue" || ko "set : [$(val ANTHROPIC_API_KEY)]"
grep -q "EXEMPLE" "$D/out4" && ko "set : valeur affichee" || ok "set : valeur non affichee"
CPAY_SET_VALUE_FILE="$D/key" run set "mauvais nom" >/dev/null 2>&1 && ko "set : nom invalide accepte" || ok "set : nom invalide refuse"
run unset ANTHROPIC_API_KEY >/dev/null 2>&1 && [ -z "$(val ANTHROPIC_API_KEY)" ] && ok "unset" || ko "unset"

# --- invariants
[ "$(val AUTRE)" = "inchange" ] && ok "autres variables intactes" || ko "autres variables"
[ "$(stat -c %a "$F")" = "600" ] && ok "droits 600 conserves" || ko "droits : $(stat -c %a "$F")"
[ "$(ls "$D"/.env.bak-* 2>/dev/null | wc -l)" -ge 7 ] && ok "copies de secours creees" || ko "copies de secours"
for b in "$D"/.env.bak-*; do [ "$(stat -c %a "$b")" = "600" ] || ko "copie de secours $b en $(stat -c %a "$b")"; done

[ "$fail" -eq 0 ] && echo "rotate-secrets.sh : OK" || { echo "rotate-secrets.sh : ECHEC"; exit 1; }
