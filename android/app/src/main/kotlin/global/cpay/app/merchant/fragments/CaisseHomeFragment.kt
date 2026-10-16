package global.cpay.app.merchant.fragments

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.ApiErrors
import global.cpay.app.common.CashSummary
import global.cpay.app.common.HistoryEntry
import global.cpay.app.common.HistoryResponse
import global.cpay.app.common.SessionManager
import global.cpay.app.common.ui.Fmt
import global.cpay.app.common.ui.Net
import global.cpay.app.common.ui.UiPrefs
import global.cpay.app.databinding.FragmentCaisseHomeBinding
import global.cpay.app.db.CacheManager
import global.cpay.app.merchant.CashSession
import global.cpay.app.merchant.MerchantMainActivity
import kotlinx.coroutines.launch
import java.util.Date

/**
 * Accueil « Caisse » (WAVE-5) : solde disponible (masquable), encaissements du jour par
 * methode, quatre tuiles, aides d'onboarding fermables, cinq dernieres operations,
 * tirer-pour-actualiser et bandeau hors ligne (cache Room du dernier resume).
 */
class CaisseHomeFragment : Fragment() {

    private var _b: FragmentCaisseHomeBinding? = null
    private val b get() = _b!!
    private var currency = CashSession.currency
    private val recent = mutableListOf<HistoryEntry>()
    private lateinit var adapter: HistoryEntryAdapter
    private var cachedAt: Long? = null

    private val act: MerchantMainActivity? get() = activity as? MerchantMainActivity

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentCaisseHomeBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        b.tvWelcome.text = getString(R.string.caisse_hello_fmt, SessionManager.userName ?: getString(R.string.profile_merchant))
        b.tvTerminal.text = when {
            SessionManager.isPaired -> listOfNotNull(SessionManager.terminalName, SessionManager.terminalSite).joinToString(" · ")
            else -> getString(R.string.app_description)
        }

        b.swipe.setColorSchemeResources(R.color.brand_primary, R.color.brand_accent)
        b.swipe.setOnRefreshListener { load(fromUser = true) }
        b.btnProfile.setOnClickListener { act?.openProfile() }
        b.btnEye.setOnClickListener {
            UiPrefs.balanceHidden = !UiPrefs.balanceHidden
            CashSession.summary?.let { render(it) }
        }

        b.tileCollect.setOnClickListener  { act?.openCollect() }
        b.tileWithdraw.setOnClickListener { act?.openWithdraw() }
        b.tileTransfer.setOnClickListener { act?.openTransfers() }
        b.tileJournal.setOnClickListener  { act?.openJournal() }
        b.btnRecentAll.setOnClickListener { act?.openJournal() }

        b.btnHintWallet.setOnClickListener { act?.openWithdraw() }
        b.btnHintBank.setOnClickListener   { act?.openBankAccounts() }
        b.btnHintKyb.setOnClickListener    { act?.openKyb() }
        b.btnHintWalletClose.setOnClickListener { UiPrefs.dismissHint(HINT_WALLET); b.hintWallet.visibility = View.GONE }
        b.btnHintBankClose.setOnClickListener   { UiPrefs.dismissHint(HINT_BANK);   b.hintBank.visibility = View.GONE }
        b.btnHintKybClose.setOnClickListener    { UiPrefs.dismissHint(HINT_KYB);    b.hintKyb.visibility = View.GONE }

        adapter = HistoryEntryAdapter(recent, { currency }) { e -> JournalDetailSheet.show(requireContext(), e, currency) }
        b.rvRecent.layoutManager = LinearLayoutManager(context)
        b.rvRecent.adapter = adapter

