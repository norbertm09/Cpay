package global.cpay.app.cardholder

import android.graphics.Color
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import global.cpay.app.R
import global.cpay.app.common.CardDetail
import java.text.NumberFormat
import java.util.Locale

class CreatedCardAdapter(
    private val items: List<CardDetail>,
    private val onDelete: (CardDetail) -> Unit,
    private val onToggle: (CardDetail) -> Unit,
) : RecyclerView.Adapter<CreatedCardAdapter.VH>() {

    private val fmt = NumberFormat.getNumberInstance(Locale.FRANCE)

    inner class VH(v: View) : RecyclerView.ViewHolder(v) {
        val label   : TextView = v.findViewById(R.id.tv_label)
        val network : TextView = v.findViewById(R.id.tv_network)
        val status  : TextView = v.findViewById(R.id.tv_status)
        val balance : TextView = v.findViewById(R.id.tv_balance)
        val number  : TextView = v.findViewById(R.id.tv_number)
        val holder  : TextView = v.findViewById(R.id.tv_holder)
        val expiry  : TextView = v.findViewById(R.id.tv_expiry)
        val btnFreeze : TextView = v.findViewById(R.id.btn_freeze)
        val btnDelete : TextView = v.findViewById(R.id.btn_delete)
    }

    override fun onCreateViewHolder(p: ViewGroup, t: Int) =
        VH(LayoutInflater.from(p.context).inflate(R.layout.item_created_card, p, false))

    override fun onBindViewHolder(h: VH, pos: Int) {
        val c = items[pos]
        val active = c.status == "active"

        h.label.text   = c.label
        h.network.text = c.network.uppercase()
        h.number.text  = c.cardMasked ?: "•••• •••• •••• ••••"
        h.holder.text  = c.cardholderName ?: "—"
        h.expiry.text  = String.format("%02d/%02d", c.expiryMonth, c.expiryYear)
        h.balance.text = "${fmt.format(c.balance)} ${c.currency}"

        h.status.text = if (active) "● Active" else "● Gelée"
        h.status.setTextColor(Color.parseColor(if (active) "#00e5a0" else "#ffb340"))

        h.btnFreeze.text = if (active) "🔒 Geler" else "🔓 Activer"
        h.btnFreeze.setOnClickListener { onToggle(c) }
        h.btnDelete.setOnClickListener { onDelete(c) }
        h.btnDelete.visibility = if (c.balance > 0) View.GONE else View.VISIBLE
    }

    override fun getItemCount() = items.size
}
