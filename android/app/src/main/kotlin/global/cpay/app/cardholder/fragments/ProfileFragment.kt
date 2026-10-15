package global.cpay.app.cardholder.fragments

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import global.cpay.app.common.ApiClient
import global.cpay.app.common.ApiErrors
import global.cpay.app.common.AuthFlow
import global.cpay.app.common.SessionManager
import global.cpay.app.common.TwoFAActivity
import global.cpay.app.databinding.FragmentProfileBinding
import global.cpay.app.onboarding.ProfileSelectActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.FileOutputStream

class ProfileFragment : Fragment() {

    private var _b: FragmentProfileBinding? = null
    private val b get() = _b!!
    private var pendingDocType = "id_card"

    private val picker = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { res ->
        if (res.resultCode == Activity.RESULT_OK) {
            res.data?.data?.let { uploadDoc(it, pendingDocType) }
        }
    }

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentProfileBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        b.tvName.text  = SessionManager.userName ?: "—"
        b.tvEmail.text = SessionManager.userEmail ?: "—"

        b.btnEditProfile.setOnClickListener   { toggle(b.layoutEditProfile) }
        b.btnSaveProfile.setOnClickListener   { saveProfile() }

        b.btnChangePassword.setOnClickListener  { toggle(b.layoutPassword) }
        b.btnConfirmPassword.setOnClickListener { changePassword() }

        b.btn2fa.setOnClickListener {
            startActivity(Intent(requireContext(), TwoFAActivity::class.java)
                .putExtra("user_type", "cardholder"))
        }

        b.btnKyc.setOnClickListener { toggle(b.layoutKyc); loadKyc() }
        b.btnUploadId.setOnClickListener      { pickFile("id_card") }
        b.btnUploadProof.setOnClickListener   { pickFile("proof_of_address") }
        b.btnUploadSelfie.setOnClickListener  { pickFile("selfie") }

        b.btnSecurity.setOnClickListener { toggle(b.layoutSecurity); loadSecurity() }
        b.btnSupport.setOnClickListener  { toggle(b.layoutSupport) }
        b.btnCreateTicket.setOnClickListener { createTicket() }

        b.btnLogout.setOnClickListener { logout() }

