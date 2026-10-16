package global.cpay.app.common.ui

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

object Net {
    /** Vrai si une connexion reseau (Wi-Fi, mobile, Ethernet) est active. */
    fun isOnline(context: Context): Boolean {
        return try {
            val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
        } catch (_: Exception) { true }
    }
}
