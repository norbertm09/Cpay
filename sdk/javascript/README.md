# @c-pay/sdk — SDK JavaScript/Node.js

SDK officiel **C-Pay** (édité par Calculus Plus SAS) pour Node.js.

## Installation

```bash
npm install @c-pay/sdk
```

## Démarrage rapide

```javascript
const { CPayClient } = require('@c-pay/sdk');

const cpay = new CPayClient({
  apiKey: 'sk_live_votre_cle_api'
  // baseUrl: 'https://api.c-pay.global/api/v1' (défaut)
});

// Encaissement Airtel Money
const txn = await cpay.collection.momo({
  amount: 5000,
  customerPhone: '+242060000001',
  method: 'airtel_money',
  reference: 'CMD-001'
});
console.log(txn.txnId, txn.status);

// Décaissement MTN MoMo
const disb = await cpay.disbursement.momo({
  amount: 10000,
  recipientPhone: '+242055000001',
  operator: 'mtn_momo'
});

// Lien de paiement carte
const link = await cpay.collection.payLink({
  amount: 25000,
  description: 'Facture INV-001',
  psp: 'cybersource'
});
console.log(link.short_url);
```

## Webhooks

C-Pay signe chaque webhook en HMAC-SHA256 (`sha256=<hex>`) dans l'en-tête
`X-CPay-Signature`. L'ancien en-tête `X-CPlus-Signature` est encore envoyé
pendant la période de transition ; `verifyWebhook` accepte directement
`req.headers` et choisit le bon en-tête.

```javascript
const express = require('express');
const { CPayClient } = require('@c-pay/sdk');
const app = express();

// Le corps BRUT est nécessaire pour vérifier la signature
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const valid = CPayClient.verifyWebhook(req.body, req.headers, process.env.CPAY_WEBHOOK_SECRET);
  if (!valid) return res.status(401).end();
  const event = JSON.parse(req.body);
  // Traiter event.txnId de façon idempotente...
  res.sendStatus(200);
});
```

## Migration depuis `@cplus/sdk`

`CPlusClient` et `CPlusError` restent exportés comme alias de `CPayClient`
et `CPayError` : aucun changement de code n'est requis, seul le nom du
paquet change (`npm install @c-pay/sdk`).

## API Reference

Voir https://c-pay.global/developers

## Support

dev@c-pay.global
