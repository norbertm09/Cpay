package global.cpay.app.onboarding

import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.ApiErrors
import global.cpay.app.common.AuthFlow
import global.cpay.app.databinding.ActivityRegisterBinding
import kotlinx.coroutines.launch

class RegisterActivity : AppCompatActivity() {

    private lateinit var binding: ActivityRegisterBinding
    private var userType: String = "cardholder"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityRegisterBinding.inflate(layoutInflater)
        setContentView(binding.root)

        userType = intent.getStringExtra("user_type") ?: "cardholder"
        binding.tvTitle.setText(if (userType == "merchant") R.string.register_title_merchant else R.string.register_title_cardholder)
        binding.tvSubtitle.setText(if (userType == "merchant") R.string.register_subtitle_merchant else R.string.register_subtitle_cardholder)

        binding.tvBack.setOnClickListener { finish() }
        binding.btnRegister.setOnClickListener { doRegister() }
    }

    private fun doRegister() {
        val firstName = binding.etFirstName.text.toString().trim()
        val lastName  = binding.etLastName.text.toString().trim()
        val email     = binding.etEmail.text.toString().trim()
        val phone     = binding.etPhone.text.toString().trim()
        val password  = binding.etPassword.text.toString()
        val confirm   = binding.etConfirm.text.toString()

        if (firstName.isEmpty() || email.isEmpty() || phone.isEmpty() || password.isEmpty()) {
            showError("Tous les champs obligatoires (*) doivent être remplis"); return
        }
        if (password.length < 8) { showError("Mot de passe : 8 caractères minimum"); return }
        if (password != confirm) { showError("Les mots de passe ne correspondent pas"); return }

        setLoading(true)
        lifecycleScope.launch {
            try {
                val body = mapOf(
                    "firstName" to firstName, "lastName" to lastName,
                    "email" to email, "phone" to phone, "password" to password,
                    "emailOrPhone" to email, "businessName" to "$firstName $lastName"
                )
                val response = if (userType == "merchant")
                    ApiClient.api.merchantRegister(body)
                else
                    ApiClient.api.cardholderRegister(body)

                if (response.isSuccessful && response.body() != null) {
                    // WAVE-3 : { access_token, refresh_token, expires_in, user, mustChangePassword }
                    if (!AuthFlow.saveAndEnter(this@RegisterActivity, response.body()!!, userType, email)) {
                        showError("Réponse inattendue du serveur")
                    }
                } else {
                    showError(ApiErrors.message(response, "Erreur inscription"))
                }
            } catch(e: Exception) { showError(getString(R.string.network_error)) }
            finally { setLoading(false) }
        }
    }

    private fun showError(msg: String) { binding.tvError.text = msg; binding.tvError.visibility = View.VISIBLE }
    private fun setLoading(l: Boolean) { binding.btnRegister.isEnabled = !l; binding.progressBar.visibility = if (l) View.VISIBLE else View.GONE; binding.tvError.visibility = View.GONE }
}
