package global.cpay.app.merchant

import global.cpay.app.common.CashSummary

/** Cache memoire du dernier resume de caisse (devise, solde) partage entre les ecrans. */
object CashSession {
    @Volatile var summary: CashSummary? = null
    val currency: String get() = summary?.cur ?: "XAF"
    fun clear() { summary = null }
}
