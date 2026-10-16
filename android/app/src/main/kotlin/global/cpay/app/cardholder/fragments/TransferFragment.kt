package global.cpay.app.cardholder.fragments

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
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import global.cpay.app.R
import global.cpay.app.common.*
import global.cpay.app.databinding.FragmentTransferBinding
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

class TransferFragment : Fragment() {

    private var _b: FragmentTransferBinding? = null
    private val b get() = _b!!
    private val fmt = NumberFormat.getNumberInstance(Locale.FRANCE)

    private var sources      = listOf<TransferSource>()
    private var accounts     = listOf<BankAccount>()
    private var institutions = listOf<Institution>()

    private var selSource: TransferSource? = null
    private var selAccount: BankAccount?   = null
    private var selInst: Institution?      = null
    private var direction = "to_bank"
    private var country   = "CG"
    private var addMode   = "bank"   // bank | wallet

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentTransferBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        b.btnAddSource.setOnClickListener  { showWalletForm() }
        b.btnAddAccount.setOnClickListener { showBankForm() }

        b.btnDirTo.setOnClickListener   { setDirection("to_bank") }
        b.btnDirFrom.setOnClickListener { setDirection("from_bank") }

        b.btnCountryCg.setOnClickListener { selCountry("CG") }
        b.btnCountryCm.setOnClickListener { selCountry("CM") }

        b.btnOpMtn.setOnClickListener    { selOperator("mtn") }
        b.btnOpAirtel.setOnClickListener { selOperator("airtel") }

        b.btnCancelForm.setOnClickListener  { hideForm() }
        b.btnConfirmForm.setOnClickListener { submitForm() }

        b.btnTransfer.setOnClickListener { doTransfer() }

