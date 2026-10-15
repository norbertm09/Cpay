package global.cpay.app.merchant.fragments

import android.graphics.Color
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.ApiErrors
import global.cpay.app.common.CashLabels
import global.cpay.app.common.HistoryEntry
import global.cpay.app.databinding.FragmentCashJournalBinding
import global.cpay.app.merchant.CashSession
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

/**
 * Journal de caisse (WAVE-4, docs/CAISSE-API.md §7) : GET /merchant/cash/history
 * avec filtre `type` (collect | withdraw | transfer_out | transfer_in), totaux
 * entrées / sorties et défilement infini (offset / limit) + bouton « Charger plus ».
 */
class CashJournalFragment : Fragment() {

    private companion object { const val PAGE = 30 }

    private var _b: FragmentCashJournalBinding? = null
    private val b get() = _b!!
    private val fmt = NumberFormat.getNumberInstance(Locale.FRANCE)
    private var currency = CashSession.currency

    private var type: String? = null
    private val items = mutableListOf<HistoryEntry>()
    private var total = 0
    private var loading = false
    private val adapter = HistoryAdapter()

    private val hasMore: Boolean get() = items.size < total

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentCashJournalBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        val lm = LinearLayoutManager(context)
        b.rvHistory.layoutManager = lm
        b.rvHistory.adapter = adapter
        b.rvHistory.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
                if (dy <= 0 || loading || !hasMore) return
                if (lm.findLastVisibleItemPosition() >= items.size - 3) load(reset = false)
            }
        })
        chips().forEach { (view, t) -> view.setOnClickListener { setType(t) } }
        b.btnRefresh.setOnClickListener  { load(reset = true) }
        b.btnLoadMore.setOnClickListener { load(reset = false) }
        setType(null)
    }

    private fun chips(): List<Pair<TextView, String?>> = listOf(
        b.chipAll to null, b.chipCollect to "collect", b.chipWithdraw to "withdraw",
        b.chipOut to "transfer_out", b.chipIn to "transfer_in",
    )

    private fun setType(t: String?) {
        type = t
        chips().forEach { (view, id) ->
            val sel = id == t
            view.setBackgroundResource(if (sel) R.drawable.bg_btn_primary else R.drawable.bg_btn_outline)
            view.setTextColor(Color.parseColor(if (sel) "#FFFFFF" else "#12b6c7"))
        }
        load(reset = true)
    }

    private fun money(v: Double?) = "${fmt.format(v ?: 0.0)} $currency"

    private fun load(reset: Boolean) {
        if (loading || _b == null) return
        loading = true
        val offset = if (reset) 0 else items.size
        b.progressBar.visibility = View.VISIBLE
        b.tvError.visibility = View.GONE
        b.btnLoadMore.visibility = View.GONE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cashHistory(type = type, limit = PAGE, offset = offset)
                if (_b == null) return@launch
                val body = r.body()
                if (r.isSuccessful && body != null) {
                    if (reset) items.clear()
                    items.addAll(body.data)
                    total = if (body.total > 0) body.total else items.size
                    adapter.notifyDataSetChanged()
                    body.totals?.let {
                        b.tvTotalIn.text  = "+ ${money(it.inTotal)}"
                        b.tvTotalOut.text = "- ${money(it.outTotal)}"
                    }
                    b.tvCount.text = "${items.size} / $total mouvement${if (total > 1) "s" else ""}"
                    b.tvEmpty.visibility = if (items.isEmpty()) View.VISIBLE else View.GONE
                } else if (ApiErrors.isFeatureDisabled(r)) {
                    showErr(getString(R.string.caisse_feature_pending))
                } else {
                    showErr(ApiErrors.cashMessage(r, currency, "Chargement impossible"))
                }
            } catch (e: Exception) {
                if (_b != null) showErr(getString(R.string.network_error))
            } finally {
                loading = false
                if (_b != null) {
                    b.progressBar.visibility = View.GONE
                    b.btnLoadMore.visibility = if (hasMore) View.VISIBLE else View.GONE
                }
            }
        }
    }

    private fun showErr(m: String) {
        b.tvError.text = m; b.tvError.visibility = View.VISIBLE
    }

    inner class HistoryAdapter : RecyclerView.Adapter<HistoryAdapter.VH>() {
        inner class VH(v: View) : RecyclerView.ViewHolder(v) {
            val icon: TextView = v.findViewById(R.id.tv_icon)
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
            h.icon.text = e.icon
            h.title.text = e.typeLabel
            val method = when (e.method) {
                "mobile_money" -> "📱 Mobile Money"
                "card"         -> "💳 Carte"
                "bank"         -> "🏦 Banque"
                null, ""       -> null
                else           -> CashLabels.operator(e.method)
            }
            h.sub.text = listOfNotNull(e.reference, e.counterparty, method).joinToString(" · ")
            h.date.text = (e.createdAt ?: "").take(16).replace("T", " ")
            h.amount.text = (if (e.isIncoming) "+ " else "- ") + money(e.amount)
            h.amount.setTextColor(Color.parseColor(if (e.isIncoming) "#007a5a" else "#c47000"))
            val fee = e.fee ?: 0.0
            h.fee.visibility = if (fee > 0) View.VISIBLE else View.GONE
            h.fee.text = "frais ${money(fee)}"
            h.status.text = CashLabels.transferStatus(e.status)
            val col = CashLabels.statusColor(e.status)
            h.status.setTextColor(Color.parseColor(col))
            h.status.setBackgroundColor(Color.parseColor(col + "1A"))
        }
        override fun getItemCount() = items.size
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
