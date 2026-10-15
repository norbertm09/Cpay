package global.cpay.app.merchant.fragments

import android.app.Dialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.ApiErrors
import global.cpay.app.common.CashCollectRequest
import global.cpay.app.common.CashCollectResponse
import global.cpay.app.common.CashCollectStatus
import global.cpay.app.common.CashLabels
import global.cpay.app.common.PhoneDetection
import global.cpay.app.common.ReceiptActivity
import global.cpay.app.common.SecurityManager
import global.cpay.app.databinding.FragmentCollectBinding
import global.cpay.app.merchant.CashSession
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

/**
 * Encaisser (WAVE-4, docs/CAISSE-API.md §2).
 *  - Mobile Money : clavier montant, détection live de l'opérateur (POST /detect/phone,
 *    debounce 450 ms) avec alternatives (Wave, Express Union…), POST /merchant/cash/collect
 *    puis sondage GET /merchant/cash/collect/:txnId toutes les 3 s pendant 90 s max →
 *    reçu (ReceiptActivity) ou « en attente de confirmation ».
 *  - Carte : method=card → lien de paiement hébergé + QR (ZXing) ; 410 → fonction en cours.
 *  - NFC : conservé, message « fonction en cours d'intégration ».
 */
class CollectFragment : Fragment() {

    companion object {
        private const val POLL_INTERVAL_MS = 3_000L
        private const val POLL_MAX_MS      = 90_000L
        private const val DETECT_DEBOUNCE_MS = 450L
    }

    private var _b: FragmentCollectBinding? = null
    private val b get() = _b!!
    private val fmt = NumberFormat.getNumberInstance(Locale.FRANCE)
    private val handler = Handler(Looper.getMainLooper())

    private var tab = "momo"
    private var amountStr = ""
    private var currency = CashSession.currency
    private var detection: PhoneDetection? = null
    private var chosenOperator: String? = null       // forçage d'un service (Wave, Express Union…)
    private var lastDetectedPhone = ""
    private var pollJob: Job? = null
    private var waitingDialog: Dialog? = null
    private var lastReceipt: Intent? = null
    private var cardUrl: String? = null
    private val detectRunnable = Runnable { detectPhone() }

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentCollectBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        b.tabMomo.setOnClickListener { switchTab("momo") }
        b.tabCard.setOnClickListener { switchTab("card") }
        b.tabNfc.setOnClickListener  { switchTab("nfc") }

        // Clavier montant
        val keys = mapOf(
            b.key1 to "1", b.key2 to "2", b.key3 to "3", b.key4 to "4", b.key5 to "5",
            b.key6 to "6", b.key7 to "7", b.key8 to "8", b.key9 to "9", b.key0 to "0", b.key000 to "000",
        )
        keys.forEach { (view, k) -> view.setOnClickListener { pressKey(k) } }
        b.keyDel.setOnClickListener { pressKey("del") }
        b.keyDel.setOnLongClickListener { amountStr = ""; renderAmount(); true }

