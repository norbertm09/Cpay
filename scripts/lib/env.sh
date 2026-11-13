#!/usr/bin/env bash
# ============================================================================
# C-Pay — lecture SÛRE d'un fichier .env (lot 3, audit 2026-11-02 infra P1-7)
#
# Le fichier n'est JAMAIS exécuté par le shell (`source`) : une valeur contenant ( ) # $ ' " ou un
# espace casserait le script, voire exécuterait une commande. On lit ligne à ligne.
#
#   source "$(dirname "$0")/lib/env.sh"
#   read_env_var <fichier> <NOM>            -> valeur (guillemets simples/doubles externes retirés), vide si absente
#   load_env_vars <fichier> NOM1 NOM2 …     -> exporte chaque NOM s'il est absent de l'environnement courant
#   write_env_var <fichier> <NOM> <valeur>  -> remplace toutes les lignes NOM=… par une seule (ou l'ajoute) ; ecriture
#                                              atomique (fichier temporaire du meme dossier, memes droits, puis mv) ;
#                                              guillemets simples ajoutes des que la valeur sort de [A-Za-z0-9_./:@+=-] ;
#                                              une valeur contenant un guillemet simple est refusee (code 2)
#   remove_env_var <fichier> <NOM>          -> retire toutes les lignes NOM=…
#
# Règle d'écriture d'un .env C-Pay : NOM=valeur ou NOM='valeur' (guillemets simples recommandés dès que la
# valeur contient un caractère spécial) ; pas d'interpolation ${…}, pas de commentaire en fin de ligne.
# ============================================================================
read_env_var() {
  local file="$1" name="$2" raw
  [ -f "$file" ] || return 0
  raw="$(sed -n "s/^[[:space:]]*\(export[[:space:]]\+\)\?${name}=//p" "$file" | tail -1)"
  raw="${raw%$'\r'}"
  case "$raw" in
    \'*\') raw="${raw#\'}"; raw="${raw%\'}" ;;
    \"*\") raw="${raw#\"}"; raw="${raw%\"}" ;;
    *) raw="$(printf '%s' "$raw" | sed -e 's/[[:space:]]*$//')" ;;
  esac
  printf '%s' "$raw"
}
load_env_vars() {
  local file="$1"; shift
  local v val
  for v in "$@"; do
    if [ -z "${!v:-}" ]; then
      val="$(read_env_var "$file" "$v")"
      if [ -n "$val" ]; then printf -v "$v" '%s' "$val"; export "$v"; fi
    fi
  done
}
_env_tmp() { # _env_tmp <fichier> : fichier temporaire du meme dossier, memes droits et proprietaire
  local f="$1" tmp
  tmp="$(mktemp "$(dirname "$f")/.env.tmp.XXXXXX")" || return 1
  chmod --reference="$f" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  chown --reference="$f" "$tmp" 2>/dev/null || true
  printf '%s' "$tmp"
}
write_env_var() {
  local file="$1" name="$2" value="$3" line tmp
  case "$value" in *\'*) printf 'write_env_var: la valeur de %s contient un guillemet simple (non representable)\n' "$name" >&2; return 2 ;; esac
  case "$value" in
    *[!A-Za-z0-9_./:@+=-]*|'') line="$name='$value'" ;;
    *) line="$name=$value" ;;
  esac
  [ -f "$file" ] || : > "$file"
  tmp="$(_env_tmp "$file")" || return 1
  NEWLINE="$line" NAME="$name" awk '
    BEGIN { done = 0; nl = ENVIRON["NEWLINE"]; re = "^[[:space:]]*(export[[:space:]]+)?" ENVIRON["NAME"] "=" }
    $0 ~ re { if (!done) { print nl; done = 1 }; next }
    { print }
    END { if (!done) print nl }
  ' "$file" > "$tmp" && mv -f "$tmp" "$file"
}
remove_env_var() {
  local file="$1" name="$2" tmp
  [ -f "$file" ] || return 0
  tmp="$(_env_tmp "$file")" || return 1
  NAME="$name" awk 'BEGIN { re = "^[[:space:]]*(export[[:space:]]+)?" ENVIRON["NAME"] "=" } $0 ~ re { next } { print }' "$file" > "$tmp" && mv -f "$tmp" "$file"
}
