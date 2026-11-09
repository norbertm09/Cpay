#!/usr/bin/env bash
# ============================================================================
# C-Pay — remontée d'état des tâches d'exploitation (lot 3, audit 2026-11-02 infra P1-4)
#
#   source "$(dirname "$0")/lib/alert.sh"
#   ops_metric <nom> <valeur> [labels]   écrit une métrique Prometheus dans le répertoire textfile du
#                                        node-exporter (OPS_TEXTFILE_DIR, défaut /var/lib/node_exporter/textfile)
#                                        → alertes BackupStale / HealthcheckFailing / CertificateExpiringSoon
#   ops_alert <alertname> <severity> <summary> [description]
#                                        pousse en plus une alerte immédiate à Alertmanager
#                                        (OPS_ALERTMANAGER_URL, défaut http://127.0.0.1:9093) si joignable
#   ops_heartbeat ok|fail                 ping d'un service de battement de cœur (OPS_HEARTBEAT_URL,
#                                        style healthchecks.io : <url> en succès, <url>/fail en échec)
# Aucune de ces fonctions ne fait échouer l'appelant : la supervision est une aide, pas un point de blocage.
# ============================================================================
OPS_TEXTFILE_DIR="${OPS_TEXTFILE_DIR:-/var/lib/node_exporter/textfile}"
OPS_ALERTMANAGER_URL="${OPS_ALERTMANAGER_URL:-http://127.0.0.1:9093}"

ops_metric() { # ops_metric <nom> <valeur> [labels sans accolades]
  local name="$1" value="$2" labels="${3:-}" file tmp
  mkdir -p "$OPS_TEXTFILE_DIR" 2>/dev/null || return 0
  file="$OPS_TEXTFILE_DIR/${name}.prom"; tmp="$file.$$"
  if [ -n "$labels" ]; then
    # fusionne avec les autres séries du même fichier (labels différents)
    { [ -f "$file" ] && grep -v "^${name}{${labels}}" "$file" || true; printf '%s{%s} %s\n' "$name" "$labels" "$value"; } > "$tmp" 2>/dev/null
  else
    printf '%s %s\n' "$name" "$value" > "$tmp" 2>/dev/null
  fi
  mv -f "$tmp" "$file" 2>/dev/null || rm -f "$tmp"
  return 0
}

ops_alert() { # ops_alert <alertname> <severity> <summary> [description]
  local name="$1" sev="$2" summary="$3" desc="${4:-}" end
  command -v curl >/dev/null 2>&1 || return 0
  end="$(date -u -d '+2 hours' +%FT%TZ 2>/dev/null || date -u -v+2H +%FT%TZ 2>/dev/null || true)"
  curl -fsS --max-time 5 -XPOST "$OPS_ALERTMANAGER_URL/api/v2/alerts" -H 'Content-Type: application/json' \
    -d "[{\"labels\":{\"alertname\":\"$name\",\"severity\":\"$sev\",\"service\":\"cpay-ops\",\"instance\":\"$(hostname)\"},\"annotations\":{\"summary\":\"$summary\",\"description\":\"$desc\"}${end:+,\"endsAt\":\"$end\"}}]" \
    >/dev/null 2>&1 || true
  return 0
}

ops_heartbeat() { # ops_heartbeat ok|fail
  [ -n "${OPS_HEARTBEAT_URL:-}" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  if [ "${1:-ok}" = "ok" ]; then curl -fsS --max-time 10 "$OPS_HEARTBEAT_URL" >/dev/null 2>&1 || true
  else curl -fsS --max-time 10 "$OPS_HEARTBEAT_URL/fail" >/dev/null 2>&1 || true; fi
  return 0
}
