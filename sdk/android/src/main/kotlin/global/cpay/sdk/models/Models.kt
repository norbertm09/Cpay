package global.cpay.sdk.models

/**
 * Configuration du SDK CPlus
 */
data class CPlusConfig(
    val apiKey:     String,
    val apiSecret:  String,
    val env:        CPlusEnv = CPlusEnv.SANDBOX,
    val debugMode:  Boolean  = false,
    val timeout:    Long     = 30_000L,
    val currency:   String   = "XAF",
) {
    val baseUrl: String get() = when (env) {
        CPlusEnv.PRODUCTION -> "https://api.c-pay.global/api/v1"
        CPlusEnv.SANDBOX    -> "https://api.c-pay.global/api/v1"
    }
}

enum class CPlusEnv { SANDBOX, PRODUCTION }

enum class PaymentMethod(val value: String) {
    AIRTEL_MONEY("airtel_money"),
    MTN_MOMO("mtn_momo"),
    CARD("card"),
    PAY_LINK("pay_link")
}

enum class PaymentType { COLLECT, DISBURSE }

enum class TransactionStatus {
    PENDING, COMPLETED, FAILED, CANCELLED
}

/**
 * Requête de paiement
 */
data class CPlusPaymentRequest(
    val type:        PaymentType,
    val amount:      Double,
    val currency:    String        = "XAF",
    val reference:   String,
    val description: String        = "",
    val phone:       String?       = null,
    val method:      PaymentMethod = PaymentMethod.AIRTEL_MONEY,
    val merchantId:  String?       = null,
)

/**
 * Transaction CPlus
 */
data class CPlusTransaction(
    val txnId:      String,
    val reference:  String,
    val status:     TransactionStatus,
    val amount:     Double,
    val fee:        Double,
    val net:        Double,
    val currency:   String,
    val method:     String,
    val createdAt:  String,
    val authCode:   String? = null,
)

/**
 * Erreur CPlus
 */
data class CPlusError(
    val code:    String,
    val message: String,
    val details: String? = null,
) {
    companion object {
        fun network(msg: String)     = CPlusError("NETWORK_ERROR",     msg)
        fun api(msg: String)         = CPlusError("API_ERROR",         msg)
        fun validation(msg: String)  = CPlusError("VALIDATION_ERROR",  msg)
        fun cancelled()              = CPlusError("USER_CANCELLED",    "Paiement annulé par l'utilisateur")
        fun timeout()                = CPlusError("TIMEOUT",           "Délai d'attente dépassé")
    }
}

class CPlusException(message: String) : Exception(message)
