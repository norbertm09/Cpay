package global.cpay.app.onboarding

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.databinding.ActivityForgotPasswordBinding
import kotlinx.coroutines.launch

class ForgotPasswordActivity : AppCompatActivity() {

    private lateinit var b: ActivityForgotPasswordBinding
    private var userType = "cardholder"

    override fun onCreate(s: Bundle?) {
        super.onCreate(s)
        b = ActivityForgotPasswordBinding.inflate(layoutInflater)
        setContentView(b.root)

        userType = intent.getStringExtra("user_type") ?: "cardholder"

        b.tvBack.setOnClickListener { finish() }
        b.btnSendCode.setOnClickListener { sendLink() }

        // Fix minimal : le reset se fait via le lien web, pas de code/token dans l'app.
        // On masque les etapes code + password et on reutilise l'ecran "code"
        // comme ecran de confirmation.
        b.btnVerifyCode.setOnClickListener { openMailApp() }
        b.btnReset.setOnClickListener { finish() }
    }

    private fun sendLink() {
        val e = b.etEmail.text.toString().trim()
        if (e.isEmpty()) { err("Email requis"); return }
        loading(true)
        lifecycleScope.launch {
            try {
                val r = if (userType == "merchant")
                    ApiClient.api.merchantForgotPassword(mapOf("email" to e))
                else
                    ApiClient.api.cardholderForgotPassword(mapOf("email" to e))

                if (r.isSuccessful) {
                    // Passer a l'ecran de confirmation (reutilise layout_step_code)
                    b.layoutStepEmail.visibility    = View.GONE
                    b.layoutStepCode.visibility     = View.VISIBLE
                    b.layoutStepPassword.visibility = View.GONE

                    // Masquer le champ de saisie du token (plus necessaire)
                    b.etCode.visibility = View.GONE

                    b.tvCodeSent.text = getString(R.string.forgot_sent_fmt, e)
                    b.tvStepDesc.setText(R.string.forgot_sent_desc)

                    b.btnVerifyCode.setText(R.string.forgot_open_mail)
                    b.tvError.visibility = View.GONE
                    Toast.makeText(this@ForgotPasswordActivity,
                        getString(R.string.forgot_sent_fmt, e), Toast.LENGTH_SHORT).show()
                } else if (r.code() == 404) {
                    err("Aucun compte associé à cet email")
                } else err("Impossible d'envoyer l'email pour le moment")
            } catch (ex: Exception) { err(getString(R.string.network_error)) }
            finally { loading(false) }
        }
    }

    private fun openMailApp() {
        try {
            val intent = Intent(Intent.ACTION_MAIN).apply {
                addCategory(Intent.CATEGORY_APP_EMAIL)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            startActivity(intent)
        } catch (e: Exception) {
            Toast.makeText(this, "Ouvrez votre application email", Toast.LENGTH_LONG).show()
        }
    }

    private fun err(m: String) { b.tvError.text = m; b.tvError.visibility = View.VISIBLE }
    private fun loading(l: Boolean) {
        b.progressBar.visibility = if (l) View.VISIBLE else View.GONE
        if (l) b.tvError.visibility = View.GONE
    }
}
