package global.cpay.app.cardholder.fragments

import android.graphics.Color
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import global.cpay.app.common.ApiClient
import global.cpay.app.common.ApiErrors
import global.cpay.app.common.CardDetail
import global.cpay.app.common.SecurityManager
import global.cpay.app.databinding.FragmentTopupBinding
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

class TopUpFragment : Fragment() {

    private var _b: FragmentTopupBinding? = null
    private val b get() = _b!!
    private val fmt = NumberFormat.getNumberInstance(Locale.FRANCE)

    private var cards = listOf<CardDetail>()
    private var selectedCard: CardDetail? = null
    private var topupOp  = "airtel"
    private var unloadOp = "airtel"

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentTopupBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        b.tabTopup.setOnClickListener  { switchTab(true) }
        b.tabUnload.setOnClickListener { switchTab(false) }

        b.btnTopupAirtel.setOnClickListener  { selOp(true, "airtel") }
        b.btnTopupMtn.setOnClickListener     { selOp(true, "mtn") }
        b.btnUnloadAirtel.setOnClickListener { selOp(false, "airtel") }
        b.btnUnloadMtn.setOnClickListener    { selOp(false, "mtn") }

        b.btnTopup.setOnClickListener  { doTopup() }
        b.btnUnload.setOnClickListener { doUnload() }

