package global.cpay.app.onboarding

import android.content.Intent
import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import global.cpay.app.R
import global.cpay.app.databinding.ActivityProfileSelectBinding

class ProfileSelectActivity : AppCompatActivity() {

    private lateinit var binding: ActivityProfileSelectBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityProfileSelectBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnCardholder.setOnClickListener {
            startLogin("cardholder")
        }

        binding.btnMerchant.setOnClickListener {
            startLogin("merchant")
        }
    }

    private fun startLogin(type: String) {
        val intent = Intent(this, LoginActivity::class.java)
        intent.putExtra("user_type", type)
        startActivity(intent)
    }
}
