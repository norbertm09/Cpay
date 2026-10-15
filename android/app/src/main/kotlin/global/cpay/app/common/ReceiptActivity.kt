package global.cpay.app.common

import android.content.Intent
import android.os.Bundle
import android.print.PrintAttributes
import android.print.PrintManager
import android.telephony.SmsManager
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import global.cpay.app.databinding.ActivityReceiptBinding
import java.text.NumberFormat
import java.util.Locale

class ReceiptActivity : AppCompatActivity() {

    private lateinit var binding: ActivityReceiptBinding
    private val fmt = NumberFormat.getNumberInstance(Locale.FRANCE)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityReceiptBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val amount    = intent.getDoubleExtra("amount", 0.0)
        val ref       = intent.getStringExtra("reference") ?: "—"
        val type      = intent.getStringExtra("type") ?: "—"
        val method    = intent.getStringExtra("method") ?: "—"
        val phone     = intent.getStringExtra("phone") ?: "—"
        val status    = intent.getStringExtra("status") ?: "completed"
        val fee       = intent.getDoubleExtra("fee", 0.0)
        val date      = intent.getStringExtra("date") ?: java.text.SimpleDateFormat(
            "dd/MM/yyyy HH:mm", Locale.FRANCE).format(java.util.Date())

        binding.tvBack.setOnClickListener { finish() }

        val methodLabel = when (method) {
            "airtel_money" -> "🔴 Airtel Money"
            "mtn_momo"     -> "🟡 MTN MoMo"
            "card"         -> "💳 Carte"
            "mobile_money" -> "📱 Mobile Money"
            else           -> method
        }

        val (statusLabel, statusColor) = when (status) {
            "completed", "authorized" -> "✅ APPROUVÉ" to 0xFF00c896.toInt()
            "failed", "expired"       -> "❌ REFUSÉ"   to 0xFFff3b30.toInt()
            else        -> "⏳ EN ATTENTE" to 0xFFff9500.toInt()
        }

        binding.tvStatusBadge.text = statusLabel
        binding.tvStatusBadge.setTextColor(statusColor)
        binding.tvAmount.text = "${fmt.format(amount)} XAF"
        binding.tvRef.text    = ref
        binding.tvType.text   = type.replaceFirstChar { it.uppercase() }
        binding.tvMethod.text = methodLabel
        binding.tvPhone.text  = phone
        binding.tvDate.text   = date
        binding.tvFee.text    = "${fmt.format(fee)} XAF"

        // Imprimer
        binding.btnPrint.setOnClickListener {
            val pm = getSystemService(PRINT_SERVICE) as PrintManager
            val html = buildReceiptHtml(amount, ref, type, methodLabel, phone, statusLabel, fee, date)
            val adapter = android.webkit.WebView(this).let { wv ->
                wv.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
                pm.print("Recu_CPay_$ref", wv.createPrintDocumentAdapter("recu"), PrintAttributes.Builder().build())
            }
        }

        // SMS
        binding.btnSms.setOnClickListener {
            if (phone.length >= 8) {
                try {
                    val msg = "C-Pay - ${type.uppercase()} ${fmt.format(amount)} XAF\nRef: $ref\nStatut: $statusLabel\nMerci!"
                    SmsManager.getDefault().sendTextMessage(phone, null, msg, null, null)
                    Toast.makeText(this, "SMS envoyé à $phone ✅", Toast.LENGTH_SHORT).show()
                } catch(e: Exception) {
                    // Ouvrir l'app SMS
                    val intent = Intent(Intent.ACTION_SENDTO).apply {
                        data = android.net.Uri.parse("smsto:$phone")
                        putExtra("sms_body", "C-Pay - ${type.uppercase()} ${fmt.format(amount)} XAF\nRef: $ref")
                    }
                    startActivity(intent)
                }
            } else {
                Toast.makeText(this, "Numéro de téléphone invalide", Toast.LENGTH_SHORT).show()
            }
        }

        // Partager
        binding.btnShare.setOnClickListener {
            val text = """
C-Pay — Reçu de transaction
----------------------------
Type    : ${type.uppercase()}
Montant : ${fmt.format(amount)} XAF
Frais   : ${fmt.format(fee)} XAF
Méthode : $methodLabel
Tél     : $phone
Réf     : $ref
Date    : $date
Statut  : $statusLabel
----------------------------
c-pay.global
            """.trimIndent()
            val intent = Intent(Intent.ACTION_SEND)
            intent.type = "text/plain"
            intent.putExtra(Intent.EXTRA_TEXT, text)
            startActivity(Intent.createChooser(intent, "Partager le reçu"))
        }
    }

    private fun buildReceiptHtml(amount: Double, ref: String, type: String,
        method: String, phone: String, status: String, fee: Double, date: String): String {
        return """
<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>body{font-family:Arial;padding:20px;max-width:400px;margin:0 auto}
.header{text-align:center;border-bottom:2px solid #1d4f92;padding-bottom:16px;margin-bottom:16px}
.title{color:#1d4f92;font-size:20px;font-weight:bold}
.amount{font-size:36px;font-weight:bold;color:#1d4f92;text-align:center;margin:16px 0}
.row{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;font-size:14px}
.label{color:#666}.value{font-weight:bold}
.footer{text-align:center;margin-top:20px;color:#999;font-size:12px}
.status{text-align:center;font-size:18px;font-weight:bold;color:#00c896;margin-bottom:8px}
</style></head><body>
<div class="header"><div class="title">CALCULUS PLUS</div><div>Reçu de transaction</div></div>
<div class="status">$status</div>
<div class="amount">${fmt.format(amount)} XAF</div>
<div class="row"><span class="label">Référence</span><span class="value">$ref</span></div>
<div class="row"><span class="label">Type</span><span class="value">${type.uppercase()}</span></div>
<div class="row"><span class="label">Méthode</span><span class="value">$method</span></div>
<div class="row"><span class="label">Téléphone</span><span class="value">$phone</span></div>
<div class="row"><span class="label">Date</span><span class="value">$date</span></div>
<div class="row"><span class="label">Frais</span><span class="value">${fmt.format(fee)} XAF</span></div>
<div class="footer">Merci de votre confiance<br>c-pay.global</div>
</body></html>"""
    }
}
