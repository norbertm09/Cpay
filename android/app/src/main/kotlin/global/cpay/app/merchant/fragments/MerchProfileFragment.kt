package global.cpay.app.merchant.fragments

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import global.cpay.app.common.SessionManager
import global.cpay.app.common.ApiClient
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import global.cpay.app.databinding.FragmentProfileBinding
import global.cpay.app.onboarding.ForgotPasswordActivity
import global.cpay.app.onboarding.ProfileSelectActivity

class MerchProfileFragment : Fragment() {

    private var _binding: FragmentProfileBinding? = null
    private val binding get() = _binding!!

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _binding = FragmentProfileBinding.inflate(inflater, container, false)
        return binding.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        binding.tvName.text  = SessionManager.userName ?: "—"
        binding.tvEmail.text = SessionManager.userEmail ?: "—"
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val a = ApiClient.api.merchantAccount().body()
                if (a != null) {
                    (a["wallet_mtn"]    as? String)?.let { binding.etWalletMtn.setText(it) }
                    (a["wallet_airtel"] as? String)?.let { binding.etWalletAirtel.setText(it) }
                    (a["bank_account"]  as? String)?.let { binding.etBankAccount.setText(it) }
                    (a["bank_name"]     as? String)?.let { binding.etBankName.setText(it) }
                }
            } catch (_: Exception) {}
        }
        binding.btnSaveProfile.setOnClickListener {
            val body = mutableMapOf<String, String>()
            binding.etPhone.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { body["phone"] = it }
            binding.etWalletMtn.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { body["walletMtn"] = it }
            binding.etWalletAirtel.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { body["walletAirtel"] = it }
            binding.etBankAccount.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { body["bankAccount"] = it }
            binding.etBankName.text?.toString()?.trim()?.takeIf { it.isNotEmpty() }?.let { body["bankName"] = it }
            viewLifecycleOwner.lifecycleScope.launch {
                try {
                    val r = ApiClient.api.merchantUpdateAccount(body)
                    android.widget.Toast.makeText(requireContext(), if (r.isSuccessful) "Enregistré ✅" else "Erreur", android.widget.Toast.LENGTH_SHORT).show()
                } catch (e: Exception) {
                    android.widget.Toast.makeText(requireContext(), "Erreur réseau", android.widget.Toast.LENGTH_SHORT).show()
                }
            }
        }

        binding.btnKyb.setOnClickListener {
            (activity as? global.cpay.app.merchant.MerchantMainActivity)?.openKyb()
        }
        binding.btnChangePassword.setOnClickListener {
            val intent = Intent(requireContext(), ForgotPasswordActivity::class.java)
            intent.putExtra("user_type", "merchant")
            startActivity(intent)
        }

        binding.btn2fa.setOnClickListener {
            startActivity(android.content.Intent(requireContext(), global.cpay.app.common.TwoFAActivity::class.java))
        }


        binding.btnLogout.setOnClickListener {
            binding.btnLogout.isEnabled = false
            viewLifecycleOwner.lifecycleScope.launch {
                // POST /merchant/auth/logout { refreshToken } + effacement local
                try { ApiClient.logout() } catch (e: Exception) { SessionManager.clearSession() }
                val intent = Intent(requireContext(), ProfileSelectActivity::class.java)
                intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
                startActivity(intent)
            }
        }
    }

    override fun onDestroyView() { super.onDestroyView(); _binding = null }
}
