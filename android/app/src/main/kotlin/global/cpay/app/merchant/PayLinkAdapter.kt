package global.cpay.app.merchant
import android.graphics.Color
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import global.cpay.app.R
import global.cpay.app.common.PayLink
import java.text.NumberFormat
import java.util.Locale

class PayLinkAdapter(
    private var items: List<PayLink>,
    private val onCopy: (PayLink) -> Unit,
    private val onShare: (PayLink) -> Unit,
    private val onCancel: (PayLink) -> Unit,
) : RecyclerView.Adapter<PayLinkAdapter.VH>() {

    private val fmt = NumberFormat.getNumberInstance(Locale.FRANCE)

    inner class VH(v: View) : RecyclerView.ViewHolder(v) {
        val amount  : TextView = v.findViewById(R.id.tv_pl_amount)
        val status  : TextView = v.findViewById(R.id.tv_pl_status)
        val desc    : TextView = v.findViewById(R.id.tv_pl_desc)
        val url     : TextView = v.findViewById(R.id.tv_pl_url)
        val expires : TextView = v.findViewById(R.id.tv_pl_expires)
        val btnCopy : TextView = v.findViewById(R.id.btn_pl_copy)
        val btnShare: TextView = v.findViewById(R.id.btn_pl_share)
        val btnCancel: TextView = v.findViewById(R.id.btn_pl_cancel)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_pay_link, parent, false)
        return VH(v)
    }

    override fun onBindViewHolder(h: VH, position: Int) {
        val pl = items[position]
        h.amount.text = "${fmt.format(pl.amount)} ${pl.currency}"
        h.desc.text = pl.description ?: ""
        h.desc.visibility = if (pl.description.isNullOrEmpty()) View.GONE else View.VISIBLE
        h.url.text = pl.shortUrl.replace("https://", "")
        h.expires.text = pl.expiresAt?.let { "Expire: ${it.take(10)}" } ?: ""

        val (lbl, col) = when (pl.status) {
            "paid"      -> "Payé"     to "#00c896"
            "pending"   -> "En attente" to "#ff9500"
            "expired"   -> "Expiré"   to "#5a6677"
            "cancelled" -> "Annulé"   to "#ff3b30"
            else         -> pl.status  to "#5a6677"
        }
        h.status.text = lbl
        h.status.setTextColor(Color.parseColor(col))
        h.status.setBackgroundColor(Color.parseColor(col + "22"))

        h.btnCopy.setOnClickListener { onCopy(pl) }
        h.btnShare.setOnClickListener { onShare(pl) }
        // Annuler seulement si en attente
        if (pl.status == "pending") {
            h.btnCancel.visibility = View.VISIBLE
            h.btnCancel.setOnClickListener { onCancel(pl) }
        } else {
            h.btnCancel.visibility = View.GONE
        }
    }

    override fun getItemCount() = items.size

    fun update(newItems: List<PayLink>) {
        items = newItems
        notifyDataSetChanged()
    }
}
