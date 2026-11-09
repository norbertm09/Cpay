package global.cpay.app.merchant.fragments

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import global.cpay.app.BuildConfig
import global.cpay.app.R
import android.net.Uri
import global.cpay.app.common.ApiClient
import global.cpay.app.common.ApiErrors
import global.cpay.app.common.DeletionRequest
import global.cpay.app.common.DeletionRequestBody
import global.cpay.app.common.AuthFlow
import global.cpay.app.common.BiometricHelper
import global.cpay.app.common.ChangePasswordActivity
import global.cpay.app.common.SessionManager
import global.cpay.app.common.TwoFAActivity
import global.cpay.app.common.ui.UiPrefs
import global.cpay.app.databinding.FragmentMerchProfileBinding
import global.cpay.app.merchant.MerchantMainActivity
import global.cpay.app.merchant.PairingActivity
import global.cpay.app.merchant.StepUp
import global.cpay.app.onboarding.ProfileSelectActivity
import kotlinx.coroutines.launch

/**
 * Profil et securite (WAVE-5) : identite (GET /merchant/auth/me), double authentification
 * (TwoFAActivity), mot de passe (ChangePasswordActivity), verrou biometrique a l'ouverture,
 * langue, terminal appaire, deconnexion.
 */
class MerchProfileFragment : Fragment() {

    private var _b: FragmentMerchProfileBinding? = null
    private val b get() = _b!!
    private val act: MerchantMainActivity? get() = activity as? MerchantMainActivity

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentMerchProfileBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        b.header.tvScreenTitle.text = getString(R.string.profile_screen_title)
        b.header.btnBack.setOnClickListener { act?.pop() }
        b.tvVersion.text = getString(R.string.app_version_fmt, BuildConfig.VERSION_NAME)

        renderIdentity(mapOf(
            getString(R.string.profile_business) to SessionManager.userName,
            getString(R.string.profile_email) to SessionManager.userEmail,
        ))
        b.tv2faStatus.setText(R.string.profile_2fa_unknown)
        b.row2fa.setOnClickListener {
            startActivity(Intent(requireContext(), TwoFAActivity::class.java).putExtra(AuthFlow.EXTRA_USER_TYPE, "merchant"))
        }
        b.rowPassword.setOnClickListener {
            startActivity(Intent(requireContext(), ChangePasswordActivity::class.java).putExtra(AuthFlow.EXTRA_USER_TYPE, "merchant"))
        }
        val bioAvailable = BiometricHelper.isAvailable(requireContext())
        b.switchBiometric.isEnabled = bioAvailable
        b.switchBiometric.isChecked = bioAvailable && UiPrefs.biometricLock
        if (!bioAvailable) b.tvBiometricSub.setText(R.string.profile_biometric_unavailable)
        b.switchBiometric.setOnCheckedChangeListener { _, checked -> UiPrefs.biometricLock = checked }
        b.rowLanguage.setOnClickListener { Toast.makeText(requireContext(), R.string.profile_language_soon, Toast.LENGTH_SHORT).show() }

        if (SessionManager.isPaired) {
            b.tvTerminal.text = listOfNotNull(SessionManager.terminalName, SessionManager.terminalSite).joinToString(" · ")
            b.btnPair.visibility = View.GONE
        } else {
            b.tvTerminal.setText(R.string.more_terminal_none)
            b.btnPair.visibility = View.VISIBLE
        }
        b.btnPair.setOnClickListener { startActivity(Intent(requireContext(), PairingActivity::class.java)) }
        b.rowTerminal.setOnClickListener { act?.openTerminals() }

        // Lot 4 (audit 2026-11-02 mobile P0-2) : politique de confidentialite et suppression de compte dans l'app
        b.rowPrivacy.setOnClickListener { openUrl(policyUrl) }
        b.rowDeleteAccount.setOnClickListener { if (pendingDeletion == null) confirmDeletion() else openUrl(deletionUrl) }
        b.btnCancelDeletion.setOnClickListener { cancelDeletion() }

