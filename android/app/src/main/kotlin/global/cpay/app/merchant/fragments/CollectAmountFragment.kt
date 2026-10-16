package global.cpay.app.merchant.fragments

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.google.android.material.chip.Chip
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.SecurityManager
import global.cpay.app.common.ui.Fmt
import global.cpay.app.databinding.FragmentCollectAmountBinding
import global.cpay.app.merchant.CashSession
import global.cpay.app.merchant.MerchantMainActivity
import kotlinx.coroutines.launch

/**
 * Encaisser — etape 1 (WAVE-5) : clavier montant plein ecran, montants rapides,
 * puis choix de la methode : Mobile Money (etape client), carte (lien + QR),
 * sans contact (bientot disponible).
 */
class CollectAmountFragment : Fragment() {

    private var _b: FragmentCollectAmountBinding? = null
    private val b get() = _b!!
    private var amountStr = ""
    private var currency = CashSession.currency

    private val act: MerchantMainActivity? get() = activity as? MerchantMainActivity

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentCollectAmountBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        amountStr = s?.getString(STATE_AMOUNT) ?: amountStr
        val keys = mapOf(
            b.key1 to "1", b.key2 to "2", b.key3 to "3", b.key4 to "4", b.key5 to "5",
            b.key6 to "6", b.key7 to "7", b.key8 to "8", b.key9 to "9", b.key0 to "0", b.key000 to "000",
        )
        keys.forEach { (view, k) -> view.setOnClickListener { press(k) } }
        b.keyDel.setOnClickListener { press("del") }
        b.keyDel.setOnLongClickListener { amountStr = ""; render(); true }

        QUICK_AMOUNTS.forEach { q ->
            val chip = Chip(requireContext()).apply {
                text = Fmt.amount(q.toDouble())
                setChipBackgroundColorResource(R.color.surface)
                isCheckable = false
                setOnClickListener { amountStr = (amountStr.toLongOrNull() ?: 0L).plus(q).toString(); render() }
            }
            b.chipsQuick.addView(chip)
        }

        b.btnMomo.setOnClickListener { withAmount { act?.push(CollectCustomerFragment.newInstance(it, currency), CollectCustomerFragment.TAG) } }
        b.btnCard.setOnClickListener { withAmount { act?.push(CollectCardFragment.newInstance(it, currency), "collect_card") } }
        b.btnNfc.setOnClickListener {
            MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.coming_soon)
                .setMessage(R.string.collect_nfc_soon)
                .setPositiveButton(R.string.ok, null)
                .show()
        }
        render()
        loadCurrency()
    }

    override fun onSaveInstanceState(out: Bundle) { super.onSaveInstanceState(out); out.putString(STATE_AMOUNT, amountStr) }

    private fun loadCurrency() {
        if (CashSession.summary != null) { currency = CashSession.currency; render(); return }
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cashSummary()
                if (_b == null) return@launch
                r.body()?.let { CashSession.summary = it; currency = it.cur; render() }
            } catch (_: Exception) {}
        }
    }

    private fun press(k: String) {
        amountStr = when (k) {
            "del" -> amountStr.dropLast(1)
            else  -> if (amountStr.length + k.length <= 9) (amountStr + k).trimStart('0') else amountStr
        }
        render()
    }

    private fun render() {
        if (_b == null) return
        b.tvAmountDisplay.text = Fmt.amount((amountStr.toLongOrNull() ?: 0L).toDouble())
        b.tvCurrency.text = currency
        b.tvError.visibility = View.GONE
    }

    private fun withAmount(block: (Double) -> Unit) {
        val amt = amountStr.toDoubleOrNull() ?: 0.0
        if (amt <= 0.0) { error(getString(R.string.collect_amount_required)); return }
        SecurityManager.validateAmount(amt)?.let { error(it); return }
        block(amt)
    }

    private fun error(m: String) { b.tvError.text = m; b.tvError.visibility = View.VISIBLE }

    override fun onDestroyView() { super.onDestroyView(); _b = null }

    private companion object {
        const val STATE_AMOUNT = "amount"
        val QUICK_AMOUNTS = listOf(500L, 1_000L, 2_000L, 5_000L, 10_000L, 25_000L)
    }
}
