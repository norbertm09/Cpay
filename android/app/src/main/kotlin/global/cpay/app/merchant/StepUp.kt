package global.cpay.app.merchant

import android.content.Context
import android.text.InputType
import android.util.Log
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import global.cpay.app.common.ApiClient
import global.cpay.app.common.ApiErrors
import global.cpay.app.common.SessionManager
import kotlinx.coroutines.suspendCancellableCoroutine
import retrofit2.Response
import kotlin.coroutines.resume

/**
 * Confirmation forte (WAVE-4, docs/CAISSE-API.md §6) partagee par Retirer, Transferer
 * et l'enregistrement du wallet.
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
     * Affiche la boite de dialogue de confirmation et rend l'objet `confirm`
     * (`{code}` ou `{password}`), ou null si l'utilisateur annule.
     */
    suspend fun ask(ctx: Context, method: String, title: String = "Confirmation requise"): Map<String, String>? =
        suspendCancellableCoroutine { cont ->
            val isTotp = method == "totp"
            val pad = (20 * ctx.resources.displayMetrics.density).toInt()
            val box = LinearLayout(ctx).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(pad, pad / 2, pad, 0)
            }
            box.addView(TextView(ctx).apply {
                text = if (isTotp) "Saisissez le code à 6 chiffres de votre application d'authentification."
                       else "Saisissez votre mot de passe pour confirmer l'opération."
                textSize = 14f
                setPadding(0, 0, 0, pad / 2)
            })
            val input = EditText(ctx).apply {
                hint = if (isTotp) "000000" else "Mot de passe"
                inputType = if (isTotp) InputType.TYPE_CLASS_NUMBER
                            else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
                if (isTotp) filters = arrayOf(android.text.InputFilter.LengthFilter(6))
                textSize = if (isTotp) 24f else 16f
                letterSpacing = if (isTotp) 0.3f else 0f
            }
            box.addView(input)

            var answered = false
            val dlg = AlertDialog.Builder(ctx)
                .setTitle(if (isTotp) "🔐 $title — code 2FA" else "🔐 $title — mot de passe")
                .setView(box)
                .setPositiveButton("Confirmer", null)
                .setNegativeButton("Annuler") { d, _ -> d.dismiss() }
                .create()
            dlg.setOnDismissListener {
                if (!answered && cont.isActive) { answered = true; cont.resume(null) }
            }
            dlg.setOnShowListener {
                input.requestFocus()
                dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                    val v = input.text.toString().trim()
                    if (isTotp && !Regex("^\\d{6}$").matches(v)) {
                        input.error = "6 chiffres attendus"; return@setOnClickListener
                    }
                    if (!isTotp && v.isEmpty()) { input.error = "Mot de passe requis"; return@setOnClickListener }
                    answered = true
                    val confirm = if (isTotp) mapOf("code" to v) else mapOf("password" to v)
                    dlg.dismiss()
                    if (cont.isActive) cont.resume(confirm)
                }
            }
            cont.invokeOnCancellation { try { dlg.dismiss() } catch (_: Exception) {} }
            dlg.show()
        }

    /**
     * Enchaine : methode → dialogue → appel → (428 → relecture de `methods` → redemande).
     * Rend la derniere reponse (jamais un 428 non traite), ou null si annule / abandon.
     */
    suspend fun <T> run(
        ctx: Context,
        title: String = "Confirmation requise",
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
                if (left > 0) "Confirmation refusée — ${left} essai(s) restant(s)" else "Confirmation refusée",
                Toast.LENGTH_SHORT).show()
        }
        return null
    }
}
