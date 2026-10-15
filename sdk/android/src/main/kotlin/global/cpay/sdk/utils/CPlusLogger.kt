package global.cpay.sdk.utils

import android.util.Log

object CPlusLogger {
    var enabled: Boolean = false
    private const val TAG = "CPlus SDK"

    fun log(message: String) {
        if (enabled) Log.d(TAG, message)
    }

    fun error(message: String, throwable: Throwable? = null) {
        if (enabled) Log.e(TAG, message, throwable)
    }
}
