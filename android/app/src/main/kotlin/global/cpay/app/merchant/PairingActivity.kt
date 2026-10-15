package global.cpay.app.merchant

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import global.cpay.app.common.*
import global.cpay.app.databinding.ActivityPairingBinding
import kotlinx.coroutines.launch

class PairingActivity : AppCompatActivity() {

    private lateinit var b: ActivityPairingBinding

    @SuppressLint("HardwareIds")
    override fun onCreate(s: Bundle?) {
        super.onCreate(s)
        b = ActivityPairingBinding.inflate(layoutInflater)
        setContentView(b.root)

        b.tvMerchant.text = SessionManager.userName ?: "Marchand"

        b.btnPair.setOnClickListener { doPair() }
        b.btnSkip.setOnClickListener {
            // Permettre d'utiliser l'app sans terminal (mode simple)
            startActivity(Intent(this, MerchantMainActivity::class.java))
            finish()
        }
    }

    @SuppressLint("HardwareIds")
    private fun doPair() {
        val code = b.etCode.text.toString().trim()
        if (code.length != 6) {
            b.tvError.text = "Le code doit comporter 6 chiffres"
            b.tvError.visibility = View.VISIBLE
            return
        }
        b.tvError.visibility = View.GONE
        b.btnPair.isEnabled = false
        b.progressBar.visibility = View.VISIBLE

        val androidId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
        val model = "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}"

        lifecycleScope.launch {
            try {
                val r = ApiClient.api.terminalPair(PairRequest(
                    pairingCode = code,
                    androidId   = androidId,
                    deviceModel = model,
                    appVersion  = "2.6.0",
                ))
                if (r.isSuccessful && r.body() != null) {
                    val d = r.body()!!
                    SessionManager.terminalId   = d.terminalId
                    SessionManager.terminalName = d.terminalName
                    SessionManager.terminalSite = d.siteName

                    val msg = if (d.alreadyPaired)
                        "Appareil déjà lié à ${d.terminalName}"
                    else "Terminal ${d.terminalName} appairé ✅"
                    Toast.makeText(this@PairingActivity, msg, Toast.LENGTH_LONG).show()

                    startActivity(Intent(this@PairingActivity, MerchantMainActivity::class.java))
                    finish()
                } else {
                    val err = r.errorBody()?.string() ?: ""
                    b.tvError.text = when {
                        err.contains("INVALID_PAIRING") -> "Code invalide ou déjà utilisé"
                        err.contains("deja lie")        -> "Cet appareil est déjà lié à un autre terminal"
                        else -> "Échec de l'appairage"
                    }
                    b.tvError.visibility = View.VISIBLE
                }
            } catch (e: Exception) {
                b.tvError.text = "Erreur réseau — vérifiez la connexion"
                b.tvError.visibility = View.VISIBLE
            } finally {
                b.btnPair.isEnabled = true
                b.progressBar.visibility = View.GONE
            }
        }
    }
}
