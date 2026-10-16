package global.cpay.app.merchant.fragments

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.ApiErrors
import global.cpay.app.common.BankAccount
import global.cpay.app.common.BankInstructions
import global.cpay.app.common.SecurityManager
import global.cpay.app.common.Transfer
import global.cpay.app.common.TransferRequest
import global.cpay.app.common.ui.Fmt
import global.cpay.app.common.ui.ResultSheet
import global.cpay.app.common.ui.StatusUi
import global.cpay.app.databinding.FragmentTransfersBinding
import global.cpay.app.merchant.CashSession
import global.cpay.app.merchant.MerchantMainActivity
import global.cpay.app.merchant.StepUp
import kotlinx.coroutines.launch

/**
 * Transferer (WAVE-5, docs/CAISSE-API.md §5).
 *  - wallet → banque : compte verifie (GET /merchant/bank-accounts), montant, step-up,
 *    POST /merchant/cash/transfers → feuille de resultat (processing | pending_manual).
 *  - banque → wallet : ordre d'approvisionnement (sans confirmation forte, §5) →
 *    feuille d'instructions de virement avec copie par champ / tout copier.
 *  - liste GET /merchant/cash/transfers : puces de statut, detail (instructions, annulation).
 */
class TransfersFragment : Fragment() {

    private var _b: FragmentTransfersBinding? = null
    private val b get() = _b!!

    private var currency = CashSession.currency
    private var available = CashSession.summary?.available ?: 0.0
    private var transferMin = CashSession.summary?.limits?.transferMin ?: 1000.0
    private var direction = "wallet_to_bank"
    private var accounts: List<BankAccount> = emptyList()
    private var selAccount: BankAccount? = null
    private val transfers = mutableListOf<Transfer>()
    private var featureDisabled = false
    private val adapter = TransferAdapter()

