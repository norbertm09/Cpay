#!/usr/bin/env bash
# ============================================================================
# C-Pay — rotation des secrets de production (lot 0, audit 2026-11-02 P0 #1 et WAVE-2 § reste a faire)
#
#   ./scripts/rotate-secrets.sh status                       # quels secrets ont une valeur « precedente » encore active
#   ./scripts/rotate-secrets.sh db-password                  # nouveau mot de passe PostgreSQL (saisi sans echo, teste, ecrit)
#   ./scripts/rotate-secrets.sh webhook-secret               # nouveau WEBHOOK_PATH_SECRET, l'ancien passe en _PREVIOUS
#   ./scripts/rotate-secrets.sh webhook-secret --clear-previous
#   ./scripts/rotate-secrets.sh mtn-token                    # nouveau MTN_WEBHOOK_TOKEN (+ MTN_CG_CALLBACK_URL ?token=…)
#   ./scripts/rotate-secrets.sh mtn-token --clear-previous
#   ./scripts/rotate-secrets.sh set ANTHROPIC_API_KEY        # toute variable secrete : saisie masquee (ou CPAY_SET_VALUE_FILE), sans echo
#   ./scripts/rotate-secrets.sh unset <NOM>
#
# Regles :
#   - rien n'est affiche ni journalise en clair : les nouvelles valeurs vont dans backend/.env (600) et c'est tout ;
#     seules les URLs de callback a declarer chez les operateurs sont affichees (elles contiennent le segment secret :
#     a copier dans le portail operateur, jamais dans un ticket ou un chat) ;
#   - backend/.env est reecrit de facon atomique (fichier temporaire du meme dossier, memes droits, puis mv) apres une
#     copie de secours backend/.env.bak-<horodatage> (600) ;
#   - l'API n'est PAS redemarree par ce script : lancer ensuite `./scripts/deploy.sh --skip-backup --skip-migrations`
#     (bascule bleu/vert sur le meme commit : aucune coupure) puis, pour le mot de passe, `sudo bash
#     scripts/setup-monitoring.sh` (l'exporter PostgreSQL relit backend/.env) ;
#   - `history -c` apres toute commande qui aurait contenu un secret.
#
# Variables : CPAY_ENV_FILE (defaut backend/.env), CPAY_SKIP_DB_TEST=true (pas de test de connexion),
#             CPAY_NEW_DB_PASSWORD_FILE (lire le nouveau mot de passe dans un fichier au lieu du terminal).
# ============================================================================
set -eu
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
# shellcheck source=lib/env.sh
. "$ROOT/scripts/lib/env.sh"
ENV_FILE="${CPAY_ENV_FILE:-$ROOT/backend/.env}"

log()  { printf '[rotate] %s\n' "$*"; }
warn() { printf '[rotate] WARN %s\n' "$*" >&2; }
die()  { printf '[rotate] ERREUR %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,26p' "$0"; exit "${1:-0}"; }

[ -f "$ENV_FILE" ] || die "$ENV_FILE introuvable"
[ -r "$ENV_FILE" ] || die "$ENV_FILE illisible (lancer avec l'utilisateur proprietaire ou sudo)"

# set_env_var <NOM> <valeur> / unset_env_var <NOM> : lib/env.sh (ecriture atomique, memes droits, valeur quotee)
set_env_var()   { write_env_var "$ENV_FILE" "$1" "$2" || die "ecriture de $1 dans $ENV_FILE impossible"; }
unset_env_var() { remove_env_var "$ENV_FILE" "$1" || die "suppression de $1 dans $ENV_FILE impossible"; }
backup_env() {
  local bak
  bak="$(mktemp "$ENV_FILE.bak-$(date +%Y%m%d_%H%M%S).XXXX")"
  cp -p "$ENV_FILE" "$bak"; chmod 600 "$bak"
  log "copie de secours : $bak (a supprimer une fois la rotation validee)"
}
new_secret() { openssl rand -hex 24; }
restart_hint() {
  log "Puis, pour que l'API lise le nouveau .env : ./scripts/deploy.sh --skip-backup --skip-migrations  (bascule bleu/vert, sans coupure)"
}
has_value() { [ -n "$(read_env_var "$ENV_FILE" "$1")" ]; }

cmd_status() {
  local v
  for v in WEBHOOK_PATH_SECRET MTN_WEBHOOK_TOKEN DB_PASSWORD DB_SSL_CA_FILE; do
    if has_value "$v"; then log "$v : renseigne"; else log "$v : ABSENT"; fi
  done
  for v in WEBHOOK_PATH_SECRET_PREVIOUS MTN_WEBHOOK_TOKEN_PREVIOUS; do
    if has_value "$v"; then warn "$v : encore actif — ancienne valeur toujours acceptee ; retirer avec '${v%_PREVIOUS}' --clear-previous une fois la rotation terminee"
    else log "$v : absent (aucune rotation en cours)"; fi
  done
  if [ "$(read_env_var "$ENV_FILE" DB_SSL_REJECT_UNAUTHORIZED | tr '[:upper:]' '[:lower:]')" = "false" ]; then
    warn "DB_SSL_REJECT_UNAUTHORIZED=false : certificat PostgreSQL NON verifie — deposer la CA (docs/LOT-0-SECRETS.md § 4) et retirer cette variable"
  fi
}

