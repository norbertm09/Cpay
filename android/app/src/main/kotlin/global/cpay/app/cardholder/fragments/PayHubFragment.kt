package global.cpay.app.cardholder.fragments

import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import global.cpay.app.R
import global.cpay.app.databinding.FragmentPayHubBinding

class PayHubFragment : Fragment() {

    private var _b: FragmentPayHubBinding? = null
    private val b get() = _b!!

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentPayHubBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        b.tabPay.setOnClickListener  { switch(true) }
        b.tabBank.setOnClickListener { switch(false) }
        switch(true)
    }

    private fun switch(isPay: Boolean) {
        val on  = Color.parseColor("#12b6c7")
        val off = Color.parseColor("#5a6677")

        b.tabPay.setTextColor(if (isPay) on else off)
        b.tabPay.setTypeface(null, if (isPay) Typeface.BOLD else Typeface.NORMAL)
        b.tabBank.setTextColor(if (!isPay) on else off)
        b.tabBank.setTypeface(null, if (!isPay) Typeface.BOLD else Typeface.NORMAL)

        b.indicatorPay.visibility  = if (isPay) View.VISIBLE else View.INVISIBLE
        b.indicatorBank.visibility = if (!isPay) View.VISIBLE else View.INVISIBLE

        childFragmentManager.beginTransaction()
            .replace(R.id.sub_container, if (isPay) PayFragment() else TransferFragment())
            .commit()
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
