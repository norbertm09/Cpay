package global.cpay.app.merchant

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import global.cpay.app.R
import global.cpay.app.databinding.ActivityMerchantMainBinding
import global.cpay.app.merchant.fragments.*

class MerchantMainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMerchantMainBinding

    override fun onCreate(s: Bundle?) {
        super.onCreate(s)

        // Si pas encore appaire a un terminal, montrer l'ecran d'appairage
        if (global.cpay.app.common.SessionManager.isPaired) {
            showDashboard(); return
        }
        val androidId = android.provider.Settings.Secure.getString(contentResolver, android.provider.Settings.Secure.ANDROID_ID)
        lifecycleScope.launch {
            try {
                val r = global.cpay.app.common.ApiClient.api.terminalCheck(global.cpay.app.common.CheckRequest(androidId = androidId))
                val body = r.body()
                if (r.isSuccessful && body != null && body.paired && !body.terminalId.isNullOrEmpty()) {
                    global.cpay.app.common.SessionManager.terminalId   = body.terminalId
                    global.cpay.app.common.SessionManager.terminalName = body.terminalName
                    global.cpay.app.common.SessionManager.terminalSite = body.siteName
                    showDashboard()
                } else goToPairing()
            } catch (e: Exception) { goToPairing() }
        }
    }
    private fun goToPairing() {
        startActivity(android.content.Intent(this, PairingActivity::class.java)); finish()
    }
    private fun showDashboard() {
        b = ActivityMerchantMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        load(MerchDashboardFragment())

        b.bottomNav.setOnItemSelectedListener { item ->
            load(when (item.itemId) {
                R.id.nav_dashboard    -> MerchDashboardFragment()
                R.id.nav_collect      -> CollectFragment()
                R.id.nav_disburse     -> DisburseFragment()
                R.id.nav_transactions -> MerchTransactionsFragment()
                R.id.nav_profile      -> MerchProfileFragment()
                else                  -> MerchDashboardFragment()
            })
            true
        }
    }

    fun openSettlements() = load(SettlementsFragment())
    fun openTerminals()   = load(TerminalsFragment())
    fun openTransfers()   = load(MerchTransferFragment())
    fun openPayLinks()    = load(global.cpay.app.merchant.fragments.PayLinksFragment())
    fun openKyb()         = load(global.cpay.app.merchant.fragments.KybDocumentsFragment())

    private fun load(f: Fragment) {
        supportFragmentManager.beginTransaction()
            .replace(R.id.fragment_container, f).commit()
    }
}
