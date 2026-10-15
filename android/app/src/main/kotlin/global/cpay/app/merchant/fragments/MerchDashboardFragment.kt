package global.cpay.app.merchant.fragments

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.ApiErrors
import global.cpay.app.common.CashSummary
import global.cpay.app.common.SessionManager
import global.cpay.app.databinding.FragmentMerchDashboardBinding
import global.cpay.app.merchant.CashSession
import global.cpay.app.merchant.MerchantMainActivity
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

/**
 * Accueil « Caisse » (WAVE-4) : solde disponible / en attente, encaissements du jour
 * par méthode, 4 tuiles (Encaisser, Retirer, Transférer, Journal), aides à
 * l'onboarding (wallet manquant, aucun compte bancaire) et accès aux autres écrans.
 * Source : GET /merchant/cash/summary.
 */
class MerchDashboardFragment : Fragment() {

    private var _b: FragmentMerchDashboardBinding? = null
    private val b get() = _b!!
    private val fmt = NumberFormat.getNumberInstance(Locale.FRANCE)
    private var currency = "XAF"

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentMerchDashboardBinding.inflate(inflater, container, false)
        return b.root
    }

    private val act: MerchantMainActivity? get() = activity as? MerchantMainActivity

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.tvWelcome.text = "Bonjour, ${SessionManager.userName ?: "marchand"} 🏪"

        b.btnRefresh.setOnClickListener { load() }
        b.btnProfile.setOnClickListener { act?.openProfile() }

        b.tileCollect.setOnClickListener  { act?.openCollect() }
        b.tileWithdraw.setOnClickListener { act?.openWithdraw() }
        b.tileTransfer.setOnClickListener { act?.openTransfers() }
        b.tileJournal.setOnClickListener  { act?.openJournal() }

        b.tvHintWallet.setOnClickListener { act?.openWithdraw() }
        b.tvHintBank.setOnClickListener   { act?.openBankAccounts() }

        b.btnSettlements.setOnClickListener  { act?.openSettlements() }
        b.btnTerminals.setOnClickListener    { act?.openTerminals() }
        b.btnPayLinks.setOnClickListener     { act?.openPayLinks() }
        b.btnBankAccounts.setOnClickListener { act?.openBankAccounts() }
        b.btnDisburse.setOnClickListener     { act?.openDisburse() }
        b.btnKyb.setOnClickListener          { act?.openKyb() }

        CashSession.summary?.let { render(it) }   // affichage immediat du dernier resume
        load()
    }

    override fun onResume() {
        super.onResume()
        if (CashSession.summary != null) load()
    }

    private fun money(v: Double?) = "${fmt.format(v ?: 0.0)} $currency"

    private fun load() {
        if (_b == null) return
        b.progressBar.visibility = View.VISIBLE
        b.tvError.visibility = View.GONE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cashSummary()
                if (_b == null) return@launch
                val s = r.body()
                if (r.isSuccessful && s != null) {
                    CashSession.summary = s
                    render(s)
                } else if (ApiErrors.isFeatureDisabled(r)) {
                    showError(getString(R.string.caisse_feature_pending))
                } else {
                    showError(ApiErrors.cashMessage(r, currency, getString(R.string.caisse_error_load)))
                }
            } catch (e: Exception) {
                if (_b != null) showError(getString(R.string.network_error))
            } finally {
                if (_b != null) b.progressBar.visibility = View.GONE
            }
        }
    }

    private fun render(s: CashSummary) {
        currency = s.cur
        val bal = s.balance
        b.tvAvailable.text = money(bal?.available)
        b.tvPending.text   = "En attente : ${money(bal?.pending)}"
        val reserved = bal?.reserved ?: 0.0
        b.tvReserved.visibility = if (reserved > 0) View.VISIBLE else View.GONE
        b.tvReserved.text = "Réservé : ${money(reserved)}"

        val t = s.today
        val n = t?.collectedCount ?: 0
        b.tvTodayCount.text     = "$n encaissement${if (n > 1) "s" else ""}"
        b.tvTodayCollected.text = money(t?.collected)
        b.tvByMomo.text         = money(t?.mobileMoney)
        b.tvByCard.text         = money(t?.card)
        b.tvWithdrawn.text      = money((t?.withdrawn ?: 0.0) + (t?.transfersOut ?: 0.0))

        val p = s.profile
        val walletMissing = p != null && (p.wallet == null || !p.wallet.isSet)
        b.tvHintWallet.visibility = if (walletMissing) View.VISIBLE else View.GONE
        b.tvHintBank.visibility   = if (p != null && p.bankAccounts <= 0) View.VISIBLE else View.GONE
        when (p?.cardAcceptance) {
            "unavailable" -> { b.tvHintCard.setText(R.string.caisse_hint_card_unavailable); b.tvHintCard.visibility = View.VISIBLE }
            "tap_to_phone_pending" -> { b.tvHintCard.setText(R.string.caisse_hint_card_pending); b.tvHintCard.visibility = View.VISIBLE }
            else -> b.tvHintCard.visibility = View.GONE
        }
    }

    private fun showError(m: String) {
        b.tvError.text = m
        b.tvError.visibility = View.VISIBLE
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
