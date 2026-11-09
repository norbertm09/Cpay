#!/usr/bin/env sh
# ================================================================
# Déploiement vague 2 — C-Pay (serveur OVH, /opt/cplus)
#   ./scripts/deploy-wave-2.sh [--dry-run] [--skip-backup]
#
# Enchaîne : variables d'environnement (génération des secrets manquants),
# sauvegarde pg_dump, migration 008, chiffrement des secrets opérateurs,
# build + relance des conteneurs, contrôles de santé.
# Idempotent : relançable sans risque (migration et chiffrement le sont).
# --dry-run  : ne modifie rien (affiche ce qui serait fait, chiffrement en --dry-run).
# ================================================================
set -eu

DRY=0; SKIP_BACKUP=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --skip-backup) SKIP_BACKUP=1 ;;
    *) echo "Option inconnue : $a" >&2; exit 2 ;;
  esac
done

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
ENV_FILE="$ROOT/backend/.env"
cd "$ROOT"

say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
fail() { printf '\033[1;31mERREUR : %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || fail "backend/.env introuvable (voir docs/WAVE-2.md §2)"
[ "$DRY" = 1 ] || command -v docker >/dev/null || fail "docker introuvable"
command -v openssl >/dev/null || fail "openssl introuvable"

# ── 1. Variables d'environnement ─────────────────────────────────
say "1/6 Variables d'environnement ($ENV_FILE)"

env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r"'"'"; }

ensure_secret() { # ensure_secret NOM OCTETS
  v="$(env_get "$1")"
  case "$v" in
    ""|REQUIRED|change_me|changeme|your_*)
      if [ "$DRY" = 1 ]; then warn "$1 absent : serait généré (openssl rand -hex $2)"; return; fi
      printf '\n# vague 2 — généré le %s par deploy-wave-2.sh\n%s=%s\n' "$(date -u +%FT%TZ)" "$1" "$(openssl rand -hex "$2")" >> "$ENV_FILE"
      echo "  + $1 généré et ajouté" ;;
    *) echo "  = $1 présent" ;;
  esac
}
ensure_secret CONFIG_ENCRYPTION_KEY 32   # AES-256-GCM, 64 hex
ensure_secret WEBHOOK_PATH_SECRET 24     # segment d'URL des webhooks, 48 hex

if [ -z "$(env_get ANTHROPIC_API_KEY)" ]; then
  warn "ANTHROPIC_API_KEY absent : l'assistant de la vitrine restera désactivé (503), le chat affichera le repli e-mail"
else
  echo "  = ANTHROPIC_API_KEY présent (assistant actif)"
fi

origins="$(env_get ALLOWED_ORIGINS)"
if [ -n "$origins" ]; then
  case "$origins" in
    *https://c-pay.global*) echo "  = ALLOWED_ORIGINS contient c-pay.global" ;;
    *)
      if [ "$DRY" = 1 ]; then warn "ALLOWED_ORIGINS : https://c-pay.global,https://www.c-pay.global seraient ajoutés"
      else
        printf '\n# vague 2 — vitrine\nALLOWED_ORIGINS=%s,https://c-pay.global,https://www.c-pay.global\n' "$origins" >> "$ENV_FILE"
        echo "  + ALLOWED_ORIGINS étendu à c-pay.global / www.c-pay.global"
      fi ;;
  esac
fi
chmod 600 "$ENV_FILE" 2>/dev/null || true

say "   Contrôle check-production-env"
( cd backend && [ -d node_modules ] || npm ci --omit=dev --silent )
if [ "$DRY" = 1 ]; then ( cd backend && node scripts/check-production-env.js ) || warn "(dry-run) variables manquantes : seraient générées ci-dessus"
else ( cd backend && node scripts/check-production-env.js ) || fail "variables obligatoires manquantes"; fi

