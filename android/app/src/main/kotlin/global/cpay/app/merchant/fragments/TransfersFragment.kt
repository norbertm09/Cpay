package global.cpay.app.merchant.fragments

import android.app.Dialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.ApiErrors
import global.cpay.app.common.BankAccount
import global.cpay.app.common.BankInstructions
import global.cpay.app.common.SecurityManager
import global.cpay.app.common.Transfer
import global.cpay.app.common.TransferRequest
import global.cpay.app.databinding.FragmentTransfersBinding
import global.cpay.app.merchant.CashSession
import global.cpay.app.merchant.MerchantMainActivity
import global.cpay.app.merchant.StepUp
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

/**
 * Transférer (WAVE-4, docs/CAISSE-API.md §5).
 *  - wallet → banque : compte bancaire vérifié (GET /merchant/bank-accounts), montant,
 *    step-up, POST /merchant/cash/transfers → processing | pending_manual.
 *  - banque → wallet : ordre d'approvisionnement → instructions de virement (banque,
 *    titulaire, compte, IBAN/SWIFT, référence, échéance) avec copie.
 *  - liste GET /merchant/cash/transfers, badges de statut, annulation
 *    (awaiting_funds, pending_manual) via POST …/:id/cancel.
 */
class TransfersFragment : Fragment() {

    private var _b: FragmentTransfersBinding? = null
    private val b get() = _b!!
    private val fmt = NumberFormat.getNumberInstance(Locale.FRANCE)

