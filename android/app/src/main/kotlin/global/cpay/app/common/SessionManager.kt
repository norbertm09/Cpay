package global.cpay.app.common

import android.content.Context
import android.util.Log

object SessionManager {

    private const val PREF_FILE   = "cplus_session"      // ancien fichier (EncryptedSharedPreferences, migre puis supprime)
    private const val PREF_FILE_V2 = "cplus_session_v2"  // lot depreciations 2026-11-12 : SecureStore (Keystore direct)
    private const val KEY_TOKEN   = "auth_token"
    private const val KEY_REFRESH = "refresh_token"   // WAVE-3 : refresh opaque (rotation)
    private const val KEY_EXPIRES = "token_expires_at" // WAVE-3 : epoch ms d'expiration de l'access
    private const val KEY_PROFILE = "user_profile"
    private const val KEY_TYPE    = "user_type"  // "cardholder" | "merchant"
    private const val KEY_USER_ID = "user_id"
    private const val KEY_NAME    = "user_name"
    private const val KEY_EMAIL   = "user_email"
    private const val KEY_COUNTRY = "user_country" // pays du marchand (ISO-2) : saisie des numeros locaux sans indicatif
    private const val KEY_TERMINAL_ID   = "terminal_id"
    private const val KEY_TERMINAL_NAME = "terminal_name"
    private const val KEY_TERMINAL_SITE = "terminal_site"

    /** Marge avant expiration a partir de laquelle on rafraichit proactivement. */
    const val REFRESH_LEEWAY_MS = 60_000L

    private lateinit var prefs: SecureStore

    private val STRING_KEYS = listOf(KEY_TOKEN, KEY_REFRESH, KEY_PROFILE, KEY_TYPE, KEY_USER_ID, KEY_NAME, KEY_EMAIL,
        KEY_COUNTRY, KEY_TERMINAL_ID, KEY_TERMINAL_NAME, KEY_TERMINAL_SITE)

    fun init(context: Context) {
        prefs = SecureStore.forContext(context, PREF_FILE_V2)
        migrateLegacyIfNeeded(context)
    }