cmd_webhook_secret() {
  local clear=false; [ "${1:-}" = "--clear-previous" ] && clear=true
  local current base s p
  current="$(read_env_var "$ENV_FILE" WEBHOOK_PATH_SECRET)"
  if [ "$clear" = true ]; then
    has_value WEBHOOK_PATH_SECRET_PREVIOUS || { log "WEBHOOK_PATH_SECRET_PREVIOUS deja absent"; return 0; }
    backup_env; unset_env_var WEBHOOK_PATH_SECRET_PREVIOUS
    log "WEBHOOK_PATH_SECRET_PREVIOUS retire : l'ancien segment n'est plus accepte"; restart_hint; return 0
  fi
  has_value WEBHOOK_PATH_SECRET_PREVIOUS && die "une rotation est deja en cours (WEBHOOK_PATH_SECRET_PREVIOUS present) : terminer avec --clear-previous avant d'en lancer une autre"
  backup_env
  s="$(new_secret)"
  [ -n "$current" ] && set_env_var WEBHOOK_PATH_SECRET_PREVIOUS "$current"
  set_env_var WEBHOOK_PATH_SECRET "$s"
  local kept=""; [ -n "$current" ] && kept=" ; l'ancien reste accepte via WEBHOOK_PATH_SECRET_PREVIOUS"
  log "WEBHOOK_PATH_SECRET renouvele$kept"
  base="$(read_env_var "$ENV_FILE" API_BASE_URL)"; base="${base%/}"
  log "URLs de callback a declarer chez les operateurs qui utilisent le chemin secret (portail operateur uniquement) :"
  for p in orange wave africell express_union free_money moov; do printf '    %s/api/v1/webhooks/%s/%s\n' "${base:-https://api.c-pay.global}" "$s" "$p"; done
  log "MTN et Airtel ne sont pas concernes (jeton et signature dedies). Une fois les URLs declarees et les paiements"
  log "anterieurs termines (24 h suffisent) : ./scripts/rotate-secrets.sh webhook-secret --clear-previous"
  restart_hint
}

cmd_mtn_token() {
  local clear=false; [ "${1:-}" = "--clear-previous" ] && clear=true
  local current t url
  current="$(read_env_var "$ENV_FILE" MTN_WEBHOOK_TOKEN)"
  if [ "$clear" = true ]; then
    has_value MTN_WEBHOOK_TOKEN_PREVIOUS || { log "MTN_WEBHOOK_TOKEN_PREVIOUS deja absent"; return 0; }
    backup_env; unset_env_var MTN_WEBHOOK_TOKEN_PREVIOUS
    log "MTN_WEBHOOK_TOKEN_PREVIOUS retire"; restart_hint; return 0
  fi
  has_value MTN_WEBHOOK_TOKEN_PREVIOUS && die "une rotation est deja en cours (MTN_WEBHOOK_TOKEN_PREVIOUS present) : terminer avec --clear-previous"
  backup_env
  t="$(new_secret)"
  [ -n "$current" ] && set_env_var MTN_WEBHOOK_TOKEN_PREVIOUS "$current"
  set_env_var MTN_WEBHOOK_TOKEN "$t"
  url="$(read_env_var "$ENV_FILE" MTN_CG_CALLBACK_URL)"
  if [ -n "$url" ]; then
    url="${url%%\?*}?token=$t"
  else
    url="$(read_env_var "$ENV_FILE" API_BASE_URL)"; url="${url%/}/api/v1/webhooks/mtn?token=$t"
  fi
  set_env_var MTN_CG_CALLBACK_URL "$url"
  local kept=""; [ -n "$current" ] && kept=" ; l'ancien jeton reste accepte via MTN_WEBHOOK_TOKEN_PREVIOUS"
  log "MTN_WEBHOOK_TOKEN renouvele et MTN_CG_CALLBACK_URL mise a jour (?token=…)$kept"
  log "MTN envoie X-Callback-Url a chaque requete : rien a declarer. Quand les paiements lances avant la rotation sont"
  log "termines (24 h) : ./scripts/rotate-secrets.sh mtn-token --clear-previous"
  restart_hint
}

