package global.cpay.app.merchant.fragments

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.RecyclerView
import global.cpay.app.R
import global.cpay.app.common.HistoryEntry
import global.cpay.app.common.ui.Fmt
import global.cpay.app.common.ui.StatusUi

/** Ligne du journal / dernieres operations (item_history_entry). */
class HistoryEntryAdapter(
    private val items: List<HistoryEntry>,
    private val currency: () -> String,
    private val onClick: (HistoryEntry) -> Unit,
) : RecyclerView.Adapter<HistoryEntryAdapter.VH>() {

    class VH(v: View) : RecyclerView.ViewHolder(v) {
        val icon: ImageView = v.findViewById(R.id.iv_type)
        val title: TextView = v.findViewById(R.id.tv_title)
        val sub: TextView = v.findViewById(R.id.tv_subtitle)
        val date: TextView = v.findViewById(R.id.tv_date)
        val amount: TextView = v.findViewById(R.id.tv_amount)
        val fee: TextView = v.findViewById(R.id.tv_fee)
        val status: TextView = v.findViewById(R.id.tv_status)
    }

    override fun onCreateViewHolder(p: ViewGroup, t: Int) =
        VH(LayoutInflater.from(p.context).inflate(R.layout.item_history_entry, p, false))

    override fun onBindViewHolder(h: VH, pos: Int) {
        val e = items[pos]
        bind(h, e, currency())
        h.itemView.setOnClickListener { onClick(e) }
    }

    override fun getItemCount() = items.size

    companion object {
        fun bind(h: VH, e: HistoryEntry, currency: String) {
            val ctx = h.itemView.context
            StatusUi.bindTypeIcon(h.icon, e.type)
            h.title.text = StatusUi.typeLabel(ctx, e.type)
            val method = StatusUi.methodLabel(ctx, e.method)
            h.sub.text = listOfNotNull(e.reference, e.counterparty, method).joinToString(" · ")
            h.sub.visibility = if (h.sub.text.isBlank()) View.GONE else View.VISIBLE
            h.date.text = Fmt.dateTime(e.createdAt)
            h.amount.text = (if (e.isIncoming) "+ " else "- ") + Fmt.money(e.amount, currency)
            h.amount.setTextColor(ContextCompat.getColor(ctx, if (e.isIncoming) R.color.success_main else R.color.on_surface))
            val fee = e.fee ?: 0.0
            h.fee.visibility = if (fee > 0) View.VISIBLE else View.GONE
            h.fee.text = ctx.getString(R.string.journal_fee_fmt, Fmt.money(fee, currency))
            StatusUi.bindChip(h.status, e.status)
        }
    }
}
