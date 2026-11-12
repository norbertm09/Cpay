package global.cpay.app.common

import android.content.SharedPreferences
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** SecureStore sur JVM : clé AES en mémoire (pas de Keystore) et SharedPreferences factice. */
class SecureStoreTest {

    /** SharedPreferences minimal en mémoire (android.jar est stubbé en test unitaire). */
    private class FakePrefs : SharedPreferences {
        val map = LinkedHashMap<String, Any?>()
        override fun getAll(): MutableMap<String, *> = LinkedHashMap(map)
        override fun getString(key: String?, defValue: String?): String? = map[key] as? String ?: defValue
        override fun getStringSet(key: String?, defValues: MutableSet<String>?): MutableSet<String>? = defValues
        override fun getInt(key: String?, defValue: Int) = defValue
        override fun getLong(key: String?, defValue: Long) = defValue
        override fun getFloat(key: String?, defValue: Float) = defValue
        override fun getBoolean(key: String?, defValue: Boolean) = defValue
        override fun contains(key: String?) = map.containsKey(key)
        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            private val pending = LinkedHashMap<String, Any?>(); private var clear = false
            override fun putString(key: String?, value: String?) = apply { pending[key!!] = value }
            override fun putStringSet(key: String?, values: MutableSet<String>?) = this
            override fun putInt(key: String?, value: Int) = this
            override fun putLong(key: String?, value: Long) = this
            override fun putFloat(key: String?, value: Float) = this
            override fun putBoolean(key: String?, value: Boolean) = this
            override fun remove(key: String?) = apply { pending[key!!] = REMOVE }
            override fun clear() = apply { clear = true }
            override fun commit(): Boolean { apply(); return true }
            override fun apply() { if (clear) map.clear(); for ((k, v) in pending) if (v === REMOVE) map.remove(k) else map[k] = v }
        }
        override fun registerOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) {}
        override fun unregisterOnSharedPreferenceChangeListener(l: SharedPreferences.OnSharedPreferenceChangeListener?) {}
        companion object { val REMOVE = Any() }
    }

    private fun jvmKey(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

    @Test fun `ecriture, lecture, suppression`() {
        val prefs = FakePrefs(); val store = SecureStore(prefs) { jvmKey() }
        store.edit().putString("auth_token", "jwt-fixture-1234").putLong("token_expires_at", 1_700_000_000_000L).apply()
        assertEquals("jwt-fixture-1234", store.getString("auth_token"))
        assertEquals(1_700_000_000_000L, store.getLong("token_expires_at"))
        assertTrue(store.contains("auth_token"))
        store.edit().remove("auth_token").commit()
        assertNull(store.getString("auth_token")); assertFalse(store.contains("auth_token"))
        assertEquals("defaut", store.getString("absent", "defaut"))
    }

    @Test fun `le fichier ne contient jamais la valeur en clair et chaque ecriture a son propre IV`() {
        val prefs = FakePrefs(); val store = SecureStore(prefs) { jvmKey() }
        store.edit().putString("refresh_token", "secret-refresh").apply()
        val first = prefs.map["refresh_token"] as String
        assertFalse(first.contains("secret-refresh")); assertTrue(first.matches(Regex("[0-9a-f]{24}:[0-9a-f]+")))
        store.edit().putString("refresh_token", "secret-refresh").apply()
        assertNotEquals(first, prefs.map["refresh_token"])
    }

    @Test fun `une valeur copiee sous une autre cle ou alteree est traitee comme absente`() {
        val prefs = FakePrefs(); val store = SecureStore(prefs) { jvmKey() }
        store.edit().putString("user_email", "m@example.test").apply()
        prefs.map["user_name"] = prefs.map["user_email"]             // nom de l'entree = donnee authentifiee
        assertNull(store.getString("user_name"))
        prefs.map["user_email"] = (prefs.map["user_email"] as String).dropLast(2) + "00"
        assertNull(store.getString("user_email"))
        prefs.map["user_id"] = "pas-du-tout-un-chiffre"
        assertNull(store.getString("user_id"))
    }

    @Test fun `une autre cle Keystore rend les anciennes valeurs absentes sans lever`() {
        val prefs = FakePrefs()
        SecureStore(prefs) { jvmKey() }.edit().putString("auth_token", "x").apply()
        assertNull(SecureStore(prefs) { jvmKey() }.getString("auth_token"))
    }

    @Test fun `hex aller-retour`() {
        val bytes = ByteArray(40) { (it * 7).toByte() }
        assertEquals(bytes.toList(), SecureStore.unhex(SecureStore.hex(bytes))!!.toList())
        assertNull(SecureStore.unhex("abc")); assertNull(SecureStore.unhex("zz"))
    }
}