        b.btnLogout.setOnClickListener {
            MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.profile_logout)
                .setMessage(R.string.profile_logout_confirm)
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.profile_logout) { _, _ -> logout() }
                .show()
        }
        loadMe()
    }

    override fun onResume() { super.onResume(); loadMe(); loadDeletionState() }

    // ─── Lot 4 : suppression de compte ──────────────────────────────
    private var policyUrl = "https://c-pay.global/legal/confidentialite.html"
    private var deletionUrl = "https://c-pay.global/legal/suppression-compte.html"
    private var pendingDeletion: DeletionRequest? = null

    private fun openUrl(u: String) {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u))) }
        catch (_: Exception) { Toast.makeText(requireContext(), R.string.profile_open_link_error, Toast.LENGTH_SHORT).show() }
    }

    private fun loadDeletionState() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.accountDeletionState()
                val st = r.body()
                if (_b == null || !r.isSuccessful || st == null) return@launch
                st.policyUrl?.takeIf { it.isNotBlank() }?.let { policyUrl = it }
                st.deletionUrl?.takeIf { it.isNotBlank() }?.let { deletionUrl = it }
                renderDeletion(st.request)
            } catch (_: Exception) { }
        }
    }

    private fun renderDeletion(req: DeletionRequest?) {
        if (_b == null) return
        pendingDeletion = req?.takeIf { it.status == "pending" }
        val p = pendingDeletion
        if (p != null) {
            val until = p.retractUntil?.let { global.cpay.app.common.ui.Fmt.shortDate(it) } ?: "—"
            b.tvDeleteSub.text = getString(R.string.profile_delete_pending_fmt, until)
            b.btnCancelDeletion.visibility = View.VISIBLE
        } else {
            b.tvDeleteSub.setText(R.string.profile_delete_account_sub)
            b.btnCancelDeletion.visibility = View.GONE
        }
    }

    private fun confirmDeletion() {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.profile_delete_confirm_title)
            .setMessage(R.string.profile_delete_confirm_body)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.profile_delete_confirm_cta) { _, _ -> requestDeletion() }
            .show()
    }

    private fun requestDeletion() {
        val ctx = requireContext()
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = StepUp.run(ctx, getString(R.string.profile_delete_stepup_title)) { confirm ->
                    ApiClient.api.accountDeletionRequest(DeletionRequestBody(reason = null, confirm = confirm))
                }
                if (_b == null || r == null) return@launch
                val body = r.body()
                if (r.isSuccessful && body != null) {
                    renderDeletion(body)
                    Toast.makeText(ctx, body.message ?: getString(R.string.profile_delete_requested), Toast.LENGTH_LONG).show()
                } else {
                    val e = ApiErrors.of(r)
                    val msg = if (e.code == "INSUFFICIENT_ROLE") getString(R.string.profile_delete_owner_only) else ApiErrors.cashMessage(r.code(), e)
                    Toast.makeText(ctx, msg, Toast.LENGTH_LONG).show()
                }
            } catch (_: Exception) {
                if (_b != null) Toast.makeText(ctx, R.string.network_error, Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun cancelDeletion() {
        val ctx = requireContext()
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.accountDeletionCancel()
                if (_b == null) return@launch
                if (r.isSuccessful) { renderDeletion(null); Toast.makeText(ctx, R.string.profile_delete_cancelled, Toast.LENGTH_SHORT).show() }
                else Toast.makeText(ctx, ApiErrors.message(r), Toast.LENGTH_LONG).show()
            } catch (_: Exception) {
                if (_b != null) Toast.makeText(ctx, R.string.network_error, Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun loadMe() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.merchantMe()
                if (_b == null) return@launch
                val u = r.body()?.effectiveUser
                if (r.isSuccessful && u != null) {
                    renderIdentity(mapOf(
                        getString(R.string.profile_business) to (u.businessName ?: SessionManager.userName),
                        getString(R.string.profile_identity) to listOfNotNull(u.firstName, u.lastName).joinToString(" ").ifBlank { null },
                        getString(R.string.profile_email) to (u.email ?: SessionManager.userEmail),
                        getString(R.string.profile_phone) to u.phone,
                        getString(R.string.profile_country_currency) to listOfNotNull(u.country, u.currency).joinToString(" · ").ifBlank { null },
                    ))
                    when (u.mfaEnabled) {
                        true  -> { b.tv2faStatus.setText(R.string.profile_2fa_on); StepUp.mfaEnabled = true }
                        false -> { b.tv2faStatus.setText(R.string.profile_2fa_off); StepUp.mfaEnabled = false }
                        null  -> b.tv2faStatus.setText(R.string.profile_2fa_unknown)
                    }
                }
            } catch (_: Exception) { }
        }
    }

    private fun renderIdentity(rows: Map<String, String?>) {
        if (_b == null) return
        b.layoutIdentity.removeAllViews()
        rows.filter { !it.value.isNullOrBlank() }.forEach { (label, value) ->
            val row = LayoutInflater.from(requireContext()).inflate(R.layout.item_detail_row, b.layoutIdentity, false)
            row.findViewById<TextView>(R.id.tv_row_label).text = label
            row.findViewById<TextView>(R.id.tv_row_value).text = value
            b.layoutIdentity.addView(row)
        }
    }

    private fun logout() {
        b.btnLogout.isEnabled = false
        viewLifecycleOwner.lifecycleScope.launch {
            try { ApiClient.logout() } catch (e: Exception) { SessionManager.clearSession() }
            UiPrefs.onLogout()
            val a = activity ?: return@launch
            val intent = Intent(a, ProfileSelectActivity::class.java)
            intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            startActivity(intent)
        }
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
