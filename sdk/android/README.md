# CPlus Android SDK v2.6.0

SDK Android natif pour intégrer les paiements CPlus (Mobile Money + Carte) dans vos applications Android.

**Développé par [Calculus Plus SAS](https://c-pay.global)**

---

## Installation

### Gradle (recommandé)
```gradle
dependencies {
    implementation 'global.cpay:cplus-sdk:2.6.0'
}
```

### Manuel (AAR)
1. Téléchargez `cplus-sdk-2.6.0.aar` depuis [c-pay.global/developers](https://c-pay.global/developers)
2. Copiez dans votre dossier `app/libs/`
3. Ajoutez dans `build.gradle` :
```gradle
dependencies {
    implementation fileTree(dir: 'libs', include: ['*.aar'])
}
```

---

## Initialisation

```kotlin
// Application.kt
class MyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        CPlus.init(this, CPlusConfig(
            apiKey    = "sk_live_votre_cle",
            apiSecret = "sk_secret_votre_secret",
            env       = CPlusEnv.PRODUCTION,
            debugMode = BuildConfig.DEBUG
        ))
    }
}
```

---

## Encaissement

```kotlin
// Dans votre Activity ou Fragment
CPlus.collect(
    activity    = this,
    amount      = 5000.0,
    currency    = "XAF",
    reference   = "CMD-${orderId}",
    description = "Commande #${orderId}",
    onSuccess   = { txn ->
        // Paiement confirmé
        Log.d("CPlus", "Paiement ✅ — Réf: ${txn.reference}, Auth: ${txn.authCode}")
        confirmerCommande(txn.txnId)
    },
    onError = { err ->
        // Paiement échoué
        Log.e("CPlus", "Erreur: ${err.code} — ${err.message}")
        afficherErreur(err.message)
    },
    onPending = { ref ->
        // En attente de confirmation (Mobile Money)
        afficherAttenteConfirmation(ref)
    }
)
```

---

## Décaissement

```kotlin
CPlus.disburse(
    activity    = this,
    amount      = 10000.0,
    phone       = "+242060000001",
    method      = PaymentMethod.AIRTEL_MONEY,
    reference   = "DSB-001",
    onSuccess   = { txn -> Log.d("CPlus", "Décaissement ✅") },
    onError     = { err -> Log.e("CPlus", err.message) }
)
```

---

## Scan QR Code

```kotlin
CPlus.scanQR(
    activity = this,
    onResult = { qrData ->
        // qrData = URL pay link ou merchant ID
        traiterQR(qrData)
    },
    onError  = { err -> afficherErreur(err.message) }
)
```

---

## Vérifier le statut d'une transaction

```kotlin
CPlus.getTransaction(
    txnId     = "uuid-transaction",
    onSuccess = { txn ->
        when (txn.status) {
            TransactionStatus.COMPLETED -> confirmerCommande()
            TransactionStatus.PENDING   -> attendreConfirmation()
            TransactionStatus.FAILED    -> afficherEchec()
            else                        -> {}
        }
    },
    onError = { err -> Log.e("CPlus", err.message) }
)
```

---

## Permissions requises

```xml
<!-- AndroidManifest.xml -->
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.CAMERA" />     <!-- Scan QR -->
<uses-permission android:name="android.permission.NFC"           <!-- Paiement NFC (optionnel) -->
    android:required="false" />
```

---

## Configuration

| Paramètre | Type | Défaut | Description |
|---|---|---|---|
| `apiKey` | String | — | Clé API CPlus (sk_live_xxx) |
| `apiSecret` | String | — | Secret API CPlus |
| `env` | CPlusEnv | SANDBOX | SANDBOX ou PRODUCTION |
| `debugMode` | Boolean | false | Logs détaillés |
| `timeout` | Long | 30000 | Timeout réseau (ms) |
| `currency` | String | XAF | Devise par défaut |

---

## Support

- 📧 Email : support@c-pay.global
- 📖 Docs  : https://c-pay.global/developers
- 🐛 Issues : legal@c-pay.global

---

## Licence

© 2026 Calculus Plus SAS. Tous droits réservés.
