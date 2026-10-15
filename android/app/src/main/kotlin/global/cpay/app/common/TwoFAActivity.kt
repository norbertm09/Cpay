package global.cpay.app.common

import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.widget.*
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import global.cpay.app.R
import kotlinx.coroutines.launch

/**
 * Double authentification TOTP.
 *
 *  - Mode "setup" (par defaut, depuis le profil) : statut, QR d'enrolement,
 *    verification du premier code (`/auth/2fa/setup` + `/auth/2fa/verify`).
 *  - Mode "login" (WAVE-3) : le login a repondu `{ mfaRequired: true, mfaToken }` ;
 *    on saisit le code puis `POST …/auth/2fa/validate { mfaToken, code }` qui
 *    renvoie la session.
 */
class TwoFAActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_MODE       = "mode"
        const val MODE_LOGIN       = "login"
        const val EXTRA_MFA_TOKEN  = "mfa_token"
        const val EXTRA_IDENTIFIER = "identifier"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_2fa)

        val userType   = intent.getStringExtra(AuthFlow.EXTRA_USER_TYPE) ?: SessionManager.userType ?: "cardholder"
        val isMerchant = userType == "merchant"
        val loginMode  = intent.getStringExtra(EXTRA_MODE) == MODE_LOGIN

        val btnBack   = findViewById<TextView>(R.id.tv_back)
        val btnSetup  = findViewById<TextView>(R.id.btn_setup_2fa)
        val btnVerify = findViewById<TextView>(R.id.btn_verify_2fa)
        val ivQR      = findViewById<ImageView>(R.id.iv_qr_2fa)
        val etCode    = findViewById<EditText>(R.id.et_2fa_code)
        val tvSecret  = findViewById<TextView>(R.id.tv_secret)
        val tvStatus  = findViewById<TextView>(R.id.tv_2fa_status)
        val progress  = findViewById<ProgressBar>(R.id.progress_bar)
        val layoutSetup  = findViewById<LinearLayout>(R.id.layout_setup)
        val layoutVerify = findViewById<LinearLayout>(R.id.layout_verify)

        btnBack.setOnClickListener { finish() }

        if (loginMode) {
            setupLoginMode(userType, isMerchant, btnSetup, btnVerify, etCode, tvStatus, progress, layoutSetup, layoutVerify)
            return
        }

        // ─── Mode configuration (depuis le profil) ───────────────────
        lifecycleScope.launch {
            try {
                val r = if (isMerchant) ApiClient.api.merchant2FAStatus() else ApiClient.api.cardholder2FAStatus()
                if (r.isSuccessful) {
                    val data = r.body()
                    val enabled = data?.get("mfaEnabled") as? Boolean ?: false
                    if (enabled) {
                        tvStatus.text = "✅ 2FA est activé sur votre compte"
                        tvStatus.setTextColor(Color.parseColor("#00c896"))
                        btnSetup.visibility = View.GONE
                    } else {
                        tvStatus.text = "⚠️ 2FA non activé — Sécurisez votre compte"
                        tvStatus.setTextColor(Color.parseColor("#ff9500"))
                    }
                }
            } catch(e: Exception) { }
        }

        btnSetup.setOnClickListener {
            progress.visibility = View.VISIBLE
            lifecycleScope.launch {
                try {
                    val r = if (isMerchant) ApiClient.api.merchant2FASetup()  else ApiClient.api.cardholder2FASetup()
                    if (r.isSuccessful && r.body() != null) {
                        val data = r.body()!!
                        val otpUri = data["otpUri"] as? String ?: ""
                        val secret = data["secret"] as? String ?: ""
                        tvSecret.text = "Clé secrète: $secret"
                        // Générer QR Code
                        if (otpUri.isNotEmpty()) {
                            val qr = generateQR(otpUri, 400)
                            if (qr != null) ivQR.setImageBitmap(qr)
                        }
                        layoutSetup.visibility = View.VISIBLE
                        layoutVerify.visibility = View.VISIBLE
                        btnSetup.visibility = View.GONE
                    }
                } catch(e: Exception) {
                    Toast.makeText(this@TwoFAActivity, "Erreur setup 2FA", Toast.LENGTH_SHORT).show()
                } finally { progress.visibility = View.GONE }
            }
        }

        btnVerify.setOnClickListener {
            val code = etCode.text.toString().trim()
            if (code.length != 6) { Toast.makeText(this, "Code 6 chiffres requis", Toast.LENGTH_SHORT).show(); return@setOnClickListener }
            progress.visibility = View.VISIBLE
            lifecycleScope.launch {
                try {
                    val r = if (isMerchant) ApiClient.api.merchant2FAVerify(mapOf("code" to code)) else ApiClient.api.cardholder2FAVerify(mapOf("code" to code))
                    if (r.isSuccessful) {
                        Toast.makeText(this@TwoFAActivity, "2FA activé avec succès ✅", Toast.LENGTH_LONG).show()
                        finish()
                    } else {
                        Toast.makeText(this@TwoFAActivity, "Code invalide", Toast.LENGTH_SHORT).show()
                    }
                } catch(e: Exception) {
                    Toast.makeText(this@TwoFAActivity, "Erreur réseau", Toast.LENGTH_SHORT).show()
                } finally { progress.visibility = View.GONE }
            }
        }
    }

    // ─── Mode login : validation du code TOTP apres login ────────────
    private fun setupLoginMode(
        userType: String, isMerchant: Boolean,
        btnSetup: TextView, btnVerify: TextView, etCode: EditText, tvStatus: TextView,
        progress: ProgressBar, layoutSetup: LinearLayout, layoutVerify: LinearLayout,
    ) {
        val mfaToken   = intent.getStringExtra(EXTRA_MFA_TOKEN) ?: ""
        val identifier = intent.getStringExtra(EXTRA_IDENTIFIER) ?: ""

        findViewById<TextView>(R.id.tv_2fa_title).text    = "🔐 Vérification en deux étapes"
        findViewById<TextView>(R.id.tv_2fa_subtitle).text = "Saisissez le code généré par votre application d'authentification"
        findViewById<TextView>(R.id.tv_verify_label).text = "Code à 6 chiffres"
        tvStatus.visibility     = View.GONE
        btnSetup.visibility     = View.GONE
        layoutSetup.visibility  = View.GONE
        layoutVerify.visibility = View.VISIBLE
        btnVerify.text = "✅ Valider"
        etCode.requestFocus()

        if (mfaToken.isEmpty()) {
            Toast.makeText(this, "Session 2FA invalide — reconnectez-vous", Toast.LENGTH_LONG).show()
            finish(); return
        }

        btnVerify.setOnClickListener {
            val code = etCode.text.toString().trim()
            if (code.length != 6) { Toast.makeText(this, "Code 6 chiffres requis", Toast.LENGTH_SHORT).show(); return@setOnClickListener }
            progress.visibility = View.VISIBLE
            btnVerify.isEnabled = false
            lifecycleScope.launch {
                try {
                    val body = MfaValidateRequest(mfaToken = mfaToken, code = code)
                    val r = if (isMerchant) ApiClient.api.merchant2FAValidate(body)
                            else ApiClient.api.cardholder2FAValidate(body)
                    val auth = r.body()
                    if (r.isSuccessful && auth != null) {
                        if (!AuthFlow.saveAndEnter(this@TwoFAActivity, auth, userType, identifier)) {
                            Toast.makeText(this@TwoFAActivity, "Réponse inattendue du serveur", Toast.LENGTH_LONG).show()
                        }
                    } else {
                        val err = ApiErrors.of(r)
                        when (err.code) {
                            "INVALID_TOTP" -> Toast.makeText(this@TwoFAActivity, "Code invalide", Toast.LENGTH_SHORT).show()
                            "INVALID_MFA_TOKEN" -> {
                                Toast.makeText(this@TwoFAActivity, "Délai dépassé — reconnectez-vous", Toast.LENGTH_LONG).show()
                                finish()
                            }
                            else -> Toast.makeText(this@TwoFAActivity, err.error ?: "Erreur (${r.code()})", Toast.LENGTH_LONG).show()
                        }
                    }
                } catch(e: Exception) {
                    Toast.makeText(this@TwoFAActivity, "Erreur réseau", Toast.LENGTH_SHORT).show()
                } finally {
                    progress.visibility = View.GONE
                    btnVerify.isEnabled = true
                }
            }
        }
    }

    private fun generateQR(content: String, size: Int): Bitmap? {
        return try {
            val bits = QRCodeWriter().encode(content, BarcodeFormat.QR_CODE, size, size)
            val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565)
            for (x in 0 until size) for (y in 0 until size)
                bmp.setPixel(x, y, if (bits[x, y]) Color.BLACK else Color.WHITE)
            bmp
        } catch(e: Exception) { null }
    }
}
