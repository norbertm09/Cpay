package global.cpay.app.cardholder

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import global.cpay.app.R

class QRScanActivity : AppCompatActivity() {

    private lateinit var barcodeView: DecoratedBarcodeView
    private var scanning = true

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_qr_scan)

        barcodeView = findViewById(R.id.barcode_scanner)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), 100)
        } else {
            startScanning()
        }

        findViewById<android.widget.TextView>(R.id.tv_cancel).setOnClickListener { finish() }
    }

    private fun startScanning() {
        barcodeView.decodeContinuous(object : BarcodeCallback {
            override fun barcodeResult(result: BarcodeResult) {
                if (!scanning) return
                scanning = false
                val text = result.text ?: return
                handleQRResult(text)
            }
        })
    }

    private fun handleQRResult(text: String) {
        // Format attendu: cplus://pay?amount=5000&merchant=xxx
        // ou https://pay.c-pay.global/qr/xxx?amount=5000
        Toast.makeText(this, "QR scanné: $text", Toast.LENGTH_SHORT).show()
        val intent = Intent(this, PaymentConfirmActivity::class.java)
        intent.putExtra("qr_data", text)
        startActivity(intent)
        finish()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 100 && grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            startScanning()
        } else {
            Toast.makeText(this, "Permission caméra requise", Toast.LENGTH_SHORT).show()
            finish()
        }
    }

    override fun onResume()  { super.onResume();  barcodeView.resume() }
    override fun onPause()   { super.onPause();   barcodeView.pause() }
    override fun onDestroy() { super.onDestroy(); barcodeView.pause() }
}
