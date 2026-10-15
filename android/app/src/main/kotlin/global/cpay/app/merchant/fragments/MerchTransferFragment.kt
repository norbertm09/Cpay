package global.cpay.app.merchant.fragments

import android.app.Dialog
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.widget.ArrayAdapter
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import global.cpay.app.R
import global.cpay.app.common.*
import global.cpay.app.databinding.FragmentMerchTransferBinding
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

class MerchTransferFragment : Fragment() {

    private var _b: FragmentMerchTransferBinding? = null
    private val b get() = _b!!
    private val fmt = NumberFormat.getNumberInstance(Locale.FRANCE)

    private var dests        = listOf<TransferSource>()   // comptes + wallets
    private var institutions = listOf<Institution>()
    private var selDest: TransferSource? = null
    private var selInst: Institution?    = null
    private var country  = "CG"
    private var addMode  = "bank"
    private var available = 0.0

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentMerchTransferBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        b.rvHistory.layoutManager = LinearLayoutManager(context)

        b.btnAddDest.setOnClickListener  { showBankForm() }
        b.btnAddWallet.setOnClickListener { showWalletForm() }
        b.btnCancelForm.setOnClickListener  { hideForm() }
        b.btnConfirmForm.setOnClickListener { submitForm() }
        b.btnCountryCg.setOnClickListener { selCountry("CG") }
        b.btnCountryCm.setOnClickListener { selCountry("CM") }
        b.btnOpMtn.setOnClickListener    { selOp("mtn") }
        b.btnOpAirtel.setOnClickListener { selOp("airtel") }
        b.btnPayout.setOnClickListener { doPayout() }