# ── 2. Sauvegarde ────────────────────────────────────────────────
say "2/6 Sauvegarde de la base"
if [ "$SKIP_BACKUP" = 1 ]; then warn "sauvegarde ignorée (--skip-backup)"
elif [ "$DRY" = 1 ]; then echo "  (dry-run) ./scripts/backup-db.sh --label pre-wave-2"
else
  command -v pg_dump >/dev/null || fail "pg_dump introuvable : apt install -y postgresql-client (ou --skip-backup à vos risques)"
  ./scripts/backup-db.sh --label pre-wave-2
fi

# ── 3. Image API + migration 008 ─────────────────────────────────
cd "$ROOT/docker"
say "3/6 Construction de l'image API"
[ "$DRY" = 1 ] && echo "  (dry-run) docker compose build api" || docker compose build api

say "   Migration 008_wave2 (idempotente)"
if [ "$DRY" = 1 ]; then echo "  (dry-run) docker compose run --rm --no-deps -e RUN_MIGRATIONS=false api node src/config/migrate.js"
else docker compose run --rm --no-deps -e RUN_MIGRATIONS=false api node src/config/migrate.js; fi

# ── 4. Chiffrement des secrets opérateurs ───────────────────────
say "4/6 Chiffrement des secrets api_configurations (enc:v1:)"
if [ "$DRY" = 1 ]; then echo "  (dry-run) docker compose run --rm --no-deps -e RUN_MIGRATIONS=false api node scripts/encrypt-api-configs.js --dry-run"
else
  docker compose run --rm --no-deps -e RUN_MIGRATIONS=false api node scripts/encrypt-api-configs.js --dry-run
  docker compose run --rm --no-deps -e RUN_MIGRATIONS=false api node scripts/encrypt-api-configs.js
fi

# ── 5. Reconstruction et relance ────────────────────────────────
say "5/6 Build des portails + vitrine et relance des services"
if [ "$DRY" = 1 ]; then echo "  (dry-run) docker compose build && docker compose up -d --remove-orphans"
else
  docker compose build
  docker compose up -d --remove-orphans
  docker compose ps
fi

# ── 6. Contrôles ─────────────────────────────────────────────────
say "6/6 Contrôles de santé"
if [ "$DRY" = 1 ]; then echo "  (dry-run) contrôles ignorés"; else
  i=0; until curl -fsS http://127.0.0.1:3001/health >/dev/null 2>&1 || [ $i -ge 30 ]; do i=$((i+1)); sleep 2; done
  curl -fsS http://127.0.0.1:3001/health && echo || warn "API /health KO sur 127.0.0.1:3001 (vérifier docker compose logs api)"
  code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3006/)"
  [ "$code" = 200 ] && echo "  vitrine (landing:3006) : 200" || warn "vitrine : HTTP $code"
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{"source":"deploy-check"}' http://127.0.0.1:3001/api/v1/public/assistant/conversations)"
  case "$code" in
    201) echo "  assistant : actif (201)" ;;
    503) warn "assistant : désactivé (503) — ANTHROPIC_API_KEY absent" ;;
    *)   warn "assistant : HTTP $code" ;;
  esac
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3001/webhooks/wave)"
  [ "$code" = 401 ] || [ "$code" = 400 ] && echo "  webhooks MM : montés (HTTP $code sans signature, attendu)" || warn "webhooks MM : HTTP $code"
fi

secret="$(env_get WEBHOOK_PATH_SECRET)"
cat <<TXT

Terminé. Reste à faire manuellement :
  1. nginx hôte : vhost c-pay.global / www.c-pay.global → 127.0.0.1:3006 (modèle : docker/nginx.conf), certificat Let's Encrypt.
  2. Opérateurs : déclarer l'URL de webhook
       https://api.c-pay.global/api/v1/webhooks/${secret:-<WEBHOOK_PATH_SECRET>}/<orange|wave|africell|express_union|free_money|moov>
     (Wave : enregistrer WAVE_WEBHOOK_SECRET ; Orange : notif_url historique /webhooks/orange toujours valide).
  3. Pages légales : compléter les champs en jaune de portal/landing/legal/*.
  4. Transactions Orange antérieures : POST /api/v1/admin/reconcile {"maxAgeHours":24} depuis le portail admin.
TXT