    /**
     * Migration unique depuis l'ancien fichier EncryptedSharedPreferences (androidx.security.crypto, deprecie) :
     * copie des entrees connues dans le nouveau magasin puis suppression de l'ancien fichier. Si l'ancien fichier
     * est illisible (Keystore reinitialise), il est simplement supprime : l'utilisateur se reconnecte et re-appaire.
     * La dependance androidx.security:security-crypto ne sert plus qu'a cette lecture et pourra etre retiree
     * une fois les installations migrees (cf. docs/MOBILE-STORES.md § 1.7).
     */
    @Suppress("DEPRECATION")
    private fun migrateLegacyIfNeeded(context: Context) {
        val legacyFile = java.io.File(context.applicationInfo.dataDir, "shared_prefs/$PREF_FILE.xml")
        if (!legacyFile.exists()) return
        try {
            val masterKey = androidx.security.crypto.MasterKey.Builder(context)
                .setKeyScheme(androidx.security.crypto.MasterKey.KeyScheme.AES256_GCM).build()
            val legacy = androidx.security.crypto.EncryptedSharedPreferences.create(
                context, PREF_FILE, masterKey,
                androidx.security.crypto.EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                androidx.security.crypto.EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
            val e = prefs.edit()
            for (k in STRING_KEYS) legacy.getString(k, null)?.let { e.putString(k, it) }
            legacy.getLong(KEY_EXPIRES, 0L).takeIf { it > 0L }?.let { e.putLong(KEY_EXPIRES, it) }
            e.commit()
            legacy.edit().clear().commit()
            Log.i("SessionManager", "session migree vers le magasin Keystore v2")
        } catch (t: Throwable) {
            Log.w("SessionManager", "ancienne session illisible, ignoree : ${t.javaClass.simpleName}")
        }
        context.deleteSharedPreferences(PREF_FILE)
    }

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(v) = prefs.edit().putString(KEY_TOKEN, v).apply()

    var refreshToken: String?
        get() = prefs.getString(KEY_REFRESH, null)
        set(v) = prefs.edit().putString(KEY_REFRESH, v).apply()

    /** Epoch ms d'expiration de l'access token (0 = inconnu). */
    var expiresAt: Long
        get() = prefs.getLong(KEY_EXPIRES, 0L)
        set(v) = prefs.edit().putLong(KEY_EXPIRES, v).apply()

    var userType: String?
        get() = prefs.getString(KEY_TYPE, null)
        set(v) = prefs.edit().putString(KEY_TYPE, v).apply()

    /** Pays du marchand connecte (ISO-2, ex. CG) ; null si inconnu. */
    var userCountry: String?
        get() = prefs.getString(KEY_COUNTRY, null)
        set(v) = prefs.edit().putString(KEY_COUNTRY, v).apply()

    var userId: String?
        get() = prefs.getString(KEY_USER_ID, null)
        set(v) = prefs.edit().putString(KEY_USER_ID, v).apply()

    var userName: String?
        get() = prefs.getString(KEY_NAME, null)
        set(v) = prefs.edit().putString(KEY_NAME, v).apply()

    var userEmail: String?
        get() = prefs.getString(KEY_EMAIL, null)
        set(v) = prefs.edit().putString(KEY_EMAIL, v).apply()

    var terminalId: String?
        get() = prefs.getString(KEY_TERMINAL_ID, null)
        set(v) { prefs.edit().putString(KEY_TERMINAL_ID, v).commit() }

    var terminalName: String?
        get() = prefs.getString(KEY_TERMINAL_NAME, null)
        set(v) = prefs.edit().putString(KEY_TERMINAL_NAME, v).apply()

    var terminalSite: String?
        get() = prefs.getString(KEY_TERMINAL_SITE, null)
        set(v) = prefs.edit().putString(KEY_TERMINAL_SITE, v).apply()

    val isPaired: Boolean get() = !terminalId.isNullOrEmpty()

    fun clearTerminal() {
        prefs.edit().remove(KEY_TERMINAL_ID).remove(KEY_TERMINAL_NAME)
            .remove(KEY_TERMINAL_SITE).apply()
    }

    val isLoggedIn: Boolean get() = !token.isNullOrBlank()
    val isCardholder: Boolean get() = userType == "cardholder"
    val isMerchant: Boolean get() = userType == "merchant"

    /** Vrai si l'access token expire dans moins de REFRESH_LEEWAY_MS (ou date inconnue). */
    val isAccessTokenExpiringSoon: Boolean
        get() {
            val exp = expiresAt
            if (exp <= 0L) return false
            return System.currentTimeMillis() >= exp - REFRESH_LEEWAY_MS
        }

    /**
     * Enregistre une nouvelle paire access/refresh (login, 2FA, inscription, refresh).
     * Ecriture synchrone (commit) : les intercepteurs OkHttp relisent immediatement.
     */
    fun saveTokens(accessToken: String, refreshToken: String?, expiresInSec: Int) {
        val ttl = if (expiresInSec > 0) expiresInSec else 900
        val editor = prefs.edit()
            .putString(KEY_TOKEN, accessToken)
            .putLong(KEY_EXPIRES, System.currentTimeMillis() + ttl * 1000L)
        if (!refreshToken.isNullOrBlank()) editor.putString(KEY_REFRESH, refreshToken)
        editor.commit()
    }

    fun saveSession(
        token: String, refreshToken: String?, expiresInSec: Int,
        userId: String, userName: String, email: String, type: String, country: String? = null,
    ) {
        saveTokens(token, refreshToken, expiresInSec)
        this.userId    = userId
        this.userName  = userName
        this.userEmail = email
        this.userType  = type
        this.userCountry = country?.takeIf { it.isNotBlank() }?.uppercase()
    }

    fun clearSession() {
        // Efface la session utilisateur MAIS preserve l'appairage du device (terminal)
        prefs.edit()
            .remove(KEY_TOKEN).remove(KEY_REFRESH).remove(KEY_EXPIRES)
            .remove(KEY_PROFILE).remove(KEY_TYPE).remove(KEY_COUNTRY)
            .remove(KEY_USER_ID).remove(KEY_NAME).remove(KEY_EMAIL)
            .commit()
    }
}
