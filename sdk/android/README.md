# C-Pay Android SDK v2.7.0

SDK Android natif pour intégrer les paiements **C-Pay** (Mobile Money + Carte) dans vos applications Android.

**Édité par [Calculus Plus SAS](https://c-pay.global)** — API : `https://api.c-pay.global/api/v1`

---

## Installation

### Gradle (recommandé)
```gradle
dependencies {
    implementation 'global.cpay:cpay-sdk:2.7.0'
}
```

### Manuel (AAR)
1. Téléchargez `cpay-sdk-2.7.0.aar` depuis [c-pay.global/developers](https://c-pay.global/developers)
2. Copiez dans votre dossier `app/libs/`
3. Ajoutez dans `build.gradle` :
```gradle
dependencies {
    implementation fileTree(dir: 'libs', include: ['*.aar'])
}
```

---

## Initialisation

Les identifiants doivent être fournis par votre backend, jamais embarqués en dur dans l'APK.

```kotlin
// Application.kt
import global.cpay.sdk.*

class MyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        CPay.init(this, CPayConfig(
            apiKey    = cleFournieParVotreServeur,
            apiSecret = secretFourniParVotreServeur,
            env       = CPayEnv.PRODUCTION,
            debugMode = BuildConfig.DEBUG
        ))
    }
}
```

---

## Encaissement

```kotlin
// Dans votre Activity ou Fragment
CPay.collect(
    activity    = this,
    amount      = 5000.0,
    currency    = "XAF",
    reference   = "CMD-${orderId}",
    description = "Commande #${orderId}",
    onSuccess   = { txn ->
        // Paiement confirmé
        Log.d("C-Pay", "Paiement ✅ — Réf: ${txn.reference}, Auth: ${txn.authCode}")
        confirmerCommande(txn.txnId)
    },
    onError = { err ->
        // Paiement échoué
        Log.e("C-Pay", "Erreur: ${err.code} — ${err.message}")
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
CPay.disburse(
    activity    = this,
    amount      = 10000.0,
    phone       = "+242060000001",
    method      = PaymentMethod.AIRTEL_MONEY,
    reference   = "DSB-001",
    onSuccess   = { txn -> Log.d("C-Pay", "Décaissement ✅") },
    onError     = { err -> Log.e("C-Pay", err.message) }
)
```

---

## Scan QR Code

```kotlin
CPay.scanQR(
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
CPay.getTransaction(
    txnId     = "uuid-transaction",
    onSuccess = { txn ->
        when (txn.status) {
            TransactionStatus.COMPLETED -> confirmerCommande()
            TransactionStatus.PENDING   -> attendreConfirmation()
            TransactionStatus.FAILED    -> afficherEchec()
            else                        -> {}
        }
    },
    onError = { err -> Log.e("C-Pay", err.message) }
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
| `apiKey` | String | — | Clé API C-Pay (sk_live_xxx) |
| `apiSecret` | String | — | Secret API C-Pay |
| `env` | CPayEnv | SANDBOX | SANDBOX ou PRODUCTION |
| `debugMode` | Boolean | false | Logs détaillés (tag `C-Pay SDK`) |
| `timeout` | Long | 30000 | Timeout réseau (ms) |
| `currency` | String | XAF | Devise par défaut |

---

## Compatibilité avec les intégrations existantes

`CPay`, `CPayConfig`, `CPayEnv`, `CPayTransaction`, `CPayError`, `CPayException`
et `CPayPaymentRequest` sont des alias (`typealias`) des classes historiques
`CPlus*` du paquet `global.cpay.sdk`. Le code écrit contre la version 2.6.0
continue de compiler sans modification.

---

## Changelog

### 2.7.0
* Marque C-Pay (alias `CPay*`, User-Agent `CPay-Android-SDK/2.7.0`, textes de l'écran de paiement).
* Aucun changement d'API réseau.

---

## Support

- 📧 Email : support@c-pay.global
- 📖 Docs  : https://c-pay.global/developers
- 🐛 Issues : legal@c-pay.global

---

## Licence

© 2026 Calculus Plus SAS. Tous droits réservés.
