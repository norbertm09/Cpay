package global.cpay.app.merchant

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import global.cpay.app.BuildConfig
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.PairRequest
import global.cpay.app.common.SessionManager
import global.cpay.app.common.ui.UiPrefs
import global.cpay.app.databinding.ActivityPairingBinding
import kotlinx.coroutines.launch

class PairingActivity : AppCompatActivity() {

    private lateinit var b: ActivityPairingBinding

    @SuppressLint("HardwareIds")
    override fun onCreate(s: Bundle?) {
        super.onCreate(s)
        b = ActivityPairingBinding.inflate(layoutInflater)
        setContentView(b.root)

        b.tvMerchant.text = SessionManager.userName ?: getString(R.string.profile_merchant)

        b.btnPair.setOnClickListener { doPair() }
        b.btnSkip.setOnClickListener {
            // Utiliser l'app sans terminal (mode simple) : le choix est memorise pour ne pas
            // revenir en boucle sur cet ecran.
            UiPrefs.pairingSkipped = true
            startActivity(Intent(this, MerchantMainActivity::class.java))
            finish()
        }
    }

    @SuppressLint("HardwareIds")
    private fun doPair() {
        val code = b.etCode.text.toString().trim()
        if (code.length != 6) {
            b.tvError.setText(R.string.pairing_error_len)
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
                    appVersion  = BuildConfig.VERSION_NAME,
                ))
                if (r.isSuccessful && r.body() != null) {
                    val d = r.body()!!
                    SessionManager.terminalId   = d.terminalId
                    SessionManager.terminalName = d.terminalName
                    SessionManager.terminalSite = d.siteName
                    UiPrefs.pairingSkipped = false

                    val msg = if (d.alreadyPaired) getString(R.string.pairing_already_fmt, d.terminalName)
                              else getString(R.string.pairing_done_fmt, d.terminalName)
                    Toast.makeText(this@PairingActivity, msg, Toast.LENGTH_LONG).show()

                    startActivity(Intent(this@PairingActivity, MerchantMainActivity::class.java))
                    finish()
                } else {
                    val err = r.errorBody()?.string() ?: ""
                    b.tvError.text = when {
                        err.contains("INVALID_PAIRING") -> getString(R.string.pairing_error_invalid)
                        err.contains("deja lie")        -> getString(R.string.pairing_error_other_device)
                        else -> getString(R.string.pairing_error_generic)
                    }
                    b.tvError.visibility = View.VISIBLE
                }
            } catch (e: Exception) {
                b.tvError.setText(R.string.network_error)
                b.tvError.visibility = View.VISIBLE
            } finally {
                b.btnPair.isEnabled = true
                b.progressBar.visibility = View.GONE
            }
        }
    }
}
