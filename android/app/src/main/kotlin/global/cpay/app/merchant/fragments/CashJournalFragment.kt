package global.cpay.app.merchant.fragments

import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
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
import global.cpay.app.common.HistoryEntry
import global.cpay.app.common.HistoryResponse
import global.cpay.app.common.ui.Fmt
import global.cpay.app.common.ui.Net
import global.cpay.app.common.ui.StickyHeaderDecoration
import global.cpay.app.databinding.FragmentCashJournalBinding
import global.cpay.app.db.CacheManager
import global.cpay.app.merchant.CashSession
import kotlinx.coroutines.launch
import java.util.Date

/**
 * Journal de caisse (WAVE-5, docs/CAISSE-API.md §7) : GET /merchant/cash/history avec
 * filtre `type`, en-tetes de jour collants, recherche (reference / telephone, sur les
 * lignes chargees), totaux entrees / sorties, defilement infini, tirer-pour-actualiser,
 * detail en feuille inferieure avec recu, cache Room de la premiere page (hors ligne).
 */
class CashJournalFragment : Fragment() {

    private companion object { const val PAGE = 30 }

    private var _b: FragmentCashJournalBinding? = null
    private val b get() = _b!!
    private var currency = CashSession.currency

    private var type: String? = null
    private var query = ""
    private val items = mutableListOf<HistoryEntry>()
    private var total = 0
    private var loading = false
    private var cachedAt: Long? = null
    private val adapter = JournalAdapter()

