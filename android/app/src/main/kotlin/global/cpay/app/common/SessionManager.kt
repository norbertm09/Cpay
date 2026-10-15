package global.cpay.app.common

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

object SessionManager {

    private const val PREF_FILE   = "cplus_session"
    private const val KEY_TOKEN   = "auth_token"
    private const val KEY_PROFILE = "user_profile"
    private const val KEY_TYPE    = "user_type"  // "cardholder" | "merchant"
    private const val KEY_USER_ID = "user_id"
    private const val KEY_NAME    = "user_name"
    private const val KEY_EMAIL   = "user_email"
    private const val KEY_TERMINAL_ID   = "terminal_id"
    private const val KEY_TERMINAL_NAME = "terminal_name"
    private const val KEY_TERMINAL_SITE = "terminal_site"

    private lateinit var prefs: android.content.SharedPreferences

    fun init(context: Context) {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        prefs = EncryptedSharedPreferences.create(
            context, PREF_FILE, masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    var token: String?
        get() = prefs.getString(KEY_TOKEN, null)
        set(v) = prefs.edit().putString(KEY_TOKEN, v).apply()

    var userType: String?
        get() = prefs.getString(KEY_TYPE, null)
        set(v) = prefs.edit().putString(KEY_TYPE, v).apply()

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

    fun saveSession(token: String, userId: String, userName: String, email: String, type: String) {
        this.token     = token
        this.userId    = userId
        this.userName  = userName
        this.userEmail = email
        this.userType  = type
    }

    fun clearSession() {
        // Efface la session utilisateur MAIS preserve l'appairage du device (terminal)
        prefs.edit()
            .remove(KEY_TOKEN).remove(KEY_PROFILE).remove(KEY_TYPE)
            .remove(KEY_USER_ID).remove(KEY_NAME).remove(KEY_EMAIL)
            .commit()
    }
}
