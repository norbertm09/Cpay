package global.cpay.app.cardholder

import android.graphics.Color
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import global.cpay.app.R
import global.cpay.app.common.Transaction
import java.text.NumberFormat
import java.util.Locale

class TransactionAdapter(private val items: List<Transaction>) :
    RecyclerView.Adapter<TransactionAdapter.VH>() {

    private val fmt = NumberFormat.getNumberInstance(Locale.FRANCE)

    inner class VH(view: View) : RecyclerView.ViewHolder(view) {
        val tvIcon   : TextView = view.findViewById(R.id.tv_icon)
        val tvType   : TextView = view.findViewById(R.id.tv_txn_type)
        val tvMethod : TextView = view.findViewById(R.id.tv_txn_method)
        val tvDate   : TextView = view.findViewById(R.id.tv_txn_date)
        val tvAmount : TextView = view.findViewById(R.id.tv_txn_amount)
        val tvStatus : TextView = view.findViewById(R.id.tv_txn_status)
        val tvSettlement : TextView = view.findViewById(R.id.tv_settlement)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_transaction, parent, false)
        return VH(v)
    }

    override fun onBindViewHolder(holder: VH, position: Int) {
        val txn = items[position]

        val (icon, typeLabel) = when (txn.type) {
            "collect"    -> "📥" to "Encaissement"
            "payout"     -> "📤" to "Décaissement"
            "disburse"   -> "📤" to "Décaissement"
            "qr_payment" -> "🔲" to "Paiement QR"
            "pay_link"   -> "🔗" to "Lien de paiement"
            "payment"    -> "💳" to "Paiement"
            "topup"      -> "💰" to "Chargement"
            "unload"     -> "💸" to "Déchargement"
            "fee"        -> "🧾" to "Frais"
            else         -> "💳" to txn.type.replaceFirstChar { it.uppercase() }
        }

        val methodLabel = when (txn.method) {
            "mobile_money" -> "📱 Mobile Money"
            "card_nfc"     -> "📡 Sans contact"
            "qr"           -> "🔲 QR Code"
            "pay_link"     -> "🔗 Lien"
            else           -> txn.method ?: "—"
        }

        val amountColor = when (txn.type) {
            "collect", "topup", "qr_payment", "pay_link" -> Color.parseColor("#1d4f92")
            "payout", "disburse", "unload"               -> Color.parseColor("#c47000")
            else                                          -> Color.parseColor("#1e2d3d")
        }

        val (statusColor, statusBg) = when (txn.status) {
            "authorized", "completed" -> Color.parseColor("#007a5a") to "#E8FFF8"
            "failed", "declined"      -> Color.parseColor("#ff3b30") to "#FFF0F0"
            "pending"                 -> Color.parseColor("#c47000") to "#FFF8E8"
            "reversed"                -> Color.parseColor("#5a6677") to "#F0F4F8"
            else                      -> Color.parseColor("#5a6677") to "#F0F4F8"
        }

        val statusLabel = when (txn.status) {
            "authorized" -> "✅ Autorisé"
            "completed"  -> "✅ Complété"
            "failed"     -> "❌ Échoué"
            "declined"   -> "❌ Refusé"
            "pending"    -> "⏳ En attente"
            "reversed"   -> "↩️ Annulé"
            else         -> txn.status
        }

        holder.tvIcon.text    = icon
        holder.tvType.text    = typeLabel
        holder.tvMethod.text  = methodLabel
        holder.tvDate.text    = txn.initiatedAt?.take(16)?.replace("T", " ") ?: "—"
        holder.tvAmount.text  = "${fmt.format(txn.amount)} ${txn.currency}"
        holder.tvAmount.setTextColor(amountColor)
        holder.tvStatus.text  = statusLabel
        holder.tvStatus.setTextColor(statusColor)
        holder.tvStatus.setBackgroundColor(Color.parseColor(statusBg))
        // Badge de reglement (marchand uniquement ; le cardholder n'a pas ce champ)
        val ss = txn.settlementStatus
        if (ss != null) {
            val (lbl, col) = when (ss) {
                "regle"    -> "Réglé"     to "#00c896"
                "en_cours" -> "En cours"  to "#ff9500"
                "echec"    -> "Échec"     to "#ff3b30"
                else        -> "Non réglé" to "#5a6677"
            }
            holder.tvSettlement.text = lbl
            holder.tvSettlement.setTextColor(Color.parseColor(col))
            holder.tvSettlement.setBackgroundColor(Color.parseColor(col + "22"))
            holder.tvSettlement.visibility = View.VISIBLE
        } else {
            holder.tvSettlement.visibility = View.GONE
        }
    }

    override fun getItemCount() = items.size
}