    private var currency = CashSession.currency
    private var available = CashSession.summary?.available ?: 0.0
    private var transferMin = CashSession.summary?.limits?.transferMin ?: 1000.0
    private var direction = "wallet_to_bank"
    private var accounts: List<BankAccount> = emptyList()
    private var selAccount: BankAccount? = null
    private var transfers: List<Transfer> = emptyList()
    private var featureDisabled = false

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentTransfersBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        b.rvTransfers.layoutManager = LinearLayoutManager(context)
        b.tabToBank.setOnClickListener   { setDirection("wallet_to_bank") }
        b.tabToWallet.setOnClickListener { setDirection("bank_to_wallet") }
        b.btnManageAccounts.setOnClickListener { (activity as? MerchantMainActivity)?.openBankAccounts() }
        b.btnTransferBank.setOnClickListener { submit("wallet_to_bank") }
        b.btnFund.setOnClickListener         { submit("bank_to_wallet") }
        b.btnRefreshList.setOnClickListener  { loadTransfers() }
        b.btnCloseInstr.setOnClickListener   { b.layoutInstructions.visibility = View.GONE }
        b.spinnerAccount.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: View?, pos: Int, id: Long) { selAccount = accounts.getOrNull(pos) }
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }
        b.tvAvailable.text = "Disponible : ${money(available)}"
        setDirection(direction)
        load()
    }

    private fun money(v: Double?) = "${fmt.format(v ?: 0.0)} $currency"

    private fun setDirection(d: String) {
        direction = d
        val toBank = d == "wallet_to_bank"
        b.tabToBank.setTextColor(Color.parseColor(if (toBank) "#12b6c7" else "#5a6677"))
        b.tabToBank.setTypeface(null, if (toBank) Typeface.BOLD else Typeface.NORMAL)
        b.tabToWallet.setTextColor(Color.parseColor(if (!toBank) "#12b6c7" else "#5a6677"))
        b.tabToWallet.setTypeface(null, if (!toBank) Typeface.BOLD else Typeface.NORMAL)
        b.layoutToBank.visibility   = if (toBank) View.VISIBLE else View.GONE
        b.layoutToWallet.visibility = if (toBank) View.GONE else View.VISIBLE
        b.tvError.visibility = View.GONE
    }

    private fun load() {
        b.progressBar.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val rs = ApiClient.api.cashSummary()
                if (_b == null) return@launch
                val s = rs.body()
                if (rs.isSuccessful && s != null) {
                    CashSession.summary = s
                    currency = s.cur; available = s.available
                    s.limits?.transferMin?.let { transferMin = it }
                    b.tvAvailable.text = "Disponible : ${money(available)}"
                } else if (ApiErrors.isFeatureDisabled(rs)) {
                    featureDisabled = true
                    showErr(ApiErrors.FEATURE_DISABLED_MESSAGE)
                }
            } catch (_: Exception) {}
            try {
                val ra = ApiClient.api.merchantBankAccounts()
                if (_b == null) return@launch
                if (ra.isSuccessful) accounts = (ra.body()?.data ?: emptyList()).filter { it.isVerified }
            } catch (_: Exception) {}
            if (_b == null) return@launch
            renderAccounts()
            loadTransfers()
        }
    }

    private fun renderAccounts() {
        if (accounts.isEmpty()) {
            b.tvNoAccount.visibility = View.VISIBLE
            b.spinnerAccount.visibility = View.GONE
            selAccount = null
            return
        }
        b.tvNoAccount.visibility = View.GONE
        b.spinnerAccount.visibility = View.VISIBLE
        val labels = accounts.map { "🏦 ${it.displayBank} — ${it.displayNumber} · ${it.accountName}" }
        val ad = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, labels)
        ad.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        b.spinnerAccount.adapter = ad
        selAccount = accounts.firstOrNull { it.isDefault } ?: accounts[0]
        b.spinnerAccount.setSelection(accounts.indexOfFirst { it === selAccount }.coerceAtLeast(0))
    }

    private fun loadTransfers() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cashTransfers(limit = 20)
                if (_b == null) return@launch
                if (r.isSuccessful) {
                    transfers = r.body()?.data ?: emptyList()
                    b.tvNoTransfers.visibility = if (transfers.isEmpty()) View.VISIBLE else View.GONE
                    b.rvTransfers.adapter = TransferAdapter(transfers)
                }
            } catch (_: Exception) {
            } finally {
                if (_b != null) b.progressBar.visibility = View.GONE
            }
        }
    }

    // ─── Creation ───────────────────────────────────────────────────
    private fun submit(dir: String) {
        if (featureDisabled) { showErr(ApiErrors.FEATURE_DISABLED_MESSAGE); return }
        val toBank = dir == "wallet_to_bank"
        val et = if (toBank) b.etAmountBank else b.etAmountFund
        val amt = et.text.toString().replace(" ", "").replace(",", ".").toDoubleOrNull()
        if (amt == null || amt < transferMin) { showErr("Montant minimum : ${money(transferMin)}"); return }
        val account = selAccount
        if (toBank && account == null) { showErr(getString(R.string.transfers_no_account)); return }
        if (toBank && amt > available) { showErr("Solde insuffisant — disponible : ${money(available)}"); return }
        val desc = (if (toBank) b.etDescBank else b.etDescFund).text.toString().trim()
        val idem = SecurityManager.generateRef("IDK")
        val ctx = requireContext()
        val title = if (toBank) "Transfert de ${money(amt)} vers la banque" else "Approvisionnement de ${money(amt)}"

        b.tvError.visibility = View.GONE
        b.progressBar.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = StepUp.run(ctx, title) { confirm ->
                    ApiClient.api.cashTransferCreate(idem, TransferRequest(
                        direction = dir, amount = amt, accountId = if (toBank) account?.accountId else null,
                        description = desc.ifEmpty { null }, confirm = confirm))
                }
                if (_b == null || r == null) return@launch
                val t = r.body()
                if (r.isSuccessful && t != null) {
                    et.text?.clear()
                    if (t.instructions != null || (!toBank && t.isFunding)) showInstructions(t) else showResult(t)
                    load()
                } else {
                    val e = ApiErrors.of(r)
                    if (r.code() == 410 || e.code == ApiErrors.FEATURE_DISABLED) featureDisabled = true
                    showErr(ApiErrors.cashMessage(r.code(), e, currency, "Transfert refusé"))
                }
            } catch (e: Exception) {
                if (_b != null) showErr(getString(R.string.network_error))
            } finally {
                if (_b != null) b.progressBar.visibility = View.GONE
            }
        }
    }

    private fun showResult(t: Transfer) {
        val d = Dialog(requireContext())
        d.requestWindowFeature(Window.FEATURE_NO_TITLE)
        d.setContentView(R.layout.dialog_transfer_result)
        d.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        d.findViewById<TextView>(R.id.tv_icon).text = "✅"
        d.findViewById<TextView>(R.id.tv_title).apply {
            text = "Transfert demandé"; setTextColor(Color.parseColor("#007a5a"))
        }
        d.findViewById<TextView>(R.id.tv_amount).text = money(t.net ?: t.amount)
        d.findViewById<TextView>(R.id.tv_details).text = buildString {
            append("Réf : ${t.reference ?: t.transferId}\n")
            append("Statut : ${t.statusLabel}\n")
            t.bankAccount?.let { append("Vers ${it.bankName ?: "banque"} ${it.accountMasked ?: ""}\n") }
            if (t.status == "pending_manual") append("Exécuté par les opérations C-Pay (J+1 ouvré).\n")
            if ((t.fee ?: 0.0) > 0) append("Frais : ${money(t.fee)}")
        }
        d.findViewById<TextView>(R.id.btn_close).setOnClickListener { d.dismiss() }
        d.show()
    }

    // ─── Instructions d'approvisionnement ───────────────────────────
    private fun showInstructions(t: Transfer) {
        val i = t.instructions ?: BankInstructions(reference = t.reference)
        b.tvInstrAmount.text = money(t.amount)
        fun row(row: View, tv: TextView, btn: View, value: String?) {
            if (value.isNullOrBlank()) { row.visibility = View.GONE; return }
            row.visibility = View.VISIBLE
            tv.text = value
            btn.setOnClickListener { copy(value) }
        }
        row(b.rowBank,   b.tvInstrBank,   b.btnCopyBank,   i.bankName)
        row(b.rowName,   b.tvInstrName,   b.btnCopyName,   i.accountName)
        row(b.rowNumber, b.tvInstrNumber, b.btnCopyNumber, i.accountNumber)
        row(b.rowIban,   b.tvInstrIban,   b.btnCopyIban,   i.iban)
        row(b.rowSwift,  b.tvInstrSwift,  b.btnCopySwift,  i.swift)
        row(b.rowRef,    b.tvInstrRef,    b.btnCopyRef,    i.reference ?: t.reference)
        val exp = i.expiresAt
        b.tvInstrExpiry.text = if (exp.isNullOrBlank()) "" else "À virer avant le ${exp.take(16).replace("T", " à ")}"
        b.btnCopyAll.setOnClickListener {
            copy(buildString {
                append("Virement C-Pay ${money(t.amount)}\n")
                i.bankName?.let { append("Banque : $it\n") }
                i.accountName?.let { append("Titulaire : $it\n") }
                i.accountNumber?.let { append("Compte : $it\n") }
                i.iban?.let { append("IBAN : $it\n") }
                i.swift?.let { append("SWIFT : $it\n") }
                append("Référence : ${i.reference ?: t.reference ?: ""}")
            })
        }
        b.layoutInstructions.visibility = View.VISIBLE
        b.root.post { b.root.smoothScrollTo(0, 0) }
    }

    private fun copy(text: String) {
        val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("C-Pay", text))
        toast("Copié")
    }

    // ─── Annulation ─────────────────────────────────────────────────
    private fun cancelTransfer(t: Transfer) {
        AlertDialog.Builder(requireContext())
            .setTitle("Annuler ce transfert ?")
            .setMessage("${t.reference ?: t.transferId} — ${money(t.amount)}")
            .setNegativeButton("Non", null)
            .setPositiveButton("Oui, annuler") { _, _ ->
                viewLifecycleOwner.lifecycleScope.launch {
                    try {
                        val r = ApiClient.api.cashTransferCancel(t.transferId)
                        if (_b == null) return@launch
                        if (r.isSuccessful) { toast("Transfert annulé"); load() }
                        else showErr(ApiErrors.cashMessage(r, currency, "Annulation impossible"))
                    } catch (e: Exception) { if (_b != null) showErr(getString(R.string.network_error)) }
                }
            }
            .show()
    }

    private fun showErr(m: String) {
        if (_b == null) return
        b.tvError.text = m; b.tvError.visibility = View.VISIBLE
    }
    private fun toast(m: String) = Toast.makeText(requireContext(), m, Toast.LENGTH_SHORT).show()

    inner class TransferAdapter(private val items: List<Transfer>) : RecyclerView.Adapter<TransferAdapter.VH>() {
        inner class VH(v: View) : RecyclerView.ViewHolder(v) {
            val icon: TextView = v.findViewById(R.id.tv_icon)
            val title: TextView = v.findViewById(R.id.tv_title)
            val sub: TextView = v.findViewById(R.id.tv_subtitle)
            val amount: TextView = v.findViewById(R.id.tv_amount)
            val status: TextView = v.findViewById(R.id.tv_status)
            val actions: View = v.findViewById(R.id.layout_actions)
            val btnInstr: TextView = v.findViewById(R.id.btn_instructions)
            val btnCancel: TextView = v.findViewById(R.id.btn_cancel)
        }
        override fun onCreateViewHolder(p: ViewGroup, t: Int) =
            VH(LayoutInflater.from(p.context).inflate(R.layout.item_cash_transfer, p, false))
        override fun onBindViewHolder(h: VH, pos: Int) {
            val t = items[pos]
            h.icon.text = if (t.isFunding) "💰" else "🏦"
            h.title.text = t.title
            h.sub.text = "${t.reference ?: t.transferId} · ${(t.createdAt ?: "").take(16).replace("T", " ")}"
            h.amount.text = (if (t.isFunding) "+ " else "- ") + fmt.format(t.amount) + " " + (t.currency ?: currency)
            h.amount.setTextColor(Color.parseColor(if (t.isFunding) "#007a5a" else "#c47000"))
            h.status.text = t.statusLabel
            h.status.setTextColor(Color.parseColor(t.statusColor))
            h.status.setBackgroundColor(Color.parseColor(t.statusColor + "1A"))
            val showInstr = t.instructions != null && t.status == "awaiting_funds"
            h.btnInstr.visibility = if (showInstr) View.VISIBLE else View.GONE
            h.btnCancel.visibility = if (t.canCancel) View.VISIBLE else View.GONE
            h.actions.visibility = if (showInstr || t.canCancel) View.VISIBLE else View.GONE
            h.btnInstr.setOnClickListener { showInstructions(t) }
            h.btnCancel.setOnClickListener { cancelTransfer(t) }
        }
        override fun getItemCount() = items.size
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
