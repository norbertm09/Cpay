# Vague 2 — refonte produit « C-Pay par Calculus Plus » (branche `wave-2`)

Base : `prod-hotfix-v1` (2.6.0 + vague 1). Backend : 18 suites / 446 tests verts. Rien n'est fusionné dans `main`.

## 1. Ce qui change

### Paiements Mobile Money (audit 02-§4)
- `services/detection/detection.engine.js` réécrit : préfixes par pays dérivés d'une table unique, numéros locaux avec 0 initial, `detectFromPhone(phone, { defaultCountry, operatorOverride })`, `alternatives` (Wave, Express Union = au choix du client).
- Webhooks opérateurs réels dans `routes/webhooks-mm.routes.js` : Orange, Wave (HMAC), Africell, Express Union, Free Money, Moov. Fail-closed (signature / jeton obligatoire, re-interrogation du statut opérateur quand elle existe), claim atomique `status='pending'`, contrôle montant/devise, rejeu idempotent. Chemin secret `POST /api/v1/webhooks/<WEBHOOK_PATH_SECRET>/:provider` + chemins historiques `/webhooks/*`.
- Secrets providers chiffrés au repos (AES-256-GCM, préfixe `enc:v1:`) : `config/secrets.js`, script `scripts/encrypt-api-configs.js`, `PUT /admin/api-configs/:key` chiffre à l'écriture.
- Idempotence : plus de persistance des 5xx, purge TTL (`IDEMPOTENCY_TTL_HOURS`).
- `rails.routes.js` réservé à `super_admin`/`ops_admin`, refus de tout PAN en clair (`RAW_PAN_NOT_ALLOWED`).
- L'orchestrateur enregistre `transactions.pay_link_id` : un lien de paiement est marqué `paid` par le webhook.

### Authentification unifiée (audit §1.1, §2.11-2.20)
- Un seul `middleware/auth.js` : JWT d'accès 15 min avec `iss`/`aud`, refresh opaque hashé en base avec rotation et détection de réutilisation (révocation globale), cookie `cp_rt_<portail>` HttpOnly/Secure/SameSite=Strict.
- 2FA TOTP au login pour marchands, admins, porteurs, partenaires (`{ mfaRequired, mfaToken }` → `POST …/auth/2fa/validate { mfaToken, code }`).
- `mustChangePassword` pour les mots de passe temporaires, verrouillage partenaires après 10 échecs, `/auth/me`, `/auth/change-password`, `/auth/refresh` + `/auth/logout` sur tous les portails.
- Les anciens refresh JWT (7 j) restent acceptés jusqu'à `AUTH_LEGACY_REFRESH_UNTIL` (défaut 2026-11-15) pour ne pas déconnecter les utilisateurs au déploiement.

### Vitrine interactive + assistant + CRM (demande produit)
- `portal/landing/` réécrite : accueil, page développeurs, pages légales, 404, démo de détection d'opérateur, simulateur de frais, formulaires de contact et de réclamation, widget de chat. Logo Calculus Plus, marque « C-Pay par Calculus Plus », plus aucune mention « CPlus » produit, aucun APK.
- Assistant (`services/assistant/`) : Claude via le SDK officiel (`claude-opus-5-5`), base de connaissances factuelle (`knowledge.js`), outils `create_lead`, `create_claim` (référence `REC-XXXXXX`), `request_human_handoff`, flux SSE. Contrat : `docs/ASSISTANT-API.md`.
- Formulaires publics `POST /api/v1/public/leads` et `/claims` (limités, pot-de-miel anti-bot).
- Admin CRM `/api/v1/admin/crm/*` (rôles `super_admin`, `ops_admin`, `support_agent`) et pages `/crm/leads`, `/crm/complaints`, `/crm/conversations` dans le portail admin.
- Service nginx `landing` (compose) servant `c-pay.global` / `www.c-pay.global` avec CSP `connect-src https://api.c-pay.global` ; CORS API étendu à ces origines.

### Portails React (7)
- Passe de marque complète (favicons, logo SVG, méta, pages de téléchargement sans APK), liens légaux vers `c-pay.global/legal/*`.
- Alignement sur les contrats hotfix-v1 et vague 2 : 2FA au login, changement de mot de passe forcé, secrets masqués (`{configured,last4}`), secret webhook affiché une seule fois, badge « ancienne génération » sur les clés API, fonctions désactivées (410) affichées comme « en cours d'intégration », réconciliation des pending depuis l'admin.
- `portal/merchant/package-lock.json` régénéré (`npm ci` échouait).

## 2. Variables d'environnement

