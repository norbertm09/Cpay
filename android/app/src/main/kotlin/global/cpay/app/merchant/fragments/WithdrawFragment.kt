package global.cpay.app.merchant.fragments

import android.app.Dialog
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.widget.ArrayAdapter
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.ApiErrors
import global.cpay.app.common.CashLabels
import global.cpay.app.common.CashSummary
import global.cpay.app.common.CashWallet
import global.cpay.app.common.CashWalletRequest
import global.cpay.app.common.PhoneDetection
import global.cpay.app.common.SecurityManager
import global.cpay.app.common.WithdrawRequest
import global.cpay.app.common.WithdrawResponse
import global.cpay.app.databinding.FragmentWithdrawBinding
import global.cpay.app.merchant.CashSession
import global.cpay.app.merchant.StepUp
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

/**
 * Retirer (WAVE-4, docs/CAISSE-API.md §3-4) : wallet de destination (GET/PUT
 * /merchant/cash/wallet avec confirmation forte), montant, plafond journalier restant,
 * POST /merchant/cash/withdraw { amount, description?, confirm } avec step-up (TOTP ou
 * mot de passe, 428 → relecture de `methods`). Messages dédiés : INSUFFICIENT_BALANCE,
 * DAILY_LIMIT_EXCEEDED, WALLET_MISSING, FEATURE_DISABLED.
 */
class WithdrawFragment : Fragment() {

    private var _b: FragmentWithdrawBinding? = null
    private val b get() = _b!!
    private val fmt = NumberFormat.getNumberInstance(Locale.FRANCE)
    private val handler = Handler(Looper.getMainLooper())