        CashSession.summary?.let { render(it) }   // affichage immediat du dernier resume
        load(fromUser = false)
    }

    override fun onResume() {
        super.onResume()
        if (CashSession.summary != null && _b != null && !b.swipe.isRefreshing) load(fromUser = false)
    }

    private fun load(fromUser: Boolean) {
        if (_b == null) return
        val ctx = requireContext().applicationContext
        if (!fromUser && CashSession.summary == null) b.swipe.isRefreshing = true
        b.tvError.visibility = View.GONE
        viewLifecycleOwner.lifecycleScope.launch {
            var online = true
            // 1. Resume de caisse
            try {
                val r = ApiClient.api.cashSummary()
                if (_b == null) return@launch
                val s = r.body()
                if (r.isSuccessful && s != null) {
                    CashSession.summary = s
                    cachedAt = null
                    render(s)
                    CacheManager.putJson(ctx, CacheManager.KEY_CASH_SUMMARY, s)
                } else if (ApiErrors.isFeatureDisabled(r)) {
                    showError(getString(R.string.caisse_feature_pending))
                } else {
                    showError(ApiErrors.cashMessage(r, currency, getString(R.string.caisse_error_load)))
                }
            } catch (e: Exception) {
                online = false
                if (_b == null) return@launch
                if (CashSession.summary == null) {
                    val cached = CacheManager.getJson(ctx, CacheManager.KEY_CASH_SUMMARY, CashSummary::class.java)
                    if (_b == null) return@launch
                    if (cached != null) { cachedAt = cached.savedAt; render(cached.value) }
                    else showError(getString(R.string.network_error))
                } else if (cachedAt == null) {
                    cachedAt = System.currentTimeMillis()
                }
            }
            if (_b == null) return@launch
            renderOfflineBanner(online)
            // 2. Dernieres operations
            loadRecent(online)
            if (_b != null) b.swipe.isRefreshing = false
        }
    }

    private suspend fun loadRecent(online: Boolean) {
        val ctx = requireContext().applicationContext
        if (recent.isEmpty()) b.progressRecent.visibility = View.VISIBLE
        var list: List<HistoryEntry>? = null
        if (online) {
            try {
                val r = ApiClient.api.cashHistory(limit = RECENT_LIMIT, offset = 0)
                if (_b == null) return
                if (r.isSuccessful) {
                    val body = r.body()
                    list = body?.data ?: emptyList()
                    if (body != null) CacheManager.putJson(ctx, CacheManager.keyHistory(null), body)
                }
            } catch (_: Exception) { }
        }
        if (list == null) {
            val cached = CacheManager.getJson(ctx, CacheManager.keyHistory(null), HistoryResponse::class.java)
            list = cached?.value?.data?.take(RECENT_LIMIT)
        }
        if (_b == null) return
        b.progressRecent.visibility = View.GONE
        if (list != null) {
            recent.clear(); recent.addAll(list.take(RECENT_LIMIT))
            adapter.notifyDataSetChanged()
        }
        b.tvRecentEmpty.visibility = if (recent.isEmpty()) View.VISIBLE else View.GONE
    }

    private fun renderOfflineBanner(online: Boolean) {
        val offline = !online || !Net.isOnline(requireContext())
        val banner = b.offlineBanner
        if (!offline) { banner.root.visibility = View.GONE; return }
        banner.root.visibility = View.VISIBLE
        val at = cachedAt
        banner.tvOfflineText.text = if (at != null) getString(R.string.offline_data_from, Fmt.dateTime(Date(at)))
                                    else getString(R.string.offline_no_data)
    }

    private fun money(v: Double?) = Fmt.money(v, currency)

    private fun render(s: CashSummary) {
        if (_b == null) return
        currency = s.cur
        val hidden = UiPrefs.balanceHidden
        val bal = s.balance
        b.tvAvailable.text = if (hidden) getString(R.string.caisse_hidden) else money(bal?.available)
        b.tvPending.text   = getString(R.string.caisse_pending_fmt, if (hidden) getString(R.string.caisse_hidden) else money(bal?.pending))
        val reserved = bal?.reserved ?: 0.0
        b.tvReserved.visibility = if (reserved > 0) View.VISIBLE else View.GONE
        b.tvReserved.text = getString(R.string.caisse_reserved_fmt, if (hidden) getString(R.string.caisse_hidden) else money(reserved))
        b.btnEye.setIconResource(if (hidden) R.drawable.ic_visibility_off else R.drawable.ic_visibility)

        val t = s.today
        b.tvTodayCount.text     = getString(R.string.caisse_today_count_fmt, t?.collectedCount ?: 0)
        b.tvTodayCollected.text = money(t?.collected)
        b.tvByMomo.text         = money(t?.mobileMoney)
        b.tvByCard.text         = money(t?.card)
        b.tvWithdrawn.text      = "${getString(R.string.caisse_withdrawn)} : ${money((t?.withdrawn ?: 0.0) + (t?.transfersOut ?: 0.0))}"

        val p = s.profile
        val walletMissing = p != null && (p.wallet == null || !p.wallet.isSet)
        b.hintWallet.visibility = if (walletMissing && !UiPrefs.isHintDismissed(HINT_WALLET)) View.VISIBLE else View.GONE
        b.hintBank.visibility   = if (p != null && p.bankAccounts <= 0 && !UiPrefs.isHintDismissed(HINT_BANK)) View.VISIBLE else View.GONE
        b.hintKyb.visibility    = if (p != null && p.kybLevel <= 0 && !UiPrefs.isHintDismissed(HINT_KYB)) View.VISIBLE else View.GONE
        when (p?.cardAcceptance) {
            "unavailable"          -> { b.tvHintCard.setText(R.string.caisse_hint_card_unavailable); b.tvHintCard.visibility = View.VISIBLE }
            "tap_to_phone_pending" -> { b.tvHintCard.setText(R.string.caisse_hint_card_pending);     b.tvHintCard.visibility = View.VISIBLE }
            else                   -> b.tvHintCard.visibility = View.GONE
        }
    }

    private fun showError(m: String) {
        if (_b == null) return
        b.tvError.text = m
        b.tvError.visibility = View.VISIBLE
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }

    private companion object {
        const val RECENT_LIMIT = 5
        const val HINT_WALLET = "wallet"
        const val HINT_BANK   = "bank"
        const val HINT_KYB    = "kyb"
    }
}
