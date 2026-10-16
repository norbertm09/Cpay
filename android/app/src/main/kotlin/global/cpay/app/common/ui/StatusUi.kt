package global.cpay.app.common.ui

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.widget.ImageView
import android.widget.TextView
import androidx.core.content.ContextCompat
import global.cpay.app.R

/** Rendu des statuts, operateurs et types de mouvement (WAVE-5). */
object StatusUi {

    fun statusLabel(ctx: Context, status: String?): String = when (status) {
        "pending"        -> ctx.getString(R.string.status_pending)
        "processing"     -> ctx.getString(R.string.status_processing)
        "pending_manual", "pending_settlement" -> ctx.getString(R.string.status_pending_manual)
        "awaiting_funds" -> ctx.getString(R.string.status_awaiting_funds)
        "completed"      -> ctx.getString(R.string.status_completed)
        "failed"         -> ctx.getString(R.string.status_failed)
        "cancelled"      -> ctx.getString(R.string.status_cancelled)
        "rejected"       -> ctx.getString(R.string.status_rejected)
        "authorized"     -> ctx.getString(R.string.status_authorized)
        "expired"        -> ctx.getString(R.string.status_expired)
        null, ""         -> "—"
        else             -> status
    }

    /** Couleur principale (texte) et conteneur (fond) d'un statut. */
    fun statusColors(ctx: Context, status: String?): Pair<Int, Int> = when (status) {
        "completed", "authorized" ->
            ContextCompat.getColor(ctx, R.color.success_main) to ContextCompat.getColor(ctx, R.color.success_container)
        "failed", "rejected", "expired" ->
            ContextCompat.getColor(ctx, R.color.error_main) to ContextCompat.getColor(ctx, R.color.error_container)
        "cancelled" ->
            ContextCompat.getColor(ctx, R.color.on_surface_variant) to ContextCompat.getColor(ctx, R.color.neutral_container)
        else ->
            ContextCompat.getColor(ctx, R.color.warn_main) to ContextCompat.getColor(ctx, R.color.warn_container)
    }

    /** Applique une puce de statut (fond arrondi + couleur) a un TextView. */
    fun bindChip(tv: TextView, status: String?) {
        val ctx = tv.context
        val (fg, bg) = statusColors(ctx, status)
        tv.text = statusLabel(ctx, status)
        tv.setTextColor(fg)
        tv.setBackgroundResource(R.drawable.bg_chip)
        tv.backgroundTintList = ColorStateList.valueOf(bg)
    }

    /** Icone + couleur d'un type de mouvement du journal. */
    fun bindTypeIcon(iv: ImageView, type: String?) {
        val ctx = iv.context
        val (icon, fg, bg) = when (type) {
            "collect"      -> Triple(R.drawable.ic_collect,  R.color.success_main,  R.color.success_container)
            "withdraw"     -> Triple(R.drawable.ic_withdraw, R.color.warn_main,     R.color.warn_container)
            "transfer_out" -> Triple(R.drawable.ic_bank,     R.color.brand_primary, R.color.primary_container)
            "transfer_in"  -> Triple(R.drawable.ic_wallet,   R.color.brand_cyan,    R.color.cyan_container)
            else           -> Triple(R.drawable.ic_journal,  R.color.on_surface_variant, R.color.neutral_container)
        }
        iv.setImageResource(icon)
        iv.imageTintList = ColorStateList.valueOf(ContextCompat.getColor(ctx, fg))
        iv.setBackgroundResource(R.drawable.bg_circle)
        iv.backgroundTintList = ColorStateList.valueOf(ContextCompat.getColor(ctx, bg))
    }

    fun typeLabel(ctx: Context, type: String?): String = when (type) {
        "collect"      -> ctx.getString(R.string.history_collect)
        "withdraw"     -> ctx.getString(R.string.history_withdraw)
        "transfer_out" -> ctx.getString(R.string.history_transfer_out)
        "transfer_in"  -> ctx.getString(R.string.history_transfer_in)
        null, ""       -> ctx.getString(R.string.history_other)
        else           -> type
    }

    fun methodLabel(ctx: Context, method: String?): String? = when (method) {
        "mobile_money" -> ctx.getString(R.string.method_mobile_money)
        "card"         -> ctx.getString(R.string.method_card)
        "bank"         -> ctx.getString(R.string.method_bank)
        null, ""       -> null
        else           -> global.cpay.app.common.CashLabels.operator(method)
    }

    /** Couleur de marque d'un operateur Mobile Money (fond du cercle d'initiales). */
    fun operatorColor(operator: String?): Int {
        val k = (operator ?: "").lowercase()
        return when {
            k.startsWith("mtn")    -> Color.parseColor("#ffcc00")
            k.startsWith("orange") -> Color.parseColor("#ff7900")
            k.startsWith("airtel") -> Color.parseColor("#e40000")
            k.startsWith("wave")   -> Color.parseColor("#1dc3ff")
            k.startsWith("moov")   -> Color.parseColor("#0066b3")
            k.startsWith("mpesa") || k.startsWith("m_pesa") -> Color.parseColor("#39b54a")
            k.startsWith("free")   -> Color.parseColor("#cd1126")
            k.startsWith("express") -> Color.parseColor("#f6a800")
            else                   -> Color.parseColor("#1d4f92")
        }
    }

    /** Couleur de texte lisible sur [operatorColor]. */
    fun operatorTextColor(operator: String?): Int {
        val k = (operator ?: "").lowercase()
        return if (k.startsWith("mtn") || k.startsWith("wave") || k.startsWith("express")) Color.parseColor("#15213a") else Color.WHITE
    }

    /** Initiales d'un operateur : « MTN », « ORA », « WAV »… */
    fun operatorInitials(brand: String?): String {
        val b = (brand ?: "").trim()
        if (b.isEmpty()) return "MM"
        val first = b.split(' ', '-', '_').firstOrNull { it.isNotBlank() } ?: b
        return first.take(3).uppercase()
    }

    /** Drapeau Unicode a partir d'un code pays ISO-2 (« CM » → drapeau camerounais). */
    fun flag(countryCode: String?): String {
        val cc = (countryCode ?: "").trim().uppercase()
        if (cc.length != 2 || !cc.all { it in 'A'..'Z' }) return ""
        val sb = StringBuilder()
        cc.forEach { sb.appendCodePoint(0x1F1E6 + (it - 'A')) }
        return sb.toString()
    }
}
