package global.cpay.app.common

import com.google.gson.Gson
import retrofit2.Response

/**
 * Lecture uniforme des erreurs backend `{ error, code }` (WAVE-3).
 *
 * Attention : `errorBody()` ne peut etre lu qu'une fois ; passer par [of] / [message]
 * et ne plus appeler `errorBody()?.string()` ensuite.
 */
object ApiErrors {

    const val FEATURE_DISABLED = "FEATURE_DISABLED"
    const val FEATURE_DISABLED_MESSAGE = "Fonctionnalité en cours d'intégration"

    private val gson = Gson()

    fun parse(raw: String?): ApiError {
        if (raw.isNullOrBlank()) return ApiError()
        return try { gson.fromJson(raw, ApiError::class.java) ?: ApiError() }
               catch (_: Exception) { ApiError(error = raw.take(200)) }
    }

    fun of(response: Response<*>): ApiError =
        parse(try { response.errorBody()?.string() } catch (_: Exception) { null })

    /** 410 FEATURE_DISABLED : fonction coupee cote backend (hotfix v1 / vague 2). */
    fun isFeatureDisabled(response: Response<*>, err: ApiError? = null): Boolean =
        response.code() == 410 || err?.code == FEATURE_DISABLED

    /** Message lisible pour l'utilisateur (consomme errorBody). */
    fun message(response: Response<*>, fallback: String = "Erreur"): String {
        if (response.code() == 410) return FEATURE_DISABLED_MESSAGE
        val e = of(response)
        if (e.code == FEATURE_DISABLED) return FEATURE_DISABLED_MESSAGE
        return e.error?.takeIf { it.isNotBlank() } ?: fallback
    }

    // ─── WAVE-4 : codes de la caisse marchande (docs/CAISSE-API.md) ───
    const val STEP_UP_REQUIRED     = "STEP_UP_REQUIRED"
    const val INSUFFICIENT_BALANCE = "INSUFFICIENT_BALANCE"
    const val DAILY_LIMIT_EXCEEDED = "DAILY_LIMIT_EXCEEDED"
    const val WALLET_MISSING       = "WALLET_MISSING"
    const val CURRENCY_MISMATCH    = "CURRENCY_MISMATCH"
    const val FUNDING_UNAVAILABLE  = "FUNDING_UNAVAILABLE"

    fun isStepUp(response: Response<*>, err: ApiError? = null): Boolean =
        response.code() == 428 || err?.code == STEP_UP_REQUIRED

    /**
     * Message specifique a la caisse pour une erreur deja lue ([of]) + le code HTTP.
     * `currency` sert a formater le solde disponible renvoye par INSUFFICIENT_BALANCE.
     */
    fun cashMessage(httpCode: Int, e: ApiError, currency: String = "XAF", fallback: String = "Erreur"): String {
        if (httpCode == 410 || e.code == FEATURE_DISABLED) return FEATURE_DISABLED_MESSAGE
        val fmt = java.text.NumberFormat.getNumberInstance(java.util.Locale.FRANCE)
        return when (e.code) {
            INSUFFICIENT_BALANCE -> "Solde insuffisant" +
                (e.available?.let { " — disponible : ${fmt.format(it)} $currency" } ?: "")
            DAILY_LIMIT_EXCEEDED -> "Plafond journalier de retrait atteint (selon votre niveau KYB)"
            WALLET_MISSING       -> "Aucun wallet Mobile Money enregistré : ajoutez-le avant de retirer"
            STEP_UP_REQUIRED     -> "Confirmation requise (code 2FA ou mot de passe)"
            CURRENCY_MISMATCH    -> "La devise du numéro client ne correspond pas à celle de votre compte"
            FUNDING_UNAVAILABLE  -> "Aucun compte de collecte C-Pay pour votre devise — contactez le support"
            "MERCHANT_INACTIVE"  -> "Compte marchand inactif — contactez le support"
            "VALIDATION_ERROR"   -> e.error?.takeIf { it.isNotBlank() } ?: "Données invalides"
            "INVALID_TOTP", "INVALID_PASSWORD", "INVALID_CONFIRMATION" -> "Confirmation invalide"
            else -> when (httpCode) {
                429  -> "Trop de tentatives — réessayez dans quelques minutes"
                403  -> e.error?.takeIf { it.isNotBlank() } ?: "Accès refusé"
                else -> e.error?.takeIf { it.isNotBlank() } ?: fallback
            }
        }
    }

    /** Raccourci : lit errorBody puis formate (ne pas relire errorBody ensuite). */
    fun cashMessage(response: Response<*>, currency: String = "XAF", fallback: String = "Erreur"): String =
        cashMessage(response.code(), of(response), currency, fallback)
}
