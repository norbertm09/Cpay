package global.cpay.app.merchant.fragments
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Typeface
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import global.cpay.app.common.ApiClient
import global.cpay.app.common.CollectRequest
import global.cpay.app.common.ReceiptActivity
import global.cpay.app.common.SecurityManager
import global.cpay.app.common.SessionManager
import global.cpay.app.databinding.FragmentCollectBinding
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale

class CollectFragment : Fragment() {
    private var _b: FragmentCollectBinding? = null
    private val b get() = _b!!
    private val fmt = NumberFormat.getNumberInstance(Locale.FRANCE)
    private var tab = "momo"
    private var method = "mtn_momo"

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentCollectBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        b.tabMomo.setOnClickListener { switchTab("momo") }
        b.tabQr.setOnClickListener   { switchTab("qr") }
        b.tabLink.setOnClickListener { switchTab("link") }
        b.tabNfc.setOnClickListener  { switchTab("nfc") }
        b.btnAirtel.setOnClickListener { selMethod("airtel_money") }
        b.btnMtn.setOnClickListener    { selMethod("mtn_momo") }
        b.btnCollect.setOnClickListener    { doCollect() }
        b.btnGenQr.setOnClickListener      { genQR() }
        b.btnGenLink.setOnClickListener    { genLink() }
        b.btnNfcCollect.setOnClickListener { doNFC() }
        b.btnNewCollect.setOnClickListener { reset() }
        b.btnCopyLink.setOnClickListener {
            val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("PayLink", b.etPayLink.text.toString()))
            toast("Copié !")
        }
        b.btnShareLink.setOnClickListener {
            startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, "Paiement CPay:\n${b.etPayLink.text}")
            }, "Partager"))
        }
        selMethod("mtn_momo")
        switchTab("momo")
        if (b.etReference.text.isNullOrEmpty()) b.etReference.setText(SecurityManager.generateRef("REF"))
    }

    private fun switchTab(t: String) {
        tab = t
        val tabs = listOf(b.tabMomo, b.tabQr, b.tabLink, b.tabNfc)
        val ids  = listOf("momo", "qr", "link", "nfc")
        tabs.forEachIndexed { i, tv ->
            val sel = ids[i] == t
            tv.setTextColor(Color.parseColor(if (sel) "#12b6c7" else "#5a6677"))
            tv.setTypeface(null, if (sel) Typeface.BOLD else Typeface.NORMAL)
        }
        b.layoutForm.visibility    = if (t == "momo") View.VISIBLE else View.GONE
        b.layoutQr.visibility      = if (t == "qr")   View.VISIBLE else View.GONE
        b.layoutLink.visibility    = if (t == "link") View.VISIBLE else View.GONE
        b.layoutNfc.visibility     = if (t == "nfc")  View.VISIBLE else View.GONE
        b.layoutSuccess.visibility = View.GONE
    }

    private fun selMethod(m: String) {
        method = m
        val a = m == "airtel_money"
        b.btnAirtel.setTextColor(Color.parseColor(if (a) "#12b6c7" else "#5a6677"))
        b.btnAirtel.setTypeface(null, if (a) Typeface.BOLD else Typeface.NORMAL)
        b.btnMtn.setTextColor(Color.parseColor(if (!a) "#12b6c7" else "#5a6677"))
        b.btnMtn.setTypeface(null, if (!a) Typeface.BOLD else Typeface.NORMAL)
    }

    private fun doCollect() {
        val amt0 = b.etAmount.text.toString().replace(" ","").replace(",",".").toDoubleOrNull()
        val eAmt = if (amt0 == null) "Montant invalide" else SecurityManager.validateAmount(amt0)
        if (eAmt != null) { showErr(eAmt); return }
        val opLabel = if (method == "airtel_money") "Airtel Money" else "MTN MoMo"
        val ctx = requireContext()
        val pad = (20 * resources.displayMetrics.density).toInt()
        val ll = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }
        val title = TextView(ctx).apply {
            text = "Encaisser via $opLabel"
            textSize = 17f; setTypeface(null, Typeface.BOLD)
            setPadding(0, 0, 0, pad)
        }
        ll.addView(title)
        val dlg = androidx.appcompat.app.AlertDialog.Builder(ctx).setView(ll).create()
        fun bigBtn(label: String, action: () -> Unit) {
            ll.addView(TextView(ctx).apply {
                text = label; textSize = 16f; setTypeface(null, Typeface.BOLD)
                gravity = Gravity.CENTER
                setTextColor(Color.WHITE)
                setBackgroundColor(Color.parseColor("#12b6c7"))
                val h = (52 * resources.displayMetrics.density).toInt()
                layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, h).apply {
                    bottomMargin = (10 * resources.displayMetrics.density).toInt()
                }
                isClickable = true
                setOnClickListener { dlg.dismiss(); action() }
            })
        }
        bigBtn("Push USSD") { doUssdCollect() }
        bigBtn("QR Code") { genQRFromCollect() }
        dlg.show()
    }

    private fun genQRFromCollect() {
        val amt = b.etAmount.text.toString().replace(" ","").replace(",",".").toDoubleOrNull() ?: return
        val ref = b.etReference.text.toString().trim().ifEmpty { SecurityManager.generateRef("QR") }
        loading(true)
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val body = mutableMapOf<String, Any>(
                    "amount" to amt, "description" to ref,
                    "expiresIn" to 24, "payment_method" to "mobile_money")
                val r = ApiClient.api.merchantCreatePayLink(body)
                val shortUrl = r.body()?.link?.shortUrl
                if (r.isSuccessful && !shortUrl.isNullOrEmpty()) {
                    switchTab("qr")
                    b.ivQrCode.setImageBitmap(qrBitmap(shortUrl, 600))
                    b.tvQrAmount.text = fmt.format(amt) + " XAF"
                    b.tvQrRef.text = "Réf: $ref"
                    b.layoutQrResult.visibility = View.VISIBLE
                } else showErr("Erreur création du QR")
            } catch (e: Exception) { showErr("Erreur réseau") }
            finally { loading(false) }
        }
    }

    private fun doUssdCollect() {
        val amt   = b.etAmount.text.toString().replace(" ","").replace(",",".").toDoubleOrNull()
        val phone = b.etPhone.text.toString().trim()
        val ref   = b.etReference.text.toString().trim()
        val name  = b.etCustomerName.text.toString().trim()
        val e1 = if (amt == null) "Montant invalide" else SecurityManager.validateAmount(amt)
        if (e1 != null) { showErr(e1); return }
        val e2 = SecurityManager.validatePhone(phone)
        if (e2 != null) { showErr(e2); return }
        loading(true)
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.merchantCollect(CollectRequest(
                    amount = amt!!, customerPhone = SecurityManager.normalizePhone(phone), method = method,
                    description = if (name.isNotEmpty()) "$ref — $name" else ref,
                    terminalId = SessionManager.terminalId))
                if (r.isSuccessful && r.body() != null) {
                    val d = r.body()!!
                    b.tvSuccessAmount.text = fmt.format(d.amount ?: amt) + " XAF"
                    b.tvSuccessRef.text = "Réf: ${d.reference ?: ref}"
                    b.layoutForm.visibility = View.GONE
                    b.layoutSuccess.visibility = View.VISIBLE
                    startActivity(Intent(requireContext(), ReceiptActivity::class.java).apply {
                        putExtra("amount", d.amount ?: amt)
                        putExtra("reference", d.reference ?: ref)
                        putExtra("type", "Encaissement")
                        putExtra("method", method)
                        putExtra("phone", SecurityManager.normalizePhone(phone))
                        putExtra("status", d.status ?: "authorized")
                        putExtra("fee", d.fee ?: 0.0)
                    })
                } else showErr(r.errorBody()?.string() ?: "Erreur")
            } catch (e: Exception) { showErr("Erreur réseau") }
            finally { loading(false) }
        }
    }

    private fun genQR() {
        val amt = b.etAmountQr.text.toString().replace(" ","").replace(",",".").toDoubleOrNull()
        val phone = b.etPhoneQr.text.toString().trim()
        if (amt == null || amt < 100) { toast("Montant minimum 100 XAF"); return }
        val ref = SecurityManager.generateRef("QR")
        loading(true)
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val body = mutableMapOf<String, Any>(
                    "amount" to amt, "description" to ref,
                    "expiresIn" to 24, "payment_method" to "mobile_money")
                if (phone.isNotEmpty()) body["recipientPhone"] = SecurityManager.normalizePhone(phone)
                val r = ApiClient.api.merchantCreatePayLink(body)
                val shortUrl = r.body()?.link?.shortUrl
                if (r.isSuccessful && !shortUrl.isNullOrEmpty()) {
                    b.ivQrCode.setImageBitmap(qrBitmap(shortUrl, 600))
                    b.tvQrAmount.text = fmt.format(amt) + " XAF"
                    b.tvQrRef.text = "Réf: $ref"
                    b.layoutQrResult.visibility = View.VISIBLE
                } else toast("Erreur création du lien QR")
            } catch (e: Exception) { toast("Erreur QR") }
            finally { loading(false) }
        }
    }

    private fun genLink() {
        val amt = b.etAmountLink.text.toString().replace(" ","").replace(",",".").toDoubleOrNull()
        val phone = b.etPhoneLink.text.toString().trim()
        val desc = b.etDescLink.text.toString().trim()
        if (amt == null || amt < 100) { toast("Montant minimum 100 XAF"); return }
        loading(true)
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val body = mutableMapOf<String, Any>(
                    "amount" to amt, "description" to desc.ifEmpty { SecurityManager.generateRef("LNK") },
                    "expiresIn" to 24, "payment_method" to "mobile_money")
                if (phone.isNotEmpty()) body["recipientPhone"] = SecurityManager.normalizePhone(phone)
                val r = ApiClient.api.merchantCreatePayLink(body)
                val d = r.body()
                if (r.isSuccessful && d?.link?.shortUrl != null) {
                    b.etPayLink.setText(d.link?.shortUrl ?: "")
                } else toast("Erreur création du lien")
            } catch (e: Exception) { toast("Erreur réseau") }
            finally { loading(false) }
        }
    }

    private fun doNFC() {
        // WAVE-3 : /merchant/collect/contactless repond 410 FEATURE_DISABLED cote backend.
        toast(global.cpay.app.common.ApiErrors.FEATURE_DISABLED_MESSAGE)
    }

    private fun reset() {
        b.etAmount.text?.clear(); b.etPhone.text?.clear(); b.etCustomerName.text?.clear()
        b.layoutSuccess.visibility = View.GONE
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
    private fun loading(l: Boolean) {
        b.progressBar.visibility = if (l) View.VISIBLE else View.GONE
        b.btnCollect.isEnabled = !l
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
