package global.cpay.app.merchant.fragments

import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import global.cpay.app.common.*
import global.cpay.app.databinding.FragmentDisburseBinding
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

class DisburseFragment : Fragment() {

    private var _b: FragmentDisburseBinding? = null
    private val b get() = _b!!
    private val fmt = NumberFormat.getNumberInstance(Locale.FRANCE)

    private var disburseOp = "airtel_money"
    private var withdrawOp = "airtel"

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentDisburseBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        b.etRefDisburse.setText(SecurityManager.generateRef("DSB"))
        b.etRefWithdraw.setText(SecurityManager.generateRef("WDR"))

        b.tabDisburse.setOnClickListener { switchTab(true) }
        b.tabWithdraw.setOnClickListener { switchTab(false) }

        b.btnDisAirtel.setOnClickListener { selOp(true, "airtel_money") }
        b.btnDisMtn.setOnClickListener    { selOp(true, "mtn_momo") }
        b.btnWdrAirtel.setOnClickListener { selOp(false, "airtel") }
        b.btnWdrMtn.setOnClickListener    { selOp(false, "mtn") }

        b.btnDisburse.setOnClickListener { doDisburse() }
        b.btnWithdraw.setOnClickListener { doWithdraw() }

        loadBalance()
    }

    private fun loadBalance() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.merchantDashboard()
                if (r.isSuccessful && r.body() != null) {
                    val settling = r.body()!!.settlingTomorrow
                    b.tvAvailable.text = "Disponible: ${fmt.format(settling)} XAF"
                }
            } catch (e: Exception) { }
        }
    }

    private fun switchTab(isDis: Boolean) {
        b.tabDisburse.setTextColor(Color.parseColor(if (isDis) "#12b6c7" else "#5a6677"))
        b.tabDisburse.setTypeface(null, if (isDis) Typeface.BOLD else Typeface.NORMAL)
        b.tabWithdraw.setTextColor(Color.parseColor(if (!isDis) "#12b6c7" else "#5a6677"))
        b.tabWithdraw.setTypeface(null, if (!isDis) Typeface.BOLD else Typeface.NORMAL)
        b.layoutDisburse.visibility = if (isDis) View.VISIBLE else View.GONE
        b.layoutWithdraw.visibility = if (!isDis) View.VISIBLE else View.GONE
    }

    private fun selOp(isDis: Boolean, op: String) {
        val on = Color.parseColor("#12b6c7"); val off = Color.parseColor("#5a6677")
        if (isDis) {
            disburseOp = op
            val a = op == "airtel_money"
            b.btnDisAirtel.setTextColor(if (a) on else off)
            b.btnDisAirtel.setTypeface(null, if (a) Typeface.BOLD else Typeface.NORMAL)
            b.btnDisMtn.setTextColor(if (!a) on else off)
            b.btnDisMtn.setTypeface(null, if (!a) Typeface.BOLD else Typeface.NORMAL)
        } else {
            withdrawOp = op
            val a = op == "airtel"
            b.btnWdrAirtel.setTextColor(if (a) on else off)
            b.btnWdrAirtel.setTypeface(null, if (a) Typeface.BOLD else Typeface.NORMAL)
            b.btnWdrMtn.setTextColor(if (!a) on else off)
            b.btnWdrMtn.setTypeface(null, if (!a) Typeface.BOLD else Typeface.NORMAL)
        }
    }

    private fun doDisburse() {
        val amt   = b.etAmountDisburse.text.toString().toDoubleOrNull()
        val phone = b.etPhoneDisburse.text.toString().trim()
        val ref   = b.etRefDisburse.text.toString().trim()

        val e1 = if (amt == null) "Montant invalide" else SecurityManager.validateAmount(amt, 500.0)
        if (e1 != null) { err(true, e1); return }
        val e2 = SecurityManager.validatePhone(phone)
        if (e2 != null) { err(true, e2); return }

        b.tvErrDisburse.visibility = View.GONE
        b.progressDisburse.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.merchantDisburse(DisburseRequest(
                    amount = amt!!, recipientPhone = phone, method = disburseOp, description = ref))
                if (r.isSuccessful && r.body() != null) {
                    val d = r.body()!!
                    Toast.makeText(requireContext(), "✅ ${fmt.format(amt)} XAF décaissés", Toast.LENGTH_LONG).show()
                    startActivity(Intent(requireContext(), ReceiptActivity::class.java).apply {
                        putExtra("amount", d.amount ?: amt)
                        putExtra("reference", d.reference ?: ref)
                        putExtra("type", "Décaissement")
                        putExtra("method", disburseOp)
                        putExtra("phone", phone)
                        putExtra("status", d.status ?: "authorized")
                        putExtra("fee", d.fee ?: 0.0)
                    })
                    b.etAmountDisburse.text?.clear(); b.etPhoneDisburse.text?.clear()
                    b.etRefDisburse.setText(SecurityManager.generateRef("DSB"))
                } else err(true, ApiErrors.message(r))
            } catch (e: Exception) { err(true, "Erreur réseau") }
            finally { if (_b != null) b.progressDisburse.visibility = View.GONE }
        }
    }

    private fun doWithdraw() {
        val amt   = b.etAmountWithdraw.text.toString().toDoubleOrNull()
        val phone = b.etPhoneWithdraw.text.toString().trim()
        val ref   = b.etRefWithdraw.text.toString().trim()

        val e1 = if (amt == null) "Montant invalide" else SecurityManager.validateAmount(amt, 1000.0)
        if (e1 != null) { err(false, e1); return }
        val e2 = SecurityManager.validatePhone(phone)
        if (e2 != null) { err(false, e2); return }

        b.tvErrWithdraw.visibility = View.GONE
        b.progressWithdraw.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.merchantWithdraw(WithdrawRequest(
                    amount = amt!!, phone = phone, operator = withdrawOp, description = ref))
                if (r.isSuccessful && r.body() != null) {
                    val d = r.body()!!
                    Toast.makeText(requireContext(), "✅ Retrait ${fmt.format(amt)} XAF", Toast.LENGTH_LONG).show()
                    startActivity(Intent(requireContext(), ReceiptActivity::class.java).apply {
                        putExtra("amount", d.amount ?: amt)
                        putExtra("reference", d.reference ?: ref)
                        putExtra("type", "Retrait")
                        putExtra("method", withdrawOp)
                        putExtra("phone", phone)
                        putExtra("status", d.status ?: "authorized")
                        putExtra("fee", d.fee ?: 0.0)
                    })
                    b.etAmountWithdraw.text?.clear(); b.etPhoneWithdraw.text?.clear()
                    b.etRefWithdraw.setText(SecurityManager.generateRef("WDR"))
                    loadBalance()
                } else {
                    // WAVE-3 : /merchant/withdraw repond 410 FEATURE_DISABLED (hotfix v1).
                    if (ApiErrors.isFeatureDisabled(r)) b.btnWithdraw.isEnabled = false
                    err(false, ApiErrors.message(r))
                }
            } catch (e: Exception) { err(false, "Erreur réseau") }
            finally { if (_b != null) b.progressWithdraw.visibility = View.GONE }
        }
    }

    private fun err(isDis: Boolean, m: String) {
        val tv = if (isDis) b.tvErrDisburse else b.tvErrWithdraw
        tv.text = m; tv.visibility = View.VISIBLE
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