        loadAll()
    }

    // ═══════════ CHARGEMENT ═══════════
    private fun loadAll() {
        b.progressBar.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            val list = mutableListOf<TransferSource>()

            // Cartes créées
            try {
                val rc = ApiClient.api.cardholderCreatedCards()
                if (rc.isSuccessful && rc.body() != null) {
                    rc.body()!!.data.filter { it.status == "active" }.forEach {
                        list.add(TransferSource(
                            type = "card",
                            id = it.cardId,
                            label = it.label,
                            subtitle = "${it.cardMasked ?: ""} · ${fmt.format(it.balance)} XAF",
                            icon = "💳",
                            balance = it.balance))
                    }
                }
            } catch (e: Exception) { }

            // Wallets
            try {
                val rw = ApiClient.api.wallets()
                if (rw.isSuccessful && rw.body() != null) {
                    rw.body()!!.data.forEach {
                        list.add(TransferSource(
                            type = "wallet",
                            id = it.walletId,
                            label = it.label,
                            subtitle = "${it.operator.uppercase()} · +${it.phone}",
                            icon = it.icon))
                    }
                }
            } catch (e: Exception) { }

            sources = list
            renderSources()

            // Comptes bancaires
            try {
                val ra = ApiClient.api.bankAccounts()
                if (ra.isSuccessful && ra.body() != null) {
                    accounts = ra.body()!!.data
                    renderAccounts()
                }
            } catch (e: Exception) { }

            if (_b != null) {
                b.progressBar.visibility = View.GONE
                updateButton()
            }
        }
    }

    private fun renderSources() {
        if (sources.isEmpty()) {
            b.tvNoSource.visibility = View.VISIBLE
            b.spinnerSource.visibility = View.GONE
            return
        }
        b.tvNoSource.visibility = View.GONE
        b.spinnerSource.visibility = View.VISIBLE

        selSource = sources[0]
        val labels = sources.map { "${it.icon}  ${it.label} — ${it.subtitle}" }
        val ad = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, labels)
        ad.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        b.spinnerSource.adapter = ad
        b.spinnerSource.onItemSelectedListener =
            object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onItemSelected(p: android.widget.AdapterView<*>?, v: View?, pos: Int, id: Long) {
                    selSource = sources[pos]
                    updateHint()
                }
                override fun onNothingSelected(p: android.widget.AdapterView<*>?) {}
            }
        updateHint()
    }

    private fun renderAccounts() {
        if (accounts.isEmpty()) {
            b.tvNoAccount.visibility = View.VISIBLE
            b.spinnerAccount.visibility = View.GONE
            return
        }
        b.tvNoAccount.visibility = View.GONE
        b.spinnerAccount.visibility = View.VISIBLE

        selAccount = accounts.firstOrNull { it.isDefault } ?: accounts[0]
        val labels = accounts.map {
            val flag = if (it.institution?.country == "CM") "🇨🇲" else "🇨🇬"
            val ic = when (it.institution?.type) {
                "microfinance" -> "🏛️"
                else           -> "🏦"
            }
            "$ic  ${it.institution?.name ?: "?"} $flag — ${it.accountNumber}"
        }
        val ad = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, labels)
        ad.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        b.spinnerAccount.adapter = ad
        b.spinnerAccount.onItemSelectedListener =
            object : android.widget.AdapterView.OnItemSelectedListener {
                override fun onItemSelected(p: android.widget.AdapterView<*>?, v: View?, pos: Int, id: Long) {
                    selAccount = accounts[pos]
                }
                override fun onNothingSelected(p: android.widget.AdapterView<*>?) {}
            }
    }

    private fun updateHint() {
        val s = selSource ?: return
        b.tvHint.text = when {
            s.type == "wallet" && direction == "to_bank" ->
                "📲 Vous devrez confirmer sur votre téléphone"
            s.type == "wallet" ->
                "📲 Les fonds arriveront sur votre Mobile Money"
            else -> "💳 Débit immédiat depuis votre carte"
        }
    }

    private fun setDirection(d: String) {
        direction = d
        val on = Color.parseColor("#1d4f92"); val off = Color.parseColor("#5a6677")
        val isTo = d == "to_bank"
        b.btnDirTo.setTextColor(if (isTo) on else off)
        b.btnDirTo.setTypeface(null, if (isTo) Typeface.BOLD else Typeface.NORMAL)
        b.btnDirFrom.setTextColor(if (!isTo) on else off)
        b.btnDirFrom.setTypeface(null, if (!isTo) Typeface.BOLD else Typeface.NORMAL)
        b.tvSourceLabel.text  = if (isTo) "Depuis" else "Vers"
        b.tvAccountLabel.text = if (isTo) "Vers le compte" else "Depuis le compte"
        updateHint()
        updateButton()
    }

    private fun updateButton() {
        val ok = sources.isNotEmpty() && accounts.isNotEmpty()
        b.btnTransfer.isEnabled = ok
        b.btnTransfer.alpha = if (ok) 1f else 0.4f
        b.btnTransfer.text = if (direction == "to_bank")
            "💸  Transférer vers la banque" else "💸  Recevoir de la banque"
    }

    // ═══════════ FORMULAIRES ═══════════
    private fun showWalletForm() {
        addMode = "wallet"
        b.layoutForm.visibility = View.VISIBLE
        b.tvFormTitle.text = "📱 Ajouter un Mobile Money"
        b.layoutWalletFields.visibility = View.VISIBLE
        b.layoutBankFields.visibility   = View.GONE
        selOperator("mtn")
    }

    private fun showBankForm() {
        addMode = "bank"
        b.layoutForm.visibility = View.VISIBLE
        b.tvFormTitle.text = "🏦 Ajouter un compte bancaire"
        b.layoutWalletFields.visibility = View.GONE
        b.layoutBankFields.visibility   = View.VISIBLE
        selCountry("CG")
    }

    private fun hideForm() {
        b.layoutForm.visibility = View.GONE
        b.etWalletPhone.text?.clear()
        b.etAccountNumber.text?.clear()
        b.etAccountName.text?.clear()
        b.etIban.text?.clear()
    }

    private fun selOperator(op: String) {
        val on = Color.parseColor("#1d4f92"); val off = Color.parseColor("#5a6677")
        b.btnOpMtn.setTextColor(if (op == "mtn") on else off)
        b.btnOpMtn.setTypeface(null, if (op == "mtn") Typeface.BOLD else Typeface.NORMAL)
        b.btnOpAirtel.setTextColor(if (op == "airtel") on else off)
        b.btnOpAirtel.setTypeface(null, if (op == "airtel") Typeface.BOLD else Typeface.NORMAL)
        b.btnOpMtn.tag = if (op == "mtn") "sel" else null
    }

    private fun currentOperator() = if (b.btnOpMtn.tag == "sel") "mtn" else "airtel"

    private fun selCountry(c: String) {
        country = c
        val on = Color.parseColor("#1d4f92"); val off = Color.parseColor("#5a6677")
        b.btnCountryCg.setTextColor(if (c == "CG") on else off)
        b.btnCountryCg.setTypeface(null, if (c == "CG") Typeface.BOLD else Typeface.NORMAL)
        b.btnCountryCm.setTextColor(if (c == "CM") on else off)
        b.btnCountryCm.setTypeface(null, if (c == "CM") Typeface.BOLD else Typeface.NORMAL)
        loadInstitutions()
    }

    private fun loadInstitutions() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.institutions(country = country)
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
        if (addMode == "wallet") addWallet() else addBankAccount()
    }

    private fun addWallet() {
        val phone = b.etWalletPhone.text.toString().replace(" ", "").replace("+", "").trim()
        if (phone.length < 9) { toast("Numéro invalide"); return }

        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.addWallet(mapOf(
                    "operator" to currentOperator(),
                    "phone"    to phone,
                    "label"    to currentOperator().uppercase(),
                    "country"  to country))
                if (r.isSuccessful) {
                    toast("Mobile Money ajouté ✅")
                    hideForm(); loadAll()
                } else toast(r.errorBody()?.string() ?: "Erreur")
            } catch (e: Exception) { toast("Erreur réseau") }
        }
    }

    private fun addBankAccount() {
        val inst = selInst ?: run { toast("Choisissez une institution"); return }
        val num  = b.etAccountNumber.text.toString().trim()
        val name = b.etAccountName.text.toString().trim()
        if (num.length < 5) { toast("Numéro de compte invalide"); return }
        if (name.isEmpty()) { toast("Nom du titulaire requis"); return }

        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val body = mutableMapOf(
                    "institutionId" to inst.institutionId,
                    "accountNumber" to num,
                    "accountName"   to name)
                val iban = b.etIban.text.toString().trim()
                if (iban.isNotEmpty()) body["iban"] = iban

                val r = ApiClient.api.addBankAccount(body)
                if (r.isSuccessful) {
                    toast("Compte ajouté ✅")
                    hideForm(); loadAll()
                } else toast(r.errorBody()?.string() ?: "Erreur")
            } catch (e: Exception) { toast("Erreur réseau") }
        }
    }

    // ═══════════ TRANSFERT ═══════════
    private fun doTransfer() {
        val src = selSource ?: run { toast("Choisissez une source"); return }
        val acc = selAccount ?: run { toast("Choisissez un compte"); return }
        val amt = b.etAmount.text.toString().replace(" ", "").toDoubleOrNull()

        if (amt == null || amt < 500) { showError("Montant minimum 500 XAF"); return }
        if (src.type == "card" && direction == "to_bank" && (src.balance ?: 0.0) < amt) {
            showError("Solde insuffisant (${fmt.format(src.balance ?: 0.0)} XAF)"); return
        }

        b.tvError.visibility = View.GONE
        b.btnTransfer.isEnabled = false
        b.progressBar.visibility = View.VISIBLE

        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val body = mutableMapOf<String, Any>(
                    "direction"  to direction,
                    "sourceType" to src.type,
                    "accountId"  to acc.accountId,
                    "amount"     to amt)
                if (src.type == "wallet") body["sourceId"] = src.id

                val r = ApiClient.api.transferInitiate(body)
                if (!r.isSuccessful || r.body() == null) {
                    showError(parseError(r.errorBody()?.string()))
                    return@launch
                }

                val init = r.body()!!
                if (init.requiresConfirmation) {
                    showWaitingDialog(init)
                } else {
                    pollUntilDone(init.transferId, null)
                }
            } catch (e: Exception) {
                showError("Erreur réseau")
            } finally {
                if (_b != null) {
                    b.btnTransfer.isEnabled = true
                    b.progressBar.visibility = View.GONE
                }
            }
        }
    }

    private fun showWaitingDialog(init: TransferInitResponse) {
        val d = Dialog(requireContext())
        d.requestWindowFeature(Window.FEATURE_NO_TITLE)
        d.setContentView(R.layout.dialog_transfer_waiting)
        d.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        d.setCancelable(false)

        val tvCount = d.findViewById<TextView>(R.id.tv_countdown)
        val tvAmt   = d.findViewById<TextView>(R.id.tv_amount)
        tvAmt.text  = "${fmt.format(init.amount)} XAF"
        d.show()

        viewLifecycleOwner.lifecycleScope.launch {
            var sec = 90
            var done = false
            while (sec > 0 && !done) {
                tvCount.text = "⏳ ${sec}s"
                delay(3000)
                sec -= 3
                try {
                    val s = ApiClient.api.transferStatus(init.transferId)
                    if (s.isSuccessful && s.body() != null) {
                        val st = s.body()!!
                        if (st.isDone || st.isFailed) {
                            done = true
                            d.dismiss()
                            showResultDialog(st)
                        }
                    }
                } catch (e: Exception) { }
            }
            if (!done) {
                d.dismiss()
                showError("Délai dépassé — vérifiez l'historique")
            }
        }
    }

    private suspend fun pollUntilDone(transferId: String, dialog: Dialog?) {
        repeat(20) {
            delay(2000)
            try {
                val s = ApiClient.api.transferStatus(transferId)
                if (s.isSuccessful && s.body() != null) {
                    val st = s.body()!!
                    if (st.isDone || st.isFailed) {
                        dialog?.dismiss()
                        showResultDialog(st)
                        return
                    }
                }
            } catch (e: Exception) { }
        }
        dialog?.dismiss()
        showError("Traitement en cours — vérifiez l'historique")
    }

    private fun showResultDialog(st: TransferStatus) {
        if (_b == null) return
        val d = Dialog(requireContext())
        d.requestWindowFeature(Window.FEATURE_NO_TITLE)
        d.setContentView(R.layout.dialog_transfer_result)
        d.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))

        val icon  = d.findViewById<TextView>(R.id.tv_icon)
        val title = d.findViewById<TextView>(R.id.tv_title)
        val amt   = d.findViewById<TextView>(R.id.tv_amount)
        val det   = d.findViewById<TextView>(R.id.tv_details)
        val btn   = d.findViewById<TextView>(R.id.btn_close)

        if (st.isDone) {
            icon.text  = "✅"
            title.text = "Transfert effectué"
            title.setTextColor(Color.parseColor("#007a5a"))
            amt.text   = "${fmt.format(st.amount)} XAF"
            det.text   = buildString {
                append(if (st.direction == "to_bank") "Vers " else "Depuis ")
                append(st.institution ?: "la banque")
                append("\nRéf: ${st.reference}")
                append("\n\n⏱️ Crédit sous 24-48h ouvrées")
            }
        } else {
            icon.text  = "❌"
            title.text = "Transfert échoué"
            title.setTextColor(Color.parseColor("#c53030"))
            amt.text   = "${fmt.format(st.amount)} XAF"
            det.text   = st.error ?: "Une erreur est survenue"
        }

        btn.setOnClickListener {
            d.dismiss()
            b.etAmount.text?.clear()
            loadAll()
        }
        d.show()
    }

    private fun parseError(body: String?): String {
        if (body == null) return "Erreur"
        return try {
            val json = org.json.JSONObject(body)
            when (json.optString("code")) {
                "NO_GTP_CARD" -> "Aucune carte GTP — émettez-en une dans l'onglet Cartes"
                else          -> json.optString("error", "Erreur")
            }
        } catch (e: Exception) { "Erreur" }
    }

    private fun showError(m: String) {
        if (_b == null) return
        b.tvError.text = m
        b.tvError.visibility = View.VISIBLE
    }

    private fun toast(m: String) = Toast.makeText(requireContext(), m, Toast.LENGTH_SHORT).show()

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
