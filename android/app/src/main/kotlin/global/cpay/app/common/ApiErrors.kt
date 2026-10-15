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
}