    private val hasMore: Boolean get() = items.size < total

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentCashJournalBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        val lm = LinearLayoutManager(context)
        b.rvHistory.layoutManager = lm
        b.rvHistory.adapter = adapter
        b.rvHistory.addItemDecoration(StickyHeaderDecoration(
            isHeader = { pos -> adapter.rows.getOrNull(pos) is Row.Header },
            createHeaderView = { parent -> LayoutInflater.from(parent.context).inflate(R.layout.item_journal_header, parent, false) },
            bindHeaderView = { view, pos -> (adapter.rows.getOrNull(pos) as? Row.Header)?.let { view.findViewById<TextView>(R.id.tv_header).text = it.label } },
        ))
        b.rvHistory.addOnScrollListener(object : RecyclerView.OnScrollListener() {
            override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
                if (dy <= 0 || loading || !hasMore || query.isNotBlank()) return
                if (lm.findLastVisibleItemPosition() >= adapter.rows.size - 4) load(reset = false)
            }
        })
        b.swipe.setColorSchemeResources(R.color.brand_primary, R.color.brand_accent)
        b.swipe.setOnRefreshListener { load(reset = true) }
        b.chipsType.setOnCheckedStateChangeListener { _, checked ->
            val t = when (checked.firstOrNull()) {
                R.id.chip_collect  -> "collect"
                R.id.chip_withdraw -> "withdraw"
                R.id.chip_out      -> "transfer_out"
                R.id.chip_in       -> "transfer_in"
                else               -> null
            }
            if (t != type) { type = t; load(reset = true) }
        }
        b.etSearch.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, c: Int, d: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, c: Int, d: Int) {}
            override fun afterTextChanged(s: Editable?) { query = s?.toString()?.trim() ?: ""; rebuildRows() }
        })
        load(reset = true)
    }

    private fun money(v: Double?) = Fmt.money(v, currency)

    private fun load(reset: Boolean) {
        if (loading || _b == null) return
        loading = true
        val ctx = requireContext().applicationContext
        val offset = if (reset) 0 else items.size
        if (!reset) b.progressBar.visibility = View.VISIBLE
        else if (!b.swipe.isRefreshing && items.isEmpty()) b.swipe.isRefreshing = true
        b.tvError.visibility = View.GONE
        viewLifecycleOwner.lifecycleScope.launch {
            var online = true
            try {
                val r = ApiClient.api.cashHistory(type = type, limit = PAGE, offset = offset)
                if (_b == null) return@launch
                val body = r.body()
                if (r.isSuccessful && body != null) {
                    if (reset) { items.clear(); cachedAt = null }
                    items.addAll(body.data)
                    total = if (body.total > 0) body.total else items.size
                    body.totals?.let {
                        b.tvTotalIn.text  = "+ ${money(it.inTotal)}"
                        b.tvTotalOut.text = "- ${money(it.outTotal)}"
                    }
                    if (offset == 0) CacheManager.putJson(ctx, CacheManager.keyHistory(type), body)
                } else if (ApiErrors.isFeatureDisabled(r)) {
                    showErr(getString(R.string.caisse_feature_pending))
                } else {
                    showErr(ApiErrors.cashMessage(r, currency, getString(R.string.journal_load_error)))
                }
            } catch (e: Exception) {
                online = false
                if (_b == null) return@launch
                if (reset) {
                    val cached = CacheManager.getJson(ctx, CacheManager.keyHistory(type), HistoryResponse::class.java)
                    if (_b == null) return@launch
                    if (cached != null) {
                        items.clear(); items.addAll(cached.value.data)
                        total = items.size
                        cachedAt = cached.savedAt
                        cached.value.totals?.let {
                            b.tvTotalIn.text  = "+ ${money(it.inTotal)}"
                            b.tvTotalOut.text = "- ${money(it.outTotal)}"
                        }
                    } else showErr(getString(R.string.network_error))
                } else showErr(getString(R.string.network_error))
            } finally {
                loading = false
                if (_b != null) {
                    b.progressBar.visibility = View.GONE
                    b.swipe.isRefreshing = false
                    renderOffline(online)
                    rebuildRows()
                }
            }
        }
    }

    private fun renderOffline(online: Boolean) {
        val offline = !online || !Net.isOnline(requireContext())
        val banner = b.offlineBanner
        banner.root.visibility = if (offline) View.VISIBLE else View.GONE
        if (offline) {
            val at = cachedAt
            banner.tvOfflineText.text = if (at != null) getString(R.string.offline_data_from, Fmt.dateTime(Date(at)))
                                        else getString(R.string.offline_no_data)
        }
    }

    private fun rebuildRows() {
        if (_b == null) return
        val q = query.lowercase()
        val filtered = if (q.isBlank()) items else items.filter {
            (it.reference ?: "").lowercase().contains(q) || (it.counterparty ?: "").lowercase().contains(q) ||
            (it.id).lowercase().contains(q)
        }
        val rows = mutableListOf<Row>()
        var lastDay: String? = null
        filtered.forEach { e ->
            val day = Fmt.dayKey(e.createdAt)
            if (day != lastDay) {
                rows.add(Row.Header(Fmt.dayLabel(e.createdAt, getString(R.string.journal_today), getString(R.string.journal_yesterday))))
                lastDay = day
            }
            rows.add(Row.Entry(e))
        }
        adapter.rows = rows
        adapter.notifyDataSetChanged()
        b.tvCount.text = getString(R.string.journal_count_fmt, filtered.size, if (q.isBlank()) total else filtered.size)
        b.tvEmpty.visibility = if (filtered.isEmpty()) View.VISIBLE else View.GONE
        b.tvEmpty.setText(if (q.isBlank()) R.string.journal_empty else R.string.journal_empty_search)
    }

    private fun showErr(m: String) {
        if (_b == null) return
        b.tvError.text = m; b.tvError.visibility = View.VISIBLE
    }

    sealed class Row {
        data class Header(val label: String) : Row()
        data class Entry(val e: HistoryEntry) : Row()
    }

    inner class JournalAdapter : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
        var rows: List<Row> = emptyList()
        inner class HeaderVH(v: View) : RecyclerView.ViewHolder(v) { val tv: TextView = v.findViewById(R.id.tv_header) }

        override fun getItemViewType(position: Int) = if (rows[position] is Row.Header) 0 else 1
        override fun onCreateViewHolder(p: ViewGroup, viewType: Int): RecyclerView.ViewHolder =
            if (viewType == 0) HeaderVH(LayoutInflater.from(p.context).inflate(R.layout.item_journal_header, p, false))
            else HistoryEntryAdapter.VH(LayoutInflater.from(p.context).inflate(R.layout.item_history_entry, p, false))
        override fun onBindViewHolder(h: RecyclerView.ViewHolder, pos: Int) {
            when (val row = rows[pos]) {
                is Row.Header -> (h as HeaderVH).tv.text = row.label
                is Row.Entry  -> {
                    HistoryEntryAdapter.bind(h as HistoryEntryAdapter.VH, row.e, currency)
                    h.itemView.setOnClickListener { JournalDetailSheet.show(requireContext(), row.e, currency) }
                }
            }
        }
        override fun getItemCount() = rows.size
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