        loadCards()
    }

    private fun loadCards() {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cardholderCreatedCards()
                if (r.isSuccessful && r.body() != null) {
                    cards = r.body()!!.data.filter { it.status == "active" }
                    if (cards.isEmpty()) {
                        b.tvNoCard.visibility = View.VISIBLE
                        b.layoutTopup.visibility  = View.GONE
                        b.layoutUnload.visibility = View.GONE
                        return@launch
                    }
                    selectedCard = cards[0]

                    val labels = cards.map { "${it.label} — ${it.cardMasked} (${fmt.format(it.balance)} XAF)" }
                    val ad = ArrayAdapter(requireContext(), android.R.layout.simple_spinner_item, labels)
                    ad.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)

                    b.spinnerCardTopup.adapter  = ad
                    b.spinnerCardUnload.adapter = ad

                    b.spinnerCardTopup.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                        override fun onItemSelected(p: android.widget.AdapterView<*>?, v: View?, pos: Int, id: Long) {
                            selectedCard = cards[pos]
                            b.tvBalanceTopup.text = "Solde: ${fmt.format(cards[pos].balance)} XAF"
                        }
                        override fun onNothingSelected(p: android.widget.AdapterView<*>?) {}
                    }
                    b.spinnerCardUnload.onItemSelectedListener = object : android.widget.AdapterView.OnItemSelectedListener {
                        override fun onItemSelected(p: android.widget.AdapterView<*>?, v: View?, pos: Int, id: Long) {
                            selectedCard = cards[pos]
                            b.tvBalanceUnload.text = "Solde: ${fmt.format(cards[pos].balance)} XAF"
                        }
                        override fun onNothingSelected(p: android.widget.AdapterView<*>?) {}
                    }

                    b.tvBalanceTopup.text  = "Solde: ${fmt.format(cards[0].balance)} XAF"
                    b.tvBalanceUnload.text = "Solde: ${fmt.format(cards[0].balance)} XAF"
                }
            } catch (e: Exception) { }
        }
    }

    private fun switchTab(isTopup: Boolean) {
        b.tabTopup.setTextColor(if (isTopup) Color.parseColor("#12b6c7") else Color.parseColor("#5a6677"))
        b.tabUnload.setTextColor(if (!isTopup) Color.parseColor("#12b6c7") else Color.parseColor("#5a6677"))
        b.layoutTopup.visibility  = if (isTopup && cards.isNotEmpty()) View.VISIBLE else View.GONE
        b.layoutUnload.visibility = if (!isTopup && cards.isNotEmpty()) View.VISIBLE else View.GONE
    }

    private fun selOp(isTopup: Boolean, op: String) {
        val active = Color.parseColor("#12b6c7")
        val idle   = Color.parseColor("#5a6677")
        if (isTopup) {
            topupOp = op
            b.btnTopupAirtel.setTextColor(if (op == "airtel") active else idle)
            b.btnTopupMtn.setTextColor(if (op == "mtn") active else idle)
        } else {
            unloadOp = op
            b.btnUnloadAirtel.setTextColor(if (op == "airtel") active else idle)
            b.btnUnloadMtn.setTextColor(if (op == "mtn") active else idle)
        }
    }

    private fun doTopup() {
        val card = selectedCard ?: return
        val amt   = b.etTopupAmount.text.toString().toDoubleOrNull()
        val phone = b.etTopupPhone.text.toString().trim()

        val e1 = if (amt == null) "Montant invalide" else SecurityManager.validateAmount(amt, 500.0)
        if (e1 != null) { err(true, e1); return }
        val e2 = SecurityManager.validatePhone(phone)
        if (e2 != null) { err(true, e2); return }

        b.tvTopupError.visibility = View.GONE
        b.progressTopup.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cardholderTopup(mapOf(
                    "amount"   to amt!!,
                    "operator" to topupOp,
                    "phone"    to phone,
                    "cardId"   to card.cardId
                ))
                if (r.isSuccessful) {
                    Toast.makeText(requireContext(),
                        "✅ ${fmt.format(amt)} XAF chargés sur ${card.label}", Toast.LENGTH_LONG).show()
                    b.etTopupAmount.text?.clear()
                    b.etTopupPhone.text?.clear()
                    loadCards()
                } else {
                    // WAVE-3 : /cardholder/topup repond 410 FEATURE_DISABLED tant que la
                    // creation de monnaie n'est pas adossee a un mouvement reel.
                    if (ApiErrors.isFeatureDisabled(r)) b.btnTopup.isEnabled = false
                    err(true, ApiErrors.message(r))
                }
            } catch (e: Exception) { err(true, "Erreur réseau") }
            finally { if (_b != null) b.progressTopup.visibility = View.GONE }
        }
    }

    private fun doUnload() {
        val card = selectedCard ?: return
        val amt   = b.etUnloadAmount.text.toString().toDoubleOrNull()
        val phone = b.etUnloadPhone.text.toString().trim()
        val pin   = b.etUnloadPin.text.toString().trim()

        if (pin.length != 4) { err(false, "PIN à 4 chiffres requis"); return }
        val e1 = if (amt == null) "Montant invalide" else SecurityManager.validateAmount(amt, 500.0)
        if (e1 != null) { err(false, e1); return }
        val e2 = SecurityManager.validatePhone(phone)
        if (e2 != null) { err(false, e2); return }
        if (amt!! > card.balance) { err(false, "Solde insuffisant (${fmt.format(card.balance)} XAF)"); return }

        b.tvUnloadError.visibility = View.GONE
        b.progressUnload.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cardholderUnload(mapOf(
                    "amount"   to amt,
                    "operator" to unloadOp,
                    "phone"    to phone,
                    "pin"      to pin,
                    "cardId"   to card.cardId
                ))
                if (r.isSuccessful) {
                    Toast.makeText(requireContext(),
                        "✅ ${fmt.format(amt)} XAF transférés vers $phone", Toast.LENGTH_LONG).show()
                    b.etUnloadAmount.text?.clear()
                    b.etUnloadPhone.text?.clear()
                    b.etUnloadPin.text?.clear()
                    loadCards()
                } else {
                    if (ApiErrors.isFeatureDisabled(r)) b.btnUnload.isEnabled = false
                    err(false, ApiErrors.message(r))
                }
            } catch (e: Exception) { err(false, "Erreur réseau") }
            finally { if (_b != null) b.progressUnload.visibility = View.GONE }
        }
    }

    private fun err(isTopup: Boolean, msg: String) {
        val tv = if (isTopup) b.tvTopupError else b.tvUnloadError
        tv.text = msg
        tv.visibility = View.VISIBLE
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
