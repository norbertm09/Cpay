package global.cpay.app.merchant.fragments

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.core.os.bundleOf
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.google.android.material.chip.Chip
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.SessionManager
import global.cpay.app.common.ApiErrors
import global.cpay.app.common.CashCollectRequest
import global.cpay.app.common.CashLabels
import global.cpay.app.common.PhoneDetection
import global.cpay.app.common.SecurityManager
import global.cpay.app.common.ui.Fmt
import global.cpay.app.common.ui.StatusUi
import global.cpay.app.databinding.FragmentCollectCustomerBinding
import global.cpay.app.merchant.MerchantMainActivity
import kotlinx.coroutines.launch

/**
 * Encaisser — etape 2 (WAVE-5) : numero du client avec detection live
 * (POST /detect/phone, debounce 450 ms : drapeau, initiales operateur, devise, alternatives
 * en puces), libelle optionnel, un grand bouton « Encaisser <montant> ».
 * POST /merchant/cash/collect (Idempotency-Key) puis ecran d'attente.
 */
class CollectCustomerFragment : Fragment() {

    companion object {
        const val TAG = "collect_customer"
        private const val ARG_AMOUNT = "amount"
        private const val ARG_CURRENCY = "currency"
        private const val ARG_PHONE = "phone"
        private const val DETECT_DEBOUNCE_MS = 450L

        fun newInstance(amount: Double, currency: String, phone: String? = null) = CollectCustomerFragment().apply {
            arguments = bundleOf(ARG_AMOUNT to amount, ARG_CURRENCY to currency, ARG_PHONE to phone)
        }
    }

    private var _b: FragmentCollectCustomerBinding? = null
    private val b get() = _b!!
    private val handler = Handler(Looper.getMainLooper())
    private val detectRunnable = Runnable { detectPhone() }

    private var amount = 0.0
    private var currency = "XAF"
    private var detection: PhoneDetection? = null
    private var chosenOperator: String? = null
    private var lastDetectedPhone = ""

    private val act: MerchantMainActivity? get() = activity as? MerchantMainActivity

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentCollectCustomerBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        amount   = requireArguments().getDouble(ARG_AMOUNT)
        currency = requireArguments().getString(ARG_CURRENCY) ?: currency

        b.header.tvScreenTitle.text = getString(R.string.collect_customer_title)
        b.header.btnBack.setOnClickListener { act?.pop() }
        b.tvAmountSub.text = getString(R.string.collect_customer_subtitle_fmt, Fmt.money(amount, currency))
        b.btnCollect.text = getString(R.string.collect_button_fmt, Fmt.money(amount, currency))

