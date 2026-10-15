package global.cpay.app.cardholder.fragments

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import global.cpay.app.cardholder.QRScanActivity
import global.cpay.app.databinding.FragmentPayBinding

class PayFragment : Fragment() {

    private var _binding: FragmentPayBinding? = null
    private val binding get() = _binding!!

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentPayBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.btnScan.setOnClickListener {
            startActivity(Intent(requireContext(), QRScanActivity::class.java))
        }
        binding.btnManual.setOnClickListener {
            android.widget.Toast.makeText(requireContext(), "Saisie manuelle — bientôt disponible", android.widget.Toast.LENGTH_SHORT).show()
        }
    }

    override fun onDestroyView() { super.onDestroyView(); _binding = null }
}
