# CPlus 2.6.0 Mobile

Application mobile Android et iOS pour interagir avec la plateforme CPlus 2.6.0.

## Fonctions incluses

- Connexion marchand et administrateur.
- Self-registration marchand.
- Encaissement Mobile Money / carte via `/api/v1/collect`.
- Retrait via `/api/v1/payout`.
- QR Code de paiement avec rendu visuel.
- Pay Link avec partage natif, WhatsApp, SMS, copie et envoi serveur WhatsApp/SMPP.
- Historique transactions.
- Règlements.
- Compte marchand.
- Rails Visa:
  - Visa Direct push funds.
  - Visa Direct pull funds.
  - Visa Account and Wallet payout.
  - Query payout.
- Administration mobile:
  - Liste et test des APIs.
  - Defaults APIs par pays.
  - Création marchand avec affectation automatique des APIs pays.
  - Liste marchands.
  - Monitoring activité et statistiques.

## Domaine par défaut

```text
API: https://api.c-pay.global
Admin portal: https://admin.c-pay.global
Merchant portal: https://merchant.c-pay.global
Pay links: https://pay.c-pay.global
```

## Lancer en développement

```bash
npm install
npm run start
```

Puis ouvrir sur Android ou iOS via Expo.

## Générer Android

```bash
npm run android
```

Ou via EAS:

```bash
npm run build:android
```

## Générer iOS

Un build iOS nécessite macOS/Xcode localement, ou EAS Build:

```bash
npm run build:ios
```

## Configuration

Créer `.env` à partir de `.env.example` si l'API change:

```text
EXPO_PUBLIC_API_BASE_URL=https://api.c-pay.global
```
