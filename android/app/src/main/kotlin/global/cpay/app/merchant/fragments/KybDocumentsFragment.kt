package global.cpay.app.merchant.fragments
import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Base64
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import global.cpay.app.common.ApiClient
import global.cpay.app.common.KybDocRequest
import global.cpay.app.databinding.FragmentKybBinding
import kotlinx.coroutines.launch

class KybDocumentsFragment : Fragment() {
    private var _b: FragmentKybBinding? = null
    private val b get() = _b!!

    // Types de documents KYB
    private val docTypes = listOf(
        "rccm" to "RCCM (registre de commerce)",
        "nif" to "NIF (identifiant fiscal)",
        "id_gerant" to "Pièce d'identité du gérant",
        "statuts" to "Statuts de la société",
        "adresse" to "Justificatif d'adresse",
        "autre" to "Autre document"
    )

    private var pickedBase64: String? = null
    private var pickedName: String? = null
    private var pickedMime: String? = null
    private var pickedSize: Long = 0

    private val picker = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { res ->
        if (res.resultCode == Activity.RESULT_OK) {
            res.data?.data?.let { uri ->
                try {
                    val cr = requireContext().contentResolver
                    var name = "doc_${System.currentTimeMillis()}"
                    cr.query(uri, null, null, null, null)?.use { c ->
                        val i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (i >= 0 && c.moveToFirst()) name = c.getString(i)
                    }
                    val bytes = cr.openInputStream(uri)?.use { it.readBytes() } ?: return@let
                    if (bytes.size > 5 * 1024 * 1024) {
                        Toast.makeText(requireContext(), "Fichier trop volumineux (max 5 Mo)", Toast.LENGTH_LONG).show()
                        return@let
                    }
                    pickedMime = cr.getType(uri) ?: "application/octet-stream"
                    pickedSize = bytes.size.toLong()
                    pickedName = name
                    val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                    pickedBase64 = "data:$pickedMime;base64,$b64"
                    b.tvSelectedFile.text = "✓ $name (${pickedSize / 1024} Ko)"
                } catch (e: Exception) {
                    Toast.makeText(requireContext(), "Erreur lecture fichier", Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentKybBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        val labels = docTypes.map { it.second }
        b.spinnerDocType.adapter = ArrayAdapter(requireContext(),
            android.R.layout.simple_spinner_dropdown_item, labels)
        b.btnPickFile.setOnClickListener {
            picker.launch(Intent(Intent.ACTION_GET_CONTENT).apply {
                type = "*/*"
                addCategory(Intent.CATEGORY_OPENABLE)
            })
        }
        b.btnUploadKyb.setOnClickListener { upload() }
        loadDocs()
    }

    private fun loadDocs() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.merchantKyb()
                val body = r.body()
                b.tvKybStatus.text = "Niveau KYB: ${body?.kycLevel ?: 0} · ${body?.status ?: "en attente"}"
                b.layoutDocsList.removeAllViews()
                val docs = body?.documents ?: emptyList()
                b.tvNoDocs.visibility = if (docs.isEmpty()) View.VISIBLE else View.GONE
                for (d in docs) {
                    val tv = TextView(requireContext()).apply {
                        text = "• ${d.docType} — ${d.status}"
                        textSize = 13f
                        setPadding(0, 8, 0, 8)
                    }
                    b.layoutDocsList.addView(tv)
                }
            } catch (_: Exception) {
                b.tvKybStatus.text = "Impossible de charger le statut"
            }
        }
    }

    private fun upload() {
        val b64 = pickedBase64
        if (b64 == null) { Toast.makeText(requireContext(), "Choisissez un fichier d'abord", Toast.LENGTH_SHORT).show(); return }
        val pos = b.spinnerDocType.selectedItemPosition
        val (docType, docLabel) = docTypes[pos]
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.uploadKybDoc(KybDocRequest(
                    docType = docType, docLabel = docLabel, fileUrl = b64,
                    fileName = pickedName, fileSize = pickedSize, mimeType = pickedMime))
                if (r.isSuccessful) {
                    Toast.makeText(requireContext(), "Document envoyé ✅", Toast.LENGTH_SHORT).show()
                    pickedBase64 = null
                    b.tvSelectedFile.text = ""
                    loadDocs()
                } else {
                    Toast.makeText(requireContext(), "Erreur envoi", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                Toast.makeText(requireContext(), "Erreur réseau", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
