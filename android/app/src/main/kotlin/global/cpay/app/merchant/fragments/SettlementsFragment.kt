package global.cpay.app.merchant.fragments

import android.graphics.Color
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import android.widget.TextView
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.Settlement
import global.cpay.app.databinding.FragmentSettlementsBinding
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

class SettlementsFragment : Fragment() {

    private var _b: FragmentSettlementsBinding? = null
    private val b get() = _b!!
    private val fmt = NumberFormat.getNumberInstance(Locale.FRANCE)

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentSettlementsBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        b.rvSettlements.layoutManager = LinearLayoutManager(context)
        load()
    }

    private fun load() {
        b.progressBar.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val rd = ApiClient.api.merchantDashboard()
                if (rd.isSuccessful && rd.body() != null) {
                    b.tvSettlingTomorrow.text = "${fmt.format(rd.body()!!.settlingTomorrow)} XAF"
                }
                val rf = ApiClient.api.merchantFees()
                if (rf.isSuccessful && rf.body() != null) {
                    val fees = rf.body()!!
                    val rate = (fees["collectRate"] as? Double) ?: 1.5
                    b.tvFeeRate.text = "Commission: $rate%"
                }
                val r = ApiClient.api.merchantSettlements()
                if (r.isSuccessful && r.body() != null) {
                    val list = r.body()!!.data
                    b.tvCount.text = "${list.size} règlement(s)"
                    b.rvSettlements.adapter = SettlementAdapter(list)
                    b.tvEmpty.visibility = if (list.isEmpty()) View.VISIBLE else View.GONE
                }
            } catch (e: Exception) {
                b.tvEmpty.visibility = View.VISIBLE
            } finally { if (_b != null) b.progressBar.visibility = View.GONE }
        }
    }

    inner class SettlementAdapter(private val items: List<Settlement>) :
        RecyclerView.Adapter<SettlementAdapter.VH>() {

        inner class VH(v: View) : RecyclerView.ViewHolder(v) {
            val date   : TextView = v.findViewById(R.id.tv_date)
            val amount : TextView = v.findViewById(R.id.tv_amount)
            val status : TextView = v.findViewById(R.id.tv_status)
            val count  : TextView = v.findViewById(R.id.tv_txn_count)
        }

        override fun onCreateViewHolder(p: ViewGroup, t: Int) =
            VH(LayoutInflater.from(p.context).inflate(R.layout.item_settlement, p, false))

        override fun onBindViewHolder(h: VH, pos: Int) {
            val s = items[pos]
            h.date.text   = s.settlementDate?.take(10) ?: "—"
            h.amount.text = "${fmt.format(s.amount)} ${s.currency}"
            h.count.text  = "${s.txnCount} transactions"
            h.status.text = if (s.settled) "Réglé" else "En attente"
            h.status.setTextColor(Color.parseColor(if (s.settled) "#007a5a" else "#c47000"))
        }

        override fun getItemCount() = items.size
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
