package global.cpay.app.common

import android.content.Context
import android.util.Log

object SecurityManager {

    // Vérifier si le token est expiré (JWT)
    fun isTokenExpired(token: String?): Boolean {
        if (token.isNullOrBlank()) return true
        return try {
            val parts = token.split(".")
            if (parts.size != 3) return true
            val payload = android.util.Base64.decode(
                parts[1].padEnd((parts[1].length + 3) / 4 * 4, '='),
                android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING
            )
            val json = String(payload)
            val expMatch = Regex("\"exp\":(\\d+)").find(json)
            val exp = expMatch?.groupValues?.get(1)?.toLongOrNull() ?: return true
            System.currentTimeMillis() / 1000 > exp - 300 // 5 min avant expiry
        } catch(e: Exception) { true }
    }

    // Valider montant
    fun validateAmount(amount: Double, min: Double = 100.0, max: Double = 5_000_000.0): String? {
        return when {
            amount < min -> "Montant minimum: ${min.toLong()} XAF"
            amount > max -> "Montant maximum: ${max.toLong()} XAF"
            else -> null
        }
    }

    // Valider numéro de téléphone CEMAC
    fun validatePhone(phone: String): String? {
        val cleaned = phone.replace(" ", "").replace("-", "")
        // Accepter aussi un numero local sans indicatif (ex: 066123456 ou 66123456)
        val local = Regex("^0?\\d{8,9}$")
        val patterns = listOf(
            Regex("^\\+242\\d{9}$"),   // Congo Brazzaville
            Regex("^\\+243\\d{9}$"),   // DRC
            Regex("^\\+237\\d{9}$"),   // Cameroun
            Regex("^\\+241\\d{7,8}$"), // Gabon
            Regex("^\\+235\\d{8}$"),   // Tchad
            Regex("^\\+240\\d{9}$"),   // Guinée Équatoriale
        )
        return if (patterns.any { it.matches(cleaned) } || local.matches(cleaned)) null
               else "Numéro invalide"
    }

    // Normalise un numero local en format international +242
    fun normalizePhone(phone: String, defaultCode: String = "+242"): String {
        val cleaned = phone.replace(" ", "").replace("-", "")
        if (cleaned.startsWith("+")) return cleaned
        val digits = cleaned.trimStart('0')
        return defaultCode + digits
    }

    // Sanitizer référence
    fun generateRef(prefix: String): String {
        val ts = System.currentTimeMillis().toString(36).uppercase()
        val rand = (1000..9999).random()
        return "$prefix-$ts-$rand"
    }

    // Vérifier si root détecté (sécurité basique)
    fun isDeviceRooted(): Boolean {
        val paths = listOf("/system/app/Superuser.apk", "/sbin/su", "/system/bin/su",
            "/system/xbin/su", "/data/local/xbin/su", "/data/local/bin/su")
        return paths.any { java.io.File(it).exists() }
    }

    // Log sécurité (en prod, envoyer à un serveur de monitoring)
    fun logSecurityEvent(context: Context, event: String, details: String = "") {
        Log.w("CPay-Security", "[$event] $details")
    }
}
