package global.cpay.app.common

import android.os.Bundle
import android.view.View
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import global.cpay.app.R
import kotlinx.coroutines.launch

/**
 * Changement de mot de passe (WAVE-3).
 *
 * Mode force (`EXTRA_FORCED`) : le backend a repondu `mustChangePassword: true`
 * (mot de passe temporaire) ; l'ecran est obligatoire avant d'entrer dans l'app,
 * le bouton retour deconnecte.
 *
 * POST /merchant/account/change-password | /cardholder/profile/change-password
 * { currentPassword, newPassword } → le serveur revoque toutes les sessions
 * (refresh) : on efface la session locale et on renvoie vers la connexion.
 */
class ChangePasswordActivity : AppCompatActivity() {

    companion object { const val EXTRA_FORCED = "forced" }

    private var userType = "cardholder"
    private var forced   = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_change_password)

        userType = intent.getStringExtra(AuthFlow.EXTRA_USER_TYPE) ?: SessionManager.userType ?: "cardholder"
        forced   = intent.getBooleanExtra(EXTRA_FORCED, false)

        val tvSubtitle = findViewById<TextView>(R.id.tv_subtitle)
        val tvLogout   = findViewById<TextView>(R.id.tv_logout)
        val btnSubmit  = findViewById<TextView>(R.id.btn_submit)

        if (forced) {
            tvSubtitle.text = "Votre mot de passe est temporaire : choisissez-en un nouveau pour continuer."
        }
        tvLogout.setOnClickListener { logoutToLogin() }
        btnSubmit.setOnClickListener { submit() }
    }

    override fun onBackPressed() {
        if (forced) logoutToLogin() else super.onBackPressed()
    }

    private fun submit() {
        val cur = findViewById<EditText>(R.id.et_current_password).text.toString()
        val new = findViewById<EditText>(R.id.et_new_password).text.toString()
        val cnf = findViewById<EditText>(R.id.et_confirm_password).text.toString()

        if (cur.isEmpty())  { showError("Mot de passe actuel requis"); return }
        if (new.length < 8) { showError("Nouveau mot de passe : 8 caractères minimum"); return }
        if (new == cur)     { showError("Le nouveau mot de passe doit être différent"); return }
        if (new != cnf)     { showError("Les mots de passe ne correspondent pas"); return }

        setLoading(true)
        lifecycleScope.launch {
            try {
                val body = mapOf("currentPassword" to cur, "newPassword" to new)
                val r = if (userType == "merchant") ApiClient.api.merchantChangePassword(body)
                        else ApiClient.api.cardholderChangePassword(body)
                if (r.isSuccessful) {
                    // Le serveur a revoque toutes les sessions : nouvelle connexion requise.
                    SessionManager.clearSession()
                    AuthFlow.toLogin(this@ChangePasswordActivity, userType,
                        "Mot de passe modifié ✅ — reconnectez-vous")
                    finish()
                } else {
                    val err = ApiErrors.of(r)
                    showError(when {
                        r.code() == 401 -> err.error ?: "Mot de passe actuel incorrect"
                        else            -> err.error ?: "Erreur (${r.code()})"
                    })
                }
            } catch (e: Exception) {
                showError("Erreur réseau — ${e.message}")
            } finally { setLoading(false) }
        }
    }

    private fun logoutToLogin() {
        setLoading(true)
        lifecycleScope.launch {
            try { ApiClient.logout() } catch (_: Exception) { SessionManager.clearSession() }
            AuthFlow.toLogin(this@ChangePasswordActivity, null)
            finish()
        }
    }

    private fun showError(msg: String) {
        val tv = findViewById<TextView>(R.id.tv_error)
        tv.text = msg; tv.visibility = View.VISIBLE
    }

    private fun setLoading(l: Boolean) {
        findViewById<TextView>(R.id.btn_submit).isEnabled = !l
        findViewById<ProgressBar>(R.id.progress_bar).visibility = if (l) View.VISIBLE else View.GONE
        if (l) findViewById<TextView>(R.id.tv_error).visibility = View.GONE
    }
}
