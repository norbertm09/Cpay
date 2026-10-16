package global.cpay.app.common.ui

import android.content.Context
import android.content.SharedPreferences
import global.cpay.app.CPlusApp

/**
 * Preferences d'interface (WAVE-5) : non sensibles, hors session chiffree.
 * Solde masque, aides fermees, verrou biometrique, appairage ignore.
 */
object UiPrefs {
    private const val FILE = "cpay_ui"
    private const val KEY_BALANCE_HIDDEN  = "balance_hidden"
    private const val KEY_HINTS_DISMISSED = "hints_dismissed"
    private const val KEY_BIOMETRIC_LOCK  = "biometric_lock"
    private const val KEY_PAIRING_SKIPPED = "pairing_skipped"

    private val prefs: SharedPreferences
        get() = CPlusApp.instance.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    var balanceHidden: Boolean
        get() = prefs.getBoolean(KEY_BALANCE_HIDDEN, false)
        set(v) = prefs.edit().putBoolean(KEY_BALANCE_HIDDEN, v).apply()

    var biometricLock: Boolean
        get() = prefs.getBoolean(KEY_BIOMETRIC_LOCK, false)
        set(v) = prefs.edit().putBoolean(KEY_BIOMETRIC_LOCK, v).apply()

    var pairingSkipped: Boolean
        get() = prefs.getBoolean(KEY_PAIRING_SKIPPED, false)
        set(v) = prefs.edit().putBoolean(KEY_PAIRING_SKIPPED, v).apply()

    fun isHintDismissed(key: String): Boolean =
        prefs.getStringSet(KEY_HINTS_DISMISSED, emptySet())?.contains(key) == true

    fun dismissHint(key: String) {
        val set = (prefs.getStringSet(KEY_HINTS_DISMISSED, emptySet()) ?: emptySet()).toMutableSet()
        set.add(key)
        prefs.edit().putStringSet(KEY_HINTS_DISMISSED, set).apply()
    }

    /** A la deconnexion : les aides et le verrou restent, le solde redevient visible. */
    fun onLogout() { balanceHidden = false }
}
