package global.cpay.app.cardholder.fragments

import android.app.DatePickerDialog
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import global.cpay.app.cardholder.TransactionAdapter
import global.cpay.app.common.ApiClient
import global.cpay.app.common.SessionManager
import global.cpay.app.common.Transaction
import global.cpay.app.databinding.FragmentTransactionsBinding
import global.cpay.app.db.CacheManager
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.*

class TransactionsFragment : Fragment() {

    private var _binding: FragmentTransactionsBinding? = null
    private val binding get() = _binding!!
    private val fmt = NumberFormat.getNumberInstance(Locale.FRANCE)
    private val sdf = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
    private var dateFrom: String? = null
    private var dateTo: String? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentTransactionsBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.rvTransactions.layoutManager = LinearLayoutManager(context)

        val statusAdapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item,
            listOf("Tous statuts", "completed", "pending", "failed"))
        statusAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        binding.spinnerStatus.adapter = statusAdapter

        val typeAdapter = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item,
            listOf("Tous types", "collect", "disburse"))
        typeAdapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        binding.spinnerType.adapter = typeAdapter

        binding.btnDateFrom.setOnClickListener { pickDate(true) }
        binding.btnDateTo.setOnClickListener   { pickDate(false) }
        binding.btnClearDates.setOnClickListener {
            dateFrom = null; dateTo = null
            binding.btnDateFrom.text = "📅 Du"
            binding.btnDateTo.text   = "📅 Au"
            binding.btnClearDates.visibility = View.GONE
            loadFromApi()
        }

        // Charger cache d'abord — non bloquant
        loadFromCache()
        // Puis API en arrière-plan
        loadFromApi()
    }

    private fun loadFromCache() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val cached = CacheManager.getCachedTransactions(requireContext(), "cardholder")
                if (cached.isNotEmpty()) {
                    val txns = cached.map { CacheManager.entityToTransaction(it) }
                    updateUI(txns, fromCache = true)
                }
            } catch(e: Exception) { }
        }
    }

    private fun loadFromApi() {
        binding.progressBar.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cardholderTransactions(page = 1, limit = 50)
                if (_binding == null) return@launch
                if (r.isSuccessful && r.body() != null) {
                    val txns = r.body()!!.data
                    CacheManager.saveTransactions(requireContext(), txns, "cardholder")
                    updateUI(txns, fromCache = false)
                }
            } catch(e: Exception) {
                // Silencieux — le cache est déjà affiché
            } finally {
                if (_binding != null) binding.progressBar.visibility = View.GONE
            }
        }
    }

    private fun updateUI(txns: List<Transaction>, fromCache: Boolean) {
        if (_binding == null) return
        val filtered = txns.filter { t ->
            val date = t.initiatedAt?.take(10) ?: ""
            (dateFrom == null || date >= dateFrom!!) &&
            (dateTo   == null || date <= dateTo!!)
        }
        binding.tvTotal.text = "${filtered.size} transactions${if (fromCache) " (cache)" else ""}"
        binding.rvTransactions.adapter = TransactionAdapter(filtered)
    }

    private fun pickDate(isFrom: Boolean) {
        val cal = Calendar.getInstance()
        DatePickerDialog(requireContext(), { _, y, m, d ->
            val date = String.format("%04d-%02d-%02d", y, m+1, d)
            if (isFrom) {
                dateFrom = date
                binding.btnDateFrom.text = "📅 $date"
            } else {
                dateTo = date
                binding.btnDateTo.text = "📅 $date"
            }
            binding.btnClearDates.visibility = View.VISIBLE
            loadFromApi()
        }, cal.get(Calendar.YEAR), cal.get(Calendar.MONTH), cal.get(Calendar.DAY_OF_MONTH)).show()
    }

    override fun onDestroyView() { super.onDestroyView(); _binding = null }
}
