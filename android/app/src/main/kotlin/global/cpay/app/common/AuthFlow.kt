package global.cpay.app.common

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.widget.Toast
import global.cpay.app.cardholder.CardholderMainActivity
import global.cpay.app.merchant.MerchantMainActivity
import global.cpay.app.onboarding.LoginActivity
import global.cpay.app.onboarding.ProfileSelectActivity

/**
 * Navigation post-authentification (WAVE-3), partagee par Login / Register /
 * 2FA / changement de mot de passe force.
 */
object AuthFlow {

    const val EXTRA_USER_TYPE = "user_type"
    const val EXTRA_MESSAGE   = "message"

    /**
     * Enregistre la session renvoyee par login / register / 2fa-validate puis
     * entre dans l'app (ou force le changement de mot de passe).
     * @return false si la reponse ne contient pas de session exploitable.
     */
    fun saveAndEnter(activity: Activity, auth: AuthResponse, userType: String, fallbackEmail: String): Boolean {
        val user = auth.effectiveUser
        if (!auth.hasSession || user == null) return false
        SessionManager.saveSession(
            token        = auth.accessToken,
            refreshToken = auth.refreshToken,
            expiresInSec = auth.expiresIn,
            userId       = user.effectiveId,
            userName     = user.displayName,
            email        = user.email ?: fallbackEmail,
            type         = userType,
        )
        enterApp(activity, userType, auth.mustChangePassword)
        return true
    }

    fun enterApp(activity: Activity, userType: String, mustChangePassword: Boolean) {
        val next = when {
            mustChangePassword     -> Intent(activity, ChangePasswordActivity::class.java)
                                        .putExtra(EXTRA_USER_TYPE, userType)
                                        .putExtra(ChangePasswordActivity.EXTRA_FORCED, true)
            userType == "merchant" -> Intent(activity, MerchantMainActivity::class.java)
            else                   -> Intent(activity, CardholderMainActivity::class.java)
        }
        next.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        activity.startActivity(next)
        activity.finish()
    }

    /** Retour a l'ecran de connexion du profil donne, en vidant la pile. */
    fun toLogin(context: Context, userType: String?, message: String? = null) {
        if (message != null) Toast.makeText(context, message, Toast.LENGTH_LONG).show()
        val next = if (userType == "merchant" || userType == "cardholder")
            Intent(context, LoginActivity::class.java).putExtra(EXTRA_USER_TYPE, userType)
        else
            Intent(context, ProfileSelectActivity::class.java)
        next.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        context.startActivity(next)
    }
}
