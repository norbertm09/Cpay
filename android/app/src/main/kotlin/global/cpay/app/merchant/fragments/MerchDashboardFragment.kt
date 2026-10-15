package global.cpay.app.merchant.fragments

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import global.cpay.app.cardholder.TransactionAdapter
import global.cpay.app.common.ApiClient
import global.cpay.app.common.SessionManager
import global.cpay.app.databinding.FragmentMerchDashboardBinding
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

class MerchDashboardFragment : Fragment() {

    private var _binding: FragmentMerchDashboardBinding? = null
    private val binding get() = _binding!!
    private val fmt = NumberFormat.getNumberInstance(Locale.FRANCE)

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentMerchDashboardBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.tvWelcome.text = "Bonjour, ${SessionManager.userName} 🏪"
        binding.rvTransactions.layoutManager = LinearLayoutManager(context)

        binding.btnSettlements.setOnClickListener {
            (activity as? global.cpay.app.merchant.MerchantMainActivity)?.openSettlements()
        }
        binding.btnTerminals.setOnClickListener {
            (activity as? global.cpay.app.merchant.MerchantMainActivity)?.openTerminals()
        }
        binding.btnTransfers.setOnClickListener {
            (activity as? global.cpay.app.merchant.MerchantMainActivity)?.openTransfers()
        }
        binding.btnPayLinks.setOnClickListener {
            (activity as? global.cpay.app.merchant.MerchantMainActivity)?.openPayLinks()
        }

        loadData()
    }

    private fun loadData() {
        binding.progressBar.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.merchantDashboard()
                if (_binding == null) return@launch
                if (r.isSuccessful && r.body() != null) {
                    val d = r.body()!!
                    binding.tvVolumeToday.text  = "${fmt.format(d.today?.volume ?: 0.0)} XAF"
                    binding.tvTxnsToday.text    = "${d.today?.txnCount ?: 0} txns"
                    binding.tvVolumeMonth.text  = "${fmt.format(d.thisMonth?.volume ?: 0.0)} XAF"
                    binding.tvTxnsMonth.text    = "${d.thisMonth?.txnCount ?: 0} txns"
                }
                val txns = ApiClient.api.merchantTransactions(limit = 5)
                if (_binding == null) return@launch
                if (txns.isSuccessful && txns.body() != null) {
                    binding.rvTransactions.adapter = TransactionAdapter(txns.body()!!.data)
                }
            } catch(e: Exception) {
                binding.tvVolumeToday.text = "Erreur"
            } finally {
                binding.progressBar.visibility = View.GONE
            }
        }
    }

    override fun onDestroyView() { super.onDestroyView(); _binding = null }
}
