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
    const val DEVICE_ALREADY_PAIRED = "DEVICE_ALREADY_PAIRED"   // 409 POST /terminals/pair (lot Android P2)
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
    // Lot 4 (P1-1) : idempotence (docs/CAISSE-API.md §0)
    const val IDEMPOTENCY_REPLAY            = "IDEMPOTENCY_REPLAY"
    const val IDEMPOTENCY_IN_PROGRESS       = "IDEMPOTENCY_IN_PROGRESS"
    const val IDEMPOTENCY_RETRY_AFTER_ERROR = "IDEMPOTENCY_RETRY_AFTER_ERROR"
    const val IDEMPOTENCY_CONFLICT          = "IDEMPOTENCY_CONFLICT"

    /**
     * Vrai si la cle d'idempotence doit etre CONSERVEE pour la prochaine tentative : le serveur n'a pas donne de
     * reponse definitive (5xx, 428 step-up, operation en cours, derniere tentative en erreur). Un refus metier (4xx)
     * libere la cle.
     */
    fun keepIdempotencyKey(httpCode: Int, e: ApiError?): Boolean =
        httpCode >= 500 || httpCode == 428 || e?.code == IDEMPOTENCY_IN_PROGRESS || e?.code == IDEMPOTENCY_RETRY_AFTER_ERROR

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
            IDEMPOTENCY_IN_PROGRESS       -> "Opération déjà en cours — patientez quelques secondes puis consultez le Journal"
            IDEMPOTENCY_RETRY_AFTER_ERROR -> "La tentative précédente a échoué côté serveur — vérifiez le Journal avant de réessayer"
            IDEMPOTENCY_CONFLICT          -> "Une autre opération utilise cette référence — recommencez une nouvelle saisie"
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
