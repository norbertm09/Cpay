# CPLUS 2.6.0 - Runbook production pilot control

Ce runbook permet de lancer la version 2.3 en production pilote, avec controle par marchands, feature flags et rollback rapide.

## Mode recommande

1. Demarrer en `PILOT_CONTROL_MODE=audit`.
2. Enroler uniquement les marchands pilotes.
3. Tester QR Code, Pay by Link, Tap to Phone, Tokenization, CRM export et ticketing.
4. Basculer en `PILOT_CONTROL_MODE=enforce` apres validation des controles.

## Commandes

```bash
npm install
npm run check:prod
npm run migrate
npm run check:pilot
npm test
```

## Endpoints de pilotage

| Usage | Endpoint |
| --- | --- |
| Programmes pilotes | `GET /api/v1/admin/pilot/programs` |
| Creer/mettre a jour un programme | `POST /api/v1/admin/pilot/programs` |
| Enroler un marchand | `POST /api/v1/admin/pilot/programs/:pilotKey/enroll` |
| Feature flags | `GET /api/v1/admin/pilot/features` |
| Modifier un flag | `PUT /api/v1/admin/pilot/features/:flagKey` |
| Override marchand | `PUT /api/v1/admin/pilot/features/:flagKey/merchants/:merchantId` |
| Etat pilote marchand | `GET /api/v1/admin/pilot/merchants/:merchantId` |
| Evaluation manuelle | `POST /api/v1/admin/pilot/evaluate` |
| Readiness | `GET /api/v1/admin/pilot/readiness` |
| Vue marchand | `GET /api/v1/merchant/pilot/state` |

## Rollback

Desactiver une fonction sans redeployer:

```http
PUT /api/v1/admin/pilot/features/tap_to_phone
Authorization: Bearer <admin_token>
Content-Type: application/json

{
  "status": "disabled",
  "defaultEnabled": false,
  "pilotOnly": true,
  "rolloutPercent": 0
}
```

## Go / no-go

Le pilote peut passer en `enforce` lorsque:

- `npm run check:prod` passe.
- `npm run check:pilot` passe.
- Les providers pays pilotes sont testes dans `/api/v1/admin/api-configs/:key/test`.
- Les endpoints `/live`, `/ready`, `/health` sont supervises.
- Le circuit support/ticketing est operationnel.
- Le plan rollback par feature flag est valide.