        loadProfile()
    }

    private fun toggle(v: View) {
        v.visibility = if (v.visibility == View.VISIBLE) View.GONE else View.VISIBLE
    }

    private fun loadProfile() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cardholderDashboard()
                if (r.isSuccessful && r.body() != null) {
                    val c = r.body()!!.card
                    b.tvCardInfo.text = c?.cardMasked ?: "Aucune carte"
                }
                val f = ApiClient.api.cardholder2FAStatus()
                if (f.isSuccessful && f.body() != null) {
                    val on = (f.body()!!["mfaEnabled"] as? Boolean) ?: false
                    b.tv2faStatus.text = if (on) "✅ Activée" else "⚠️ Désactivée"
                }
                val k = ApiClient.api.cardholderKyc()
                if (k.isSuccessful && k.body() != null) {
                    b.tvKycLevel.text = "Niveau ${k.body()!!.kycLevel}"
                }
            } catch (e: Exception) { }
        }
    }

    private fun saveProfile() {
        val phone = b.etPhone.text.toString().trim()
        val addr  = b.etAddress.text.toString().trim()
        val city  = b.etCity.text.toString().trim()
        val body = mutableMapOf<String, String>()
        if (phone.isNotEmpty()) body["phone"]   = phone
        if (addr.isNotEmpty())  body["address"] = addr
        if (city.isNotEmpty())  body["city"]    = city
        if (body.isEmpty()) { toast("Rien à modifier"); return }

        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cardholderUpdateProfile(body)
                if (r.isSuccessful) {
                    toast("Profil mis à jour ✅")
                    b.layoutEditProfile.visibility = View.GONE
                } else toast("Erreur")
            } catch (e: Exception) { toast("Erreur réseau") }
        }
    }

    private fun changePassword() {
        val cur = b.etCurrentPassword.text.toString()
        val new = b.etNewPassword.text.toString()
        val cnf = b.etConfirmPassword.text.toString()
        if (new.length < 8) { toast("8 caractères minimum"); return }
        if (new != cnf)     { toast("Les mots de passe diffèrent"); return }
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cardholderChangePassword(mapOf(
                    "currentPassword" to cur, "newPassword" to new))
                if (r.isSuccessful) {
                    // WAVE-3 : le serveur revoque toutes les sessions → reconnexion.
                    SessionManager.clearSession()
                    AuthFlow.toLogin(requireContext(), "cardholder", "Mot de passe modifié ✅ — reconnectez-vous")
                } else toast(ApiErrors.message(r))
            } catch (e: Exception) { toast("Erreur réseau") }
        }
    }

    private fun loadKyc() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cardholderKyc()
                if (r.isSuccessful && r.body() != null) {
                    val k = r.body()!!
                    b.tvKycStatus.text = "Statut: ${k.status} · Niveau ${k.kycLevel}\n" +
                        if (k.documents.isEmpty()) "Aucun document envoyé"
                        else k.documents.joinToString("\n") {
                            val icon = when (it.status) {
                                "approved", "verified" -> "✅"
                                "rejected"             -> "❌"
                                else                   -> "⏳"
                            }
                            "$icon ${docLabel(it.docType)}: ${it.status}"
                        }
                }
            } catch (e: Exception) { b.tvKycStatus.text = "Erreur de chargement" }
        }
    }

    private fun docLabel(t: String) = when (t) {
        "id_card"          -> "Pièce d'identité"
        "passport"         -> "Passeport"
        "proof_of_address" -> "Justificatif de domicile"
        "selfie"           -> "Selfie"
        else               -> t
    }

    private fun pickFile(docType: String) {
        pendingDocType = docType
        picker.launch(Intent(Intent.ACTION_GET_CONTENT).apply {
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("image/*", "application/pdf"))
        })
    }

    private fun uploadDoc(uri: Uri, docType: String) {
        b.progressKyc.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val file = withContext(Dispatchers.IO) { copyToCache(uri) }
                if (file == null) { toast("Fichier illisible"); return@launch }
                if (file.length() > 5 * 1024 * 1024) {
                    toast("Fichier trop lourd (max 5 Mo)"); return@launch
                }

                val mime = requireContext().contentResolver.getType(uri) ?: "application/octet-stream"
                val part = MultipartBody.Part.createFormData(
                    "file", file.name, file.asRequestBody(mime.toMediaTypeOrNull()))
                val typeBody: RequestBody = docType.toRequestBody("text/plain".toMediaTypeOrNull())

                val r = ApiClient.api.uploadKycDoc(typeBody, part)
                if (r.isSuccessful) {
                    toast("${docLabel(docType)} envoyé ✅")
                    loadKyc()
                } else toast(r.errorBody()?.string() ?: "Erreur d'envoi")

                file.delete()
            } catch (e: Exception) {
                toast("Erreur: ${e.message}")
            } finally {
                if (_b != null) b.progressKyc.visibility = View.GONE
            }
        }
    }

    private fun copyToCache(uri: Uri): File? {
        return try {
            val cr = requireContext().contentResolver
            var name = "doc_${System.currentTimeMillis()}"
            cr.query(uri, null, null, null, null)?.use { c ->
                val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                if (i >= 0 && c.moveToFirst()) name = c.getString(i)
            }
            val f = File(requireContext().cacheDir, name)
            cr.openInputStream(uri)?.use { input ->
                FileOutputStream(f).use { out -> input.copyTo(out) }
            }
            f
        } catch (e: Exception) { null }
    }

    private fun loadSecurity() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cardholderSecurityEvents()
                if (r.isSuccessful && r.body() != null) {
                    val d = r.body()!!["data"] as? List<*> ?: emptyList<Any>()
                    b.tvSecurityEvents.text = if (d.isEmpty()) "Aucun événement récent"
                        else d.take(5).joinToString("\n") { ev ->
                            val m = ev as? Map<*, *> ?: return@joinToString "—"
                            "• ${m["event_type"] ?: "?"} — ${(m["created_at"] as? String)?.take(10) ?: ""}"
                        }
                }
            } catch (e: Exception) { b.tvSecurityEvents.text = "Erreur de chargement" }
        }
    }

    private fun createTicket() {
        val subj = b.etTicketSubject.text.toString().trim()
        val msg  = b.etTicketMessage.text.toString().trim()
        if (subj.isEmpty() || msg.isEmpty()) { toast("Sujet et message requis"); return }
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cardholderCreateTicket(mapOf(
                    "subject" to subj, "message" to msg))
                if (r.isSuccessful) {
                    toast("Ticket créé ✅")
                    b.etTicketSubject.text?.clear()
                    b.etTicketMessage.text?.clear()
                    b.layoutSupport.visibility = View.GONE
                } else toast("Erreur")
            } catch (e: Exception) { toast("Erreur réseau") }
        }
    }

    private fun logout() {
        viewLifecycleOwner.lifecycleScope.launch {
            // POST /cardholder/auth/logout { refreshToken } + effacement local
            try { ApiClient.logout() } catch (e: Exception) { SessionManager.clearSession() }
            startActivity(Intent(requireContext(), ProfileSelectActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            })
        }
    }

    private fun toast(m: String) = Toast.makeText(requireContext(), m, Toast.LENGTH_SHORT).show()

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