        b.etPhone.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, c: Int, d: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, c: Int, d: Int) {}
            override fun afterTextChanged(s: Editable?) {
                handler.removeCallbacks(detectRunnable)
                b.tvError.visibility = View.GONE
                val digits = (s?.toString() ?: "").filter { it.isDigit() }
                if (digits.length >= 8) {
                    showDetecting()
                    handler.postDelayed(detectRunnable, DETECT_DEBOUNCE_MS)
                } else {
                    detection = null; chosenOperator = null
                    b.cardDetection.visibility = View.GONE
                }
            }
        })
        requireArguments().getString(ARG_PHONE)?.let { if (b.etPhone.text.isNullOrEmpty()) b.etPhone.setText(it) }
        b.btnCollect.setOnClickListener { submit() }
        if (b.etPhone.text.isNullOrEmpty()) b.etPhone.requestFocus()
    }

    // ─── Detection live ─────────────────────────────────────────────
    private fun showDetecting() {
        b.cardDetection.visibility = View.VISIBLE
        b.progressDetect.visibility = View.VISIBLE
        b.tvCurrencyChip.visibility = View.GONE
        b.tvDetectMain.text = getString(R.string.collect_detecting)
        b.tvDetectSub.text = ""
        b.tvFlag.text = ""
        b.tvOperatorInitials.text = "…"
        b.tvOperatorInitials.setBackgroundResource(R.drawable.bg_circle)
        b.tvOperatorInitials.backgroundTintList = null
        b.tvOperatorInitials.setTextColor(StatusUi.operatorTextColor(null))
        b.tvDetectWarn.visibility = View.GONE
        b.tvAlternativesLabel.visibility = View.GONE
        b.chipsAlternatives.visibility = View.GONE
    }

    private fun detectPhone() {
        if (_b == null) return
        val phone = b.etPhone.text.toString().trim()
        if (phone == lastDetectedPhone && detection != null) { detection?.let { renderDetection(it) }; return }
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                // Pays du marchand : un numero LOCAL (06 XXX XX XX) est accepte sans indicatif, l'operateur est deduit du prefixe
                val body = mutableMapOf("phone" to phone)
                SessionManager.userCountry?.let { body["country"] = it }
                val r = ApiClient.api.detectPhone(body)
                if (_b == null) return@launch
                val d = r.body() ?: PhoneDetection(success = false, error = ApiErrors.message(r, getString(R.string.collect_detect_unknown)))
                lastDetectedPhone = phone
                detection = d
                chosenOperator = null
                renderDetection(d)
            } catch (e: Exception) {
                if (_b == null) return@launch
                detection = null
                b.progressDetect.visibility = View.GONE
                b.tvDetectMain.text = getString(R.string.method_mobile_money)
                b.tvDetectSub.text = getString(R.string.collect_detect_unavailable)
                b.tvOperatorInitials.text = "MM"
            }
        }
    }

    private fun renderDetection(d: PhoneDetection) {
        b.cardDetection.visibility = View.VISIBLE
        b.progressDetect.visibility = View.GONE
        val op = chosenOperator ?: d.operator
        val brand = if (chosenOperator != null) CashLabels.operator(chosenOperator) else d.operatorLabel
        b.tvOperatorInitials.text = StatusUi.operatorInitials(brand)
        b.tvOperatorInitials.backgroundTintList = android.content.res.ColorStateList.valueOf(StatusUi.operatorColor(op))
        b.tvOperatorInitials.setTextColor(StatusUi.operatorTextColor(op))
        b.tvFlag.text = StatusUi.flag(d.country)
        b.tvDetectSub.text = d.countryName ?: d.country ?: ""
        if (d.success) {
            b.tvDetectMain.text = brand + if (d.verified == false) " (${getString(R.string.collect_detect_to_confirm)})" else ""
        } else {
            b.tvDetectMain.text = d.error ?: getString(R.string.collect_detect_unknown)
        }
        if (!d.currency.isNullOrBlank()) {
            b.tvCurrencyChip.visibility = View.VISIBLE
            b.tvCurrencyChip.text = d.currency
        } else b.tvCurrencyChip.visibility = View.GONE
        if (!d.currency.isNullOrBlank() && d.currency != currency) {
            b.tvDetectWarn.visibility = View.VISIBLE
            b.tvDetectWarn.text = getString(R.string.collect_currency_mismatch_fmt, d.currency, currency)
        } else b.tvDetectWarn.visibility = View.GONE
        renderAlternatives(d)
    }

    private fun renderAlternatives(d: PhoneDetection) {
        b.chipsAlternatives.removeAllViews()
        val alts = d.alternatives.filter { it.operator.isNotBlank() && !it.operator.equals(d.operator, true) }
        if (alts.isEmpty()) {
            b.tvAlternativesLabel.visibility = View.GONE; b.chipsAlternatives.visibility = View.GONE; return
        }
        b.tvAlternativesLabel.visibility = View.VISIBLE
        b.chipsAlternatives.visibility = View.VISIBLE
        fun chip(label: String, value: String?) {
            b.chipsAlternatives.addView(Chip(requireContext()).apply {
                text = label
                isCheckable = true
                isChecked = value == chosenOperator
                setOnClickListener { chosenOperator = value; renderDetection(d) }
            })
        }
        if (d.success) chip(d.operatorLabel, null)
        alts.forEach { chip(it.brand ?: CashLabels.operator(it.operator), it.operator) }
    }

    // ─── Encaissement ───────────────────────────────────────────────
    private fun submit() {
        val rawPhone = b.etPhone.text.toString().trim()
        if (rawPhone.isEmpty()) { error(getString(R.string.collect_phone_required)); return }
        val d = detection
        if (d != null && !d.success && chosenOperator == null && d.alternatives.isEmpty() && d.code != "OPERATOR_UNKNOWN") {
            error(d.error ?: getString(R.string.collect_unsupported)); return
        }
        if (d != null && !d.success && chosenOperator == null && d.alternatives.isNotEmpty()) {
            error(getString(R.string.collect_choose_alternative)); return
        }
        val phone = d?.phone?.takeIf { it.isNotBlank() } ?: SecurityManager.normalizePhone(rawPhone)
        val desc = b.etDescription.text.toString().trim()
        val ref  = SecurityManager.generateRef("ENC")
        val idem = SecurityManager.generateRef("IDK")
        val opLabelGuess = if (chosenOperator != null) CashLabels.operator(chosenOperator) else d?.operatorLabel ?: getString(R.string.method_mobile_money)

        b.tvError.visibility = View.GONE
        loading(true)
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cashCollect(idem, CashCollectRequest(
                    amount = amount, method = "mobile_money", customerPhone = phone,
                    operator = chosenOperator, description = desc.ifEmpty { null }, reference = ref))
                if (_b == null) return@launch
                val body = r.body()
                if (r.isSuccessful && body != null) {
                    val cur = body.currency?.takeIf { it.isNotBlank() } ?: currency
                    val opLabel = body.operatorLabel
                        ?: (body.operator ?: chosenOperator ?: d?.operator)?.let { CashLabels.operator(it) }
                        ?: opLabelGuess
                    val amt = body.amount ?: amount
                    val reference = body.reference ?: ref
                    val txnId = body.txnId
                    if (txnId.isNullOrBlank()) {
                        act?.popTo(TAG)
                        act?.push(CollectResultFragment.newInstance(CollectResultFragment.KIND_PENDING, amt, cur, reference,
                            phone, opLabel, body.fee ?: 0.0, getString(R.string.collect_sent_follow)), CollectResultFragment.TAG)
                    } else {
                        act?.push(CollectWaitingFragment.newInstance(txnId, amt, cur, reference, phone, opLabel, body.fee ?: 0.0), CollectWaitingFragment.TAG)
                    }
                } else {
                    error(ApiErrors.cashMessage(r, currency, getString(R.string.collect_refused)))
                }
            } catch (e: Exception) {
                if (_b != null) error(getString(R.string.network_error))
            } finally {
                if (_b != null) loading(false)
            }
        }
    }

    private fun error(m: String) { b.tvError.text = m; b.tvError.visibility = View.VISIBLE }
    private fun loading(l: Boolean) {
        b.progressBar.visibility = if (l) View.VISIBLE else View.GONE
        b.btnCollect.isEnabled = !l
    }

    override fun onDestroyView() {
        handler.removeCallbacks(detectRunnable)
        super.onDestroyView(); _b = null
    }
}
