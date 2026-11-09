#!/usr/bin/env bash
# ============================================================================
# C-Pay — ajoute « include snippets/cpay-security-spa.conf; » dans les blocs server des
# portails du vhost nginx HÔTE (lot 2 de l'audit 2026-11-02, P1-3 : CSP sur les SPA).
#
# Usage (en root, sur le serveur) :
#   sudo bash /opt/cplus/scripts/add-spa-security-headers.sh            # applique (sauvegarde + nginx -t + reload)
#   sudo bash /opt/cplus/scripts/add-spa-security-headers.sh --dry-run  # montre ce qui serait fait
#   VHOST=/etc/nginx/sites-available/cpay-dev API_ORIGIN=https://api.dev.c-pay.global sudo -E bash ...  # serveur de dev
#
# Ce que fait le script :
#   1. copie docker/nginx-host/snippets/cpay-security-spa.conf vers /etc/nginx/snippets/ (en remplaçant
#      https://api.c-pay.global par API_ORIGIN si fourni) ;
#   2. dans le vhost, pour chaque bloc `server { … }` dont server_name contient un hôte de portail
#      (admin. merchant. app. card. partners. bank. agency. agent.), insère la ligne include juste après
#      `server_name …;` si elle n'y est pas déjà ;
#   3. sauvegarde le vhost (horodatée), `nginx -t`, puis `systemctl reload nginx`. En cas d'échec de nginx -t,
#      le vhost d'origine est restauré.
# ============================================================================
set -euo pipefail

VHOST="${VHOST:-/etc/nginx/sites-available/cpay}"
REPO="${REPO:-/opt/cplus}"
API_ORIGIN="${API_ORIGIN:-https://api.c-pay.global}"
SNIPPET_SRC="$REPO/docker/nginx-host/snippets/cpay-security-spa.conf"
SNIPPET_DST="/etc/nginx/snippets/cpay-security-spa.conf"
INCLUDE_LINE="include snippets/cpay-security-spa.conf;"
DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1

[ "$(id -u)" -eq 0 ] || { echo "Ce script doit être lancé en root (sudo)." >&2; exit 1; }
[ -f "$VHOST" ] || { echo "Vhost introuvable : $VHOST (variable VHOST)" >&2; exit 1; }
[ -f "$SNIPPET_SRC" ] || { echo "Snippet introuvable : $SNIPPET_SRC — faites d'abord : git -C $REPO pull" >&2; exit 1; }

echo "Vhost      : $VHOST"
echo "Snippet    : $SNIPPET_SRC -> $SNIPPET_DST"
echo "API origin : $API_ORIGIN"

# 1) snippet
mkdir -p /etc/nginx/snippets
if [ "$DRY" -eq 0 ]; then
  sed "s#https://api.c-pay.global#${API_ORIGIN}#g" "$SNIPPET_SRC" > "$SNIPPET_DST"
  echo "Snippet installé."
else
  echo "[dry-run] snippet non copié."
fi

# 2) insertion dans le vhost (python3 : découpe par blocs server, accolades équilibrées)
NEW="$(mktemp)"
python3 - "$VHOST" "$INCLUDE_LINE" > "$NEW" <<'PY'
import re, sys
path, include = sys.argv[1], sys.argv[2]
src = open(path, encoding='utf-8').read()
HOSTS = re.compile(r'\b(admin|merchant|app|card|partners|bank|agency|agent)\.(dev\.)?c-pay\.global\b')
out, i, n, changed = [], 0, len(src), 0
while True:
    m = re.compile(r'^[ \t]*server\s*\{', re.M).search(src, i)
    if not m:
        out.append(src[i:]); break
    out.append(src[i:m.start()])
    # fin du bloc : accolades équilibrées
    depth, j = 0, m.start()
    while j < n:
        c = src[j]
        if c == '{': depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0: j += 1; break
        j += 1
    block = src[m.start():j]
    sn = re.search(r'^([ \t]*)server_name\s+([^;]+);[ \t]*$', block, re.M)
    if sn and HOSTS.search(sn.group(2)) and include not in block:
        indent = sn.group(1)
        block = block[:sn.end()] + f"\n{indent}{include}  # lot 2 : CSP + en-tetes de securite des SPA" + block[sn.end():]
        changed += 1
        sys.stderr.write(f"  + include ajouté dans le bloc : {sn.group(2).strip()}\n")
    elif sn and HOSTS.search(sn.group(2)):
        sys.stderr.write(f"  = déjà présent : {sn.group(2).strip()}\n")
    out.append(block); i = j
sys.stdout.write(''.join(out))
sys.stderr.write(f"Blocs modifiés : {changed}\n")
PY

if cmp -s "$VHOST" "$NEW"; then
  echo "Aucune modification nécessaire du vhost."
  rm -f "$NEW"
  [ "$DRY" -eq 0 ] && nginx -t && systemctl reload nginx && echo "nginx rechargé (snippet à jour)."
  exit 0
fi

if [ "$DRY" -eq 1 ]; then
  echo "[dry-run] différences qui seraient appliquées :"
  diff -u "$VHOST" "$NEW" || true
  rm -f "$NEW"; exit 0
fi

# 3) sauvegarde, test, rechargement
BACKUP="${VHOST}.bak.$(date +%Y%m%d-%H%M%S)"
cp -a "$VHOST" "$BACKUP"
install -m 0644 "$NEW" "$VHOST"; rm -f "$NEW"
if nginx -t; then
  systemctl reload nginx
  echo "OK : vhost mis à jour (sauvegarde : $BACKUP), nginx rechargé."
  echo "Vérification : curl -sI https://admin.c-pay.global | grep -i content-security-policy"
else
  echo "nginx -t a échoué : restauration de $BACKUP" >&2
  cp -a "$BACKUP" "$VHOST"; nginx -t || true
  exit 1
fi
