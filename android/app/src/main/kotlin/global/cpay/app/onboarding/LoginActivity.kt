package global.cpay.app.onboarding

import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.ApiErrors
import global.cpay.app.common.AuthFlow
import global.cpay.app.common.BiometricHelper
import global.cpay.app.common.LoginRequest
import global.cpay.app.common.SessionManager
import global.cpay.app.common.TwoFAActivity
import global.cpay.app.databinding.ActivityLoginBinding
import kotlinx.coroutines.launch

/**
 * Connexion (WAVE-3 pour le contrat, WAVE-5 pour l'ecran) : grands champs, bascule du
 * mot de passe integree, bouton biometrique si une session (access + refresh) du meme
 * profil existe, 2FA au login, mot de passe temporaire force.
 */
class LoginActivity : AppCompatActivity() {

    private lateinit var binding: ActivityLoginBinding
    private var userType: String = "cardholder"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)

        userType = intent.getStringExtra(AuthFlow.EXTRA_USER_TYPE) ?: "cardholder"

        if (userType == "merchant") {
            binding.tvTitle.setText(R.string.login_title_merchant)
            binding.tvSubtitle.setText(R.string.login_subtitle_merchant)
        } else {
            binding.tvTitle.setText(R.string.login_title_cardholder)
            binding.tvSubtitle.setText(R.string.login_subtitle_cardholder)
        }

        binding.btnLogin.setOnClickListener { doLogin() }
        binding.tvRegister.setOnClickListener {
            startActivity(Intent(this, RegisterActivity::class.java).putExtra(AuthFlow.EXTRA_USER_TYPE, userType))
        }
        binding.tvForgotPassword.setOnClickListener {
            startActivity(Intent(this, ForgotPasswordActivity::class.java).putExtra(AuthFlow.EXTRA_USER_TYPE, userType))
        }
        binding.tvBack.setOnClickListener { finish() }

        // Biometrie si une session (access + refresh) existe pour ce profil
        if (SessionManager.isLoggedIn && SessionManager.userType == userType
            && !SessionManager.refreshToken.isNullOrBlank() && BiometricHelper.isAvailable(this)) {
            binding.btnBiometric.visibility = View.VISIBLE
            binding.btnBiometric.setOnClickListener { biometric() }
            if (intent.getBooleanExtra(EXTRA_AUTO_BIOMETRIC, false)) biometric()
        }
    }

    private fun biometric() {
        BiometricHelper.authenticate(this,
            subtitle = getString(R.string.login_biometric_subtitle),
            onSuccess = {
                // L'access est rafraichi au besoin par ApiClient (refresh token).
                AuthFlow.enterApp(this, userType, mustChangePassword = false)
            },
            onError = { msg -> showError(msg) }
        )
    }

    private fun doLogin() {
        val identifier = binding.etEmail.text.toString().trim()
        val password   = binding.etPassword.text.toString()

        if (identifier.isEmpty() || password.isEmpty()) {
            showError(getString(R.string.login_error_required)); return
        }
        setLoading(true)
        lifecycleScope.launch {
            try {
                val response = if (userType == "merchant") ApiClient.api.merchantLogin(LoginRequest(identifier, password))
                               else ApiClient.api.cardholderLogin(LoginRequest(identifier, password))
                Log.d("CPay", "Login response: ${response.code()}")

                val body = response.body()
                if (response.isSuccessful && body != null) {
                    when {
                        // 2FA active : pas de session tant que le code TOTP n'est pas valide
                        body.mfaRequired && !body.mfaToken.isNullOrBlank() -> {
                            startActivity(Intent(this@LoginActivity, TwoFAActivity::class.java)
                                .putExtra(TwoFAActivity.EXTRA_MODE, TwoFAActivity.MODE_LOGIN)
                                .putExtra(TwoFAActivity.EXTRA_MFA_TOKEN, body.mfaToken)
                                .putExtra(TwoFAActivity.EXTRA_IDENTIFIER, identifier)
                                .putExtra(AuthFlow.EXTRA_USER_TYPE, userType))
                        }
                        // Session : { access_token, refresh_token, expires_in, user, mustChangePassword }
                        body.hasSession -> {
                            if (!AuthFlow.saveAndEnter(this@LoginActivity, body, userType, identifier)) {
                                showError(getString(R.string.login_error_generic))
                            }
                        }
                        else -> showError(body.error ?: getString(R.string.login_error_generic))
                    }
                } else {
                    val err = ApiErrors.of(response)
                    showError(when (response.code()) {
                        401  -> if (err.attemptsLeft != null) getString(R.string.login_error_attempts, err.attemptsLeft)
                                else getString(R.string.login_error_invalid)
                        403  -> err.error ?: getString(R.string.login_error_suspended)
                        423  -> getString(R.string.login_error_locked)
                        429  -> getString(R.string.login_error_too_many)
                        else -> err.error ?: "${getString(R.string.login_error_generic)} (${response.code()})"
                    })
                }
            } catch (e: Exception) {
                showError(getString(R.string.network_error))
            } finally {
                setLoading(false)
            }
        }
    }

    private fun showError(msg: String) {
        binding.tvError.text = msg
        binding.layoutError.visibility = View.VISIBLE
    }

    private fun setLoading(loading: Boolean) {
        binding.btnLogin.isEnabled = !loading
        binding.progressBar.visibility = if (loading) View.VISIBLE else View.GONE
        if (loading) binding.layoutError.visibility = View.GONE
    }

    companion object {
        /** Lance directement l'invite biometrique (verrou a l'ouverture, depuis le splash). */
        const val EXTRA_AUTO_BIOMETRIC = "auto_biometric"
    }
}
