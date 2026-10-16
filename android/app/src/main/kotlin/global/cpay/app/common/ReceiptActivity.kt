package global.cpay.app.common

import android.content.Intent
import android.content.res.ColorStateList
import android.os.Bundle
import android.print.PrintAttributes
import android.print.PrintManager
import android.telephony.SmsManager
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import global.cpay.app.R
import global.cpay.app.common.ui.Fmt
import global.cpay.app.common.ui.StatusUi
import global.cpay.app.databinding.ActivityReceiptBinding
import java.util.Date
import java.util.Locale

/** Recu de transaction : impression (WebView → PrintManager), SMS, partage. */
class ReceiptActivity : AppCompatActivity() {

    private lateinit var binding: ActivityReceiptBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityReceiptBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val amount    = intent.getDoubleExtra("amount", 0.0)
        val currency  = intent.getStringExtra("currency")?.takeIf { it.isNotBlank() } ?: "XAF"
        val ref       = intent.getStringExtra("reference") ?: "—"
        val type      = intent.getStringExtra("type") ?: "—"
        val method    = intent.getStringExtra("method") ?: "—"
        val phone     = intent.getStringExtra("phone") ?: "—"
        val status    = intent.getStringExtra("status") ?: "completed"
        val fee       = intent.getDoubleExtra("fee", 0.0)
        val date      = intent.getStringExtra("date") ?: Fmt.dateTime(Date())

        binding.tvBack.setOnClickListener { finish() }

        val methodLabel = when (method.lowercase(Locale.ROOT)) {
            "card"         -> getString(R.string.method_card)
            "mobile_money" -> getString(R.string.method_mobile_money)
            "bank"         -> getString(R.string.method_bank)
            "", "—"        -> "—"
            else           -> if (method.contains('_') || method.lowercase(Locale.ROOT) == method) CashLabels.operator(method) else method
        }

        val statusLabel = when (status) {
            "completed", "authorized" -> getString(R.string.receipt_status_approved)
            "failed", "expired", "rejected", "cancelled" -> getString(R.string.receipt_status_refused)
            else -> getString(R.string.receipt_status_pending)
        }
        val (fg, bg) = StatusUi.statusColors(this, status)
        binding.tvStatusBadge.text = statusLabel
        binding.tvStatusBadge.setTextColor(fg)
        binding.tvStatusBadge.backgroundTintList = ColorStateList.valueOf(bg)
        binding.tvAmount.text = Fmt.money(amount, currency)
        binding.tvRef.text    = ref
        binding.tvType.text   = type.replaceFirstChar { it.uppercase() }
        binding.tvMethod.text = methodLabel
        binding.tvPhone.text  = phone
        binding.tvDate.text   = date
        binding.tvFee.text    = Fmt.money(fee, currency)

        // Imprimer
        binding.btnPrint.setOnClickListener {
            val pm = getSystemService(PRINT_SERVICE) as PrintManager
            val html = buildReceiptHtml(amount, currency, ref, type, methodLabel, phone, statusLabel, fee, date)
            android.webkit.WebView(this).let { wv ->
                wv.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
                pm.print("Recu_CPay_$ref", wv.createPrintDocumentAdapter("recu"), PrintAttributes.Builder().build())
            }
        }

        // SMS
        val smsText = "C-Pay - ${type.uppercase()} ${Fmt.money(amount, currency)}\nRef: $ref\nStatut: $statusLabel\nMerci !"
        binding.btnSms.setOnClickListener {
            if (phone.filter { it.isDigit() }.length >= 8) {
                try {
                    @Suppress("DEPRECATION")
                    SmsManager.getDefault().sendTextMessage(phone, null, smsText, null, null)
                    Toast.makeText(this, getString(R.string.receipt_sms_sent_fmt, phone), Toast.LENGTH_SHORT).show()
                } catch (e: Exception) {
                    // Pas de permission SMS : ouvrir l'application de messagerie
                    val i = Intent(Intent.ACTION_SENDTO).apply {
                        data = android.net.Uri.parse("smsto:$phone")
                        putExtra("sms_body", smsText)
                    }
                    try { startActivity(i) } catch (_: Exception) { }
                }
            } else {
                Toast.makeText(this, R.string.receipt_phone_invalid, Toast.LENGTH_SHORT).show()
            }
        }

        // Partager
        binding.btnShare.setOnClickListener {
            val text = """
C-Pay — ${getString(R.string.receipt_title)}
----------------------------
Type    : ${type.uppercase()}
Montant : ${Fmt.money(amount, currency)}
Frais   : ${Fmt.money(fee, currency)}
Méthode : $methodLabel
Tél     : $phone
Réf     : $ref
Date    : $date
Statut  : $statusLabel
----------------------------
c-pay.global
            """.trimIndent()
            val i = Intent(Intent.ACTION_SEND)
            i.type = "text/plain"
            i.putExtra(Intent.EXTRA_TEXT, text)
            startActivity(Intent.createChooser(i, getString(R.string.collect_share_receipt)))
        }
    }

    private fun buildReceiptHtml(amount: Double, currency: String, ref: String, type: String,
        method: String, phone: String, status: String, fee: Double, date: String): String {
        return """
<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body{font-family:Arial;padding:20px;max-width:400px;margin:0 auto}
.header{text-align:center;border-bottom:2px solid #1d4f92;padding-bottom:16px;margin-bottom:16px}
.title{color:#12306e;font-size:20px;font-weight:bold}
.amount{font-size:36px;font-weight:bold;color:#12306e;text-align:center;margin:16px 0}
.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;font-size:14px}
.label{color:#666}.value{font-weight:bold}
.footer{text-align:center;margin-top:20px;color:#999;font-size:12px}
.status{text-align:center;font-size:18px;font-weight:bold;color:#1b8a4c;margin-bottom:8px}
</style></head><body>
<div class="header"><div class="title">C-PAY — CALCULUS PLUS</div><div>${getString(R.string.receipt_title)}</div></div>
<div class="status">$status</div>
<div class="amount">${Fmt.money(amount, currency)}</div>
<div class="row"><span class="label">Référence</span><span class="value">$ref</span></div>
<div class="row"><span class="label">Type</span><span class="value">${type.uppercase()}</span></div>
<div class="row"><span class="label">Méthode</span><span class="value">$method</span></div>
<div class="row"><span class="label">Téléphone</span><span class="value">$phone</span></div>
<div class="row"><span class="label">Date</span><span class="value">$date</span></div>
<div class="row"><span class="label">Frais</span><span class="value">${Fmt.money(fee, currency)}</span></div>
<div class="footer">Merci de votre confiance<br>c-pay.global</div>
</body></html>"""
    }
}
