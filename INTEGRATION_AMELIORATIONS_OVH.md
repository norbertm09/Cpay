# Integration des ameliorations OVH

Date: 2026-06-13  
Version: `2.6.0-production-ovh`

## Corrections integrees

- Alignement des packages backend, admin portal, merchant portal et mobile sur `2.6.0`.
- Ajout de `backend/package-lock.json` pour rendre `npm ci` et le build Docker API reproductibles.
- Mise a jour de `uuid` vers `^11.1.1`; `npm audit --omit=dev` retourne 0 vulnerabilite.
- Correction du role support: `support_admin` remplace par `support_agent`, conforme a l'enum SQL.
- Correction de `scripts/init-ovh.sh`: heredoc Fail2ban nettoye.
- Suppression du dossier parasite `{ovh,monitoring`.
- Suppression de la documentation de compte admin par defaut.
- Ajout de `backend/scripts/create-first-admin.js` et du script `npm run create:first-admin`.
- Ajout de `scripts/renew-tls.sh` versionne.
- Ajout d'Alertmanager dans `docker/docker-compose.yml`.
- Ajout de `monitoring/alertmanager/alertmanager.yml`.
- Protection du scrape Prometheus par fichier secret `docker/secrets/metrics_token`.
- Mise a jour de `scripts/deploy-ovh.sh` pour generer le secret metrics, charger `.env`, verifier PostgreSQL avec les bonnes variables, executer les migrations sans double-run, verifier l'API dans le reseau Docker et demarrer Nginx apres API/portails.
- Ajout endpoint interne `/internal/alerts/prometheus` pour receptionner les alertes Alertmanager.
- Renforcement de `check-production-env.js` via `env.js`: `METRICS_TOKEN`, `GRAFANA_PASSWORD`, `CERTBOT_EMAIL` deviennent obligatoires en production.

## Validations realisees

- `npm test`: 71 tests backend passes.
- `node --check`: fichiers backend et scripts Node critiques OK.
- `npm audit --omit=dev`: 0 vulnerabilite.
- Verification archive: lockfile, Alertmanager, renew TLS, runbook et absence de `node_modules`.

## Points a valider sur serveur Linux OVH

- `bash -n scripts/*.sh docker/api-entrypoint.sh`.
- `docker compose --env-file ../backend/.env config`.
- Obtention TLS Let's Encrypt.
- Test de restauration backup PostgreSQL.
- Test de creation du premier admin avec `npm run create:first-admin`.
