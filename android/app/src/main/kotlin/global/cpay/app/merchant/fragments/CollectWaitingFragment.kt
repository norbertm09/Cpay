package global.cpay.app.merchant.fragments

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.activity.OnBackPressedCallback
import androidx.core.os.bundleOf
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.CashCollectStatus
import global.cpay.app.common.ui.Fmt
import global.cpay.app.databinding.FragmentCollectWaitingBinding
import global.cpay.app.merchant.MerchantMainActivity
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Encaisser — etape 3 (WAVE-5) : ecran d'attente plein ecran. Sondage
 * GET /merchant/cash/collect/:txnId toutes les 3 s pendant 90 s max, puis ecran
 * de resultat (succes, refus, en attente). Retour = annuler l'attente.
 */
class CollectWaitingFragment : Fragment() {

    companion object {
        const val TAG = "collect_waiting"
        private const val POLL_INTERVAL_MS = 3_000L
        private const val POLL_MAX_MS = 90_000L
        private const val A_TXN = "txn"; private const val A_AMOUNT = "amount"; private const val A_CUR = "currency"
        private const val A_REF = "ref"; private const val A_PHONE = "phone"; private const val A_OP = "op"; private const val A_FEE = "fee"

        fun newInstance(txnId: String, amount: Double, currency: String, reference: String, phone: String, opLabel: String, fee: Double) =
            CollectWaitingFragment().apply {
                arguments = bundleOf(A_TXN to txnId, A_AMOUNT to amount, A_CUR to currency, A_REF to reference,
                    A_PHONE to phone, A_OP to opLabel, A_FEE to fee)
            }
    }

    private var _b: FragmentCollectWaitingBinding? = null
    private val b get() = _b!!
    private var pollJob: Job? = null
    private val act: MerchantMainActivity? get() = activity as? MerchantMainActivity

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentCollectWaitingBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        val a = requireArguments()
        val txnId = a.getString(A_TXN) ?: ""
        val amount = a.getDouble(A_AMOUNT); val currency = a.getString(A_CUR) ?: "XAF"
        val reference = a.getString(A_REF) ?: ""; val phone = a.getString(A_PHONE) ?: ""
        val opLabel = a.getString(A_OP) ?: ""; val fee = a.getDouble(A_FEE)

        b.tvAmount.text = Fmt.money(amount, currency)
        b.tvPhone.text = "$opLabel · $phone"
        b.progressRing.max = 100
        b.progressRing.progress = 100

        fun finish(kind: String, amt: Double, ref: String, feeV: Double, message: String?) {
            pollJob?.cancel()
            act?.popTo(CollectCustomerFragment.TAG)
            act?.push(CollectResultFragment.newInstance(kind, amt, currency, ref, phone, opLabel, feeV, message), CollectResultFragment.TAG)
        }
        val cancel = { finish(CollectResultFragment.KIND_PENDING, amount, reference, fee, getString(R.string.collect_pending_body)) }
        b.btnCancel.setOnClickListener { cancel() }
        requireActivity().onBackPressedDispatcher.addCallback(viewLifecycleOwner, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { cancel() }
        })

        pollJob = viewLifecycleOwner.lifecycleScope.launch {
            val start = System.currentTimeMillis()
            var last: CashCollectStatus? = null
            while (isActive) {
                delay(1_000L)
                if (_b == null) return@launch
                val elapsed = System.currentTimeMillis() - start
                val left = ((POLL_MAX_MS - elapsed) / 1000).coerceAtLeast(0)
                b.tvCountdown.text = getString(R.string.collect_waiting_countdown_fmt, left.toInt())
                b.progressRing.setProgressCompat(((POLL_MAX_MS - elapsed) * 100 / POLL_MAX_MS).toInt().coerceIn(0, 100), true)
                if (elapsed / 1000 % (POLL_INTERVAL_MS / 1000) == 0L) {
                    try {
                        val r = ApiClient.api.cashCollectStatus(txnId)
                        val st = r.body()
                        if (r.isSuccessful && st != null) {
                            last = st
                            if (st.isDone) {
                                finish(CollectResultFragment.KIND_SUCCESS, st.amount ?: amount, st.reference ?: reference, st.fee ?: fee, null); return@launch
                            }
                            if (st.isFailed) {
                                finish(CollectResultFragment.KIND_FAILED, st.amount ?: amount, st.reference ?: reference, st.fee ?: fee,
                                    st.error ?: getString(if (st.status == "expired") R.string.collect_expired_body else R.string.collect_failed_body))
                                return@launch
                            }
                        }
                    } catch (_: Exception) { /* erreur passagere : on continue */ }
                }
                if (elapsed >= POLL_MAX_MS) {
                    finish(CollectResultFragment.KIND_PENDING, last?.amount ?: amount, last?.reference ?: reference,
                        last?.fee ?: fee, getString(R.string.collect_pending_body))
                    return@launch
                }
            }
        }
    }

    override fun onDestroyView() { pollJob?.cancel(); super.onDestroyView(); _b = null }
}
