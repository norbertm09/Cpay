package global.cpay.app.merchant.fragments

import android.content.res.ColorStateList
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.SessionManager
import global.cpay.app.common.ApiError
import global.cpay.app.common.ApiErrors
import global.cpay.app.common.CashLabels
import global.cpay.app.common.CashSummary
import global.cpay.app.common.CashWallet
import global.cpay.app.common.CashWalletRequest
import global.cpay.app.common.PhoneDetection
import global.cpay.app.common.SecurityManager
import global.cpay.app.common.WithdrawRequest
import global.cpay.app.common.WithdrawResponse
import global.cpay.app.common.ui.Fmt
import global.cpay.app.common.ui.ResultSheet
import global.cpay.app.common.ui.StatusUi
import global.cpay.app.databinding.FragmentWithdrawBinding
import global.cpay.app.merchant.CashSession
import global.cpay.app.merchant.MerchantMainActivity
import global.cpay.app.merchant.StepUp
import kotlinx.coroutines.launch

/**
 * Retirer (WAVE-5, docs/CAISSE-API.md §3-4) : wallet de destination (GET/PUT
 * /merchant/cash/wallet avec confirmation forte), montant avec « Tout retirer »,
 * estimation des frais, plafond journalier, POST /merchant/cash/withdraw avec step-up
 * (feuille TOTP ou mot de passe) puis feuille de resultat.
 */
class WithdrawFragment : Fragment() {

    private var _b: FragmentWithdrawBinding? = null
    private val b get() = _b!!
    private val handler = Handler(Looper.getMainLooper())

    private var currency = CashSession.currency
    private var summary: CashSummary? = CashSession.summary
    private var wallet: CashWallet? = null
    private var walletDetection: PhoneDetection? = null
    private var selectedOperator: String = CashLabels.OPERATORS.first().first
    private var featureDisabled = false
    private val detectRunnable = Runnable { detectWalletPhone() }

    private val act: MerchantMainActivity? get() = activity as? MerchantMainActivity

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentWithdrawBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        b.header.tvScreenTitle.text = getString(R.string.withdraw_title)
        b.header.btnBack.setOnClickListener { act?.pop() }

        val labels = CashLabels.OPERATORS.map { it.second }
        b.acOperator.setAdapter(ArrayAdapter(requireContext(), android.R.layout.simple_list_item_1, labels))
        b.acOperator.setOnItemClickListener { _, _, pos, _ -> selectedOperator = CashLabels.OPERATORS[pos].first }

