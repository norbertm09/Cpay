package global.cpay.app.merchant.fragments

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.core.os.bundleOf
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.ApiErrors
import global.cpay.app.common.CashCollectRequest
import global.cpay.app.common.SecurityManager
import global.cpay.app.common.ui.Fmt
import global.cpay.app.databinding.FragmentCollectCardBinding
import global.cpay.app.merchant.MerchantMainActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Encaisser — carte (WAVE-5) : POST /merchant/cash/collect { method: card } → lien de
 * paiement heberge affiche en grand code QR pour le client, copier / partager / ouvrir.
 * 410 FEATURE_DISABLED → message « fonctionnalite en cours d'integration ».
 */
class CollectCardFragment : Fragment() {

    companion object {
        private const val A_AMOUNT = "amount"; private const val A_CUR = "currency"
        fun newInstance(amount: Double, currency: String) = CollectCardFragment().apply {
            arguments = bundleOf(A_AMOUNT to amount, A_CUR to currency)
        }
    }

    private var _b: FragmentCollectCardBinding? = null
    private val b get() = _b!!
    private var url: String? = null
    private var amount = 0.0
    private var currency = "XAF"
    private val act: MerchantMainActivity? get() = activity as? MerchantMainActivity

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentCollectCardBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        amount = requireArguments().getDouble(A_AMOUNT)
        currency = requireArguments().getString(A_CUR) ?: currency
        b.header.tvScreenTitle.text = getString(R.string.collect_card_title)
        b.header.btnBack.setOnClickListener { act?.pop() }
        b.tvAmount.text = Fmt.money(amount, currency)
        b.btnDone.setOnClickListener { act?.pop() }
        b.btnCopy.setOnClickListener {
            val u = url ?: return@setOnClickListener
            val cm = requireContext().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("C-Pay", u))
            Toast.makeText(requireContext(), R.string.copied, Toast.LENGTH_SHORT).show()
        }
        b.btnShare.setOnClickListener {
            val u = url ?: return@setOnClickListener
            startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, getString(R.string.collect_share_text_fmt, Fmt.money(amount, currency), u))
            }, getString(R.string.share)))
        }
        b.btnOpen.setOnClickListener {
            val u = url ?: return@setOnClickListener
            try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u))) }
            catch (_: Exception) { Toast.makeText(requireContext(), R.string.collect_no_browser, Toast.LENGTH_SHORT).show() }
        }
        if (url == null) create()
    }

    private fun create() {
        val idem = SecurityManager.generateRef("IDK")
        viewLifecycleOwner.lifecycleScope.launch {
            try {
                val r = ApiClient.api.cashCollect(idem, CashCollectRequest(
                    amount = amount, method = "card", reference = SecurityManager.generateRef("CRD")))
                if (_b == null) return@launch
                val link = r.body()?.payLink
                val u = link?.shortUrl
                if (r.isSuccessful && !u.isNullOrBlank()) {
                    url = u
                    val bmp = withContext(Dispatchers.Default) { qrBitmap(u, 720) }
                    if (_b == null) return@launch
                    b.ivQr.setImageBitmap(bmp)
                    b.ivQr.visibility = View.VISIBLE
                    b.layoutLoading.visibility = View.GONE
                    b.tvUrl.text = u.replace("https://", "")
                    val exp = link?.expiresAt
                    b.tvExpiry.text = if (exp.isNullOrBlank()) "" else getString(R.string.collect_card_expires_fmt, Fmt.dateTime(exp))
                    b.layoutActions.visibility = View.VISIBLE
                } else if (r.isSuccessful) {
                    fail(getString(R.string.collect_card_unavailable))
                } else {
                    fail(ApiErrors.cashMessage(r, currency, getString(R.string.collect_card_error)))
                }
            } catch (e: Exception) {
                if (_b != null) fail(getString(R.string.network_error))
            }
        }
    }

    private fun fail(m: String) {
        b.layoutLoading.visibility = View.GONE
        b.tvError.text = m; b.tvError.visibility = View.VISIBLE
    }

    private fun qrBitmap(text: String, size: Int): Bitmap {
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size)
        val pixels = IntArray(size * size)
        for (y in 0 until size) for (x in 0 until size) pixels[y * size + x] = if (matrix[x, y]) Color.BLACK else Color.WHITE
        return Bitmap.createBitmap(pixels, size, size, Bitmap.Config.RGB_565)
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