        // Détection opérateur (debounce)
        b.etPhone.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, c: Int, d: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, c: Int, d: Int) {}
            override fun afterTextChanged(s: Editable?) {
                handler.removeCallbacks(detectRunnable)
                val digits = (s?.toString() ?: "").filter { it.isDigit() }
                if (digits.length >= 8) {
                    b.layoutDetection.visibility = View.VISIBLE
                    b.tvDetectMain.text = getString(R.string.collect_detecting)
                    b.tvDetectSub.text = ""
                    handler.postDelayed(detectRunnable, DETECT_DEBOUNCE_MS)
                } else {
                    detection = null; chosenOperator = null
                    b.layoutDetection.visibility = View.GONE
                }
            }
        })

        b.btnCollect.setOnClickListener    { doCollect() }
        b.btnGenCard.setOnClickListener    { genCard() }
        b.btnNfcCollect.setOnClickListener { doNFC() }
        b.btnNewCollect.setOnClickListener { reset() }
        b.btnReceipt.setOnClickListener    { lastReceipt?.let { startActivity(it) } }

        b.btnCopyLink.setOnClickListener {
            val url = cardUrl ?: return@setOnClickListener
            val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("PayLink", url))
            toast("Lien copié")
        }
        b.btnShareLink.setOnClickListener {
            val url = cardUrl ?: return@setOnClickListener
            startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, "Paiement C-Pay ${b.tvCardAmount.text} :\n$url")
            }, "Partager"))
        }
        b.btnOpenLink.setOnClickListener {
            val url = cardUrl ?: return@setOnClickListener
            try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) { toast("Aucun navigateur") }
        }

        if (b.etReference.text.isNullOrEmpty()) b.etReference.setText(SecurityManager.generateRef("ENC"))
        renderAmount()
        switchTab("momo")
        loadCurrency()
    }

    private fun loadCurrency() {
        if (CashSession.summary != null) { currency = CashSession.currency; renderAmount(); return }
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cashSummary()
                if (_b == null) return@launch
                r.body()?.let { CashSession.summary = it; currency = it.cur; renderAmount() }
            } catch (_: Exception) {}
        }
    }

    // ─── Onglets ────────────────────────────────────────────────────
    private fun switchTab(t: String) {
        tab = t
        val tabs = listOf(b.tabMomo to "momo", b.tabCard to "card", b.tabNfc to "nfc")
        tabs.forEach { (tv, id) ->
            val sel = id == t
            tv.setTextColor(Color.parseColor(if (sel) "#12b6c7" else "#5a6677"))
            tv.setTypeface(null, if (sel) Typeface.BOLD else Typeface.NORMAL)
        }
        b.layoutMomo.visibility   = if (t == "momo") View.VISIBLE else View.GONE
        b.layoutCard.visibility   = if (t == "card") View.VISIBLE else View.GONE
        b.layoutNfc.visibility    = if (t == "nfc")  View.VISIBLE else View.GONE
        b.layoutResult.visibility = View.GONE
        b.tvError.visibility = View.GONE
    }

    // ─── Clavier ────────────────────────────────────────────────────
    private fun pressKey(k: String) {
        amountStr = when (k) {
            "del" -> amountStr.dropLast(1)
            else  -> if (amountStr.length + k.length <= 9) (amountStr + k).trimStart('0') else amountStr
        }
        renderAmount()
    }

    private fun renderAmount() {
        if (_b == null) return
        b.tvAmountDisplay.text = "${fmt.format(amountStr.toLongOrNull() ?: 0L)} $currency"
    }

    private fun money(v: Double?) = "${fmt.format(v ?: 0.0)} $currency"

    // ─── Détection live ─────────────────────────────────────────────
    private fun detectPhone() {
        if (_b == null) return
        val phone = b.etPhone.text.toString().trim()
        if (phone == lastDetectedPhone && detection != null) return
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.detectPhone(mapOf("phone" to phone))
                if (_b == null) return@launch
                val d = r.body() ?: PhoneDetection(success = false, error = ApiErrors.message(r, "Détection impossible"))
                lastDetectedPhone = phone
                detection = d
                chosenOperator = null
                renderDetection(d)
            } catch (e: Exception) {
                if (_b == null) return@launch
                detection = null
                b.tvDetectMain.text = "Détection indisponible (réseau)"
                b.tvDetectSub.text = "L'opérateur sera détecté par le serveur"
                b.layoutAlternatives.removeAllViews()
                b.tvAlternativesLabel.visibility = View.GONE
            }
        }
    }

    private fun renderDetection(d: PhoneDetection) {
        b.layoutDetection.visibility = View.VISIBLE
        val countryLine = listOfNotNull(d.countryName ?: d.country, d.currency).joinToString(" · ")
        if (d.success) {
            b.tvDetectMain.text = "📱 ${d.operatorLabel}" + if (d.verified == false) "  (à confirmer)" else ""
            b.tvDetectSub.text = countryLine
            if (!d.currency.isNullOrBlank() && d.currency != currency) {
                b.tvDetectSub.text = "$countryLine — ⚠️ devise différente de votre compte ($currency)"
            }
        } else {
            b.tvDetectMain.text = "⚠️ ${d.error ?: "Opérateur non reconnu"}"
            b.tvDetectSub.text = countryLine
        }
        renderAlternatives(d)
    }

    private fun renderAlternatives(d: PhoneDetection) {
        b.layoutAlternatives.removeAllViews()
        val alts = d.alternatives.filter { it.operator.isNotBlank() && !it.operator.equals(d.operator, true) }
        if (alts.isEmpty()) { b.tvAlternativesLabel.visibility = View.GONE; return }
        b.tvAlternativesLabel.visibility = View.VISIBLE
        val density = resources.displayMetrics.density
        fun chip(label: String, value: String?) {
            val selected = value == chosenOperator
            b.layoutAlternatives.addView(TextView(requireContext()).apply {
                text = label
                textSize = 12f
                setTypeface(null, Typeface.BOLD)
                setTextColor(if (selected) Color.WHITE else Color.parseColor("#12b6c7"))
                setBackgroundResource(if (selected) R.drawable.bg_btn_primary else R.drawable.bg_btn_outline)
                setPadding((12 * density).toInt(), (6 * density).toInt(), (12 * density).toInt(), (6 * density).toInt())
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                    .apply { marginEnd = (6 * density).toInt() }
                setOnClickListener { chosenOperator = value; renderAlternatives(d) }
            })
        }
        if (d.success) chip("Détecté : ${d.operatorLabel}", null)
        alts.forEach { chip(it.brand ?: CashLabels.operator(it.operator), it.operator) }
    }

    // ─── Encaissement Mobile Money ──────────────────────────────────
    private fun doCollect() {
        val amt = amountStr.toDoubleOrNull() ?: 0.0
        SecurityManager.validateAmount(amt)?.let { showErr(it); return }
        val rawPhone = b.etPhone.text.toString().trim()
        if (rawPhone.isEmpty()) { showErr("Numéro du client requis"); return }
        val d = detection
        if (d != null && !d.success && chosenOperator == null && d.alternatives.isEmpty() && d.code != "OPERATOR_UNKNOWN") {
            showErr(d.error ?: "Numéro non pris en charge"); return
        }
        if (d != null && !d.success && chosenOperator == null && d.alternatives.isNotEmpty()) {
            showErr("Choisissez un service de paiement ci-dessus"); return
        }
        val phone = d?.phone?.takeIf { it.isNotBlank() } ?: SecurityManager.normalizePhone(rawPhone)
        val desc = b.etDescription.text.toString().trim()
        val ref  = b.etReference.text.toString().trim().ifEmpty { SecurityManager.generateRef("ENC") }
        val idem = SecurityManager.generateRef("IDK")

        b.tvError.visibility = View.GONE
        loading(true)
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cashCollect(idem, CashCollectRequest(
                    amount = amt, method = "mobile_money", customerPhone = phone,
                    operator = chosenOperator, description = desc.ifEmpty { null }, reference = ref))
                if (_b == null) return@launch
                val body = r.body()
                if (r.isSuccessful && body != null) {
                    if (!body.currency.isNullOrBlank()) currency = body.currency
                    startPolling(body, amt, phone, ref)
                } else {
                    showErr(ApiErrors.cashMessage(r, currency, "Encaissement refusé"))
                }
            } catch (e: Exception) {
                if (_b != null) showErr(getString(R.string.network_error))
            } finally {
                if (_b != null) loading(false)
            }
        }
    }

    private fun startPolling(c: CashCollectResponse, amt: Double, phone: String, ref: String) {
        val txnId = c.txnId
        val opLabel = c.operatorLabel ?: CashLabels.operator(c.operator ?: chosenOperator ?: detection?.operator)
        val amount = c.amount ?: amt
        val reference = c.reference ?: ref
        if (txnId.isNullOrBlank()) {
            showResult("pending", amount, reference, phone, opLabel, c.fee ?: 0.0,
                "Demande envoyée — suivez le statut dans le Journal.")
            return
        }
        val ctx = requireContext()
        val dlg = Dialog(ctx)
        dlg.requestWindowFeature(Window.FEATURE_NO_TITLE)
        dlg.setContentView(R.layout.dialog_collect_waiting)
        dlg.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        dlg.setCancelable(false)
        dlg.findViewById<TextView>(R.id.tv_amount).text = money(amount)
        dlg.findViewById<TextView>(R.id.tv_phone).text = "$opLabel · $phone"
        val tvCountdown = dlg.findViewById<TextView>(R.id.tv_countdown)
        dlg.findViewById<TextView>(R.id.btn_cancel).setOnClickListener {
            pollJob?.cancel()
            dlg.dismiss()
            showResult("pending", amount, reference, phone, opLabel, c.fee ?: 0.0,
                getString(R.string.collect_waiting_detail))
        }
        dlg.show()
        waitingDialog = dlg

        pollJob = viewLifecycleOwner.lifecycleScope.launch {
            val start = System.currentTimeMillis()
            var last: CashCollectStatus? = null
            while (isActive) {
                delay(POLL_INTERVAL_MS)
                if (_b == null) return@launch
                try {
                    val r = ApiClient.api.cashCollectStatus(txnId)
                    val st = r.body()
                    if (r.isSuccessful && st != null) {
                        last = st
                        if (st.isDone) {
                            dlg.dismiss()
                            showResult("success", st.amount ?: amount, st.reference ?: reference, phone,
                                opLabel, st.fee ?: c.fee ?: 0.0, null)
                            return@launch
                        }
                        if (st.isFailed) {
                            dlg.dismiss()
                            showResult("failed", st.amount ?: amount, st.reference ?: reference, phone, opLabel,
                                st.fee ?: 0.0, st.error ?: if (st.status == "expired") "Délai dépassé" else "Paiement refusé par le client ou l'opérateur")
                            return@launch
                        }
                    }
                } catch (_: Exception) { /* erreur passagere : on continue */ }
                val elapsed = System.currentTimeMillis() - start
                tvCountdown.text = "⏳ ${((POLL_MAX_MS - elapsed) / 1000).coerceAtLeast(0)}s"
                if (elapsed >= POLL_MAX_MS) {
                    dlg.dismiss()
                    showResult("pending", last?.amount ?: amount, last?.reference ?: reference, phone, opLabel,
                        last?.fee ?: c.fee ?: 0.0, getString(R.string.collect_waiting_detail))
                    return@launch
                }
            }
        }
    }

    private fun showResult(kind: String, amount: Double, ref: String, phone: String, method: String,
                           fee: Double, message: String?) {
        if (_b == null) return
        val (icon, title, color) = when (kind) {
            "success" -> Triple("✅", getString(R.string.collect_success), "#007a5a")
            "failed"  -> Triple("❌", getString(R.string.collect_failed), "#c53030")
            else      -> Triple("⏳", getString(R.string.collect_waiting), "#c47000")
        }
        b.tvResultIcon.text = icon
        b.tvResultTitle.text = title
        b.tvResultTitle.setTextColor(Color.parseColor(color))
        b.tvResultAmount.text = money(amount)
        b.tvResultRef.text = "Réf : $ref"
        b.tvResultMsg.visibility = if (message.isNullOrBlank()) View.GONE else View.VISIBLE
        b.tvResultMsg.text = message ?: ""
        b.btnReceipt.visibility = if (kind == "failed") View.GONE else View.VISIBLE
        b.layoutMomo.visibility = View.GONE
        b.layoutResult.visibility = View.VISIBLE

        lastReceipt = Intent(requireContext(), ReceiptActivity::class.java).apply {
            putExtra("amount", amount)
            putExtra("reference", ref)
            putExtra("type", "Encaissement")
            putExtra("method", method)
            putExtra("phone", phone)
            putExtra("status", when (kind) { "success" -> "authorized"; "failed" -> "failed"; else -> "pending" })
            putExtra("fee", fee)
        }
        if (kind == "success") lastReceipt?.let { startActivity(it) }
    }

    // ─── Carte : lien de paiement + QR ──────────────────────────────
    private fun genCard() {
        val amt = b.etAmountCard.text.toString().replace(" ", "").replace(",", ".").toDoubleOrNull()
        val e = if (amt == null) "Montant invalide" else SecurityManager.validateAmount(amt)
        if (e != null) { cardErr(e); return }
        val desc = b.etDescriptionCard.text.toString().trim()
        val idem = SecurityManager.generateRef("IDK")
        b.tvCardError.visibility = View.GONE
        b.progressCard.visibility = View.VISIBLE
        b.btnGenCard.isEnabled = false
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cashCollect(idem, CashCollectRequest(
                    amount = amt!!, method = "card", description = desc.ifEmpty { null },
                    reference = SecurityManager.generateRef("CRD")))
                if (_b == null) return@launch
                val url = r.body()?.payLink?.shortUrl
                if (r.isSuccessful && !url.isNullOrBlank()) {
                    cardUrl = url
                    b.ivQrCode.setImageBitmap(qrBitmap(url, 600))
                    b.tvCardAmount.text = money(amt)
                    b.tvCardUrl.text = url
                    val exp = r.body()?.payLink?.expiresAt
                    b.tvCardExpiry.text = if (exp.isNullOrBlank()) "" else "Expire le ${exp.take(16).replace("T", " à ")}"
                    b.layoutCardResult.visibility = View.VISIBLE
                } else if (r.isSuccessful) {
                    cardErr("Lien de paiement indisponible")
                } else {
                    cardErr(ApiErrors.cashMessage(r, currency, "Création du lien impossible"))
                }
            } catch (ex: Exception) {
                if (_b != null) cardErr(getString(R.string.network_error))
            } finally {
                if (_b != null) { b.progressCard.visibility = View.GONE; b.btnGenCard.isEnabled = true }
            }
        }
    }

    private fun doNFC() {
        // Tap-to-Phone : 410 FEATURE_DISABLED tant que la certification n'est pas obtenue.
        toast(ApiErrors.FEATURE_DISABLED_MESSAGE)
    }

    private fun reset() {
        amountStr = ""; renderAmount()
        b.etPhone.text?.clear(); b.etDescription.text?.clear()
        b.etReference.setText(SecurityManager.generateRef("ENC"))
        detection = null; chosenOperator = null; lastDetectedPhone = ""
        b.layoutDetection.visibility = View.GONE
        b.layoutResult.visibility = View.GONE
        switchTab("momo")
    }

    private fun qrBitmap(text: String, size: Int): Bitmap {
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size)
        val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.RGB_565)
        for (x in 0 until size) for (y in 0 until size)
            bmp.setPixel(x, y, if (matrix[x, y]) Color.BLACK else Color.WHITE)
        return bmp
    }

    private fun toast(m: String) { Toast.makeText(requireContext(), m, Toast.LENGTH_SHORT).show() }
    private fun showErr(m: String) { b.tvError.text = m; b.tvError.visibility = View.VISIBLE }
    private fun cardErr(m: String) { b.tvCardError.text = m; b.tvCardError.visibility = View.VISIBLE }
    private fun loading(l: Boolean) {
        b.progressBar.visibility = if (l) View.VISIBLE else View.GONE
        b.btnCollect.isEnabled = !l
    }

    override fun onDestroyView() {
        handler.removeCallbacks(detectRunnable)
        pollJob?.cancel()
        try { waitingDialog?.dismiss() } catch (_: Exception) {}
        waitingDialog = null
        super.onDestroyView()
        _b = null
    }
}
