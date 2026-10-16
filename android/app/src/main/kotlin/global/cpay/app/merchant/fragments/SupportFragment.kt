package global.cpay.app.merchant.fragments

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.ApiErrors
import global.cpay.app.common.Ticket
import global.cpay.app.common.ui.Fmt
import global.cpay.app.common.ui.StatusUi
import global.cpay.app.databinding.FragmentSupportBinding
import global.cpay.app.merchant.MerchantMainActivity
import kotlinx.coroutines.launch

/** Support (WAVE-5) : e-mail, demandes (GET/POST /merchant/support/tickets). */
class SupportFragment : Fragment() {

    private var _b: FragmentSupportBinding? = null
    private val b get() = _b!!
    private val tickets = mutableListOf<Ticket>()
    private val adapter = TicketAdapter()
    private val act: MerchantMainActivity? get() = activity as? MerchantMainActivity

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentSupportBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        b.header.tvScreenTitle.text = getString(R.string.support_title)
        b.header.btnBack.setOnClickListener { act?.pop() }
        b.rvTickets.layoutManager = LinearLayoutManager(context)
        b.rvTickets.adapter = adapter
        b.btnEmail.setOnClickListener {
            try {
                startActivity(Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:" + getString(R.string.support_email))))
            } catch (_: Exception) { Toast.makeText(requireContext(), R.string.support_no_mail_app, Toast.LENGTH_SHORT).show() }
        }
        b.btnNewTicket.setOnClickListener { showNewTicket() }
        load()
    }

    private fun load() {
        b.progressBar.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.merchantTickets()
                if (_b == null) return@launch
                if (r.isSuccessful) {
                    tickets.clear(); tickets.addAll(r.body()?.data ?: emptyList())
                    adapter.notifyDataSetChanged()
                }
            } catch (_: Exception) {
            } finally {
                if (_b != null) {
                    b.progressBar.visibility = View.GONE
                    b.tvEmpty.visibility = if (tickets.isEmpty()) View.VISIBLE else View.GONE
                }
            }
        }
    }

    private fun showNewTicket() {
        val ctx = requireContext()
        val dlg = BottomSheetDialog(ctx)
        val v = LayoutInflater.from(ctx).inflate(R.layout.sheet_new_ticket, null, false)
        val etSubject = v.findViewById<TextInputEditText>(R.id.et_subject)
        val etMessage = v.findViewById<TextInputEditText>(R.id.et_message)
        val btn = v.findViewById<MaterialButton>(R.id.btn_send)
        btn.setOnClickListener {
            val subject = etSubject.text?.toString()?.trim() ?: ""
            val message = etMessage.text?.toString()?.trim() ?: ""
            if (subject.isEmpty() || message.isEmpty()) { Toast.makeText(ctx, R.string.support_fields_required, Toast.LENGTH_SHORT).show(); return@setOnClickListener }
            btn.isEnabled = false
            viewLifecycleOwner.lifecycleScope.launch {
                try {
                    val r = ApiClient.api.merchantCreateTicket(mapOf("subject" to subject, "message" to message))
                    if (r.isSuccessful) {
                        Toast.makeText(ctx, R.string.support_sent, Toast.LENGTH_LONG).show()
                        dlg.dismiss(); load()
                    } else {
                        Toast.makeText(ctx, ApiErrors.message(r, getString(R.string.error_generic)), Toast.LENGTH_LONG).show()
                        btn.isEnabled = true
                    }
                } catch (e: Exception) {
                    Toast.makeText(ctx, R.string.network_error, Toast.LENGTH_SHORT).show()
                    btn.isEnabled = true
                }
            }
        }
        dlg.setContentView(v)
        dlg.show()
    }

    inner class TicketAdapter : RecyclerView.Adapter<TicketAdapter.VH>() {
        inner class VH(v: View) : RecyclerView.ViewHolder(v) {
            val subject: TextView = v.findViewById(R.id.tv_subject)
            val status: TextView = v.findViewById(R.id.tv_status)
            val message: TextView = v.findViewById(R.id.tv_message)
            val date: TextView = v.findViewById(R.id.tv_date)
        }
        override fun onCreateViewHolder(p: ViewGroup, t: Int) =
            VH(LayoutInflater.from(p.context).inflate(R.layout.item_ticket, p, false))
        override fun onBindViewHolder(h: VH, pos: Int) {
            val t = tickets[pos]
            h.subject.text = t.subject
            h.message.text = t.message ?: ""
            h.message.visibility = if (t.message.isNullOrBlank()) View.GONE else View.VISIBLE
            h.date.text = Fmt.dateTime(t.createdAt)
            StatusUi.bindChip(h.status, when (t.status) { "open" -> "pending"; "closed", "resolved" -> "completed"; else -> t.status })
            h.status.text = t.status
        }
        override fun getItemCount() = tickets.size
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