        loadAll()
    }

    private fun loadAll() {
        b.progressBar.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            // Solde
            try {
                val bal = ApiClient.api.merchantBalance()
                if (_b == null) return@launch
                if (bal.isSuccessful && bal.body() != null) {
                    val d = bal.body()!!
                    available = d.available
                    b.tvAvailable.text = "${fmt.format(d.available)} XAF"
                    b.tvPending.text = "En attente : ${fmt.format(d.pending)} XAF"
                    b.tvWithdrawn.text = "Retiré : ${fmt.format(d.totalWithdrawn)} XAF"
                }
            } catch (e: Exception) { }

            // Destinations : comptes bancaires + wallets
            val list = mutableListOf<TransferSource>()
            try {
                val ra = ApiClient.api.merchantBankAccounts()
                if (ra.isSuccessful && ra.body() != null) {
                    ra.body()!!.data.forEach {
                        list.add(TransferSource("bank", it.accountId,
                            it.institution?.name ?: "Banque",
                            "${it.accountNumber} · ${it.accountName}", "🏦"))
                    }
                }
            } catch (e: Exception) { }

            dests = list
            if (_b == null) return@launch
            renderDests()
            loadHistory()

            if (_b != null) {
                b.progressBar.visibility = View.GONE
                updateButton()
            }
        }
    }

    private fun renderDests() {
        if (dests.isEmpty()) {
            b.tvNoDest.visibility = View.VISIBLE
            b.spinnerDest.visibility = View.GONE
            return
        }
        b.tvNoDest.visibility = View.GONE
        b.spinnerDest.visibility = View.VISIBLE
        selDest = dests[0]
        val labels = dests.map { "${it.icon}  ${it.label} — ${it.subtitle}" }
        val ad = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, labels)
        ad.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        b.spinnerDest.adapter = ad
        b.spinnerDest.onItemSelectedListener =
            object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onItemSelected(p: android.widget.AdapterView<*>?, v: View?, pos: Int, id: Long) {
                    selDest = dests[pos]
                }
                override fun onNothingSelected(p: android.widget.AdapterView<*>?) {}
            }
    }

    private suspend fun loadHistory() {
        try {
            val r = ApiClient.api.merchantTransfers()
            if (_b == null) return
            if (r.isSuccessful && r.body() != null) {
                val list = r.body()!!.data
                b.tvNoHistory.visibility = if (list.isEmpty()) View.VISIBLE else View.GONE
                b.rvHistory.adapter = HistoryAdapter(list.take(10))
            }
        } catch (e: Exception) { }
    }

    private fun updateButton() {
        val ok = dests.isNotEmpty() && available > 0
        b.btnPayout.isEnabled = ok
        b.btnPayout.alpha = if (ok) 1f else 0.4f
    }

    // ─── Formulaires ───
    private fun showBankForm() {
        addMode = "bank"
        b.layoutForm.visibility = View.VISIBLE
        b.tvFormTitle.text = "🏦 Ajouter un compte bancaire"
        b.layoutBankFields.visibility = View.VISIBLE
        b.layoutWalletFields.visibility = View.GONE
        selCountry("CG")
    }

    private fun showWalletForm() {
        addMode = "wallet"
        b.layoutForm.visibility = View.VISIBLE
        b.tvFormTitle.text = "📱 Ajouter un Mobile Money"
        b.layoutBankFields.visibility = View.GONE
        b.layoutWalletFields.visibility = View.VISIBLE
        selOp("mtn")
    }

    private fun hideForm() {
        b.layoutForm.visibility = View.GONE
        b.etAccountNumber.text?.clear()
        b.etAccountName.text?.clear()
        b.etWalletPhone.text?.clear()
    }

    private fun selCountry(c: String) {
        country = c
        val on = Color.parseColor("#12b6c7"); val off = Color.parseColor("#5a6677")
        b.btnCountryCg.setTextColor(if (c == "CG") on else off)
        b.btnCountryCm.setTextColor(if (c == "CM") on else off)
        loadInstitutions()
    }

    private fun selOp(op: String) {
        val on = Color.parseColor("#12b6c7"); val off = Color.parseColor("#5a6677")
        b.btnOpMtn.setTextColor(if (op == "mtn") on else off)
        b.btnOpMtn.setTypeface(null, if (op == "mtn") Typeface.BOLD else Typeface.NORMAL)
        b.btnOpAirtel.setTextColor(if (op == "airtel") on else off)
        b.btnOpMtn.tag = if (op == "mtn") "sel" else null
    }

    private fun currentOp() = if (b.btnOpMtn.tag == "sel") "mtn" else "airtel"

    private fun loadInstitutions() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.institutions(country = country)
                if (_b == null) return@launch
                if (r.isSuccessful && r.body() != null) {
                    institutions = r.body()!!.data
                    if (institutions.isEmpty()) return@launch
                    selInst = institutions[0]
                    val labels = institutions.map { "${it.typeLabel}  ${it.name}" }
                    val ad = ArrayAdapter(requireContext(),
                        android.R.layout.simple_spinner_item, labels)
                    ad.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
                    b.spinnerInstitution.adapter = ad
                    b.spinnerInstitution.onItemSelectedListener =
                        object : android.widget.AdapterView.OnItemSelectedListener {
                            override fun onItemSelected(p: android.widget.AdapterView<*>?, v: View?, pos: Int, id: Long) {
                                selInst = institutions[pos]
                            }
                            override fun onNothingSelected(p: android.widget.AdapterView<*>?) {}
                        }
                }
            } catch (e: Exception) { }
        }
    }

    private fun submitForm() {
        if (addMode == "bank") addBank() else { hideForm(); toast("Wallet: utilisez le retrait direct") }
    }

    private fun addBank() {
        val inst = selInst ?: run { toast("Choisissez une institution"); return }
        val num  = b.etAccountNumber.text.toString().trim()
        val name = b.etAccountName.text.toString().trim()
        if (num.length < 5) { toast("Numéro invalide"); return }
        if (name.isEmpty()) { toast("Nom requis"); return }

        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.merchantAddBankAccount(mapOf(
                    "institutionId" to inst.institutionId,
                    "accountNumber" to num,
                    "accountName"   to name))
                if (_b == null) return@launch
                if (r.isSuccessful) { toast("Compte ajouté ✅"); hideForm(); loadAll() }
                else toast(r.errorBody()?.string() ?: "Erreur")
            } catch (e: Exception) { toast("Erreur réseau") }
        }
    }

    // ─── Retrait ───
    private fun doPayout() {
        val dest = selDest ?: run { toast("Choisissez une destination"); return }
        val amt  = b.etAmount.text.toString().replace(" ", "").toDoubleOrNull()

        if (amt == null || amt < 1000) { showErr("Montant minimum 1000 XAF"); return }
        if (amt > available) { showErr("Solde insuffisant (${fmt.format(available)} XAF)"); return }

        b.tvError.visibility = View.GONE
        b.btnPayout.isEnabled = false
        b.progressBar.visibility = View.VISIBLE

        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val body = mutableMapOf<String, Any>(
                    "destType" to dest.type,
                    "amount"   to amt)
                if (dest.type == "bank") body["accountId"] = dest.id

                val r = ApiClient.api.merchantPayout(body)
                if (_b == null) return@launch

                if (r.isSuccessful && r.body() != null) {
                    showResult(r.body()!!)
                } else {
                    showErr(r.errorBody()?.string() ?: "Erreur")
                }
            } catch (e: Exception) {
                showErr("Erreur réseau")
            } finally {
                if (_b != null) {
                    b.btnPayout.isEnabled = true
                    b.progressBar.visibility = View.GONE
                }
            }
        }
    }

    private fun showResult(r: MerchantPayoutResponse) {
        val d = Dialog(requireContext())
        d.requestWindowFeature(Window.FEATURE_NO_TITLE)
        d.setContentView(R.layout.dialog_transfer_result)
        d.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))

        d.findViewById<TextView>(R.id.tv_icon).text = "✅"
        d.findViewById<TextView>(R.id.tv_title).apply {
            text = "Retrait demandé"
            setTextColor(Color.parseColor("#007a5a"))
        }
        d.findViewById<TextView>(R.id.tv_amount).text = "${fmt.format(r.net)} XAF"
        d.findViewById<TextView>(R.id.tv_details).text = buildString {
            append("Réf: ${r.reference}\n")
            append(r.message ?: "")
            if (r.fee > 0) append("\nFrais: ${fmt.format(r.fee)} XAF")
        }
        d.findViewById<TextView>(R.id.btn_close).setOnClickListener {
            d.dismiss()
            b.etAmount.text?.clear()
            loadAll()
        }
        d.show()
    }

    private fun showErr(m: String) {
        if (_b == null) return
        b.tvError.text = m
        b.tvError.visibility = View.VISIBLE
    }

    private fun toast(m: String) = Toast.makeText(requireContext(), m, Toast.LENGTH_SHORT).show()

    inner class HistoryAdapter(private val items: List<MerchantTransfer>) :
        RecyclerView.Adapter<HistoryAdapter.VH>() {
        inner class VH(v: View) : RecyclerView.ViewHolder(v) {
            val icon   : TextView = v.findViewById(R.id.tv_icon)
            val title  : TextView = v.findViewById(R.id.tv_title)
            val sub    : TextView = v.findViewById(R.id.tv_subtitle)
            val amount : TextView = v.findViewById(R.id.tv_amount)
            val status : TextView = v.findViewById(R.id.tv_status)
        }
        override fun onCreateViewHolder(p: ViewGroup, t: Int) =
            VH(LayoutInflater.from(p.context).inflate(R.layout.item_transfer, p, false))
        override fun onBindViewHolder(h: VH, pos: Int) {
            val t = items[pos]
            h.icon.text  = t.destIcon
            h.title.text = t.destLabel
            h.sub.text   = "${t.reference} · ${(t.createdAt ?: "").take(10)}"
            h.amount.text = "- ${fmt.format(t.amount)} XAF"
            h.amount.setTextColor(Color.parseColor("#c47000"))
            h.status.text = t.statusLabel
            h.status.setTextColor(Color.parseColor(t.statusColor))
        }
        override fun getItemCount() = items.size
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