cmd_db_password() {
  local user host port name pw pw2 ssl
  user="$(read_env_var "$ENV_FILE" DB_USER)"; host="$(read_env_var "$ENV_FILE" DB_HOST)"
  port="$(read_env_var "$ENV_FILE" DB_PORT)"; name="$(read_env_var "$ENV_FILE" DB_NAME)"; ssl="$(read_env_var "$ENV_FILE" DB_SSL)"
  [ -n "$user" ] && [ -n "$host" ] || die "DB_USER / DB_HOST absents de $ENV_FILE"
  log "Mot de passe de $user@$host:${port:-5432}/$name — a changer D'ABORD dans le manager OVH (Cloud DB > Utilisateurs > Reinitialiser)"
  if [ -n "${CPAY_NEW_DB_PASSWORD_FILE:-}" ]; then
    pw="$(tr -d '\r\n' < "$CPAY_NEW_DB_PASSWORD_FILE")"
  else
    [ -t 0 ] || die "pas de terminal : fournir CPAY_NEW_DB_PASSWORD_FILE=<fichier 600 contenant le mot de passe>"
    printf 'Nouveau mot de passe (saisie masquee) : '; read -r -s pw; printf '\n'
    printf 'Confirmer : '; read -r -s pw2; printf '\n'
    [ "$pw" = "$pw2" ] || die "les deux saisies different"
  fi
  [ "${#pw}" -ge 16 ] || die "mot de passe trop court (16 caracteres minimum)"
  case "$pw" in *\'*) die "mot de passe contenant un guillemet simple : en choisir un autre (non representable dans .env)" ;; esac
  if [ "${CPAY_SKIP_DB_TEST:-false}" != "true" ]; then
    log "Test de connexion avec le nouveau mot de passe…"
    if command -v psql >/dev/null 2>&1; then
      PGPASSWORD="$pw" PGSSLMODE="$([ "$ssl" = "true" ] && echo require || echo prefer)" PGCONNECT_TIMEOUT=10 \
        psql -h "$host" -p "${port:-5432}" -U "$user" -d "$name" -tAc 'select 1' >/dev/null 2>&1 \
        || die "connexion refusee avec le nouveau mot de passe : verifier la reinitialisation cote OVH (backend/.env inchange)"
    else
      (cd "$ROOT/docker" && docker compose run --rm --no-deps -T -e RUN_MIGRATIONS=false -e DB_PASSWORD="$pw" api-blue \
        node -e "require('./src/config/database').query('select 1').then(()=>process.exit(0)).catch((e)=>{console.error(e.message);process.exit(1)})") \
        >/dev/null 2>&1 || die "connexion refusee avec le nouveau mot de passe (test via l'image API) : verifier la reinitialisation cote OVH (backend/.env inchange)"
    fi
    log "connexion OK"
  else
    warn "test de connexion ignore (CPAY_SKIP_DB_TEST=true)"
  fi
  backup_env
  set_env_var DB_PASSWORD "$pw"
  if [ -z "$(read_env_var "${MONITORING_ENV_FILE:-/etc/cplus/monitoring.env}" PG_EXPORTER_USER 2>/dev/null)" ]; then
    warn "l'exporter PostgreSQL utilise encore DB_USER : relancer setup-monitoring.sh (ou creer le role dedie : scripts/create-monitoring-role.sh)"
  fi
  log "DB_PASSWORD mis a jour dans $ENV_FILE"
  restart_hint
  log "Ensuite : sudo bash scripts/setup-monitoring.sh   (l'exporter PostgreSQL relit backend/.env) ; verifier"
  log "'docker logs cplus-postgres-exporter --since 2m' et une sauvegarde : ./scripts/backup-db.sh --label post-rotation"
  log "Enfin : history -c"
}

cmd_set() {
  local name="$1" v v2
  case "$name" in *[!A-Z0-9_]*|'') die "nom de variable invalide : $name (majuscules, chiffres, _)" ;; esac
  if [ -n "${CPAY_SET_VALUE_FILE:-}" ]; then v="$(tr -d '\r\n' < "$CPAY_SET_VALUE_FILE")"
  else
    [ -t 0 ] || die "pas de terminal : fournir CPAY_SET_VALUE_FILE=<fichier 600 contenant la valeur>"
    printf 'Valeur de %s (saisie masquee) : ' "$name"; read -r -s v; printf '\n'
    printf 'Confirmer : '; read -r -s v2; printf '\n'
    [ "$v" = "$v2" ] || die "les deux saisies different"
  fi
  [ -n "$v" ] || die "valeur vide (utiliser 'unset $name' pour retirer la variable)"
  backup_env; set_env_var "$name" "$v"
  log "$name inscrit dans $ENV_FILE (valeur non affichee)"; restart_hint; log "Enfin : history -c"
}
cmd_unset() {
  local name="$1"
  case "$name" in *[!A-Z0-9_]*|'') die "nom de variable invalide : $name" ;; esac
  has_value "$name" || { log "$name deja absent"; return 0; }
  backup_env; unset_env_var "$name"; log "$name retire de $ENV_FILE"; restart_hint
}

case "${1:-}" in
  status)          cmd_status ;;
  set)             cmd_set "${2:-}" ;;
  unset)           cmd_unset "${2:-}" ;;
  webhook-secret)  cmd_webhook_secret "${2:-}" ;;
  mtn-token)       cmd_mtn_token "${2:-}" ;;
  db-password)     cmd_db_password ;;
  -h|--help|'')    usage 0 ;;
  *) die "commande inconnue : $1 (status | db-password | webhook-secret [--clear-previous] | mtn-token [--clear-previous] | set <NOM> | unset <NOM>)" ;;
esac