| Variable | Obligatoire | Rôle |
|---|---|---|
| `CONFIG_ENCRYPTION_KEY` | **oui** (prod) | 32 octets hex (`openssl rand -hex 32`) — chiffrement des `api_configurations` |
| `WEBHOOK_PATH_SECRET` | **oui** (prod) | segment secret des URLs de webhooks (`openssl rand -hex 24`) |
| `WAVE_WEBHOOK_SECRET` | si Wave | secret HMAC fourni par Wave |
| `<PROVIDER>_WEBHOOK_TOKEN` | si chemins legacy | jeton `X-Webhook-Token` (Africell, Express Union, Free Money, Moov) ; sinon `extra_params.webhookToken` en base |
| `ANTHROPIC_API_KEY` | recommandé | active l'assistant (sinon 503 `ASSISTANT_DISABLED`, le chat affiche le repli e-mail) |
| `ASSISTANT_MODEL` | non | défaut `claude-opus-5-5` |
| `ASSISTANT_FALLBACKS` | non | `default` (repli serveur Anthropic) ou `off` |
| `IDEMPOTENCY_TTL_HOURS` | non | défaut 24 |
| `JWT_ISSUER` / `JWT_AUDIENCE` | non | défauts `api.c-pay.global` / `c-pay` |
| `JWT_REFRESH_TTL_DAYS` / `JWT_REFRESH_TTL_DAYS_ADMIN` | non | 30 / 7 |
| `AUTH_LEGACY_REFRESH_UNTIL` | non | fin d'acceptation des anciens refresh JWT (ISO 8601) |
| `COOKIE_SECURE` | non | `false` uniquement en développement http |

`COOKIE_DOMAIN` n'est plus lu. `node scripts/check-production-env.js` refuse de démarrer sans les deux variables obligatoires.

## 3. Déploiement

Script tout-en-un (étapes 1 à 5 ci-dessous, idempotent, `--dry-run` pour prévisualiser) :

```bash
cd /opt/cplus && git fetch origin && git checkout main && git pull origin main
./scripts/deploy-wave-2.sh --dry-run && ./scripts/deploy-wave-2.sh
```

Ou manuellement :

```bash
cd /opt/cplus && git fetch origin && git checkout wave-2
./scripts/backup-db.sh --label pre-wave-2
# 1. compléter backend/.env (§2) puis vérifier
cd backend && node scripts/check-production-env.js && cd ..
# 2. migration 008 (idempotente : colonnes 2FA/temp_password, refresh_tokens TEXT, pay_link_id, tables CRM)
cd docker && docker compose run --rm --no-deps -e RUN_MIGRATIONS=false api node src/config/migrate.js
# 3. chiffrer les secrets providers déjà en base (idempotent ; --dry-run d'abord)
docker compose run --rm --no-deps api node scripts/encrypt-api-configs.js --dry-run
docker compose run --rm --no-deps api node scripts/encrypt-api-configs.js
# 4. reconstruire et relancer
docker compose build api landing admin-portal merchant-portal cardholder-portal partners-portal
docker compose up -d
# 5. vérifications
curl -s https://api.c-pay.global/health
curl -s -o /dev/null -w '%{http_code}\n' https://c-pay.global/            # 200
curl -s -X POST https://api.c-pay.global/api/v1/public/assistant/conversations -H 'Content-Type: application/json' -d '{"source":"check"}'
```

Puis :
1. Déclarer chez chaque opérateur l'URL de webhook `https://api.c-pay.global/api/v1/webhooks/<WEBHOOK_PATH_SECRET>/<provider>` (Wave : enregistrer le secret HMAC ; Orange : `notif_url` historique `/webhooks/orange` reste valide).
2. Reporter sur le nginx de l'hôte le vhost `c-pay.global` de `docker/nginx.conf` (certificat Let's Encrypt pour `c-pay.global` et `www.c-pay.global`).
3. Compléter les champs en jaune des pages légales (`portal/landing/legal/*`) : capital, RCS/RCCM, siège, directeur de la publication, droit applicable, durées de conservation.
4. Réconcilier les transactions Orange initiées avant le déploiement (`POST /api/v1/admin/reconcile`).

## 4. Impacts visibles / points d'attention
- Jetons d'accès à 15 min partout : les apps natives (Android, Expo) doivent appeler `/auth/refresh` ; elles ne sont pas mises à jour dans cette vague.
- `partnerAuth` n'accepte plus les JWT du portail distribution ; `card2momo` n'accepte plus les JWT marchand/admin.
- Rate limiters en mémoire : un seul nœud API, sinon prévoir un store partagé.
- `PATCH /admin/crm/leads|claims/:id` ne permet pas de désassigner (COALESCE).
- `/merchant/public/collect` reste en 410 : la page développeurs l'annonce « bientôt », ouverture pays par pays avec les opérateurs.
- Préfixes `verified:false` dans `detection.engine.js` à confirmer avec les opérateurs.
- Toujours à faire côté compte : rotation du mot de passe Cloud DB, suppression de la branche `ovh-prod-snapshot`, révocation du PAT, dépôt privé.
