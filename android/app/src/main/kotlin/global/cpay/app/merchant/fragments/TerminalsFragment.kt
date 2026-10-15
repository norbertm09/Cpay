package global.cpay.app.merchant.fragments

import android.graphics.Color
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
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.Terminal
import global.cpay.app.databinding.FragmentTerminalsBinding
import kotlinx.coroutines.launch

class TerminalsFragment : Fragment() {

    private var _b: FragmentTerminalsBinding? = null
    private val b get() = _b!!

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentTerminalsBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        b.rvTerminals.layoutManager = LinearLayoutManager(context)
        b.btnAdd.setOnClickListener     { toggle() }
        b.btnConfirmAdd.setOnClickListener { create() }
        b.btnCancelAdd.setOnClickListener  { toggle() }
        load()
    }

    private fun toggle() {
        val show = b.layoutAddForm.visibility != View.VISIBLE
        b.layoutAddForm.visibility = if (show) View.VISIBLE else View.GONE
        b.btnAdd.visibility        = if (show) View.GONE else View.VISIBLE
        if (!show) { b.etLabel.text?.clear(); b.etSerial.text?.clear() }
    }

    private fun load() {
        b.progressBar.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.merchantTerminals()
                if (r.isSuccessful && r.body() != null) {
                    val list = r.body()!!.data
                    b.tvCount.text = "${list.size} terminal(aux)"
                    b.rvTerminals.adapter = TerminalAdapter(list) { del(it) }
                    b.tvEmpty.visibility = if (list.isEmpty()) View.VISIBLE else View.GONE
                }
            } catch (e: Exception) {
                b.tvEmpty.visibility = View.VISIBLE
            } finally { if (_b != null) b.progressBar.visibility = View.GONE }
        }
    }

    private fun create() {
        val label  = b.etLabel.text.toString().trim()
        val serial = b.etSerial.text.toString().trim()
        if (label.isEmpty()) { toast("Nom requis"); return }
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val body = mutableMapOf("label" to label)
                if (serial.isNotEmpty()) body["serial"] = serial
                val r = ApiClient.api.merchantCreateTerminal(body)
                if (r.isSuccessful) { toast("Terminal ajouté ✅"); toggle(); load() }
                else toast(r.errorBody()?.string() ?: "Erreur")
            } catch (e: Exception) { toast("Erreur réseau") }
        }
    }

    private fun del(t: Terminal) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                ApiClient.api.merchantDeleteTerminal(t.terminalId)
                toast("Terminal supprimé"); load()
            } catch (e: Exception) { toast("Erreur") }
        }
    }

    private fun toast(m: String) = Toast.makeText(requireContext(), m, Toast.LENGTH_SHORT).show()

    inner class TerminalAdapter(
        private val items: List<Terminal>,
        private val onDelete: (Terminal) -> Unit,
    ) : RecyclerView.Adapter<TerminalAdapter.VH>() {

        inner class VH(v: View) : RecyclerView.ViewHolder(v) {
            val label  : TextView = v.findViewById(R.id.tv_label)
            val serial : TextView = v.findViewById(R.id.tv_serial)
            val status : TextView = v.findViewById(R.id.tv_status)
            val del    : TextView = v.findViewById(R.id.btn_delete)
        }

        override fun onCreateViewHolder(p: ViewGroup, t: Int) =
            VH(LayoutInflater.from(p.context).inflate(R.layout.item_terminal, p, false))

        override fun onBindViewHolder(h: VH, pos: Int) {
            val t = items[pos]
            h.label.text  = t.label ?: "Terminal"
            h.serial.text = t.serial ?: t.terminalId.take(8)
            val active = t.status == "active"
            h.status.text = if (active) "● Actif" else "● ${t.status}"
            h.status.setTextColor(Color.parseColor(if (active) "#007a5a" else "#c47000"))
            h.del.setOnClickListener { onDelete(t) }
        }

        override fun getItemCount() = items.size
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