    private var currency = CashSession.currency
    private var summary: CashSummary? = CashSession.summary
    private var wallet: CashWallet? = null
    private var walletDetection: PhoneDetection? = null
    private val detectRunnable = Runnable { detectWalletPhone() }

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentWithdrawBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        val ad = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item,
            CashLabels.OPERATORS.map { it.second })
        ad.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        b.spinnerOperator.adapter = ad

        b.btnEditWallet.setOnClickListener   { showWalletForm() }
        b.btnCancelWallet.setOnClickListener { b.layoutWalletForm.visibility = View.GONE }
        b.btnSaveWallet.setOnClickListener   { saveWallet() }
        b.btnWithdraw.setOnClickListener     { doWithdraw() }

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
        load()
    }

    private fun money(v: Double?) = "${fmt.format(v ?: 0.0)} $currency"

    private fun load() {
        b.progressBar.visibility = View.VISIBLE
        b.tvError.visibility = View.GONE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val rs = ApiClient.api.cashSummary()
                if (_b == null) return@launch
                val s = rs.body()
                if (rs.isSuccessful && s != null) { summary = s; CashSession.summary = s; renderSummary(s) }
                else if (ApiErrors.isFeatureDisabled(rs)) featureDisabled()
            } catch (_: Exception) {}
            try {
                val rw = ApiClient.api.cashWallet()
                if (_b == null) return@launch
                when {
                    rw.code() == 204 -> wallet = null
                    rw.isSuccessful  -> wallet = rw.body()?.takeIf { it.isSet }
                    ApiErrors.isFeatureDisabled(rw) -> featureDisabled()
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

    private fun featureDisabled() {
        b.tvFeature.visibility = View.VISIBLE
        b.btnWithdraw.isEnabled = false
        b.btnWithdraw.alpha = 0.5f
    }

    private fun renderSummary(s: CashSummary) {
        currency = s.cur
        b.tvAvailable.text = "Disponible : ${money(s.available)}"
        val lim = s.limits
        b.tvDailyRemaining.text = when {
            lim?.withdrawDailyRemaining != null && lim.withdrawDailyMax != null ->
                "${getString(R.string.withdraw_daily_remaining)} : ${money(lim.withdrawDailyRemaining)} / ${money(lim.withdrawDailyMax)}"
            lim?.withdrawDailyRemaining != null ->
                "${getString(R.string.withdraw_daily_remaining)} : ${money(lim.withdrawDailyRemaining)}"
            else -> ""
        }
    }

    private fun renderWallet() {
        val w = wallet
        if (w == null) {
            b.tvWalletOperator.setText(R.string.withdraw_wallet_none)
            b.tvWalletPhone.text = "Nécessaire pour recevoir vos retraits"
            b.tvWalletVerified.text = ""
            b.btnEditWallet.setText(R.string.withdraw_wallet_add)
        } else {
            b.tvWalletOperator.text = w.operatorLabel
            b.tvWalletPhone.text = w.phone ?: ""
            b.tvWalletVerified.text = if (w.verifiedAt.isNullOrBlank()) getString(R.string.withdraw_wallet_unverified)
                                      else getString(R.string.withdraw_wallet_verified)
            b.tvWalletVerified.setTextColor(Color.parseColor(if (w.verifiedAt.isNullOrBlank()) "#c47000" else "#007a5a"))
            b.btnEditWallet.setText(R.string.withdraw_wallet_edit)
        }
    }

    // ─── Wallet ─────────────────────────────────────────────────────
    private fun showWalletForm() {
        b.layoutWalletForm.visibility = View.VISIBLE
        wallet?.let { w ->
            val idx = CashLabels.OPERATORS.indexOfFirst { it.first == w.operator?.lowercase() }
            if (idx >= 0) b.spinnerOperator.setSelection(idx)
            b.etWalletPhone.setText(w.phone ?: "")
        }
    }

    private fun detectWalletPhone() {
        if (_b == null) return
        val phone = b.etWalletPhone.text.toString().trim()
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val d = ApiClient.api.detectPhone(mapOf("phone" to phone)).body() ?: return@launch
                if (_b == null) return@launch
                walletDetection = d
                if (d.success) {
                    b.tvWalletDetect.text = "📱 ${d.operatorLabel} · ${d.countryName ?: d.country ?: ""}"
                    val idx = operatorIndexFor(d)
                    if (idx >= 0) b.spinnerOperator.setSelection(idx)
                } else {
                    b.tvWalletDetect.text = "⚠️ ${d.error ?: "Opérateur non reconnu"} — choisissez-le manuellement"
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
        val op = CashLabels.OPERATORS.getOrNull(b.spinnerOperator.selectedItemPosition)?.first ?: return
        val raw = b.etWalletPhone.text.toString().trim()
        SecurityManager.validatePhone(raw)?.let { toast(it); return }
        val phone = walletDetection?.phone?.takeIf { it.isNotBlank() } ?: SecurityManager.normalizePhone(raw)
        val ctx = requireContext()
        b.progressBar.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = StepUp.run(ctx, "Enregistrer le wallet") { confirm ->
                    ApiClient.api.cashWalletUpdate(CashWalletRequest(op, phone, confirm))
                }
                if (_b == null) return@launch
                if (r == null) return@launch
                if (r.isSuccessful) {
                    wallet = r.body()?.takeIf { it.isSet } ?: CashWallet(op, phone, null)
                    b.layoutWalletForm.visibility = View.GONE
                    renderWallet()
                    toast("Wallet enregistré ✅")
                } else {
                    val e = ApiErrors.of(r)
                    if (r.code() == 410) featureDisabled()
                    showErr(ApiErrors.cashMessage(r.code(), e, currency, "Enregistrement impossible"))
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
        val amt = b.etAmount.text.toString().replace(" ", "").replace(",", ".").toDoubleOrNull()
        val e1 = if (amt == null) "Montant invalide" else SecurityManager.validateAmount(amt)
        if (e1 != null) { showErr(e1); return }
        if (wallet == null) {
            showErr(ApiErrors.cashMessage(422, global.cpay.app.common.ApiError(code = ApiErrors.WALLET_MISSING), currency))
            showWalletForm(); return
        }
        val s = summary
        if (s != null && amt!! > s.available) {
            showErr("Solde insuffisant — disponible : ${money(s.available)}"); return
        }
        val remaining = s?.limits?.withdrawDailyRemaining
        if (remaining != null && amt!! > remaining) {
            showErr("Plafond journalier : il vous reste ${money(remaining)} aujourd'hui"); return
        }
        val desc = b.etDescription.text.toString().trim()
        val idem = SecurityManager.generateRef("IDK")
        val ctx = requireContext()
        b.tvError.visibility = View.GONE
        b.progressBar.visibility = View.VISIBLE
        b.btnWithdraw.isEnabled = false
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = StepUp.run(ctx, "Retrait de ${money(amt)}") { confirm ->
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
                    if (r.code() == 410 || e.code == ApiErrors.FEATURE_DISABLED) featureDisabled()
                    if (e.code == ApiErrors.WALLET_MISSING) { wallet = null; renderWallet() }
                    showErr(ApiErrors.cashMessage(r.code(), e, currency, "Retrait refusé"))
                }
            } catch (e: Exception) {
                if (_b != null) showErr(getString(R.string.network_error))
            } finally {
                if (_b != null) {
                    b.progressBar.visibility = View.GONE
                    if (b.tvFeature.visibility != View.VISIBLE) b.btnWithdraw.isEnabled = true
                }
            }
        }
    }

    private fun showResult(r: WithdrawResponse, amt: Double) {
        val d = Dialog(requireContext())
        d.requestWindowFeature(Window.FEATURE_NO_TITLE)
        d.setContentView(R.layout.dialog_transfer_result)
        d.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        d.findViewById<TextView>(R.id.tv_icon).text = "✅"
        d.findViewById<TextView>(R.id.tv_title).apply {
            text = getString(R.string.withdraw_done)
            setTextColor(Color.parseColor("#007a5a"))
        }
        d.findViewById<TextView>(R.id.tv_amount).text = money(r.net ?: r.amount ?: amt)
        d.findViewById<TextView>(R.id.tv_details).text = buildString {
            append("Réf : ${r.reference ?: r.transferId ?: "—"}\n")
            append("Statut : ${CashLabels.transferStatus(r.status)}\n")
            val w = r.wallet ?: wallet
            if (w != null) append("Vers ${w.operatorLabel} ${w.phone ?: ""}\n")
            if ((r.fee ?: 0.0) > 0) append("Frais : ${money(r.fee)}")
        }
        d.findViewById<TextView>(R.id.btn_close).setOnClickListener { d.dismiss() }
        d.show()
    }

    private fun showErr(m: String) {
        if (_b == null) return
        b.tvError.text = m; b.tvError.visibility = View.VISIBLE
    }
    private fun toast(m: String) = Toast.makeText(requireContext(), m, Toast.LENGTH_SHORT).show()

    override fun onDestroyView() {
        handler.removeCallbacks(detectRunnable)
        super.onDestroyView(); _b = null
    }
}
