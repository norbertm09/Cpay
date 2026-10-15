package global.cpay.app.cardholder.fragments

import android.graphics.Color
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import global.cpay.app.cardholder.CreatedCardAdapter
import global.cpay.app.cardholder.EnrolledCardAdapter
import global.cpay.app.common.ApiClient
import global.cpay.app.common.CardDetail
import global.cpay.app.common.EnrolledCard
import global.cpay.app.databinding.FragmentCardsBinding
import kotlinx.coroutines.launch

class CardsFragment : Fragment() {

    private var _b: FragmentCardsBinding? = null
    private val b get() = _b!!

    private var created  = listOf<CardDetail>()
    private var enrolled = listOf<EnrolledCard>()
    private var maxCards = 3

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentCardsBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        b.rvCreated.layoutManager  = LinearLayoutManager(context)
        b.rvEnrolled.layoutManager = LinearLayoutManager(context)

        b.tabCreated.setOnClickListener  { switchTab(true) }
        b.tabEnrolled.setOnClickListener { switchTab(false) }

        b.btnCreateCard.setOnClickListener { showCreateForm() }
        b.btnConfirmCreate.setOnClickListener { createCard() }
        b.btnCancelCreate.setOnClickListener { hideCreateForm() }

        b.btnEnrollCard.setOnClickListener { showEnrollForm() }
        b.btnConfirmEnroll.setOnClickListener { enrollCard() }
        b.btnCancelEnroll.setOnClickListener { hideEnrollForm() }

