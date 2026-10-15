package global.cpay.app.onboarding

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.appcompat.app.AppCompatActivity
import global.cpay.app.R
import global.cpay.app.cardholder.CardholderMainActivity
import global.cpay.app.common.SessionManager
import global.cpay.app.merchant.MerchantMainActivity

class SplashActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_splash)

        Handler(Looper.getMainLooper()).postDelayed({
            val next = when {
                SessionManager.isLoggedIn && SessionManager.isCardholder ->
                    Intent(this, CardholderMainActivity::class.java)
                SessionManager.isLoggedIn && SessionManager.isMerchant ->
                    Intent(this, MerchantMainActivity::class.java)
                else ->
                    Intent(this, ProfileSelectActivity::class.java)
            }
            startActivity(next)
            finish()
        }, 2000)
    }
}
