package global.cpay.app.onboarding

import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import global.cpay.app.cardholder.CardholderMainActivity
import global.cpay.app.common.ApiClient
import global.cpay.app.common.LoginRequest
import global.cpay.app.common.SessionManager
import global.cpay.app.R
import global.cpay.app.common.BiometricHelper
import global.cpay.app.databinding.ActivityLoginBinding
import global.cpay.app.merchant.MerchantMainActivity
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
            binding.tvSubtitle.text = "Accédez à votre espace cardholder"
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
            i.putExtra("user_type", "cardholder")
            startActivity(i)
        }

        binding.tvBack.setOnClickListener { finish() }

        // Biométrie si token existant
        if (SessionManager.isLoggedIn && BiometricHelper.isAvailable(this)) {
            binding.btnBiometric.visibility = android.view.View.VISIBLE
            binding.btnBiometric.setOnClickListener {
                BiometricHelper.authenticate(this,
                    onSuccess = {
                        val next = if (SessionManager.isMerchant)
                            android.content.Intent(this, global.cpay.app.merchant.MerchantMainActivity::class.java)
                        else
                            android.content.Intent(this, global.cpay.app.cardholder.CardholderMainActivity::class.java)
                        next.flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK
                        startActivity(next)
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

                // Log pour debug
                android.util.Log.d("CPlus", "Login response: ${response.code()} ${response.errorBody()?.string()}")

                if (response.isSuccessful && response.body() != null) {
                    val body = response.body()!!
                    val user = body.effectiveUser
                    if (user == null) { showError("Erreur de connexion — réessayez"); return@launch }
                    SessionManager.saveSession(
                        token    = body.accessToken,
                        userId   = user.effectiveId,
                        userName = user.displayName,
                        email    = user.email ?: identifier,
                        type     = userType
                    )
                    val next = if (userType == "merchant")
                        Intent(this@LoginActivity, MerchantMainActivity::class.java)
                    else
                        Intent(this@LoginActivity, CardholderMainActivity::class.java)
                    next.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                    startActivity(next)
                } else {
                    showError("Identifiants incorrects")
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
