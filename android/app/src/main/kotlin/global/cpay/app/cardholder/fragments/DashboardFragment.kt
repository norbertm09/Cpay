package global.cpay.app.cardholder.fragments

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import global.cpay.app.cardholder.QRScanActivity
import global.cpay.app.cardholder.TransactionAdapter
import global.cpay.app.common.ApiClient
import global.cpay.app.common.SessionManager
import global.cpay.app.databinding.FragmentChDashboardBinding
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.text.SimpleDateFormat
import java.util.*

class DashboardFragment : Fragment() {

    private var _binding: FragmentChDashboardBinding? = null
    private val binding get() = _binding!!
    private val fmt = NumberFormat.getNumberInstance(Locale.FRANCE)

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentChDashboardBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.tvWelcome.text = "Bonjour, ${SessionManager.userName} 👋"
        binding.tvDate.text = SimpleDateFormat("EEEE dd MMMM yyyy", Locale.FRENCH).format(Date())
        binding.rvTransactions.layoutManager = LinearLayoutManager(context)

        binding.btnScanQr.setOnClickListener {
            startActivity(Intent(requireContext(), QRScanActivity::class.java))
        }

        loadData()
    }

    private fun loadData() {
        binding.progressBar.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cardholderDashboard()
                if (_binding == null) return@launch
                if (r.isSuccessful && r.body() != null) {
                    val d = r.body()!!
                    val card = d.card
                    // Solde
                    binding.tvBalance.text = "${fmt.format(d.balance)} ${d.currency}"
                    // Stats
                    binding.tvTxnsToday.text = "${d.txnsToday}"
                    binding.tvSpent.text = "${fmt.format(d.spentMonth)} XAF"
                    // Carte + nom
                    val name = d.card?.cardholderName ?: SessionManager.userName ?: ""
                    if (name.isNotEmpty()) binding.tvWelcome.text = "Bonjour, $name 👋"
                    loadTransactions()
                }
            } catch(e: Exception) {
                binding.tvBalance.text = "— XAF"
                loadTransactions()
            } finally {
                if (_binding != null) binding.progressBar.visibility = View.GONE
            }
        }
    }

    private fun loadTransactions() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cardholderTransactions(limit = 5)
                if (_binding == null) return@launch
                if (r.isSuccessful && r.body() != null) {
                    val txns = r.body()!!.data
                    if (_binding != null) {
                        binding.rvTransactions.adapter = TransactionAdapter(txns)
                    }
                }
            } catch(e: Exception) { }
        }
    }

    override fun onDestroyView() { super.onDestroyView(); _binding = null }
}
