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