        b.btnEditWallet.setOnClickListener   { showWalletForm() }
        b.btnCancelWallet.setOnClickListener { b.layoutWalletForm.visibility = View.GONE }
        b.btnSaveWallet.setOnClickListener   { saveWallet() }
        b.btnWithdraw.setOnClickListener     { doWithdraw() }
        b.chipAll.setOnClickListener {
            val s0 = summary ?: return@setOnClickListener
            val max = listOfNotNull(s0.available, s0.limits?.withdrawDailyRemaining).minOrNull() ?: s0.available
            b.etAmount.setText(Fmt.amount(max).replace(Regex("[^0-9]"), ""))
            b.etAmount.setSelection(b.etAmount.text?.length ?: 0)
        }
        b.etAmount.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, c: Int, d: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, c: Int, d: Int) {}
            override fun afterTextChanged(s: Editable?) { b.tvError.visibility = View.GONE; renderFee() }
        })
        b.etWalletPhone.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, c: Int, d: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, c: Int, d: Int) {}
            override fun afterTextChanged(s: Editable?) {
                handler.removeCallbacks(detectRunnable)
                walletDetection = null
                b.tvWalletDetect.text = ""
                if ((s?.toString() ?: "").filter { it.isDigit() }.length >= 8) handler.postDelayed(detectRunnable, 450)
            }
        })

        summary?.let { renderSummary(it) }
        renderWallet()
        load()
    }

    private fun money(v: Double?) = Fmt.money(v, currency)

    private fun load() {
        b.progressBar.visibility = View.VISIBLE
        b.tvError.visibility = View.GONE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val rs = ApiClient.api.cashSummary()
                if (_b == null) return@launch
                val s = rs.body()
                if (rs.isSuccessful && s != null) { summary = s; CashSession.summary = s; renderSummary(s) }
                else if (ApiErrors.isFeatureDisabled(rs)) setFeatureDisabled()
            } catch (_: Exception) {}
            try {
                val rw = ApiClient.api.cashWallet()
                if (_b == null) return@launch
                when {
                    rw.code() == 204 -> wallet = null
                    rw.isSuccessful  -> wallet = rw.body()?.takeIf { it.isSet }
                    ApiErrors.isFeatureDisabled(rw) -> setFeatureDisabled()
                    else -> wallet = summary?.profile?.wallet?.takeIf { it.isSet }
                }
            } catch (_: Exception) {
                wallet = summary?.profile?.wallet?.takeIf { it.isSet }
            }
            if (_b == null) return@launch
            renderWallet()
            b.progressBar.visibility = View.GONE
        }
    }

    private fun setFeatureDisabled() {
        featureDisabled = true
        b.tvFeature.visibility = View.VISIBLE
        b.btnWithdraw.isEnabled = false
    }

    private fun renderSummary(s: CashSummary) {
        currency = s.cur
        b.tvAvailable.text = money(s.available)
        val lim = s.limits
        b.tvDailyRemaining.text = when {
            lim?.withdrawDailyRemaining != null && lim.withdrawDailyMax != null ->
                getString(R.string.withdraw_daily_remaining_max_fmt, money(lim.withdrawDailyRemaining), money(lim.withdrawDailyMax))
            lim?.withdrawDailyRemaining != null -> getString(R.string.withdraw_daily_remaining_fmt, money(lim.withdrawDailyRemaining))
            else -> ""
        }
        renderFee()
    }

    private fun renderFee() {
        if (_b == null) return
        val amt = b.etAmount.text.toString().replace(" ", "").toDoubleOrNull()
        val fee = if (amt != null && amt > 0) summary?.limits?.estimateWithdrawFee(amt) else null
        b.tvFeeEstimate.text = if (fee != null && amt != null) getString(R.string.withdraw_fee_estimate_fmt, money(fee), money(amt - fee)) else ""
    }

    private fun renderWallet() {
        val w = wallet
        val ctx = requireContext()
        if (w == null) {
            b.tvWalletOperator.setText(R.string.withdraw_wallet_none)
            b.tvWalletPhone.setText(R.string.withdraw_wallet_none_body)
            b.tvWalletVerified.visibility = View.GONE
            b.tvWalletInitials.text = "MM"
            b.tvWalletInitials.backgroundTintList = ColorStateList.valueOf(ContextCompat.getColor(ctx, R.color.primary_container))
            b.tvWalletInitials.setTextColor(ContextCompat.getColor(ctx, R.color.brand_primary))
            b.btnEditWallet.setText(R.string.withdraw_wallet_add)
        } else {
            b.tvWalletOperator.text = w.operatorLabel
            b.tvWalletPhone.text = w.phone ?: ""
            b.tvWalletInitials.text = StatusUi.operatorInitials(w.operatorLabel)
            b.tvWalletInitials.backgroundTintList = ColorStateList.valueOf(StatusUi.operatorColor(w.operator))
            b.tvWalletInitials.setTextColor(StatusUi.operatorTextColor(w.operator))
            b.tvWalletVerified.visibility = View.VISIBLE
            val verified = !w.verifiedAt.isNullOrBlank()
            b.tvWalletVerified.text = getString(if (verified) R.string.withdraw_wallet_verified else R.string.withdraw_wallet_unverified)
            val (fg, bg) = StatusUi.statusColors(ctx, if (verified) "completed" else "pending")
            b.tvWalletVerified.setTextColor(fg)
            b.tvWalletVerified.backgroundTintList = ColorStateList.valueOf(bg)
            b.btnEditWallet.setText(R.string.withdraw_wallet_edit)
        }
    }

    // ─── Wallet ─────────────────────────────────────────────────────
    private fun showWalletForm() {
        b.layoutWalletForm.visibility = View.VISIBLE
        val w = wallet
        val idx = CashLabels.OPERATORS.indexOfFirst { it.first == w?.operator?.lowercase() }.takeIf { it >= 0 } ?: 0
        selectedOperator = CashLabels.OPERATORS[idx].first
        b.acOperator.setText(CashLabels.OPERATORS[idx].second, false)
        if (w != null) b.etWalletPhone.setText(w.phone ?: "")
        b.etWalletPhone.requestFocus()
    }

    private fun detectWalletPhone() {
        if (_b == null) return
        val phone = b.etWalletPhone.text.toString().trim()
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val d = ApiClient.api.detectPhone(buildMap { put("phone", phone); SessionManager.userCountry?.let { put("country", it) } }).body() ?: return@launch
                if (_b == null) return@launch
                walletDetection = d
                if (d.success) {
                    b.tvWalletDetect.text = listOfNotNull(StatusUi.flag(d.country).takeIf { it.isNotEmpty() }, d.operatorLabel, d.countryName ?: d.country).joinToString(" ")
                    val idx = operatorIndexFor(d)
                    if (idx >= 0) {
                        selectedOperator = CashLabels.OPERATORS[idx].first
                        b.acOperator.setText(CashLabels.OPERATORS[idx].second, false)
                    }
                } else {
                    b.tvWalletDetect.text = getString(R.string.withdraw_wallet_detect_manual)
                }
            } catch (_: Exception) {}
        }
    }

    private fun operatorIndexFor(d: PhoneDetection): Int {
        val op = (d.operator ?: "").lowercase()
        val brand = (d.brand ?: "§").lowercase()
        return CashLabels.OPERATORS.indexOfFirst {
            it.first == op || it.first.startsWith("${op}_") || it.second.lowercase().contains(brand)
        }
    }

    private fun saveWallet() {
        val op = selectedOperator
        val raw = b.etWalletPhone.text.toString().trim()
        SecurityManager.validatePhone(raw)?.let { b.tilWalletPhone.error = it; return }
        b.tilWalletPhone.error = null
        val phone = walletDetection?.phone?.takeIf { it.isNotBlank() } ?: SecurityManager.normalizePhone(raw)
        val ctx = requireContext()
        b.progressBar.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = StepUp.run(ctx, getString(R.string.withdraw_wallet_add)) { confirm ->
                    ApiClient.api.cashWalletUpdate(CashWalletRequest(op, phone, confirm))
                }
                if (_b == null || r == null) return@launch
                if (r.isSuccessful) {
                    wallet = r.body()?.takeIf { it.isSet } ?: CashWallet(op, phone, null)
                    b.layoutWalletForm.visibility = View.GONE
                    renderWallet()
                    ResultSheet.show(ctx, ResultSheet.Spec(ResultSheet.Kind.SUCCESS, getString(R.string.withdraw_wallet_saved),
                        body = "${wallet?.operatorLabel} · ${wallet?.phone}"))
                } else {
                    val e = ApiErrors.of(r)
                    if (r.code() == 410 || e.code == ApiErrors.FEATURE_DISABLED) setFeatureDisabled()
                    showErr(ApiErrors.cashMessage(r.code(), e, currency, getString(R.string.withdraw_wallet_error)))
                }
            } catch (e: Exception) {
                if (_b != null) showErr(getString(R.string.network_error))
            } finally {
                if (_b != null) b.progressBar.visibility = View.GONE
            }
        }
    }

    // ─── Retrait ────────────────────────────────────────────────────
    private fun doWithdraw() {
        if (featureDisabled) { showErr(getString(R.string.feature_disabled)); return }
        val amt = b.etAmount.text.toString().replace(" ", "").replace(",", ".").toDoubleOrNull()
        val e1 = if (amt == null) getString(R.string.amount_invalid) else SecurityManager.validateAmount(amt)
        if (e1 != null) { b.tilAmount.error = e1; return }
        b.tilAmount.error = null
        if (wallet == null) {
            showErr(ApiErrors.cashMessage(422, ApiError(code = ApiErrors.WALLET_MISSING), currency))
            showWalletForm(); return
        }
        val s = summary
        if (s != null && amt!! > s.available) { showErr(getString(R.string.withdraw_insufficient_fmt, money(s.available))); return }
        val remaining = s?.limits?.withdrawDailyRemaining
        if (remaining != null && amt!! > remaining) { showErr(getString(R.string.withdraw_limit_fmt, money(remaining))); return }
        val desc = b.etDescription.text.toString().trim()
        val idem = SecurityManager.generateRef("IDK")
        val ctx = requireContext()
        b.tvError.visibility = View.GONE
        b.progressBar.visibility = View.VISIBLE
        b.btnWithdraw.isEnabled = false
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = StepUp.run(ctx, getString(R.string.withdraw_confirm_title_fmt, money(amt))) { confirm ->
                    ApiClient.api.cashWithdraw(idem, WithdrawRequest(amt!!, desc.ifEmpty { null }, confirm))
                }
                if (_b == null || r == null) return@launch
                val body = r.body()
                if (r.isSuccessful && body != null) {
                    b.etAmount.text?.clear(); b.etDescription.text?.clear()
                    showResult(body, amt!!)
                    load()
                } else {
                    val e = ApiErrors.of(r)
                    if (r.code() == 410 || e.code == ApiErrors.FEATURE_DISABLED) setFeatureDisabled()
                    if (e.code == ApiErrors.WALLET_MISSING) { wallet = null; renderWallet() }
                    showErr(ApiErrors.cashMessage(r.code(), e, currency, getString(R.string.withdraw_refused)))
                }
            } catch (e: Exception) {
                if (_b != null) showErr(getString(R.string.network_error))
            } finally {
                if (_b != null) {
                    b.progressBar.visibility = View.GONE
                    if (!featureDisabled) b.btnWithdraw.isEnabled = true
                }
            }
        }
    }

    private fun showResult(r: WithdrawResponse, amt: Double) {
        val w = r.wallet ?: wallet
        ResultSheet.show(requireContext(), ResultSheet.Spec(
            kind = ResultSheet.Kind.SUCCESS,
            title = getString(R.string.withdraw_done),
            amount = money(r.net ?: r.amount ?: amt),
            body = getString(R.string.withdraw_done_body),
            rows = listOf(
                getString(R.string.reference) to (r.reference ?: r.transferId),
                getString(R.string.status) to StatusUi.statusLabel(requireContext(), r.status),
                getString(R.string.withdraw_wallet) to w?.let { "${it.operatorLabel} ${it.phone ?: ""}".trim() },
                getString(R.string.fees) to r.fee?.takeIf { it > 0 }?.let { money(it) },
            ),
            primaryLabel = getString(R.string.close),
            secondaryLabel = getString(R.string.nav_journal),
            secondary = { act?.openJournal() },
        ))
    }

    private fun showErr(m: String) {
        if (_b == null) return
        b.tvError.text = m; b.tvError.visibility = View.VISIBLE
    }

    override fun onDestroyView() {
        handler.removeCallbacks(detectRunnable)
        super.onDestroyView(); _b = null
    }
}
