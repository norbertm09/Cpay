package global.cpay.app.common

import android.content.Context
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

object BiometricHelper {

    fun isAvailable(context: Context): Boolean {
        val bm = BiometricManager.from(context)
        return bm.canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_WEAK) ==
               BiometricManager.BIOMETRIC_SUCCESS
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
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .setSubtitle(subtitle)
            .setNegativeButtonText(activity.getString(global.cpay.app.R.string.biometric_negative))
            .build()
        prompt.authenticate(info)
    }
}
