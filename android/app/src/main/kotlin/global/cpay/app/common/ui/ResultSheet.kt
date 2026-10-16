package global.cpay.app.common.ui

import android.content.Context
import android.content.res.ColorStateList
import android.view.LayoutInflater
import android.view.View
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.button.MaterialButton
import global.cpay.app.R

/** Feuille de resultat (succes / avertissement / erreur) partagee par Retirer, Transferer, Journal. */
object ResultSheet {

    enum class Kind { SUCCESS, PENDING, ERROR, INFO }

    class Spec(
        val kind: Kind,
        val title: String,
        val amount: String? = null,
        val body: String? = null,
        val rows: List<Pair<String, String?>> = emptyList(),
        val primaryLabel: String? = null,
        val primary: (() -> Unit)? = null,
        val secondaryLabel: String? = null,
        val secondary: (() -> Unit)? = null,
        val onDismiss: (() -> Unit)? = null,
    )

    fun show(ctx: Context, spec: Spec): BottomSheetDialog {
        val dlg = BottomSheetDialog(ctx)
        val v = LayoutInflater.from(ctx).inflate(R.layout.sheet_result, null, false)
        val icon = v.findViewById<ImageView>(R.id.iv_result_icon)
        val (res, fg, bg) = when (spec.kind) {
            Kind.SUCCESS -> Triple(R.drawable.ic_check_circle, R.color.success_main, R.color.success_container)
            Kind.PENDING -> Triple(R.drawable.ic_pending,      R.color.warn_main,    R.color.warn_container)
            Kind.ERROR   -> Triple(R.drawable.ic_error,        R.color.error_main,   R.color.error_container)
            Kind.INFO    -> Triple(R.drawable.ic_info,         R.color.brand_primary, R.color.primary_container)
        }
        icon.setImageResource(res)
        icon.imageTintList = ColorStateList.valueOf(ContextCompat.getColor(ctx, fg))
        icon.backgroundTintList = ColorStateList.valueOf(ContextCompat.getColor(ctx, bg))

        v.findViewById<TextView>(R.id.tv_result_title).text = spec.title
        v.findViewById<TextView>(R.id.tv_result_amount).apply {
            visibility = if (spec.amount.isNullOrBlank()) View.GONE else View.VISIBLE
            text = spec.amount ?: ""
        }
        v.findViewById<TextView>(R.id.tv_result_body).apply {
            visibility = if (spec.body.isNullOrBlank()) View.GONE else View.VISIBLE
            text = spec.body ?: ""
        }
        val rows = v.findViewById<LinearLayout>(R.id.layout_result_rows)
        rows.removeAllViews()
        spec.rows.filter { !it.second.isNullOrBlank() }.forEach { (label, value) ->
            val row = LayoutInflater.from(ctx).inflate(R.layout.item_detail_row, rows, false)
            row.findViewById<TextView>(R.id.tv_row_label).text = label
            row.findViewById<TextView>(R.id.tv_row_value).text = value
            rows.addView(row)
        }
        rows.visibility = if (rows.childCount == 0) View.GONE else View.VISIBLE

        val btnPrimary = v.findViewById<MaterialButton>(R.id.btn_result_primary)
        btnPrimary.text = spec.primaryLabel ?: ctx.getString(R.string.close)
        btnPrimary.setOnClickListener { dlg.dismiss(); spec.primary?.invoke() }

        val btnSecondary = v.findViewById<MaterialButton>(R.id.btn_result_secondary)
        if (spec.secondaryLabel == null) btnSecondary.visibility = View.GONE
        else {
            btnSecondary.text = spec.secondaryLabel
            btnSecondary.setOnClickListener { dlg.dismiss(); spec.secondary?.invoke() }
        }
        spec.onDismiss?.let { cb -> dlg.setOnDismissListener { cb() } }
        dlg.setContentView(v)
        dlg.show()
        return dlg
    }
}
