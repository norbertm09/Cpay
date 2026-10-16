package global.cpay.app.merchant.fragments

import android.content.Intent
import android.content.res.ColorStateList
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.os.bundleOf
import androidx.fragment.app.Fragment
import global.cpay.app.R
import global.cpay.app.common.ReceiptActivity
import global.cpay.app.common.ui.Fmt
import global.cpay.app.databinding.FragmentCollectResultBinding
import global.cpay.app.merchant.MerchantMainActivity
import java.util.Date

/**
 * Encaisser — resultat (WAVE-5) : succes (recu, partage), refus (reessayer), en attente
 * (explication, suivi dans le Journal).
 */
class CollectResultFragment : Fragment() {

    companion object {
        const val TAG = "collect_result"
        const val KIND_SUCCESS = "success"; const val KIND_FAILED = "failed"; const val KIND_PENDING = "pending"
        private const val A_KIND = "kind"; private const val A_AMOUNT = "amount"; private const val A_CUR = "currency"
        private const val A_REF = "ref"; private const val A_PHONE = "phone"; private const val A_OP = "op"
        private const val A_FEE = "fee"; private const val A_MSG = "msg"

        fun newInstance(kind: String, amount: Double, currency: String, reference: String, phone: String,
                        opLabel: String, fee: Double, message: String?) = CollectResultFragment().apply {
            arguments = bundleOf(A_KIND to kind, A_AMOUNT to amount, A_CUR to currency, A_REF to reference,
                A_PHONE to phone, A_OP to opLabel, A_FEE to fee, A_MSG to message)
        }
    }

    private var _b: FragmentCollectResultBinding? = null
    private val b get() = _b!!
    private val act: MerchantMainActivity? get() = activity as? MerchantMainActivity

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentCollectResultBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        val a = requireArguments()
        val kind = a.getString(A_KIND) ?: KIND_PENDING
        val amount = a.getDouble(A_AMOUNT); val currency = a.getString(A_CUR) ?: "XAF"
        val reference = a.getString(A_REF) ?: ""; val phone = a.getString(A_PHONE) ?: ""
        val opLabel = a.getString(A_OP) ?: ""; val fee = a.getDouble(A_FEE); val message = a.getString(A_MSG)
        val ctx = requireContext()

        val (icon, fg, bg, title, body) = when (kind) {
            KIND_SUCCESS -> Res(R.drawable.ic_check_circle, R.color.success_main, R.color.success_container, R.string.collect_success, R.string.collect_success_body)
            KIND_FAILED  -> Res(R.drawable.ic_error, R.color.error_main, R.color.error_container, R.string.collect_failed, R.string.collect_failed_body)
            else         -> Res(R.drawable.ic_pending, R.color.warn_main, R.color.warn_container, R.string.collect_pending, R.string.collect_pending_body)
        }
        b.ivIcon.setImageResource(icon)
        b.ivIcon.imageTintList = ColorStateList.valueOf(ContextCompat.getColor(ctx, fg))
        b.ivIcon.backgroundTintList = ColorStateList.valueOf(ContextCompat.getColor(ctx, bg))
        b.tvTitle.text = getString(title)
        b.tvTitle.setTextColor(ContextCompat.getColor(ctx, fg))
        b.tvAmount.text = Fmt.money(amount, currency)
        b.tvMessage.text = message ?: getString(body)

        listOf(
            getString(R.string.reference) to reference,
            getString(R.string.customer) to phone,
            getString(R.string.method) to opLabel,
            getString(R.string.fees) to fee.takeIf { it > 0 }?.let { Fmt.money(it, currency) },
        ).filter { !it.second.isNullOrBlank() }.forEach { (label, value) ->
            val row = LayoutInflater.from(ctx).inflate(R.layout.item_detail_row, b.layoutRows, false)
            row.findViewById<TextView>(R.id.tv_row_label).text = label
            row.findViewById<TextView>(R.id.tv_row_value).text = value
            b.layoutRows.addView(row)
        }

        val status = when (kind) { KIND_SUCCESS -> "authorized"; KIND_FAILED -> "failed"; else -> "pending" }
        val receipt = Intent(ctx, ReceiptActivity::class.java).apply {
            putExtra("amount", amount); putExtra("currency", currency); putExtra("reference", reference)
            putExtra("type", getString(R.string.history_collect)); putExtra("method", opLabel)
            putExtra("phone", phone); putExtra("status", status); putExtra("fee", fee)
        }
        b.btnReceipt.visibility = if (kind == KIND_FAILED) View.GONE else View.VISIBLE
        b.btnShare.visibility   = if (kind == KIND_FAILED) View.GONE else View.VISIBLE
        b.btnRetry.visibility   = if (kind == KIND_FAILED) View.VISIBLE else View.GONE
        b.btnReceipt.setOnClickListener { startActivity(receipt) }
        b.btnShare.setOnClickListener {
            val text = buildString {
                append("C-Pay — ${getString(R.string.history_collect)}\n")
                append("${getString(R.string.amount)} : ${Fmt.money(amount, currency)}\n")
                append("${getString(R.string.reference)} : $reference\n")
                append("${getString(R.string.status)} : ${getString(title)}\n")
                append("${getString(R.string.date)} : ${Fmt.dateTime(Date())}")
            }
            startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"; putExtra(Intent.EXTRA_TEXT, text)
            }, getString(R.string.share)))
        }
        b.btnRetry.setOnClickListener {
            act?.popTo(TAG)
            act?.push(CollectCustomerFragment.newInstance(amount, currency, phone), CollectCustomerFragment.TAG)
        }
        b.btnNew.setOnClickListener { act?.popTo(TAG) }
    }

    private data class Res(val icon: Int, val fg: Int, val bg: Int, val title: Int, val body: Int)

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
