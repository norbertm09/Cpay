# C-Pay 2.7.0 — production OVH

Version production OVH de C-Pay (ex-CPlus) ; la version courante est celle du fichier `VERSION`.

Voir `OVH_DEPLOYMENT.md` pour le deploiement OVH et `PILOT_CONTROL_RUNBOOK.md` pour le pilotage production.

**CI/CD et versions.** Le depot est verifie par GitHub Actions a chaque PR et push (`.github/workflows/ci.yml` :
backend, 7 portails, vitrine, PHP, SDK, Expo, Android, Docker, coherence des versions). La mise en production suit
`docs/CI-CD.md` : merge dans `main` → tag `vX.Y.Z` → `release.yml` (GitHub Release avec APK/AAB et archives SDK/plugin)
→ `deploy.yml` (SSH vers OVH, `scripts/deploy.sh`, approbation de l'environnement `production`, rollback par
`scripts/deploy.sh --rollback`). Les regles de numerotation (semver, branches `wave-N`, `versionCode` des stores) et la
commande `scripts/bump-version.sh X.Y.Z` sont dans `docs/VERSIONING.md`.

## Production pilot control

La plateforme inclut un module de pilotage production:
programmes pilotes, enrolement marchand, feature flags, overrides par marchand,
journalisation des decisions et script `npm run check:pilot`.

Voir `PILOT_CONTROL_RUNBOOK.md` pour le lancement controle et le rollback.

**Plateforme de paiement panafricaine — Le marchand ne choisit jamais rien.**

---

## Architecture

```
Apps mobiles Android/iOS (Expo) + Android natif (Kotlin)
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

## Mise en production rapide

Domaines cibles:
- API: `https://api.c-pay.global`
- Admin: `https://admin.c-pay.global`
- Marchand: `https://merchant.c-pay.global`
- Paiement/QR: `https://pay.c-pay.global`

Preparation serveur Linux:
```bash
cp backend/.env.production.example backend/.env
nano backend/.env
./scripts/preflight.sh
```

Demarrage production Docker:
```bash
cd docker
docker compose --env-file ../backend/.env up -d --build
```

Initialisation TLS Let's Encrypt:
```bash
export LETSENCRYPT_EMAIL=ops@c-pay.global
./scripts/init-tls.sh
```

Deploiement automatise:
```bash
./scripts/deploy-prod.sh
```

Sauvegarde et restauration:
```bash
./scripts/backup-db.sh
./scripts/restore-db.sh backups/cplus-db-YYYYMMDD-HHMMSS.sql.gz
```

Verification apres deploiement:
```bash
./scripts/healthcheck-prod.sh
```

La CI GitHub Actions inclut les tests backend, les builds des portails, une verification mobile Expo et une validation Docker Compose.

## Feuille de route CPlus 3.0

La feuille de route vers CPlus 3.0 est documentee dans `ROADMAP_CPLUS_3_0.md`.

Axes principaux:
- 30 jours: Fraud Engine, AML Engine, OpenSanctions, Device Fingerprint, Velocity Rules.
- 60 jours: Prometheus, Grafana, OpenTelemetry, Alert Manager.
- 90 jours: PCI DSS, Token Vault avance, HSM, Key Rotation.
- 120 jours: multi-tenant complet, KYB avance, Merchant Risk Scoring, settlement multi-banques.

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
    │   ├── theme/                  # Palette couleurs CPlus 2.6.0
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

## Application mobile Android/iOS

Une application cross-platform est disponible dans `mobile/cpay-mobile`.

Fonctions principales:
- Connexion marchand et administrateur.
- Self-registration marchand.
- Encaissement, retrait, QR Code et Pay Link.
- Partage natif, WhatsApp, SMS et copie du lien.
- Transactions, règlements et compte marchand.
- Gestion admin mobile: APIs, defaults pays, marchands, monitoring.
- Rails Visa: Visa Direct push/pull funds et Visa Account/Wallet payouts.

```bash
cd mobile/cpay-mobile
npm install
npm run start
```

Build Android:
```bash
npm run android
```

Build iOS:
```bash
npm run ios
```

Pour iOS, utiliser macOS/Xcode ou EAS Build.

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
