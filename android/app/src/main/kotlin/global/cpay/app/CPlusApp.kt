package global.cpay.app

import android.app.Application
import global.cpay.app.common.ApiClient
import global.cpay.app.common.SessionManager

class CPlusApp : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
        SessionManager.init(this)
        ApiClient.init(this)
    }
    companion object {
        lateinit var instance: CPlusApp
            private set
    }
}
