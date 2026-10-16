package global.cpay.app.merchant.fragments

import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import global.cpay.app.BuildConfig
import global.cpay.app.R
import global.cpay.app.common.ApiClient
import global.cpay.app.common.SessionManager
import global.cpay.app.common.ui.UiPrefs
import global.cpay.app.databinding.FragmentMoreBinding
import global.cpay.app.merchant.CashSession
import global.cpay.app.merchant.MerchantMainActivity
import global.cpay.app.onboarding.ProfileSelectActivity
import kotlinx.coroutines.launch

/** Onglet « Plus » (WAVE-5) : acces aux operations secondaires, outils et compte. */
class MoreFragment : Fragment() {

    private var _b: FragmentMoreBinding? = null
    private val b get() = _b!!
    private val act: MerchantMainActivity? get() = activity as? MerchantMainActivity

    private sealed class Item {
        class Header(val title: Int) : Item()
        class Entry(val icon: Int, val title: Int, val subtitle: Int, val action: () -> Unit) : Item()
    }

    override fun onCreateView(i: LayoutInflater, c: ViewGroup?, s: Bundle?): View {
        _b = FragmentMoreBinding.inflate(i, c, false)
        return b.root
    }

    override fun onViewCreated(v: View, s: Bundle?) {
        val name = SessionManager.userName ?: getString(R.string.profile_merchant)
        b.tvName.text = name
        b.tvEmail.text = SessionManager.userEmail ?: ""
        b.tvAvatar.text = name.trim().split(' ').filter { it.isNotBlank() }.take(2).joinToString("") { it.take(1).uppercase() }.ifEmpty { "C" }
        val kyb = CashSession.summary?.profile?.kybLevel
        b.tvKyb.visibility = if (kyb != null) View.VISIBLE else View.GONE
        b.tvKyb.text = getString(R.string.more_kyb_level_fmt, kyb ?: 0)
        b.tvTerminal.text = if (SessionManager.isPaired) getString(R.string.more_terminal_fmt, SessionManager.terminalName ?: "") else getString(R.string.more_terminal_none)
        b.cardAccount.setOnClickListener { act?.openProfile() }
        b.tvVersion.text = getString(R.string.app_version_fmt, BuildConfig.VERSION_NAME)

        val items = listOf(
            Item.Header(R.string.more_section_operations),
            Item.Entry(R.drawable.ic_withdraw,  R.string.nav_withdraw,       R.string.more_withdraw_sub)      { act?.openWithdraw() },
            Item.Entry(R.drawable.ic_transfer,  R.string.nav_transfers,      R.string.more_transfers_sub)     { act?.openTransfers() },
            Item.Entry(R.drawable.ic_link,      R.string.more_pay_links,     R.string.more_pay_links_sub)     { act?.openPayLinks() },
            Item.Entry(R.drawable.ic_send,      R.string.more_disburse,      R.string.more_disburse_sub)      { act?.openDisburse() },
            Item.Header(R.string.more_section_tools),
            Item.Entry(R.drawable.ic_terminal,  R.string.more_terminals,     R.string.more_terminals_sub)     { act?.openTerminals() },
            Item.Entry(R.drawable.ic_settlement, R.string.more_settlements,  R.string.more_settlements_sub)   { act?.openSettlements() },
            Item.Entry(R.drawable.ic_bank,      R.string.more_bank_accounts, R.string.more_bank_accounts_sub) { act?.openBankAccounts() },
            Item.Entry(R.drawable.ic_history,   R.string.more_transactions,  R.string.more_transactions_sub)  { act?.openTransactions() },
            Item.Entry(R.drawable.ic_document,  R.string.more_kyb,           R.string.more_kyb_sub)           { act?.openKyb() },
            Item.Header(R.string.more_section_account),
            Item.Entry(R.drawable.ic_shield,    R.string.more_profile,       R.string.more_profile_sub)       { act?.openProfile() },
            Item.Entry(R.drawable.ic_support,   R.string.more_support,       R.string.more_support_sub)       { act?.openSupport() },
            Item.Entry(R.drawable.ic_logout,    R.string.more_logout,        R.string.profile_logout_confirm) { confirmLogout() },
        )
        b.rvMore.layoutManager = LinearLayoutManager(context)
        b.rvMore.adapter = MoreAdapter(items)
    }

    private fun confirmLogout() {
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.more_logout)
            .setMessage(R.string.profile_logout_confirm)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.more_logout) { _, _ -> logout() }
            .show()
    }

    private fun logout() {
        viewLifecycleOwner.lifecycleScope.launch {
            try { ApiClient.logout() } catch (e: Exception) { SessionManager.clearSession() }
            UiPrefs.onLogout()
            val a = activity ?: return@launch
            val intent = Intent(a, ProfileSelectActivity::class.java)
            intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            startActivity(intent)
        }
    }

    private inner class MoreAdapter(private val items: List<Item>) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
        inner class HeaderVH(v: View) : RecyclerView.ViewHolder(v) { val tv: TextView = v.findViewById(R.id.tv_header) }
        inner class EntryVH(v: View) : RecyclerView.ViewHolder(v) {
            val icon: ImageView = v.findViewById(R.id.iv_icon)
            val title: TextView = v.findViewById(R.id.tv_title)
            val sub: TextView = v.findViewById(R.id.tv_subtitle)
        }
        override fun getItemViewType(position: Int) = if (items[position] is Item.Header) 0 else 1
        override fun onCreateViewHolder(p: ViewGroup, viewType: Int): RecyclerView.ViewHolder =
            if (viewType == 0) HeaderVH(LayoutInflater.from(p.context).inflate(R.layout.item_more_header, p, false))
            else EntryVH(LayoutInflater.from(p.context).inflate(R.layout.item_more_entry, p, false))
        override fun onBindViewHolder(h: RecyclerView.ViewHolder, pos: Int) {
            when (val item = items[pos]) {
                is Item.Header -> (h as HeaderVH).tv.setText(item.title)
                is Item.Entry -> {
                    val vh = h as EntryVH
                    vh.icon.setImageResource(item.icon)
                    vh.title.setText(item.title)
                    vh.sub.setText(item.subtitle)
                    vh.itemView.setOnClickListener { item.action() }
                }
            }
        }
        override fun getItemCount() = items.size
    }

    override fun onDestroyView() { super.onDestroyView(); _b = null }
}
