package global.cpay.app.merchant

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import global.cpay.app.R
import global.cpay.app.databinding.ActivityMerchantMainBinding
import global.cpay.app.merchant.fragments.*

/**
 * Ecran principal marchand (WAVE-4 : caisse).
 * Navigation basse : Caisse · Encaisser · Retirer · Transférer · Journal.
 * Profil, règlements, terminaux, liens, KYB, comptes bancaires et l'ancien
 * décaissement restent accessibles depuis l'accueil Caisse (menu « Autres »).
 */
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
                R.id.nav_dashboard -> MerchDashboardFragment()
                R.id.nav_collect   -> CollectFragment()
                R.id.nav_withdraw  -> WithdrawFragment()
                R.id.nav_transfers -> TransfersFragment()
                R.id.nav_journal   -> CashJournalFragment()
                else               -> MerchDashboardFragment()
            })
            true
        }
        b.bottomNav.setOnItemReselectedListener { /* pas de rechargement */ }
    }

    /** Selectionne un onglet de la barre basse (declenche le chargement du fragment). */
    fun selectTab(itemId: Int) {
        if (!::b.isInitialized) return
        if (b.bottomNav.selectedItemId == itemId) {
            load(when (itemId) {
                R.id.nav_collect   -> CollectFragment()
                R.id.nav_withdraw  -> WithdrawFragment()
                R.id.nav_transfers -> TransfersFragment()
                R.id.nav_journal   -> CashJournalFragment()
                else               -> MerchDashboardFragment()
            })
        } else b.bottomNav.selectedItemId = itemId
    }

    fun openCollect()      = selectTab(R.id.nav_collect)
    fun openWithdraw()     = selectTab(R.id.nav_withdraw)
    fun openTransfers()    = selectTab(R.id.nav_transfers)
    fun openJournal()      = selectTab(R.id.nav_journal)

    fun openProfile()      = load(MerchProfileFragment())
    fun openSettlements()  = load(SettlementsFragment())
    fun openTerminals()    = load(TerminalsFragment())
    fun openPayLinks()     = load(PayLinksFragment())
    fun openKyb()          = load(KybDocumentsFragment())
    fun openTransactions() = load(MerchTransactionsFragment())
    /** Gestion des comptes bancaires (ancien ecran retraits/transferts). */
    fun openBankAccounts() = load(MerchTransferFragment())
    /** Ancien decaissement vers un client (conserve, hors barre basse). */
    fun openDisburse()     = load(DisburseFragment())

    private fun load(f: Fragment) {
        supportFragmentManager.beginTransaction()
            .replace(R.id.fragment_container, f).commitAllowingStateLoss()
    }
}
