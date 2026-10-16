package global.cpay.app.merchant

import android.content.Context
import android.text.InputFilter
import android.text.InputType
import android.util.Log
import android.view.LayoutInflater
import android.widget.TextView
import android.widget.Toast
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.ApiErrors
import global.cpay.app.common.SessionManager
import kotlinx.coroutines.suspendCancellableCoroutine
import retrofit2.Response
import kotlin.coroutines.resume

/**
 * Confirmation forte (WAVE-4, docs/CAISSE-API.md §6) partagee par Retirer, Transferer
 * et l'enregistrement du wallet. WAVE-5 : feuille inferieure Material 3.
 *
 *  - `{ "code": "<TOTP 6 chiffres>" }` si le 2FA du compte est actif, sinon
 *    `{ "password": "<mot de passe>" }` ;
 *  - la methode est connue via `GET /merchant/auth/me` (`user.mfaEnabled`), mise en
 *    cache pour la session ; sur `428 STEP_UP_REQUIRED { methods }` on relit la methode
 *    annoncee par le serveur et on redemande (3 tentatives maximum, puis abandon).
 */
object StepUp {

    private const val TAG = "CPay-StepUp"
    private const val MAX_ATTEMPTS = 3

    /** null = inconnu (non encore interroge). Invalide a la deconnexion. */
    @Volatile var mfaEnabled: Boolean? = null
    @Volatile private var cachedFor: String? = null

    fun reset() { mfaEnabled = null; cachedFor = null }

    /** "totp" | "password" — interroge /merchant/auth/me une fois par session. */
    suspend fun resolveMethod(): String {
        val uid = SessionManager.userId
        if (mfaEnabled == null || cachedFor != uid) {
            try {
                val r = ApiClient.api.merchantMe()
                val on = r.body()?.effectiveUser?.mfaEnabled
                if (r.isSuccessful && on != null) { mfaEnabled = on; cachedFor = uid }
            } catch (e: Exception) {
                Log.w(TAG, "auth/me: ${e.message}")
            }
        }
        return if (mfaEnabled == true) "totp" else "password"
    }

    /**
     * Affiche la feuille de confirmation et rend l'objet `confirm`
     * (`{code}` ou `{password}`), ou null si l'utilisateur annule.
     */
    suspend fun ask(ctx: Context, method: String, title: String? = null): Map<String, String>? =
        suspendCancellableCoroutine { cont ->
            val isTotp = method == "totp"
            val dlg = BottomSheetDialog(ctx)
            val v = LayoutInflater.from(ctx).inflate(R.layout.sheet_step_up, null, false)
            v.findViewById<TextView>(R.id.tv_stepup_title).text =
                ctx.getString(if (isTotp) R.string.stepup_totp_title else R.string.stepup_password_title)
            v.findViewById<TextView>(R.id.tv_stepup_operation).text =
                title ?: ctx.getString(R.string.stepup_title_default)
            v.findViewById<TextView>(R.id.tv_stepup_body).text =
                ctx.getString(if (isTotp) R.string.stepup_totp_body else R.string.stepup_password_body)
            val til = v.findViewById<TextInputLayout>(R.id.til_stepup)
            val et  = v.findViewById<TextInputEditText>(R.id.et_stepup)
            til.hint = ctx.getString(if (isTotp) R.string.stepup_totp_hint else R.string.stepup_password_hint)
            if (isTotp) {
                et.inputType = InputType.TYPE_CLASS_NUMBER
                et.filters = arrayOf(InputFilter.LengthFilter(6))
                et.textSize = 26f
                et.letterSpacing = 0.3f
                til.endIconMode = TextInputLayout.END_ICON_NONE
            } else {
                et.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                til.endIconMode = TextInputLayout.END_ICON_PASSWORD_TOGGLE
            }

            var answered = false
            fun finish(confirm: Map<String, String>?) {
                if (answered) return
                answered = true
                try { dlg.dismiss() } catch (_: Exception) {}
                if (cont.isActive) cont.resume(confirm)
            }
            v.findViewById<MaterialButton>(R.id.btn_stepup_confirm).setOnClickListener {
                val value = et.text?.toString()?.trim() ?: ""
                if (isTotp && !Regex("^\\d{6}$").matches(value)) {
                    til.error = ctx.getString(R.string.stepup_error_6); return@setOnClickListener
                }
                if (!isTotp && value.isEmpty()) {
                    til.error = ctx.getString(R.string.stepup_error_pwd); return@setOnClickListener
                }
                til.error = null
                finish(if (isTotp) mapOf("code" to value) else mapOf("password" to value))
            }
            v.findViewById<MaterialButton>(R.id.btn_stepup_cancel).setOnClickListener { finish(null) }
            dlg.setOnDismissListener { finish(null) }
            dlg.setOnShowListener { et.requestFocus() }
            cont.invokeOnCancellation { try { dlg.dismiss() } catch (_: Exception) {} }
            dlg.setContentView(v)
            dlg.show()
        }

    /**
     * Enchaine : methode → feuille → appel → (428 → relecture de `methods` → redemande).
     * Rend la derniere reponse (jamais un 428 non traite), ou null si annule / abandon.
     */
    suspend fun <T> run(
        ctx: Context,
        title: String? = null,
        call: suspend (confirm: Map<String, String>) -> Response<T>,
    ): Response<T>? {
        var method = resolveMethod()
        repeat(MAX_ATTEMPTS) { attempt ->
            val confirm = ask(ctx, method, title) ?: return null
            val r = call(confirm)
            if (r.code() != 428) return r
            val e = ApiErrors.of(r)
            val announced = e.methods?.firstOrNull()
            if (announced != null) { method = announced; mfaEnabled = announced == "totp" }
            val left = MAX_ATTEMPTS - attempt - 1
            Toast.makeText(ctx,
                if (left > 0) ctx.getString(R.string.stepup_refused_left_fmt, left) else ctx.getString(R.string.stepup_refused),
                Toast.LENGTH_SHORT).show()
        }
        return null
    }
}