        loadAll()
    }

    private fun switchTab(isCreated: Boolean) {
        b.tabCreated.setTextColor(if (isCreated) Color.parseColor("#12b6c7") else Color.parseColor("#5a6677"))
        b.tabEnrolled.setTextColor(if (!isCreated) Color.parseColor("#12b6c7") else Color.parseColor("#5a6677"))
        b.layoutCreated.visibility  = if (isCreated) View.VISIBLE else View.GONE
        b.layoutEnrolled.visibility = if (!isCreated) View.VISIBLE else View.GONE
    }

    private var gtpActive = true

    private fun loadAll() {
        b.progressBar.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            // Verifier si le service cartes (GTP) est actif
            try {
                val st = ApiClient.api.gtpStatus()
                if (_b == null) return@launch
                if (st.isSuccessful && st.body() != null) {
                    gtpActive = st.body()!!.configured
                    if (!gtpActive) {
                        b.tvMaxReached.text = "🔧 Service cartes en cours d'activation"
                        b.tvMaxReached.visibility = View.VISIBLE
                    }
                }
            } catch (e: Exception) { }

            try {
                val rc = ApiClient.api.cardholderCreatedCards()
                if (rc.isSuccessful && rc.body() != null) {
                    created  = rc.body()!!.data
                    maxCards = rc.body()!!.max
                    b.tvCreatedCount.text = "${created.size} / $maxCards cartes"
                    b.rvCreated.adapter = CreatedCardAdapter(created,
                        onDelete = { card -> deleteCard(card) },
                        onToggle = { card -> toggleCard(card) })
                    b.btnCreateCard.visibility = if (gtpActive && created.size < maxCards) View.VISIBLE else View.GONE
                    if (created.size >= maxCards) b.tvMaxReached.visibility = View.VISIBLE
                }
            } catch (e: Exception) { }

            try {
                val re = ApiClient.api.cardholderEnrolledCards()
                if (re.isSuccessful && re.body() != null) {
                    enrolled = re.body()!!.data
                    b.tvEnrolledCount.text = "${enrolled.size} carte(s) enrôlée(s)"
                    b.rvEnrolled.adapter = EnrolledCardAdapter(enrolled,
                        onRemove     = { c -> removeEnrolled(c) },
                        onSetDefault = { c -> setDefault(c) })
                }
            } catch (e: Exception) { }

            if (_b != null) b.progressBar.visibility = View.GONE
        }
    }

    private fun showCreateForm()  { b.layoutCreateForm.visibility = View.VISIBLE;  b.btnCreateCard.visibility = View.GONE }
    private fun hideCreateForm()  { b.layoutCreateForm.visibility = View.GONE;     b.btnCreateCard.visibility = View.VISIBLE; b.etCardLabel.text?.clear() }
    private fun showEnrollForm()  { b.layoutEnrollForm.visibility = View.VISIBLE;  b.btnEnrollCard.visibility = View.GONE }
    private fun hideEnrollForm()  { b.layoutEnrollForm.visibility = View.GONE;     b.btnEnrollCard.visibility = View.VISIBLE }

    private fun createCard() {
        val label = b.etCardLabel.text.toString().trim()
        b.progressBar.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cardholderCreateCard(
                    if (label.isEmpty()) emptyMap() else mapOf("label" to label))
                if (r.isSuccessful) {
                    Toast.makeText(requireContext(), "Carte créée ✅", Toast.LENGTH_SHORT).show()
                    hideCreateForm()
                    loadAll()
                } else {
                    val body = r.errorBody()?.string() ?: ""
                    val msg = when {
                        r.code() == 503 || body.contains("GTP_NOT_CONFIGURED") ->
                            "Le service cartes est en cours d'activation. Réessayez bientôt."
                        r.code() == 504 -> "Le service cartes ne répond pas. Réessayez."
                        body.contains("deja une carte") -> "Vous avez déjà une carte."
                        else -> "Impossible de créer la carte pour le moment."
                    }
                    Toast.makeText(requireContext(), msg, Toast.LENGTH_LONG).show()
                }
            } catch (e: Exception) {
                Toast.makeText(requireContext(), "Erreur réseau", Toast.LENGTH_SHORT).show()
            } finally { if (_b != null) b.progressBar.visibility = View.GONE }
        }
    }

    private fun enrollCard() {
        val num  = b.etCardNumber.text.toString().replace(" ", "").trim()
        val exp  = b.etExpiry.text.toString().trim()
        val cvv  = b.etCvv.text.toString().trim()
        val name = b.etCardName.text.toString().trim()

        if (num.length < 13)  { showEnrollError("Numéro invalide"); return }
        if (!exp.contains("/")) { showEnrollError("Format MM/AA requis"); return }
        if (cvv.length < 3)   { showEnrollError("CVV invalide"); return }
        if (name.isEmpty())   { showEnrollError("Nom requis"); return }

        val parts = exp.split("/")
        val mm = parts[0].toIntOrNull() ?: 0
        val yy = parts.getOrNull(1)?.toIntOrNull() ?: 0
        if (mm !in 1..12) { showEnrollError("Mois invalide"); return }

        b.tvEnrollError.visibility = View.GONE
        b.progressBar.visibility = View.VISIBLE
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cardholderEnrollCard(mapOf(
                    "cardNumber"     to num,
                    "expiryMonth"    to mm,
                    "expiryYear"     to yy,
                    "cvv"            to cvv,
                    "cardholderName" to name
                ))
                if (r.isSuccessful) {
                    Toast.makeText(requireContext(), "Carte enrôlée ✅", Toast.LENGTH_SHORT).show()
                    hideEnrollForm()
                    b.etCardNumber.text?.clear(); b.etExpiry.text?.clear()
                    b.etCvv.text?.clear(); b.etCardName.text?.clear()
                    loadAll()
                } else showEnrollError(r.errorBody()?.string() ?: "Erreur enrôlement")
            } catch (e: Exception) { showEnrollError("Erreur réseau") }
            finally { if (_b != null) b.progressBar.visibility = View.GONE }
        }
    }

    private fun deleteCard(card: CardDetail) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cardholderDeleteCard(card.cardId)
                if (r.isSuccessful) { Toast.makeText(requireContext(), "Carte supprimée", Toast.LENGTH_SHORT).show(); loadAll() }
                else Toast.makeText(requireContext(), r.errorBody()?.string() ?: "Erreur", Toast.LENGTH_LONG).show()
            } catch (e: Exception) { Toast.makeText(requireContext(), "Erreur", Toast.LENGTH_SHORT).show() }
        }
    }

    private fun toggleCard(card: CardDetail) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val newSt = if (card.status == "active") "frozen" else "active"
                ApiClient.api.cardholderCardStatus(mapOf("status" to newSt))
                Toast.makeText(requireContext(), if (newSt == "frozen") "Carte gelée" else "Carte réactivée", Toast.LENGTH_SHORT).show()
                loadAll()
            } catch (e: Exception) { Toast.makeText(requireContext(), "Erreur", Toast.LENGTH_SHORT).show() }
        }
    }

    private fun removeEnrolled(card: EnrolledCard) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                ApiClient.api.cardholderRemoveEnrolled(card.enrollmentId)
                Toast.makeText(requireContext(), "Carte retirée", Toast.LENGTH_SHORT).show()
                loadAll()
            } catch (e: Exception) { Toast.makeText(requireContext(), "Erreur", Toast.LENGTH_SHORT).show() }
        }
    }

    private fun setDefault(card: EnrolledCard) {
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                ApiClient.api.cardholderSetDefaultCard(card.enrollmentId)
                Toast.makeText(requireContext(), "Carte par défaut", Toast.LENGTH_SHORT).show()
                loadAll()
            } catch (e: Exception) { Toast.makeText(requireContext(), "Erreur", Toast.LENGTH_SHORT).show() }
        }
    }

    private fun showEnrollError(m: String) { b.tvEnrollError.text = m; b.tvEnrollError.visibility = View.VISIBLE }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
