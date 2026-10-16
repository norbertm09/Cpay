package global.cpay.app.onboarding

import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import global.cpay.app.BuildConfig
import global.cpay.app.R
import global.cpay.app.cardholder.CardholderMainActivity
import global.cpay.app.common.ApiClient
import global.cpay.app.common.AuthFlow
import global.cpay.app.common.BiometricHelper
import global.cpay.app.common.ChangePasswordActivity
import global.cpay.app.common.SessionManager
import global.cpay.app.common.ui.UiPrefs
import global.cpay.app.merchant.MerchantMainActivity
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

class SplashActivity : AppCompatActivity() {

    private companion object { const val MIN_SPLASH_MS = 1200L }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_splash)
        findViewById<TextView>(R.id.tv_version).text = "v${BuildConfig.VERSION_NAME}"

        val started = SystemClock.elapsedRealtime()
        lifecycleScope.launch {
            val userType = SessionManager.userType
            val wasLoggedIn = SessionManager.isLoggedIn
            var mustChangePassword = false

            if (SessionManager.isLoggedIn && (userType == "merchant" || userType == "cardholder")) {
                // WAVE-3 : /auth/me valide la session (refresh automatique via ApiClient si
                // l'access a expire) et remonte mustChangePassword. Une panne reseau laisse
                // entrer dans l'app (les ecrans gerent leurs propres erreurs).
                try {
                    val r = if (userType == "merchant") ApiClient.api.merchantMe()
                            else ApiClient.api.cardholderMe()
                    if (r.isSuccessful) mustChangePassword = r.body()?.mustChangePassword == true
                } catch (_: Exception) { }
            }

            val elapsed = SystemClock.elapsedRealtime() - started
            if (elapsed < MIN_SPLASH_MS) delay(MIN_SPLASH_MS - elapsed)

            if (!SessionManager.isLoggedIn) {
                // Session perdue pendant /auth/me : ApiClient.onSessionLost a deja redirige
                // vers ProfileSelectActivity ; sinon (jamais connecte) on y va nous-memes.
                if (!wasLoggedIn) startActivity(Intent(this@SplashActivity, ProfileSelectActivity::class.java))
                finish()
                return@launch
            }

            val next = when {
                mustChangePassword ->
                    Intent(this@SplashActivity, ChangePasswordActivity::class.java)
                        .putExtra(AuthFlow.EXTRA_USER_TYPE, userType)
                        .putExtra(ChangePasswordActivity.EXTRA_FORCED, true)
                SessionManager.isCardholder -> Intent(this@SplashActivity, CardholderMainActivity::class.java)
                SessionManager.isMerchant   -> Intent(this@SplashActivity, MerchantMainActivity::class.java)
                else                        -> Intent(this@SplashActivity, ProfileSelectActivity::class.java)
            }

            // WAVE-5 : verrou biometrique a l'ouverture (prefere par le marchand dans Profil).
            if (!mustChangePassword && UiPrefs.biometricLock && BiometricHelper.isAvailable(this@SplashActivity)
                && !SessionManager.refreshToken.isNullOrBlank()) {
                val toLogin = {
                    startActivity(Intent(this@SplashActivity, LoginActivity::class.java)
                        .putExtra(AuthFlow.EXTRA_USER_TYPE, userType))
                    finish()
                }
                BiometricHelper.authenticate(this@SplashActivity,
                    onSuccess = { startActivity(next); finish() },
                    onError = { toLogin() },
                    onCancel = { toLogin() })
                return@launch
            }
            startActivity(next)
            finish()
        }
    }
}
