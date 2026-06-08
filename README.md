# Calculus Plus

**Plateforme de paiement panafricaine — Le marchand ne choisit jamais rien.**

---

## Architecture

```
Application Android (Kotlin + Jetpack Compose)
              │
              ▼
  Payment Orchestration Hub (Node.js)
              │
    ┌─────────┼─────────┬──────────┐
    ▼         ▼         ▼          ▼
Mobile    Gateways   QR/Link   Settlement
Money     Carte      Engine    Engine (J+1)
  │           │
  ▼           ▼
MTN/Orange   Visa (CyberSource)
Airtel/Wave  Mastercard (MPGS)
M-Pesa/Moov  GIMAC / Verve
```

## Principe directeur

Le marchand saisit uniquement :
- Un montant
- Un numéro de téléphone OU approche une carte NFC

La plateforme détecte automatiquement :
- Le pays (`+237` → Cameroun)
- L'opérateur (`+237 69` → MTN Mobile Money)
- La devise (Cameroun → XAF)
- Le réseau carte (BIN `4xxx` → Visa → CyberSource)
- La route technique (AID `A0000000041010` → Mastercard → MPGS)

## Pays supportés

| Pays              | Indicatif | Devise | Opérateurs détectés |
|-------------------|-----------|--------|----------------------|
| Sénégal           | +221      | XOF    | Orange Money, Wave, Free Money |
| Côte d'Ivoire     | +225      | XOF    | Orange Money, MTN, Moov, Wave |
| Cameroun          | +237      | XAF    | MTN, Orange, Express Union, Moov |
| Congo Brazzaville | +242      | XAF    | MTN, Airtel, Orange |
| RDC               | +243      | CDF    | Vodacom M-Pesa, Airtel, Orange, Africell |

## Réseaux carte détectés

| Réseau     | BIN / AID                    | Acquéreur   |
|-----------|------------------------------|-------------|
| GIMAC     | 979xxx / A000000333010101    | GIMAC GW    |
| Visa      | 4xxxxx / A0000000031010      | CyberSource |
| Mastercard| 51-55 / A0000000041010       | MPGS        |
| Maestro   | 6304, 6759 / A0000000043060  | MPGS        |
| Verve     | 650, 506 / A000000065101001  | Interswitch |
| UnionPay  | 62xxxx / A000000626          | CyberSource |

## Démarrage backend

```bash
cd backend
cp .env.example .env     # remplir les credentials
npm install
npm run migrate           # créer les tables
npm start
```

Ou avec Docker :
```bash
cd docker
cp ../backend/.env.example ../backend/.env
docker compose up -d
```

## Structure backend

```
backend/
├── src/
│   ├── server.js                          # Point d'entrée API
│   ├── config/
│   │   ├── database.js
│   │   └── logger.js
│   └── services/
│       ├── detection/
│       │   └── detection.engine.js        # Détection automatique (cœur)
│       ├── orchestration/
│       │   └── orchestrator.js            # Hub central
│       ├── mobilemoney/
│       │   ├── mobilemoney.router.js      # Router multi-opérateur
│       │   └── providers/
│       │       ├── mtn.provider.js        # MTN MoMo API
│       │       ├── orange.provider.js     # Orange Money API
│       │       ├── airtel.provider.js     # Airtel Money API
│       │       └── ...                   # Autres opérateurs
│       ├── gateways/
│       │   ├── card.router.js
│       │   ├── cybersource.gateway.js     # → voir softpos-platform
│       │   ├── mpgs.gateway.js            # → voir softpos-platform
│       │   └── gimac.gateway.js
│       └── settlement/
│           └── settlement.engine.js       # Règlement J+1
└── database/
    └── 001_schema.sql
```

## Structure Android

```
android/
└── app/src/main/java/africa/calculus/plus/
    ├── ui/
    │   ├── screens/
    │   │   ├── Screens.kt          # Dashboard, Collect, Payout, QR, PayLink
    │   │   ├── AuthScreens.kt      # Login, Onboarding
    │   │   └── ListScreens.kt      # Transactions, Settlements
    │   ├── components/             # Composants UI partagés
    │   ├── theme/                  # Palette couleurs Calculus Plus
    │   └── viewmodel/              # ViewModels (MVVM)
    ├── domain/
    │   ├── model/                  # Transaction, PaymentResult…
    │   └── usecase/                # CollectUseCase, PayoutUseCase…
    ├── data/
    │   ├── api/                    # Retrofit + modèles
    │   └── repository/             # PaymentRepo, AuthRepo, MerchantRepo
    ├── security/
    │   └── SecureStorage.kt        # Tokens chiffrés via Keystore
    └── di/
        └── AppModule.kt            # Injection Hilt
```

## Modules Android

| Module       | Écran                          | Flux |
|--------------|-------------------------------|------|
| Encaissement | Mobile Money → Montant → Numéro → Résultat | 3 étapes |
| Encaissement | Carte NFC → Montant → Tap → Résultat | 2 étapes |
| Retrait      | Même logique | |
| QR Code      | Montant (+Description) → QR affiché | |
| Lien paiement| Montant (+Description) → Lien partageable (WhatsApp/SMS) | |

## Settlement Engine

```
Transaction autorisée
    → settlement_queue (INSERT)
    → Cron 23h → runSettlement()
    → Calcul commissions (1.5% MM / 2.5% carte par défaut)
    → settlement_batches (batch par marchand)
    → Virement J+1 (banque ou Mobile Money)
```

## Taux de commission par défaut

| Méthode      | Niveau 0 (KYB en cours) | Niveau 1 (KYB validé) | Niveau 2 (Contrat) |
|--------------|------------------------|----------------------|-------------------|
| Mobile Money | 1.5%                   | 1.2%                 | 1.0%              |
| Carte NFC    | 2.5%                   | 2.0%                 | 1.8%              |

## Prochaines étapes

1. **Intégrer les vrais SDK** mobile money par pays (credentials nécessaires)
2. **Brancher GIMAC** pour les cartes CEMAC — voir `gimac.gateway.js`
3. **Implémenter les providers Wave, Moov, Vodacom, Africell** (stubs en place)
4. **Certification PCI** pour le module NFC (voir `softpos-platform/docs/certification/`)
5. **Portail web marchand** — back office React (architecture identique à `softpos-platform/admin-portal`)
