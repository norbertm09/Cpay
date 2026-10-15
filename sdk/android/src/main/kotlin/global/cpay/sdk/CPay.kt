package global.cpay.sdk

import global.cpay.sdk.models.*

/**
 * Noms publics C-Pay du SDK (v2.7.0).
 *
 * Les classes d'implementation gardent leurs identifiants historiques
 * (`CPlus`, `CPlusConfig`, `CPlusEnv`...) pour ne pas casser les integrations
 * existantes ; ces alias exposent l'API sous la marque C-Pay :
 *
 * ```kotlin
 * CPay.init(context, CPayConfig(apiKey = "sk_live_xxx", apiSecret = "sk_secret_xxx", env = CPayEnv.PRODUCTION))
 * CPay.collect(activity, amount = 5000.0, currency = "XAF", reference = "CMD-001",
 *     onSuccess = { txn -> }, onError = { err -> })
 * ```
 */
typealias CPay = CPlus
typealias CPayConfig = CPlusConfig
typealias CPayEnv = CPlusEnv
typealias CPayTransaction = CPlusTransaction
typealias CPayError = CPlusError
typealias CPayException = CPlusException
typealias CPayPaymentRequest = CPlusPaymentRequest
