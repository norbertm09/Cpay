# Webhooks sortants C-Pay — signature et en-têtes (vague 3)

Référence pour les développeurs marchands (page développeurs de la vitrine) et pour les intégrations
(`merchant_integrations`). Implémentation unique : `backend/src/services/webhooks/outgoing.js`.

## 1. Quand C-Pay appelle votre serveur

| Émetteur | Événements (`X-CPay-Event`) | Secret utilisé |
|---|---|---|
| Webhook marchand (`PATCH /api/v1/merchant/webhook-config`, test via `POST …/webhook-config/test`) | `payment.completed`, `payment.failed`, `webhook.test` | `webhook_secret` du marchand (affiché une seule fois à la création) |
| Intégration marchand (`merchant_integrations`, type `webhook`) | `transaction.authorized`, `transaction.failed`, `transaction.pending`, `settlement.completed` | `signing_secret` de l'intégration |

Contraintes côté C-Pay : URL `https://` obligatoire, hôtes privés / loopback / métadonnées refusés, délai
maximal 10 s, pas de suivi de redirection. Le webhook marchand est retenté 3 fois (5 s, 10 s) sur une
réponse 5xx ou une erreur réseau ; répondez `2xx` dès que le message est accepté (traitez en asynchrone).

## 2. En-têtes envoyés

```
Content-Type:      application/json
User-Agent:        CPay-Webhooks/1.0
X-CPay-Event:      payment.completed
X-CPay-Signature:  sha256=3f1a…c9   ← à vérifier
X-CPay-Timestamp:  2026-10-15T09:12:33.120Z   (informatif, non signé)
X-CPlus-Event:     payment.completed            (transition, sera retiré)
X-CPlus-Signature: …                            (transition, sera retiré)
```

Les en-têtes `X-CPlus-*` sont conservés provisoirement avec leur format historique (`sha256=<hex>` pour
les webhooks marchands, hex nu pour les intégrations) pour ne casser aucun consommateur existant.
**Nouvelles intégrations : n'utilisez que `X-CPay-Signature`.** Date de retrait prévue : annoncée sur la
page développeurs, au plus tôt 90 jours après la mise en production de la vague 3.

## 3. Algorithme de signature

```
signature = "sha256=" + hex( HMAC-SHA256( key = secret, message = corps brut de la requête ) )
```

- Le message est **le corps exactement tel qu'il est reçu** (octets UTF-8), pas une re-sérialisation :
  ne pas parser puis `JSON.stringify` avant de vérifier.
- Hex en minuscules, préfixe `sha256=`.
- Comparez en temps constant (`crypto.timingSafeEqual`, `hmac.compare_digest`, `hash_equals`).
- `X-CPay-Timestamp` n'entre pas dans le calcul (il n'y a pas, à ce stade, de fenêtre anti-rejeu : utilisez
  `txnId` pour l'idempotence côté récepteur).

### Node.js

```js
const crypto = require('crypto');
app.post('/cpay/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const given = String(req.get('X-CPay-Signature') || '').replace(/^sha256=/, '');
  const expected = crypto.createHmac('sha256', process.env.CPAY_WEBHOOK_SECRET).update(req.body).digest('hex');
  if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
    return res.status(401).end();
  }
  const event = JSON.parse(req.body);   // { event, txnId, reference, amount, currency, status, method, authCode, timestamp }
  res.status(200).end();                // puis traitement asynchrone, idempotent sur event.txnId
});
```

### PHP

```php
$raw = file_get_contents('php://input');
$given = preg_replace('/^sha256=/', '', $_SERVER['HTTP_X_CPAY_SIGNATURE'] ?? '');
$expected = hash_hmac('sha256', $raw, $secret);
if (!hash_equals($expected, $given)) { http_response_code(401); exit; }
```

### Python

```python
import hmac, hashlib
expected = hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
given = request.headers.get("X-CPay-Signature", "").removeprefix("sha256=")
if not hmac.compare_digest(expected, given): abort(401)
```

## 4. Corps des messages

Webhook marchand (`payment.*`) :

```json
{ "event": "payment.completed", "txnId": "…uuid…", "reference": "REF-001", "amount": 5000, "currency": "XAF",
  "status": "authorized", "method": "mobile_money", "authCode": "FT123", "timestamp": "2026-10-15T09:12:33.120Z" }
```

Intégration (`transaction.*`, `settlement.*`) :

```json
{ "eventType": "transaction.authorized", "merchantId": "…uuid…", "payload": { … }, "sentAt": "2026-10-15T09:12:33.120Z" }
```

`webhook.test` a la même forme que `payment.*` avec `txnId` préfixé `test-`.

## 5. Côté C-Pay (pour mémoire)

`services/webhooks/outgoing.js` expose `buildHeaders({ secret, rawBody, event, legacyPrefixed })`,
`signatureHeader(secret, rawBody)` et `verifySignature(secret, rawBody, header)` ; les trois émetteurs
(`services/integrations/integration.service.js`, `routes/merchant.routes.js` test de webhook,
`routes/webhook-handlers.js` `triggerMerchantWebhook`) l'utilisent. Retirer les en-têtes `X-CPlus-*` =
passer `legacy:false` (ou supprimer le bloc `legacy` du helper) et mettre à jour cette page.
