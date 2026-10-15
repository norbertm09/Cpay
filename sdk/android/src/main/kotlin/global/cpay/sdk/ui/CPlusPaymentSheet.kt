package global.cpay.sdk.ui

import android.app.Activity
import android.app.Dialog
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.Window
import android.widget.*
import global.cpay.sdk.CPlus
import global.cpay.sdk.R
import global.cpay.sdk.models.*

object CPlusPaymentSheet {

    private val mainHandler = Handler(Looper.getMainLooper())

    fun show(
        activity:  Activity,
        request:   CPlusPaymentRequest,
        onSuccess: (CPlusTransaction) -> Unit,
        onError:   (CPlusError) -> Unit,
        onPending: ((String) -> Unit)? = null
    ) {
        mainHandler.post {
            val dialog = Dialog(activity)
            dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
            dialog.setContentView(R.layout.cplus_payment_sheet)
            dialog.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            dialog.setCancelable(true)

            // Remplir les données
            dialog.findViewById<TextView>(R.id.tv_amount)?.text =
                "${String.format("%,.0f", request.amount)} ${request.currency}"
            dialog.findViewById<TextView>(R.id.tv_reference)?.text = "Réf: ${request.reference}"

            // Spinner méthodes
            val methods  = listOf("Airtel Money", "MTN MoMo")
            val spinner  = dialog.findViewById<Spinner>(R.id.spinner_method)
            spinner?.adapter = ArrayAdapter(activity, android.R.layout.simple_spinner_dropdown_item, methods)

            // Champ téléphone
            val etPhone  = dialog.findViewById<EditText>(R.id.et_phone)
            val btnPay   = dialog.findViewById<Button>(R.id.btn_pay)
            val btnCancel = dialog.findViewById<Button>(R.id.btn_cancel)
            val progressBar = dialog.findViewById<ProgressBar>(R.id.progress_bar)

            btnCancel?.setOnClickListener {
                dialog.dismiss()
                onError(CPlusError.cancelled())
            }

            btnPay?.setOnClickListener {
                val phone = etPhone?.text?.toString()?.trim() ?: ""
                if (phone.isEmpty()) {
                    Toast.makeText(activity, "Numéro requis", Toast.LENGTH_SHORT).show()
                    return@setOnClickListener
                }

                progressBar?.visibility = View.VISIBLE
                btnPay.isEnabled = false
                btnCancel?.isEnabled = false

                val method = when (spinner?.selectedItemPosition) {
                    0    -> PaymentMethod.AIRTEL_MONEY
                    1    -> PaymentMethod.MTN_MOMO
                    else -> PaymentMethod.AIRTEL_MONEY
                }

                val payRequest = request.copy(phone = phone, method = method)

                CPlus.api?.collect(payRequest,
                    onSuccess = { txn ->
                        mainHandler.post {
                            progressBar?.visibility = View.GONE
                            dialog.dismiss()
                            showSuccessDialog(activity, txn)
                            onSuccess(txn)
                        }
                    },
                    onError = { err ->
                        mainHandler.post {
                            progressBar?.visibility = View.GONE
                            btnPay.isEnabled = true
                            btnCancel?.isEnabled = true
                            Toast.makeText(activity, err.message, Toast.LENGTH_LONG).show()
                            onError(err)
                        }
                    }
                )
            }

            dialog.show()
            dialog.window?.setLayout(
                (activity.resources.displayMetrics.widthPixels * 0.92).toInt(),
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
        }
    }

    fun showQRScanner(
        activity: Activity,
        onResult: (String) -> Unit,
        onError:  (CPlusError) -> Unit
    ) {
        // Déléguer à CPlusQRScannerActivity
        mainHandler.post {
            Toast.makeText(activity, "Scan QR — démarrage caméra…", Toast.LENGTH_SHORT).show()
            // En production: startActivity(Intent(activity, CPlusQRScannerActivity::class.java))
            onResult("DEMO-MERCHANT-001")
        }
    }

    private fun showSuccessDialog(activity: Activity, txn: CPlusTransaction) {
        val dialog = Dialog(activity)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        dialog.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        dialog.setCancelable(true)

        val layout = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 48)
            setBackgroundResource(android.R.drawable.dialog_holo_light_frame)
        }

        layout.addView(TextView(activity).apply {
            text = "✅ Paiement réussi"
            textSize = 20f
            setTextColor(Color.parseColor("#00c896"))
            gravity = android.view.Gravity.CENTER
        })

        layout.addView(TextView(activity).apply {
            text = "${String.format("%,.0f", txn.amount)} XAF"
            textSize = 28f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            gravity = android.view.Gravity.CENTER
            setPadding(0, 16, 0, 8)
        })

        layout.addView(TextView(activity).apply {
            text = "Réf: ${txn.reference}"
            textSize = 13f
            setTextColor(Color.parseColor("#5a6677"))
            gravity = android.view.Gravity.CENTER
            setPadding(0, 0, 0, 24)
        })

        layout.addView(Button(activity).apply {
            text = "Fermer"
            setBackgroundColor(Color.parseColor("#12b6c7"))
            setTextColor(Color.WHITE)
            setOnClickListener { dialog.dismiss() }
        })

        dialog.setContentView(layout)
        dialog.show()
    }
}
