package global.cpay.app.common

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Lot « dépréciations Android » (2026-11-12) : remplace androidx.security.crypto (EncryptedSharedPreferences, MasterKey),
 * dont toutes les API sont dépréciées depuis la 1.1.0 au profit du Keystore Android utilisé directement.
 *
 * Chaque valeur est chiffrée en AES-256-GCM avec une clé non exportable du Keystore (alias [KEY_ALIAS]), un IV aléatoire
 * par écriture et le nom de l'entrée comme donnée authentifiée (une valeur copiée sous une autre clé ne se déchiffre pas).
 * Le stockage est un SharedPreferences ordinaire contenant « hex(iv) : hex(chiffré+tag) ». Une valeur illisible
 * (clé Keystore régénérée après réinitialisation, fichier altéré) est traitée comme absente : l'utilisateur se reconnecte.
 *
 * La fabrique de clé est injectable pour les tests JVM (clé AES en mémoire, pas de Keystore).
 */
class SecureStore(private val prefs: SharedPreferences, private val keyProvider: () -> SecretKey) {

    companion object {
        private const val KEY_ALIAS = "cpay_session_v2"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128

        /** Magasin applicatif adossé au Keystore Android ([name] = fichier SharedPreferences). */
        fun forContext(context: Context, name: String): SecureStore =
            SecureStore(context.getSharedPreferences(name, Context.MODE_PRIVATE)) { keystoreKey() }

        private fun keystoreKey(): SecretKey {
            val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
            val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
            gen.init(
                KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setRandomizedEncryptionRequired(true)
                    .build()
            )
            return gen.generateKey()
        }

        internal fun hex(bytes: ByteArray): String = buildString(bytes.size * 2) { for (b in bytes) append(String.format("%02x", b)) }
        internal fun unhex(s: String): ByteArray? {
            if (s.length % 2 != 0) return null
            return try { ByteArray(s.length / 2) { i -> s.substring(i * 2, i * 2 + 2).toInt(16).toByte() } } catch (_: NumberFormatException) { null }
        }
    }

    @Volatile private var key: SecretKey? = null
    private fun key(): SecretKey = key ?: synchronized(this) { key ?: keyProvider().also { key = it } }

    private fun encrypt(name: String, plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
        val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return hex(cipher.iv) + ":" + hex(ct)
    }

    private fun decrypt(name: String, stored: String?): String? {
        if (stored.isNullOrEmpty()) return null
        val sep = stored.indexOf(':'); if (sep <= 0) return null
        val iv = unhex(stored.substring(0, sep)) ?: return null
        val ct = unhex(stored.substring(sep + 1)) ?: return null
        if (iv.size != IV_BYTES) return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, iv))
            cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
            String(cipher.doFinal(ct), Charsets.UTF_8)
        } catch (_: Exception) { null }   // AEADBadTagException, clé changée, Keystore indisponible : valeur absente
    }

    fun getString(name: String, default: String? = null): String? = decrypt(name, prefs.getString(name, null)) ?: default
    fun getLong(name: String, default: Long = 0L): Long = getString(name)?.toLongOrNull() ?: default
    fun contains(name: String): Boolean = prefs.contains(name)
    val isEmpty: Boolean get() = prefs.all.isEmpty()

    fun edit(): Editor = Editor()

    inner class Editor internal constructor() {
        private val e = prefs.edit()
        fun putString(name: String, value: String?): Editor = apply { if (value == null) e.remove(name) else e.putString(name, encrypt(name, value)) }
        fun putLong(name: String, value: Long): Editor = apply { e.putString(name, encrypt(name, value.toString())) }
        fun remove(name: String): Editor = apply { e.remove(name) }
        fun clear(): Editor = apply { e.clear() }
        fun apply() = e.apply()
        fun commit(): Boolean = e.commit()
    }
}
