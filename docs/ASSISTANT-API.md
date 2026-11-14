# Contrat API — Assistant, leads et réclamations (vague 2)

Base : `https://api.c-pay.global/api/v1`. Toutes les réponses sont en JSON sauf le flux SSE.
Erreurs : `{ "error": "<message>", "code": "<CODE>", "details?": [{ "path", "message" }] }`.

Origines autorisées (CORS) : `https://c-pay.global`, `https://www.c-pay.global` (+ portails).

## 1. Assistant conversationnel (public, sans authentification)

Désactivé (`503 ASSISTANT_DISABLED`) tant que `ANTHROPIC_API_KEY` n'est pas défini.

| Méthode | Route | Limite |
|---|---|---|
| POST | `/public/assistant/conversations` | 10 / 15 min / IP |
| GET | `/public/assistant/conversations/{id}` | — |
| POST | `/public/assistant/conversations/{id}/messages` | 30 / 5 min / IP, 120 messages / conversation |

### POST `/public/assistant/conversations`
Corps optionnel : `{ "source": "landing", "page": "/" }`.
Réponse `201` : `{ "conversationId": "<uuid>" }`.

### GET `/public/assistant/conversations/{id}`
Réponse `200` : `{ "conversationId", "messages": [{ "id", "role": "user|assistant", "text", "at" }] }`.
`404 NOT_FOUND` si l'identifiant est inconnu (le client doit alors recréer une conversation).

### POST `/public/assistant/conversations/{id}/messages`
Corps : `{ "message": "<1 à 4000 caractères>" }`.

**Mode flux (défaut)** : réponse `text/event-stream`, un commentaire `: ping` toutes les 15 s.

| event | data |
|---|---|
| `token` | `{ "text": "<delta>" }` — fragment de la réponse, à concaténer |
| `tool` | `{ "name": "create_lead|create_claim|request_human_handoff", "status": "start|done", "summary?" }` |
| `done` | `{ "messageId", "leadId?", "claimId?", "claimReference?": "REC-XXXXXX", "handoff?": true }` |
| `error` | `{ "code": "ASSISTANT_ERROR|ASSISTANT_DISABLED|…", "message" }` |

**Mode JSON** : `?stream=0` → `200 { "reply", "messageId", "leadId?", "claimId?", "claimReference?", "handoff?" }`.
`422 VALIDATION_ERROR`, `429 CONVERSATION_LIMIT`, `502 ASSISTANT_ERROR`.

## 2. Formulaires directs (public, 5 / 15 min / IP)

Champ pot-de-miel `website` : s'il est renseigné la requête est acceptée (`201`) mais ignorée.

### POST `/public/leads`
```json
{ "name": "…", "email": "…", "phone?": "+242…", "company?": "…", "country?": "CG",
  "interest?": "merchant|partner|developer|other", "message?": "…", "source?": "landing", "consent": true }
```
Réponse `201` : `{ "leadId": "<uuid>" }`. `422 VALIDATION_ERROR` avec `details` par champ.

### POST `/public/claims`
```json
{ "name": "…", "email": "…", "phone?": "+242…", "merchantRef?": "…", "transactionRef?": "MOB-ABC123",
  "category": "payment|settlement|account|fraud|other", "description": "<≥ 10 caractères>", "consent": true }
```
E-mail valide **ou** téléphone requis. Réponse `201` : `{ "claimId": "<uuid>", "reference": "REC-XXXXXX" }`.
La référence est à communiquer au support (`support@c-pay.global`).

## 3. Administration CRM (JWT admin, rôles `super_admin`, `ops_admin`, `support_agent`)

| Méthode | Route | Description |
|---|---|---|
| GET | `/admin/crm/stats` | compteurs leads/réclamations/conversations |
| GET | `/admin/crm/leads?status&q&limit&offset` | liste paginée |
| PATCH | `/admin/crm/leads/{id}` | `{ "status": "new|contacted|qualified|converted|lost", "notes?" }` |
| GET | `/admin/crm/claims?status&category&q&limit&offset` | liste paginée |
| PATCH | `/admin/crm/claims/{id}` | `{ "status": "open|in_progress|resolved|closed", "assignedTo?", "resolution?" }` |
| GET | `/admin/crm/conversations?limit&offset` | conversations de l'assistant |
| GET | `/admin/crm/conversations/{id}` | détail + messages |

## 4. Variables d'environnement

| Variable | Rôle |
|---|---|
| `ANTHROPIC_API_KEY` | active l'assistant |
| `ASSISTANT_MODEL` | défaut `claude-opus-5-5` |
| `ASSISTANT_FALLBACKS` | `default` (repli serveur) ou `off` |

Tables : `assistant_conversations`, `assistant_messages`, `crm_leads`, `crm_claims` (`backend/database/008_wave2.sql`).

## 5. Activation en production (14 novembre 2026)

L'implémentation est complète et vérifiée (SDK Anthropic 1.x, modèle `claude-opus-5-5` à effort bas, repli serveur en cas
de refus de politique, outils stricts `create_lead` / `create_claim` / `request_human_handoff`, prompt système mis en
cache, flux SSE non tamponné par nginx grâce à `X-Accel-Buffering: no`, widget `portal/landing/assistant.js` chargé par
la vitrine). Il ne manque que la clé API sur le serveur :

1. Créer une clé API dans la console Anthropic (espace de travail dédié « C-Pay vitrine », limite de dépense mensuelle).
2. Sur le serveur, sans la coller dans un chat ni un ticket :
   ```sh
   cd /opt/cplus
   ./scripts/rotate-secrets.sh set ANTHROPIC_API_KEY        # saisie masquée, écriture atomique dans backend/.env
   ./scripts/deploy.sh --skip-backup --skip-migrations      # bascule bleu/vert : l'API relit .env sans coupure
   history -c
   ```
   Facultatif : `ASSISTANT_MODEL` (défaut `claude-opus-5-5`), `ASSISTANT_FALLBACKS=off` pour désactiver le repli serveur.
3. Vérifier :
   ```sh
   ./scripts/check-go-live-cg.sh | grep -i assistant        # « activé — modèle … »
   C=$(curl -s -X POST https://api.c-pay.global/api/v1/public/assistant/conversations -H 'Content-Type: application/json' -d '{"source":"test"}' | sed 's/.*"conversationId":"\([^"]*\)".*/\1/')
   curl -s -X POST "https://api.c-pay.global/api/v1/public/assistant/conversations/$C/messages?stream=0" -H 'Content-Type: application/json' -d '{"message":"Quels moyens de paiement sont disponibles au Congo ?"}'
   ```
   La réponse JSON contient `reply`. Puis, sur `https://c-pay.global`, ouvrir l'assistant en bas à droite et poser la même
   question ; la conversation apparaît dans le back-office admin (CRM → Conversations) avec les jetons consommés.
4. Suivi : `docker logs cplus-api-<couleur> --since 1h | grep -i assistant` (erreurs `ASSISTANT_ERROR`), consommation dans
   la console Anthropic, leads et réclamations créés par l'assistant dans le CRM. Limites : 10 conversations / 15 min / IP,
   30 messages / 5 min / IP, 120 messages par conversation.
5. Désactiver : `./scripts/rotate-secrets.sh unset ANTHROPIC_API_KEY` puis redéploiement ; la vitrine masque le widget sur
   `503 ASSISTANT_DISABLED`.
