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
