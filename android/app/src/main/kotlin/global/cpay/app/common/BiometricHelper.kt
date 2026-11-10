package global.cpay.app.common

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

object BiometricHelper {

    // Lot Android P2 (audit 2026-11-02 P2-1) : biometrie de classe 3 (empreinte, visage 3D) OU identifiant de
    // l'appareil (code, schema) — plus de BIOMETRIC_WEAK (visage 2D) pour une application financiere.
    // Android 9/10 (API 28-29) ne supportent pas STRONG | DEVICE_CREDENTIAL (androidx.biometric) : repli
    // WEAK | DEVICE_CREDENTIAL sur ces versions, ou l'identifiant de l'appareil reste exige.
    val AUTHENTICATORS: Int = if (android.os.Build.VERSION.SDK_INT >= 30)
        BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
    else BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL

    fun isAvailable(context: Context): Boolean {
        val bm = BiometricManager.from(context)
        return bm.canAuthenticate(AUTHENTICATORS) == BiometricManager.BIOMETRIC_SUCCESS
    }

    fun authenticate(
        activity: FragmentActivity,
        title: String = activity.getString(global.cpay.app.R.string.biometric_title),
        subtitle: String = activity.getString(global.cpay.app.R.string.biometric_subtitle),
        onSuccess: () -> Unit,
        onError: (String) -> Unit,
        onCancel: (() -> Unit)? = null,
    ) {
        val executor = ContextCompat.getMainExecutor(activity)
        val callback = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                onSuccess()
            }
            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                if (errorCode != BiometricPrompt.ERROR_USER_CANCELED &&
                    errorCode != BiometricPrompt.ERROR_NEGATIVE_BUTTON) {
                    onError(errString.toString())
                } else {
                    onCancel?.invoke()
                }
            }
            override fun onAuthenticationFailed() {
                onError(activity.getString(global.cpay.app.R.string.biometric_failed))
            }
        }

        val prompt = BiometricPrompt(activity, executor, callback)
        // Avec DEVICE_CREDENTIAL, le bouton negatif est interdit par la bibliotheque : le repli « code de l'appareil »
        // est propose par le systeme lui-meme.
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle(subtitle)
            .setAllowedAuthenticators(AUTHENTICATORS)
            .build()
        prompt.authenticate(info)
    }
}
