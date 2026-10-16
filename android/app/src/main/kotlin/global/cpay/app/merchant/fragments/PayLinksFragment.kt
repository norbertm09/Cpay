package global.cpay.app.merchant.fragments
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import global.cpay.app.common.ApiClient
import global.cpay.app.common.PayLink
import global.cpay.app.databinding.FragmentPayLinksBinding
import global.cpay.app.merchant.PayLinkAdapter
import kotlinx.coroutines.launch

class PayLinksFragment : Fragment() {
    private var _b: FragmentPayLinksBinding? = null
    private val b get() = _b!!
    private lateinit var adapter: PayLinkAdapter
    private var links: List<PayLink> = emptyList()

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentPayLinksBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        b.rvPayLinks.layoutManager = LinearLayoutManager(context)
        adapter = PayLinkAdapter(links, ::copyLink, ::shareLink, ::cancelLink)
        b.rvPayLinks.adapter = adapter
        b.btnNewLink.setOnClickListener { showCreateDialog() }
        load()
    }

    private fun load() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.merchantPayLinks()
                val body = r.body()
                if (r.isSuccessful && body != null) {
                    links = body.data
                    adapter.update(links)
                    b.tvEmpty.visibility = if (links.isEmpty()) View.VISIBLE else View.GONE
                }
            } catch (_: Exception) {
                b.tvEmpty.visibility = View.VISIBLE
            }
        }
    }

    private fun copyLink(pl: PayLink) {
        val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("PayLink", pl.shortUrl))
        Toast.makeText(requireContext(), "Copié !", Toast.LENGTH_SHORT).show()
    }

    private fun shareLink(pl: PayLink) {
        val i = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, "Paiement CPay: ${pl.shortUrl}")
        }
        startActivity(Intent.createChooser(i, "Partager le lien"))
    }

    private fun cancelLink(pl: PayLink) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.merchantDeletePayLink(pl.id)
                if (r.isSuccessful) {
                    Toast.makeText(requireContext(), "Lien annulé", Toast.LENGTH_SHORT).show()
                    load()
                } else Toast.makeText(requireContext(), "Erreur", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(requireContext(), "Erreur réseau", Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun showCreateDialog() {
        val ctx = requireContext()
        val pad = (16 * resources.displayMetrics.density).toInt()
        val layout = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        val etAmount = EditText(ctx).apply { hint = "Montant (XAF)"; inputType = android.text.InputType.TYPE_CLASS_NUMBER }
        val etDesc = EditText(ctx).apply { hint = "Description (optionnel)" }
        layout.addView(etAmount)
        layout.addView(etDesc)
        androidx.appcompat.app.AlertDialog.Builder(ctx)
            .setTitle("Nouveau lien de paiement")
            .setView(layout)
            .setPositiveButton("Créer") { _, _ ->
                val amt = etAmount.text.toString().toDoubleOrNull()
                if (amt == null || amt < 100) { Toast.makeText(ctx, "Montant minimum 100 XAF", Toast.LENGTH_SHORT).show(); return@setPositiveButton }
                createLink(amt, etDesc.text.toString().trim())
            }
            .setNegativeButton("Annuler", null)
            .show()
    }

    private fun createLink(amount: Double, desc: String) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val body = mutableMapOf<String, Any>("amount" to amount, "expiresIn" to 24)
                if (desc.isNotEmpty()) body["description"] = desc
                val r = ApiClient.api.merchantCreatePayLink(body)
                if (r.isSuccessful) {
                    Toast.makeText(requireContext(), "Lien créé", Toast.LENGTH_SHORT).show()
                    load()
                } else Toast.makeText(requireContext(), "Erreur création", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(requireContext(), "Erreur réseau", Toast.LENGTH_SHORT).show()
            }
        }
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
