package global.cpay.app.merchant.fragments

import android.content.Context
import android.content.Intent
import android.view.LayoutInflater
import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.button.MaterialButton
import global.cpay.app.R
import global.cpay.app.common.HistoryEntry
import global.cpay.app.common.ReceiptActivity
import global.cpay.app.common.ui.Fmt
import global.cpay.app.common.ui.StatusUi

/** Detail d'un mouvement du journal : feuille inferieure avec recu et partage. */
object JournalDetailSheet {

    fun show(ctx: Context, e: HistoryEntry, currency: String) {
        val dlg = BottomSheetDialog(ctx)
        val v = LayoutInflater.from(ctx).inflate(R.layout.sheet_journal_detail, null, false)
        StatusUi.bindTypeIcon(v.findViewById(R.id.iv_type), e.type)
        v.findViewById<TextView>(R.id.tv_title).text = StatusUi.typeLabel(ctx, e.type)
        v.findViewById<TextView>(R.id.tv_date).text = Fmt.dateTime(e.createdAt)
        StatusUi.bindChip(v.findViewById(R.id.tv_status), e.status)
        v.findViewById<TextView>(R.id.tv_amount).apply {
            text = (if (e.isIncoming) "+ " else "- ") + Fmt.money(e.amount, currency)
            setTextColor(ContextCompat.getColor(ctx, if (e.isIncoming) R.color.success_main else R.color.on_surface))
        }
        val rows = v.findViewById<LinearLayout>(R.id.layout_rows)
        val method = StatusUi.methodLabel(ctx, e.method)
        listOf(
            ctx.getString(R.string.reference) to e.reference,
            ctx.getString(R.string.customer) to e.counterparty,
            ctx.getString(R.string.method) to method,
            ctx.getString(R.string.fees) to e.fee?.takeIf { it > 0 }?.let { Fmt.money(it, currency) },
            ctx.getString(R.string.net) to e.net?.let { Fmt.money(it, currency) },
        ).filter { !it.second.isNullOrBlank() }.forEach { (label, value) ->
            val row = LayoutInflater.from(ctx).inflate(R.layout.item_detail_row, rows, false)
            row.findViewById<TextView>(R.id.tv_row_label).text = label
            row.findViewById<TextView>(R.id.tv_row_value).text = value
            rows.addView(row)
        }
        rows.visibility = if (rows.childCount == 0) View.GONE else View.VISIBLE

        val receipt = receiptIntent(ctx, e, currency)
        v.findViewById<MaterialButton>(R.id.btn_receipt).setOnClickListener { dlg.dismiss(); ctx.startActivity(receipt) }
        v.findViewById<MaterialButton>(R.id.btn_share).setOnClickListener {
            val text = buildString {
                append("C-Pay — ${StatusUi.typeLabel(ctx, e.type)}\n")
                append("${ctx.getString(R.string.amount)} : ${Fmt.money(e.amount, currency)}\n")
                e.reference?.let { append("${ctx.getString(R.string.reference)} : $it\n") }
                append("${ctx.getString(R.string.status)} : ${StatusUi.statusLabel(ctx, e.status)}\n")
                append("${ctx.getString(R.string.date)} : ${Fmt.dateTime(e.createdAt)}")
            }
            ctx.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"; putExtra(Intent.EXTRA_TEXT, text)
            }, ctx.getString(R.string.share)))
        }
        dlg.setContentView(v)
        dlg.show()
    }

    fun receiptIntent(ctx: Context, e: HistoryEntry, currency: String): Intent =
        Intent(ctx, ReceiptActivity::class.java).apply {
            putExtra("amount", e.amount)
            putExtra("currency", currency)
            putExtra("reference", e.reference ?: e.id)
            putExtra("type", StatusUi.typeLabel(ctx, e.type))
            putExtra("method", e.method ?: "")
            putExtra("phone", e.counterparty ?: "—")
            putExtra("status", e.status ?: "pending")
            putExtra("fee", e.fee ?: 0.0)
            putExtra("date", Fmt.dateTime(e.createdAt))
        }
}
