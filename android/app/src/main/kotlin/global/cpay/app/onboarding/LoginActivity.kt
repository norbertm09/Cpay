package global.cpay.app.onboarding

import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import global.cpay.app.common.ApiClient
import global.cpay.app.common.ApiErrors
import global.cpay.app.common.AuthFlow
import global.cpay.app.common.LoginRequest
import global.cpay.app.common.SessionManager
import global.cpay.app.common.TwoFAActivity
import global.cpay.app.R
import global.cpay.app.common.BiometricHelper
import global.cpay.app.databinding.ActivityLoginBinding
import kotlinx.coroutines.launch

class LoginActivity : AppCompatActivity() {

    private lateinit var binding: ActivityLoginBinding
    private var userType: String = "cardholder"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityLoginBinding.inflate(layoutInflater)
        setContentView(binding.root)

        userType = intent.getStringExtra("user_type") ?: "cardholder"

        // UI selon profil
        if (userType == "merchant") {
            binding.tvTitle.text = "🏪 Connexion Marchand"
            binding.tvSubtitle.text = "Accédez à votre espace marchand"
        } else {
            binding.tvTitle.text = "💳 Connexion Porteur"
            binding.tvSubtitle.text = "Accédez à votre espace porteur"
        }

        // Show/hide password
        binding.ivTogglePassword.setOnClickListener {
            val et = binding.etPassword
            if (et.inputType == android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD) {
                et.inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
                binding.ivTogglePassword.setImageResource(R.drawable.ic_eye)
            } else {
                et.inputType = android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                binding.ivTogglePassword.setImageResource(R.drawable.ic_eye_off)
            }
            et.setSelection(et.text.length)
        }

        binding.btnLogin.setOnClickListener { doLogin() }

        binding.tvRegister.setOnClickListener {
            val intent = Intent(this, RegisterActivity::class.java)
            intent.putExtra("user_type", userType)
            startActivity(intent)
        }

        binding.tvForgotPassword.setOnClickListener {
            val i = android.content.Intent(this, ForgotPasswordActivity::class.java)
            i.putExtra("user_type", userType)
            startActivity(i)
        }

        binding.tvBack.setOnClickListener { finish() }

        // Biométrie si une session (access + refresh) existe pour ce profil
        if (SessionManager.isLoggedIn && SessionManager.userType == userType
            && !SessionManager.refreshToken.isNullOrBlank() && BiometricHelper.isAvailable(this)) {
            binding.btnBiometric.visibility = android.view.View.VISIBLE
            binding.btnBiometric.setOnClickListener {
                BiometricHelper.authenticate(this,
                    onSuccess = {
                        // L'access est rafraichi au besoin par ApiClient (refresh token).
                        AuthFlow.enterApp(this, userType, mustChangePassword = false)
                    },
                    onError = { msg -> showError(msg) }
                )
            }
        }
    }

    private fun doLogin() {
        val identifier = binding.etEmail.text.toString().trim()
        val password   = binding.etPassword.text.toString()

        if (identifier.isEmpty() || password.isEmpty()) {
            showError("Email et mot de passe requis")
            return
        }

        setLoading(true)

        lifecycleScope.launch {
            try {
                val response = if (userType == "merchant") {
                    ApiClient.api.merchantLogin(LoginRequest(identifier, password))
                } else {
                    ApiClient.api.cardholderLogin(LoginRequest(identifier, password))
                }
                android.util.Log.d("CPay", "Login response: ${response.code()}")

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
                                showError("Erreur de connexion — réessayez")
                            }
                        }
                        else -> showError(body.error ?: "Erreur de connexion — réessayez")
                    }
                } else {
                    val err = ApiErrors.of(response)
                    showError(when (response.code()) {
                        401  -> if (err.attemptsLeft != null) "Identifiants incorrects (${err.attemptsLeft} essai(s) restant(s))"
                                else "Identifiants incorrects"
                        403  -> err.error ?: "Compte suspendu — contactez le support"
                        423  -> "Compte temporairement verrouillé — réessayez dans 15 minutes"
                        429  -> "Trop de tentatives — réessayez plus tard"
                        else -> err.error ?: "Erreur de connexion (${response.code()})"
                    })
                }
            } catch (e: Exception) {
                showError("Erreur réseau — ${e.message}")
            } finally {
                setLoading(false)
            }
        }
    }

    private fun showError(msg: String) {
        binding.tvError.text = msg
        binding.tvError.visibility = View.VISIBLE
    }

    private fun setLoading(loading: Boolean) {
        binding.btnLogin.isEnabled = !loading
        binding.progressBar.visibility = if (loading) View.VISIBLE else View.GONE
        binding.tvError.visibility = View.GONE
    }
}
