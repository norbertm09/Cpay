package global.cpay.sdk

import android.app.Activity
import android.content.Context
import global.cpay.sdk.api.CPlusAPI
import global.cpay.sdk.models.*
import global.cpay.sdk.ui.CPlusPaymentSheet

/**
 * C-Pay Android SDK v2.7.0
 * Calculus Plus SAS — https://c-pay.global
 *
 * Usage:
 * ```kotlin
 * CPlus.init(context, CPlusConfig(apiKey = "sk_live_xxx", apiSecret = "sk_secret_xxx"))
 * CPlus.collect(activity, amount = 5000.0, currency = "XAF", reference = "CMD-001",
 *     onSuccess = { txn -> }, onError = { err -> })
 * ```
 */
object CPlus {

    private var config: CPlusConfig? = null
    internal var api: CPlusAPI? = null

    /**
     * Initialiser le SDK C-Pay
     * @param context ApplicationContext
     * @param config  Configuration (apiKey, apiSecret, env)
     */
    fun init(context: Context, config: CPlusConfig) {
        this.config = config
        this.api    = CPlusAPI(config)
        CPlusLogger.enabled = config.debugMode
        CPlusLogger.log("C-Pay SDK v2.7.0 initialisé — env: ${config.env}")
    }

    /**
     * Encaissement Mobile Money
     */
    fun collect(
        activity:  Activity,
        amount:    Double,
        currency:  String = "XAF",
        reference: String = generateRef(),
        description: String = "",
        onSuccess: (CPlusTransaction) -> Unit,
        onError:   (CPlusError) -> Unit,
        onPending: ((String) -> Unit)? = null
    ) {
        checkInit()
        CPlusPaymentSheet.show(
            activity    = activity,
            request     = CPlusPaymentRequest(
                type        = PaymentType.COLLECT,
                amount      = amount,
                currency    = currency,
                reference   = reference,
                description = description,
            ),
            onSuccess   = onSuccess,
            onError     = onError,
            onPending   = onPending
        )
    }

    /**
     * Décaissement Mobile Money
     */
    fun disburse(
        activity:    Activity,
        amount:      Double,
        phone:       String,
        method:      PaymentMethod = PaymentMethod.AIRTEL_MONEY,
        reference:   String = generateRef(),
        description: String = "",
        onSuccess:   (CPlusTransaction) -> Unit,
        onError:     (CPlusError) -> Unit
    ) {
        checkInit()
        val req = CPlusPaymentRequest(
            type        = PaymentType.DISBURSE,
            amount      = amount,
            currency    = "XAF",
            reference   = reference,
            description = description,
            phone       = phone,
            method      = method
        )
        api!!.disburse(req, onSuccess, onError)
    }

    /**
     * Scanner un QR Code marchand
     */
    fun scanQR(
        activity:  Activity,
        onResult:  (String) -> Unit,
        onError:   (CPlusError) -> Unit
    ) {
        checkInit()
        CPlusPaymentSheet.showQRScanner(activity, onResult, onError)
    }

    /**
     * Vérifier le statut d'une transaction
     */
    fun getTransaction(
        txnId:     String,
        onSuccess: (CPlusTransaction) -> Unit,
        onError:   (CPlusError) -> Unit
    ) {
        checkInit()
        api!!.getTransaction(txnId, onSuccess, onError)
    }

    /**
     * Obtenir la configuration actuelle
     */
    fun getConfig(): CPlusConfig = config ?: throw CPlusException("SDK non initialisé — appelez CPlus.init() d'abord")

    private fun checkInit() {
        if (config == null || api == null) {
            throw CPlusException("C-Pay SDK non initialisé. Appelez CPay.init(context, config) dans votre Application.onCreate()")
        }
    }

    private fun generateRef(): String {
        val chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
        return "SDK-" + (1..8).map { chars.random() }.joinToString("")
    }
}
