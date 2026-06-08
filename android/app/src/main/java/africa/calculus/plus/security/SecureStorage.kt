package africa.calculus.plus.security

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class SecureStorage @Inject constructor(@ApplicationContext private val context: Context) {

    private val prefs by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(context, "calculus_secure_prefs", masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM)
    }

    fun saveSession(accessToken: String, refreshToken: String, userId: String,
                    merchantId: String, businessName: String, firstName: String?,
                    currency: String, kybLevel: Int) {
        prefs.edit()
            .putString("access_token",  accessToken)
            .putString("refresh_token", refreshToken)
            .putString("user_id",       userId)
            .putString("merchant_id",   merchantId)
            .putString("business_name", businessName)
            .putString("first_name",    firstName)
            .putString("currency",      currency)
            .putInt("kyb_level",        kybLevel)
            .apply()
    }

    fun getAccessToken()  : String? = prefs.getString("access_token",  null)
    fun getRefreshToken() : String? = prefs.getString("refresh_token", null)
    fun getMerchantId()   : String? = prefs.getString("merchant_id",   null)
    fun getBusinessName() : String? = prefs.getString("business_name", null)
    fun getFirstName()    : String? = prefs.getString("first_name",    null)
    fun getCurrency()     : String? = prefs.getString("currency",      null)
    fun getKybLevel()     : Int     = prefs.getInt("kyb_level",        0)
    fun getDeviceId()     : String? = prefs.getString("device_id",     null)
    fun isLoggedIn()      : Boolean = !getAccessToken().isNullOrBlank()
    fun clearSession()              { prefs.edit().clear().apply() }
}
