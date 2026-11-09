# Scripts historiques (lot 7, audit 2026-11-02 infra P2-13)

Ces scripts datent des architectures précédentes (nginx conteneurisé, PostgreSQL local, vague 2) et **ne doivent pas
être lancés sur la production 2.7** (nginx hôte, base OVH managée, `scripts/deploy.sh`). Ils sont conservés pour
lecture ; `scripts/deploy-prod.sh` (service `postgres` inexistant) a été supprimé.

| Script | Remplacé par |
|--------|--------------|
| `deploy-ovh.sh`, `deploy-wave-2.sh` | `scripts/deploy.sh` (lancé par `deploy.yml`), `scripts/deploy.sh --rollback` |
| `init-ovh.sh` | `scripts/init-vps.sh` + `scripts/harden-host.sh` + `scripts/setup-deploy-user.sh` |
| `init-tls.sh`, `renew-tls.sh` | certbot de l'hôte (`certbot.timer`, hook `reload-nginx.sh` posé par `init-vps.sh`), `scripts/cert-expiry-metric.sh` |

La CI ne vérifie plus leur syntaxe (`ci.yml`, job « Versions et scripts » : `scripts/*.sh` seulement).
