package global.cpay.app.common

// Lot Android P2 (audit 2026-11-02 P2-1) : isTokenExpired, isDeviceRooted et logSecurityEvent, jamais appeles,
// sont retires (fausse impression de controle). Fonctions pures, couvertes par SecurityManagerTest.
object SecurityManager {

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
    /** Lot 4 (audit 2026-11-02 mobile P1-1) : cle d'idempotence = UUID, conservee par l'ecran tant que le resultat est inconnu. */
    fun newIdempotencyKey(): String = java.util.UUID.randomUUID().toString()

    fun generateRef(prefix: String): String {
        val ts = System.currentTimeMillis().toString(36).uppercase()
        val rand = (1000..9999).random()
        return "$prefix-$ts-$rand"
    }

}
