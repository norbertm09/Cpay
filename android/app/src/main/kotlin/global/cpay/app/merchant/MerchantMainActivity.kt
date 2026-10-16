package global.cpay.app.merchant

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentManager
import androidx.lifecycle.lifecycleScope
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.CheckRequest
import global.cpay.app.common.SessionManager
import global.cpay.app.common.ui.UiPrefs
import global.cpay.app.databinding.ActivityMerchantMainBinding
import global.cpay.app.merchant.fragments.CaisseHomeFragment
import global.cpay.app.merchant.fragments.CashJournalFragment
import global.cpay.app.merchant.fragments.CollectAmountFragment
import global.cpay.app.merchant.fragments.DisburseFragment
import global.cpay.app.merchant.fragments.KybDocumentsFragment
import global.cpay.app.merchant.fragments.MerchProfileFragment
import global.cpay.app.merchant.fragments.MerchTransactionsFragment
import global.cpay.app.merchant.fragments.MerchTransferFragment
import global.cpay.app.merchant.fragments.MoreFragment
import global.cpay.app.merchant.fragments.PayLinksFragment
import global.cpay.app.merchant.fragments.SettlementsFragment
import global.cpay.app.merchant.fragments.SupportFragment
import global.cpay.app.merchant.fragments.TerminalsFragment
import global.cpay.app.merchant.fragments.TransfersFragment
import global.cpay.app.merchant.fragments.WithdrawFragment
import kotlinx.coroutines.launch

/**
 * Ecran principal marchand (WAVE-5).
 *
 * Barre basse a 4 onglets : Caisse · Encaisser · Journal · Plus. Les onglets sont des
 * ecrans racines (sans pile) ; les autres ecrans (Retirer, Transferer, Liens, Terminaux,
 * Reglements, Profil, Support, etapes de l'encaissement…) sont empiles avec [push] et
 * fermes par le bouton Retour. Re-toucher l'onglet courant revient a sa racine.
 */
class MerchantMainActivity : AppCompatActivity() {

    private lateinit var b: ActivityMerchantMainBinding
    private val fm: FragmentManager get() = supportFragmentManager

    override fun onCreate(s: Bundle?) {
        super.onCreate(s)

        // Appairage terminal : optionnel (« Continuer sans terminal » memorise le choix).
        if (SessionManager.isPaired || UiPrefs.pairingSkipped) {
            showMain(s); return
        }
        val androidId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
        lifecycleScope.launch {
            try {
                val r = ApiClient.api.terminalCheck(CheckRequest(androidId = androidId))
                val body = r.body()
                if (r.isSuccessful && body != null && body.paired && !body.terminalId.isNullOrEmpty()) {
                    SessionManager.terminalId   = body.terminalId
                    SessionManager.terminalName = body.terminalName
                    SessionManager.terminalSite = body.siteName
                    showMain(null)
                } else goToPairing()
            } catch (e: Exception) { goToPairing() }
        }
    }

    private fun goToPairing() {
        startActivity(Intent(this, PairingActivity::class.java)); finish()
    }

    private fun showMain(saved: Bundle?) {
        b = ActivityMerchantMainBinding.inflate(layoutInflater)
        setContentView(b.root)

        if (saved == null) fm.beginTransaction().replace(R.id.fragment_container, CaisseHomeFragment()).commit()

        b.bottomNav.setOnItemSelectedListener { item -> switchTab(item.itemId); true }
        b.bottomNav.setOnItemReselectedListener { popToRoot() }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    fm.backStackEntryCount > 0 -> fm.popBackStack()
                    b.bottomNav.selectedItemId != R.id.nav_dashboard -> b.bottomNav.selectedItemId = R.id.nav_dashboard
                    else -> finish()
                }
            }
        })
    }

    private fun rootFor(itemId: Int): Fragment = when (itemId) {
        R.id.nav_collect -> CollectAmountFragment()
        R.id.nav_journal -> CashJournalFragment()
        R.id.nav_more    -> MoreFragment()
        else             -> CaisseHomeFragment()
    }

    private fun switchTab(itemId: Int) {
        if (!::b.isInitialized) return
        popToRoot()
        fm.beginTransaction()
            .setReorderingAllowed(true)
            .replace(R.id.fragment_container, rootFor(itemId))
            .commitAllowingStateLoss()
    }

    /** Vide la pile d'ecrans secondaires (retour a la racine de l'onglet). */
    fun popToRoot() {
        if (fm.backStackEntryCount > 0) fm.popBackStack(null, FragmentManager.POP_BACK_STACK_INCLUSIVE)
    }

    /** Empile un ecran secondaire au-dessus de l'onglet courant. */
    fun push(f: Fragment, tag: String? = null) {
        if (!::b.isInitialized) return
        fm.beginTransaction()
            .setReorderingAllowed(true)
            .setCustomAnimations(R.anim.cpay_slide_in, R.anim.cpay_fade_out, R.anim.cpay_fade_in, R.anim.cpay_slide_out)
            .replace(R.id.fragment_container, f, tag)
            .addToBackStack(tag)
            .commitAllowingStateLoss()
    }

    /** Depile jusqu'a l'ecran [tag] (inclus). */
    fun popTo(tag: String, inclusive: Boolean = true) {
        fm.popBackStack(tag, if (inclusive) FragmentManager.POP_BACK_STACK_INCLUSIVE else 0)
    }

    fun pop() { if (fm.backStackEntryCount > 0) fm.popBackStack() else b.bottomNav.selectedItemId = R.id.nav_dashboard }

    /** Selectionne un onglet (declenche le chargement de sa racine). */
    fun selectTab(itemId: Int) {
        if (!::b.isInitialized) return
        if (b.bottomNav.selectedItemId == itemId) switchTab(itemId) else b.bottomNav.selectedItemId = itemId
    }

    // ─── Onglets ──────────────────────────────────────────────────────
    fun openHome()    = selectTab(R.id.nav_dashboard)
    fun openCollect() = selectTab(R.id.nav_collect)
    fun openJournal() = selectTab(R.id.nav_journal)
    fun openMore()    = selectTab(R.id.nav_more)

    // ─── Ecrans secondaires ───────────────────────────────────────────
    fun openWithdraw()     = push(WithdrawFragment(), "withdraw")
    fun openTransfers()    = push(TransfersFragment(), "transfers")
    fun openProfile()      = push(MerchProfileFragment(), "profile")
    fun openSettlements()  = push(SettlementsFragment(), "settlements")
    fun openTerminals()    = push(TerminalsFragment(), "terminals")
    fun openPayLinks()     = push(PayLinksFragment(), "paylinks")
    fun openKyb()          = push(KybDocumentsFragment(), "kyb")
    fun openTransactions() = push(MerchTransactionsFragment(), "transactions")
    fun openSupport()      = push(SupportFragment(), "support")
    /** Gestion des comptes bancaires (ancien ecran retraits/transferts). */
    fun openBankAccounts() = push(MerchTransferFragment(), "bank_accounts")
    /** Ancien decaissement vers un client (conserve, hors barre basse). */
    fun openDisburse()     = push(DisburseFragment(), "disburse")
}
