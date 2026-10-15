package global.cpay.app.onboarding

import android.content.Intent
import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import global.cpay.app.cardholder.CardholderMainActivity
import global.cpay.app.common.ApiClient
import global.cpay.app.common.SessionManager
import global.cpay.app.databinding.ActivityRegisterBinding
import global.cpay.app.merchant.MerchantMainActivity
import kotlinx.coroutines.launch

class RegisterActivity : AppCompatActivity() {

    private lateinit var binding: ActivityRegisterBinding
    private var userType: String = "cardholder"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityRegisterBinding.inflate(layoutInflater)
        setContentView(binding.root)

        userType = intent.getStringExtra("user_type") ?: "cardholder"
        binding.tvTitle.text = if (userType == "merchant") "Créer un compte Marchand" else "Créer un compte Porteur"
        binding.tvSubtitle.text = if (userType == "merchant") "Acceptez des paiements Mobile Money" else "Paiements digitaux Zone CEMAC"

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
                    val body2 = response.body()!!
                    val user = body2.effectiveUser
                    if (user != null) {
                        SessionManager.saveSession(body2.accessToken, user.effectiveId,
                            user.displayName, user.email ?: email, userType)
                        val next = if (userType == "merchant")
                            Intent(this@RegisterActivity, MerchantMainActivity::class.java)
                        else
                            Intent(this@RegisterActivity, CardholderMainActivity::class.java)
                        next.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                        startActivity(next)
                    }
                } else {
                    val err = response.errorBody()?.string() ?: "Erreur inscription"
                    showError(err)
                }
            } catch(e: Exception) { showError("Erreur réseau: ${e.message}") }
            finally { setLoading(false) }
        }
    }

    private fun showError(msg: String) { binding.tvError.text = msg; binding.tvError.visibility = View.VISIBLE }
    private fun setLoading(l: Boolean) { binding.btnRegister.isEnabled = !l; binding.progressBar.visibility = if (l) View.VISIBLE else View.GONE; binding.tvError.visibility = View.GONE }
}
