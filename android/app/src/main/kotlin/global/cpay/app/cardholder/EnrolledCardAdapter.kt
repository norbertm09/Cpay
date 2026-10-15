package global.cpay.app.cardholder

import android.graphics.Color
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import global.cpay.app.R
import global.cpay.app.common.EnrolledCard

class EnrolledCardAdapter(
    private val items: List<EnrolledCard>,
    private val onRemove: (EnrolledCard) -> Unit,
    private val onSetDefault: (EnrolledCard) -> Unit,
) : RecyclerView.Adapter<EnrolledCardAdapter.VH>() {

    inner class VH(v: View) : RecyclerView.ViewHolder(v) {
        val icon    : TextView = v.findViewById(R.id.tv_icon)
        val number  : TextView = v.findViewById(R.id.tv_number)
        val info    : TextView = v.findViewById(R.id.tv_info)
        val badge   : TextView = v.findViewById(R.id.tv_default_badge)
        val btnSet  : TextView = v.findViewById(R.id.btn_set_default)
        val btnDel  : TextView = v.findViewById(R.id.btn_remove)
    }

    override fun onCreateViewHolder(p: ViewGroup, t: Int) =
        VH(LayoutInflater.from(p.context).inflate(R.layout.item_enrolled_card, p, false))

    override fun onBindViewHolder(h: VH, pos: Int) {
        val c = items[pos]
        h.icon.text   = when (c.network) {
            "visa"       -> "💳"
            "mastercard" -> "💳"
            "amex"       -> "💳"
            else         -> "💳"
        }
        h.number.text = c.cardMasked
        h.info.text   = "${c.network.uppercase()} · ${String.format("%02d/%02d", c.expiryMonth, c.expiryYear)} · ${c.cardholderName ?: ""}"

        h.badge.visibility  = if (c.isDefault) View.VISIBLE else View.GONE
        h.btnSet.visibility = if (c.isDefault) View.GONE else View.VISIBLE
        h.btnSet.setOnClickListener { onSetDefault(c) }
        h.btnDel.setOnClickListener { onRemove(c) }
    }

    override fun getItemCount() = items.size
}