    private val act: MerchantMainActivity? get() = activity as? MerchantMainActivity

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentTransfersBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        b.header.tvScreenTitle.text = getString(R.string.transfers_title)
        b.header.btnBack.setOnClickListener { act?.pop() }
        b.rvTransfers.layoutManager = LinearLayoutManager(context)
        b.rvTransfers.adapter = adapter
        b.toggleDirection.addOnButtonCheckedListener { _, checkedId, isChecked ->
            if (isChecked) setDirection(if (checkedId == R.id.tab_to_bank) "wallet_to_bank" else "bank_to_wallet")
        }
        b.btnManageAccounts.setOnClickListener { act?.openBankAccounts() }
        b.btnTransferBank.setOnClickListener { submit("wallet_to_bank") }
        b.btnFund.setOnClickListener         { submit("bank_to_wallet") }
        b.btnRefreshList.setOnClickListener  { loadTransfers() }
        b.acAccount.setOnItemClickListener { _, _, pos, _ -> selAccount = accounts.getOrNull(pos) }
        b.tvAvailable.text = getString(R.string.transfers_available_fmt, money(available))
        setDirection(direction)
        load()
    }

    private fun money(v: Double?) = Fmt.money(v, currency)

    private fun setDirection(d: String) {
        direction = d
        val toBank = d == "wallet_to_bank"
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
                    b.tvAvailable.text = getString(R.string.transfers_available_fmt, money(available))
                    b.tilAmountBank.helperText = getString(R.string.transfers_min_fmt, money(transferMin))
                    b.tilAmountFund.helperText = getString(R.string.transfers_min_fmt, money(transferMin))
                } else if (ApiErrors.isFeatureDisabled(rs)) {
                    featureDisabled = true
                    showErr(getString(R.string.feature_disabled))
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
            b.tilAccount.visibility = View.GONE
            selAccount = null
            return
        }
        b.tvNoAccount.visibility = View.GONE
        b.tilAccount.visibility = View.VISIBLE
        val labels = accounts.map { "${it.displayBank} — ${it.displayNumber} · ${it.accountName}" }
        b.acAccount.setAdapter(ArrayAdapter(requireContext(), android.R.layout.simple_list_item_1, labels))
        selAccount = accounts.firstOrNull { it.isDefault } ?: accounts[0]
        b.acAccount.setText(labels[accounts.indexOfFirst { it === selAccount }.coerceAtLeast(0)], false)
    }

    private fun loadTransfers() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cashTransfers(limit = 20)
                if (_b == null) return@launch
                if (r.isSuccessful) {
                    transfers.clear(); transfers.addAll(r.body()?.data ?: emptyList())
                    b.tvNoTransfers.visibility = if (transfers.isEmpty()) View.VISIBLE else View.GONE
                    adapter.notifyDataSetChanged()
                }
            } catch (_: Exception) {
            } finally {
                if (_b != null) b.progressBar.visibility = View.GONE
            }
        }
    }

    // ─── Creation ───────────────────────────────────────────────────
    private fun submit(dir: String) {
        if (featureDisabled) { showErr(getString(R.string.feature_disabled)); return }
        val toBank = dir == "wallet_to_bank"
        val til = if (toBank) b.tilAmountBank else b.tilAmountFund
        val et = if (toBank) b.etAmountBank else b.etAmountFund
        val amt = et.text.toString().replace(" ", "").replace(",", ".").toDoubleOrNull()
        if (amt == null || amt < transferMin) { til.error = getString(R.string.transfers_min_fmt, money(transferMin)); return }
        til.error = null
        val account = selAccount
        if (toBank && account == null) { showErr(getString(R.string.transfers_no_account)); return }
        if (toBank && amt > available) { showErr(getString(R.string.withdraw_insufficient_fmt, money(available))); return }
        val desc = (if (toBank) b.etDescBank else b.etDescFund).text.toString().trim()
        val idem = SecurityManager.generateRef("IDK")
        val ctx = requireContext()

        b.tvError.visibility = View.GONE
        b.progressBar.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val call: suspend (Map<String, String>) -> retrofit2.Response<Transfer> = { confirm ->
                    ApiClient.api.cashTransferCreate(idem, TransferRequest(
                        direction = dir, amount = amt, accountId = if (toBank) account?.accountId else null,
                        description = desc.ifEmpty { null }, confirm = confirm))
                }
                // §5 : aucune confirmation forte pour bank_to_wallet (aucun fonds ne sort).
                val r = if (toBank) StepUp.run(ctx, getString(R.string.transfers_confirm_bank_fmt, money(amt)), call)
                        else call(emptyMap())
                if (_b == null || r == null) return@launch
                val t = r.body()
                if (r.isSuccessful && t != null) {
                    et.text?.clear()
                    if (t.instructions != null || (!toBank && t.isFunding)) showInstructions(t) else showResult(t)
                    load()
                } else {
                    val e = ApiErrors.of(r)
                    if (r.code() == 410 || e.code == ApiErrors.FEATURE_DISABLED) featureDisabled = true
                    showErr(ApiErrors.cashMessage(r.code(), e, currency, getString(R.string.transfers_refused)))
                }
            } catch (e: Exception) {
                if (_b != null) showErr(getString(R.string.network_error))
            } finally {
                if (_b != null) b.progressBar.visibility = View.GONE
            }
        }
    }

    private fun showResult(t: Transfer) {
        val ctx = requireContext()
        ResultSheet.show(ctx, ResultSheet.Spec(
            kind = if (t.status == "failed" || t.status == "rejected") ResultSheet.Kind.ERROR else ResultSheet.Kind.SUCCESS,
            title = getString(R.string.transfers_requested),
            amount = money(t.net ?: t.amount),
            body = when (t.status) {
                "pending_manual" -> getString(R.string.transfers_manual_body)
                "processing"     -> getString(R.string.transfers_processing_body)
                else             -> null
            },
            rows = listOf(
                getString(R.string.reference) to (t.reference ?: t.transferId),
                getString(R.string.status) to StatusUi.statusLabel(ctx, t.status),
                getString(R.string.transfers_instr_bank) to t.bankAccount?.let { "${it.bankName ?: ""} ${it.accountMasked ?: ""}".trim() },
                getString(R.string.fees) to t.fee?.takeIf { it > 0 }?.let { money(it) },
            ),
        ))
    }

    // ─── Instructions d'approvisionnement ───────────────────────────
    private fun showInstructions(t: Transfer) {
        val ctx = requireContext()
        val i = t.instructions ?: BankInstructions(reference = t.reference)
        val dlg = BottomSheetDialog(ctx)
        val v = LayoutInflater.from(ctx).inflate(R.layout.sheet_funding_instructions, null, false)
        v.findViewById<TextView>(R.id.tv_instr_amount).text = money(t.amount)
        val rows = v.findViewById<LinearLayout>(R.id.layout_instr_rows)
        val lines = listOf(
            getString(R.string.transfers_instr_bank) to i.bankName,
            getString(R.string.transfers_instr_holder) to i.accountName,
            getString(R.string.transfers_instr_account) to i.accountNumber,
            getString(R.string.transfers_instr_iban) to i.iban,
            getString(R.string.transfers_instr_swift) to i.swift,
            getString(R.string.transfers_instr_reference) to (i.reference ?: t.reference),
        ).filter { !it.second.isNullOrBlank() }
        lines.forEach { (label, value) ->
            val row = LayoutInflater.from(ctx).inflate(R.layout.item_instruction_row, rows, false)
            row.findViewById<TextView>(R.id.tv_row_label).text = label
            row.findViewById<TextView>(R.id.tv_row_value).text = value
            row.findViewById<MaterialButton>(R.id.btn_row_copy).setOnClickListener { copy(value!!) }
            rows.addView(row)
        }
        val exp = i.expiresAt
        v.findViewById<TextView>(R.id.tv_instr_expiry).text = if (exp.isNullOrBlank()) "" else getString(R.string.transfers_instr_expires_fmt, Fmt.dateTime(exp))
        v.findViewById<MaterialButton>(R.id.btn_copy_all).setOnClickListener {
            copy(buildString {
                append("C-Pay — ${getString(R.string.transfers_instructions)} ${money(t.amount)}\n")
                lines.forEach { (label, value) -> append("$label : $value\n") }
            }.trim())
        }
        v.findViewById<MaterialButton>(R.id.btn_instr_close).setOnClickListener { dlg.dismiss() }
        dlg.setContentView(v)
        dlg.show()
    }

    private fun copy(text: String) {
        val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("C-Pay", text))
        Toast.makeText(requireContext(), R.string.copied, Toast.LENGTH_SHORT).show()
    }

    // ─── Detail / annulation ────────────────────────────────────────
    private fun showDetail(t: Transfer) {
        val ctx = requireContext()
        val hasInstr = t.instructions != null && t.status == "awaiting_funds"
        ResultSheet.show(ctx, ResultSheet.Spec(
            kind = when (t.status) {
                "completed" -> ResultSheet.Kind.SUCCESS
                "failed", "rejected", "cancelled" -> ResultSheet.Kind.ERROR
                else -> ResultSheet.Kind.PENDING
            },
            title = transferTitle(t),
            amount = (if (t.isFunding) "+ " else "- ") + money(t.amount),
            body = if (t.status == "pending_manual") getString(R.string.transfers_manual_body) else null,
            rows = listOf(
                getString(R.string.reference) to (t.reference ?: t.transferId),
                getString(R.string.status) to StatusUi.statusLabel(ctx, t.status),
                getString(R.string.date) to Fmt.dateTime(t.createdAt),
                getString(R.string.fees) to t.fee?.takeIf { it > 0 }?.let { money(it) },
                getString(R.string.description) to t.description,
            ),
            primaryLabel = if (hasInstr) getString(R.string.transfers_instructions) else getString(R.string.close),
            primary = if (hasInstr) ({ showInstructions(t) }) else null,
            secondaryLabel = if (t.canCancel) getString(R.string.transfers_cancel) else null,
            secondary = if (t.canCancel) ({ cancelTransfer(t) }) else null,
        ))
    }

    private fun transferTitle(t: Transfer): String = when {
        t.isFunding -> getString(R.string.transfers_funding_title)
        t.bankAccount != null -> getString(R.string.transfers_bank_title_fmt, t.bankAccount.bankName ?: getString(R.string.method_bank), t.bankAccount.accountMasked ?: "").trim()
        else -> getString(R.string.transfers_to_bank_generic)
    }

    private fun cancelTransfer(t: Transfer) {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.transfers_cancel_confirm_title)
            .setMessage("${t.reference ?: t.transferId} — ${money(t.amount)}")
            .setNegativeButton(R.string.no, null)
            .setPositiveButton(R.string.transfers_cancel_yes) { _, _ ->
                viewLifecycleOwner.lifecycleScope.launch {
                    try {
                        val r = ApiClient.api.cashTransferCancel(t.transferId)
                        if (_b == null) return@launch
                        if (r.isSuccessful) { Toast.makeText(requireContext(), R.string.transfers_cancelled, Toast.LENGTH_SHORT).show(); load() }
                        else showErr(ApiErrors.cashMessage(r, currency, getString(R.string.transfers_cancel_error)))
                    } catch (e: Exception) { if (_b != null) showErr(getString(R.string.network_error)) }
                }
            }
            .show()
    }

    private fun showErr(m: String) {
        if (_b == null) return
        b.tvError.text = m; b.tvError.visibility = View.VISIBLE
        b.scroll.post { b.scroll.smoothScrollTo(0, b.tvError.top) }
    }

    inner class TransferAdapter : RecyclerView.Adapter<TransferAdapter.VH>() {
        inner class VH(v: View) : RecyclerView.ViewHolder(v) {
            val icon: ImageView = v.findViewById(R.id.iv_type)
            val title: TextView = v.findViewById(R.id.tv_title)
            val sub: TextView = v.findViewById(R.id.tv_subtitle)
            val amount: TextView = v.findViewById(R.id.tv_amount)
            val status: TextView = v.findViewById(R.id.tv_status)
        }
        override fun onCreateViewHolder(p: ViewGroup, t: Int) =
            VH(LayoutInflater.from(p.context).inflate(R.layout.item_cash_transfer, p, false))
        override fun onBindViewHolder(h: VH, pos: Int) {
            val t = transfers[pos]
            StatusUi.bindTypeIcon(h.icon, if (t.isFunding) "transfer_in" else "transfer_out")
            h.title.text = transferTitle(t)
            h.sub.text = listOfNotNull(t.reference ?: t.transferId, Fmt.dateTime(t.createdAt).takeIf { it.isNotBlank() }).joinToString(" · ")
            h.amount.text = (if (t.isFunding) "+ " else "- ") + Fmt.money(t.amount, t.currency ?: currency)
            h.amount.setTextColor(ContextCompat.getColor(h.itemView.context, if (t.isFunding) R.color.success_main else R.color.on_surface))
            StatusUi.bindChip(h.status, t.status)
            h.itemView.setOnClickListener { showDetail(t) }
        }
        override fun getItemCount() = transfers.size
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
