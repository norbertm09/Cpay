package global.cpay.app.cardholder

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import global.cpay.app.R
import global.cpay.app.cardholder.fragments.PayHubFragment
import global.cpay.app.cardholder.fragments.CardsFragment
import global.cpay.app.cardholder.fragments.TopUpFragment
import global.cpay.app.cardholder.fragments.DashboardFragment
import global.cpay.app.cardholder.fragments.PayFragment
import global.cpay.app.cardholder.fragments.ProfileFragment
import global.cpay.app.cardholder.fragments.TransactionsFragment
import global.cpay.app.databinding.ActivityCardholderMainBinding

class CardholderMainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityCardholderMainBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityCardholderMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        loadFragment(DashboardFragment())

        binding.bottomNav.setOnItemSelectedListener { item ->
            val fragment: Fragment = when (item.itemId) {
                R.id.nav_dashboard    -> DashboardFragment()
                R.id.nav_cards        -> CardsFragment()
                R.id.nav_topup        -> TopUpFragment()
                R.id.nav_pay          -> PayHubFragment()
                R.id.nav_transactions -> TransactionsFragment()
                R.id.nav_profile      -> ProfileFragment()
                else -> DashboardFragment()
            }
            loadFragment(fragment)
            true
        }
    }

    private fun loadFragment(fragment: Fragment) {
        supportFragmentManager.beginTransaction()
            .replace(R.id.fragment_container, fragment)
            .commit()
    }
}
