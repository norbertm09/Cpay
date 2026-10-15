# @cplus/sdk — SDK JavaScript/Node.js

SDK officiel CPlus pour Node.js et le navigateur.

## Installation

```bash
npm install @cplus/sdk
```

## Démarrage rapide

```javascript
const { CPlusClient } = require('@cplus/sdk');

const cplus = new CPlusClient({
  apiKey: 'sk_live_votre_cle_api'
});

// Encaissement Airtel Money
const txn = await cplus.collection.momo({
  amount: 5000,
  customerPhone: '+242060000001',
  method: 'airtel_money',
  reference: 'CMD-001'
});
console.log(txn.txnId, txn.status);

// Décaissement MTN MoMo
const disb = await cplus.disbursement.momo({
  amount: 10000,
  recipientPhone: '+242055000001',
  operator: 'mtn_momo'
});

// Lien de paiement carte
const link = await cplus.collection.payLink({
  amount: 25000,
  description: 'Facture INV-001',
  psp: 'cybersource'
});
console.log(link.short_url);

// Vérifier webhook
const valid = CPlusClient.verifyWebhook(
  JSON.stringify(req.body),
  req.headers['x-cplus-signature'],
  process.env.CPLUS_WEBHOOK_SECRET
);
```

## API Reference

Voir https://api.c-pay.global/api/v1/docs/

## Support

dev@c-pay.global
