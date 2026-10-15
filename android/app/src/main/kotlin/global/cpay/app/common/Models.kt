package global.cpay.app.common

import com.google.gson.annotations.SerializedName

// ═══════════ AUTH ═══════════
data class LoginRequest(
    @SerializedName("emailOrPhone") val emailOrPhone: String,
    @SerializedName("password")     val password: String,
    @SerializedName("mfaCode")      val mfaCode: String? = null,
)

/**
 * Reponse de login / register / 2fa-validate / refresh / auth-me (WAVE-3).
 *  - session : { access_token, refresh_token, expires_in, user|cardholder, mustChangePassword }
 *  - 2FA requise au login : { mfaRequired: true, mfaToken } (aucune session)
 *  - erreur : { error, code }
 */
data class AuthResponse(
    @SerializedName("access_token")       val accessToken: String = "",
    @SerializedName("refresh_token")      val refreshToken: String? = null,
    @SerializedName("expires_in")         val expiresIn: Int = 0,
    @SerializedName("user")               val user: UserInfo? = null,
    @SerializedName("cardholder")         val cardholder: UserInfo? = null,
    @SerializedName("mfaRequired")        val mfaRequired: Boolean = false,
    @SerializedName("mfaToken")           val mfaToken: String? = null,
    @SerializedName("mustChangePassword") val mustChangePassword: Boolean = false,
    @SerializedName("error")              val error: String? = null,
    @SerializedName("code")               val code: String? = null,
) {
    val effectiveUser: UserInfo? get() = user ?: cardholder
    val hasSession: Boolean get() = accessToken.isNotBlank()
}

/** Corps de POST …/auth/refresh et …/auth/logout (refresh opaque, hors cookie). */
data class RefreshRequest(
    @SerializedName("refreshToken") val refreshToken: String,
)

/** Corps de POST …/auth/2fa/validate apres un login { mfaRequired: true }. */
data class MfaValidateRequest(
    @SerializedName("mfaToken") val mfaToken: String,
    @SerializedName("code")     val code: String,
)

/** Corps d'erreur standard du backend : { error, code } (+ champs optionnels du login). */
data class ApiError(
    @SerializedName("error")        val error: String? = null,
    @SerializedName("code")         val code: String? = null,
    @SerializedName("attemptsLeft") val attemptsLeft: Int? = null,
    @SerializedName("lockedUntil")  val lockedUntil: String? = null,
    // WAVE-4 : 428 STEP_UP_REQUIRED { methods }, 422 INSUFFICIENT_BALANCE { available }
    @SerializedName("methods")      val methods: List<String>? = null,
    @SerializedName("available")    val available: Double? = null,
)

data class UserInfo(
    @SerializedName("userId")       val userId: String? = null,
    @SerializedName("cardholderId") val cardholderId: String? = null,
    @SerializedName("merchantId")   val merchantId: String? = null,
    @SerializedName("cardId")       val cardId: String? = null,
    @SerializedName("firstName")    val firstName: String? = null,
    @SerializedName("lastName")     val lastName: String? = null,
    @SerializedName("email")        val email: String? = null,
    @SerializedName("phone")        val phone: String? = null,
    @SerializedName("role")         val role: String? = null,
    @SerializedName("businessName") val businessName: String? = null,
    @SerializedName("kycLevel")     val kycLevel: Int = 0,
    @SerializedName("kybLevel")     val kybLevel: Int = 0,
    @SerializedName("currency")     val currency: String? = null,
    @SerializedName("country")      val country: String? = null,
    @SerializedName("mfaEnabled")   val mfaEnabled: Boolean? = null,
) {
    val displayName: String get() = when {
        !businessName.isNullOrBlank() -> businessName
        !firstName.isNullOrBlank()    -> "$firstName ${lastName ?: ""}".trim()
        !email.isNullOrBlank()        -> email
        else                          -> "Utilisateur"
    }
    val effectiveId: String get() = userId ?: cardholderId ?: ""
}

// ═══════════ TRANSACTIONS ═══════════
data class Transaction(
    @SerializedName("txn_id")         val txnIdCh: String? = null,
    @SerializedName("transaction_id") val txnIdMerch: String? = null,
    @SerializedName("type")           val type: String = "",
    @SerializedName("amount")         val amount: Double = 0.0,
    @SerializedName("fee_amount")     val feeAmount: Double = 0.0,
    @SerializedName("net_amount")     val netAmount: Double = 0.0,
    @SerializedName("currency")       val currency: String = "XAF",
    @SerializedName("status")         val status: String = "pending",
    @SerializedName("payment_method") val method: String? = null,
    @SerializedName("initiated_at")   val initiatedAt: String? = null,
    @SerializedName("completed_at")   val completedAt: String? = null,
    @SerializedName("auth_code")      val authCode: String? = null,
    @SerializedName("customer_phone") val customerPhone: String? = null,
    @SerializedName("description")    val description: String? = null,
    @SerializedName("settlement_status") val settlementStatus: String? = null,
) {
    val txnId: String get() = txnIdCh ?: txnIdMerch ?: ""
}

data class TransactionsResponse(
    @SerializedName("data")  val data: List<Transaction> = emptyList(),
    @SerializedName("total") val total: Int = 0,
    @SerializedName("page")  val page: Int = 1,
)

// ═══════════ DASHBOARDS ═══════════
data class PeriodStats(
    @SerializedName("volume")    val volume: Double = 0.0,
    @SerializedName("txn_count") val txnCount: Int = 0,
)

data class MerchantDashboard(
    @SerializedName("today")            val today: PeriodStats? = null,
    @SerializedName("thisMonth")        val thisMonth: PeriodStats? = null,
    @SerializedName("activeTerminals")  val activeTerminals: Int = 0,
    @SerializedName("settlingTomorrow") val settlingTomorrow: Double = 0.0,
)

data class CardDashboard(
    @SerializedName("balance")         val balance: Double = 0.0,
    @SerializedName("currency")        val currency: String = "XAF",
    @SerializedName("status")          val status: String = "active",
    @SerializedName("card_masked")     val cardMasked: String? = null,
    @SerializedName("cardholder_name") val cardholderName: String? = null,
    @SerializedName("network")         val network: String = "visa",
)

data class CardholderStats(
    @SerializedName("monthSpent")  val monthSpent: Double = 0.0,
    @SerializedName("monthTopup")  val monthTopup: Double = 0.0,
    @SerializedName("monthUnload") val monthUnload: Double = 0.0,
    @SerializedName("monthCount")  val monthCount: Int = 0,
    @SerializedName("todayCount")  val todayCount: Int = 0,
)

data class CardholderDashboard(
    @SerializedName("card")               val card: CardDashboard? = null,
    @SerializedName("stats")              val stats: CardholderStats? = null,
    @SerializedName("recentTransactions") val recentTransactions: List<Transaction> = emptyList(),
) {
    val balance: Double    get() = card?.balance ?: 0.0
    val currency: String   get() = card?.currency ?: "XAF"
    val txnsToday: Int     get() = stats?.todayCount ?: 0
    val spentMonth: Double get() = stats?.monthSpent ?: 0.0
}

// ═══════════ CARTES ═══════════
data class CardDetail(
    @SerializedName("cardId")         val cardId: String = "",
    @SerializedName("cardMasked")     val cardMasked: String? = null,
    @SerializedName("cardholderName") val cardholderName: String? = null,
    @SerializedName("balance")        val balance: Double = 0.0,
    @SerializedName("currency")       val currency: String = "XAF",
    @SerializedName("status")         val status: String = "active",
    @SerializedName("network")        val network: String = "visa",
    @SerializedName("expiryMonth")    val expiryMonth: Int = 0,
    @SerializedName("expiryYear")     val expiryYear: Int = 0,
    @SerializedName("dailyLimit")     val dailyLimit: Double = 0.0,
    @SerializedName("monthlyLimit")   val monthlyLimit: Double = 0.0,
    @SerializedName("label")          val label: String = "Carte",
    @SerializedName("cardType")       val cardType: String = "created",
)

data class CreatedCardsResponse(
    @SerializedName("data")  val data: List<CardDetail> = emptyList(),
    @SerializedName("total") val total: Int = 0,
    @SerializedName("max")   val max: Int = 3,
)

data class EnrolledCard(
    @SerializedName("enrollmentId")   val enrollmentId: String = "",
    @SerializedName("cardMasked")     val cardMasked: String = "",
    @SerializedName("cardholderName") val cardholderName: String? = null,
    @SerializedName("network")        val network: String = "visa",
    @SerializedName("expiryMonth")    val expiryMonth: Int = 0,
    @SerializedName("expiryYear")     val expiryYear: Int = 0,
    @SerializedName("isDefault")      val isDefault: Boolean = false,
    @SerializedName("status")         val status: String = "active",
)

data class EnrolledCardsResponse(
    @SerializedName("data")  val data: List<EnrolledCard> = emptyList(),
    @SerializedName("total") val total: Int = 0,
)

// ═══════════ PAIEMENTS ═══════════
data class CollectRequest(
    @SerializedName("amount")        val amount: Double,
    @SerializedName("customerPhone") val customerPhone: String,
    @SerializedName("method")        val method: String,
    @SerializedName("description")   val description: String = "",
    @SerializedName("terminalId")    val terminalId: String? = null,
)

data class PairRequest(
    @SerializedName("pairingCode") val pairingCode: String,
    @SerializedName("androidId")   val androidId: String,
    @SerializedName("deviceModel") val deviceModel: String? = null,
    @SerializedName("appVersion")  val appVersion: String? = null,
)

data class CheckRequest(
    @SerializedName("androidId") val androidId: String,
)
data class CheckResponse(
    @SerializedName("paired")       val paired: Boolean = false,
    @SerializedName("terminalId")   val terminalId: String? = null,
    @SerializedName("terminalName") val terminalName: String? = null,
    @SerializedName("siteName")     val siteName: String? = null,
    @SerializedName("merchantName") val merchantName: String? = null,
)
data class PairResponse(
    @SerializedName("success")       val success: Boolean = false,
    @SerializedName("alreadyPaired") val alreadyPaired: Boolean = false,
    @SerializedName("terminalId")    val terminalId: String = "",
    @SerializedName("terminalName")  val terminalName: String = "",
    @SerializedName("siteName")      val siteName: String? = null,
    @SerializedName("merchantName")  val merchantName: String? = null,
)

data class DisburseRequest(
    @SerializedName("amount")         val amount: Double,
    @SerializedName("recipientPhone") val recipientPhone: String,
    @SerializedName("method")         val method: String,
    @SerializedName("description")    val description: String = "",
)

/** Ancien retrait direct (POST /merchant/withdraw, 410 depuis le hotfix v1). */
data class LegacyWithdrawRequest(
    @SerializedName("amount")      val amount: Double,
    @SerializedName("phone")       val phone: String,
    @SerializedName("operator")    val operator: String,
    @SerializedName("description") val description: String = "",
)

data class PaymentResponse(
    @SerializedName("success")   val success: Boolean = false,
    @SerializedName("txnId")     val txnId: String? = null,
    @SerializedName("reference") val reference: String? = null,
    @SerializedName("authCode")  val authCode: String? = null,
    @SerializedName("status")    val status: String? = null,
    @SerializedName("amount")    val amount: Double? = null,
    @SerializedName("fee")       val fee: Double? = null,
    @SerializedName("net")       val net: Double? = null,
    @SerializedName("payUrl")    val payUrl: String? = null,
    @SerializedName("shortUrl")  val shortUrl: String? = null,
    @SerializedName("message")   val message: String? = null,
    @SerializedName("requiresConfirmation") val requiresConfirmation: Boolean = false,
)

// ═══════════ PAY LINKS ═══════════
data class PayLinkCreateResponse(
    @SerializedName("success") val success: Boolean = false,
    @SerializedName("link")    val link: PayLink? = null,
)
data class PayLink(
    @SerializedName("pay_link_id")     val id: String = "",
    @SerializedName("short_url")       val shortUrl: String = "",
    @SerializedName("amount")          val amount: Double = 0.0,
    @SerializedName("currency")        val currency: String = "XAF",
    @SerializedName("description")     val description: String? = null,
    @SerializedName("status")          val status: String = "pending",
    @SerializedName("recipient_phone") val recipientPhone: String? = null,
    @SerializedName("expires_at")      val expiresAt: String? = null,
    @SerializedName("created_at")      val createdAt: String? = null,
)

data class PayLinksResponse(
    @SerializedName("data")  val data: List<PayLink> = emptyList(),
    @SerializedName("total") val total: Int = 0,
)

// ═══════════ SETTLEMENTS ═══════════
data class Settlement(
    @SerializedName("batch_id")      val batchId: String = "",
    @SerializedName("amount")        val amount: Double = 0.0,
    @SerializedName("currency")      val currency: String = "XAF",
    @SerializedName("status")        val status: String = "pending",
    @SerializedName("settled")       val settled: Boolean = false,
    @SerializedName("settlement_date") val settlementDate: String? = null,
    @SerializedName("txn_count")     val txnCount: Int = 0,
)

data class SettlementsResponse(
    @SerializedName("data")  val data: List<Settlement> = emptyList(),
    @SerializedName("total") val total: Int = 0,
)

// ═══════════ TERMINALS ═══════════
data class Terminal(
    @SerializedName("terminal_id") val terminalId: String = "",
    @SerializedName("label")       val label: String? = null,
    @SerializedName("serial")      val serial: String? = null,
    @SerializedName("status")      val status: String = "active",
    @SerializedName("last_seen")   val lastSeen: String? = null,
)

data class TerminalsResponse(
    @SerializedName("data")  val data: List<Terminal> = emptyList(),
    @SerializedName("total") val total: Int = 0,
)

// ═══════════ SUPPORT ═══════════
data class Ticket(
    @SerializedName("ticket_id")  val ticketId: String = "",
    @SerializedName("subject")    val subject: String = "",
    @SerializedName("message")    val message: String? = null,
    @SerializedName("status")     val status: String = "open",
    @SerializedName("priority")   val priority: String = "normal",
    @SerializedName("created_at") val createdAt: String? = null,
)

data class TicketsResponse(
    @SerializedName("data")  val data: List<Ticket> = emptyList(),
    @SerializedName("total") val total: Int = 0,
)

// ═══════════ KYC / KYB ═══════════
data class KybDocRequest(
    @SerializedName("docType")  val docType: String,
    @SerializedName("docLabel") val docLabel: String? = null,
    @SerializedName("fileUrl")  val fileUrl: String,
    @SerializedName("fileName") val fileName: String? = null,
    @SerializedName("fileSize") val fileSize: Long? = null,
    @SerializedName("mimeType") val mimeType: String? = null,
)
data class KycStatus(
    @SerializedName("kycLevel")  val kycLevel: Int = 0,
    @SerializedName("status")    val status: String = "pending",
    @SerializedName("documents") val documents: List<KycDoc> = emptyList(),
)

data class KycDoc(
    @SerializedName("doc_id")   val docId: String = "",
    @SerializedName("doc_type") val docType: String = "",
    @SerializedName("status")   val status: String = "pending",
)

// ═══════════ API KEYS ═══════════
data class ApiKey(
    @SerializedName("key_id")      val keyId: String = "",
    @SerializedName("label")       val label: String? = null,
    @SerializedName("key_prefix")  val keyPrefix: String? = null,
    @SerializedName("api_key")     val apiKey: String? = null,
    @SerializedName("permissions") val permissions: List<String> = emptyList(),
    @SerializedName("status")      val status: String = "active",
    @SerializedName("created_at")  val createdAt: String? = null,
)

data class ApiKeysResponse(
    @SerializedName("data")  val data: List<ApiKey> = emptyList(),
    @SerializedName("total") val total: Int = 0,
)

// ═══════════ GTP ═══════════
data class GtpCard(
    @SerializedName("gtp_card_id")    val gtpCardId: Long = 0,
    @SerializedName("cardMasked")     val cardMasked: String? = null,
    @SerializedName("last4")          val last4: String? = null,
    @SerializedName("cardholderName") val cardholderName: String? = null,
    @SerializedName("status")         val status: String = "active",
    @SerializedName("balance")        val balance: Double = 0.0,
    @SerializedName("currency")       val currency: String = "XAF",
    @SerializedName("issuingBank")    val issuingBank: String? = null,
)

data class GtpCardsResponse(
    @SerializedName("data")  val data: List<GtpCard> = emptyList(),
    @SerializedName("total") val total: Int = 0,
)

data class GtpTransaction(
    @SerializedName("transactionId")  val transactionId: String = "",
    @SerializedName("date")           val date: String? = null,
    @SerializedName("amount")         val amount: Double = 0.0,
    @SerializedName("fee")            val fee: Double = 0.0,
    @SerializedName("runningBalance") val runningBalance: Double = 0.0,
    @SerializedName("description")    val description: String? = null,
    @SerializedName("merchantName")   val merchantName: String? = null,
    @SerializedName("currency")       val currency: String = "XAF",
)

data class GtpTransactionsResponse(
    @SerializedName("data")  val data: List<GtpTransaction> = emptyList(),
    @SerializedName("total") val total: Int = 0,
)

// ═══════════ TRANSFERTS BANCAIRES ═══════════
data class Institution(
    @SerializedName("institutionId") val institutionId: String = "",
    @SerializedName("code")          val code: String = "",
    @SerializedName("name")          val name: String = "",
    @SerializedName("type")          val type: String = "bank",
    @SerializedName("country")       val country: String = "CG",
    @SerializedName("swift")         val swift: String? = null,
) {
    val typeLabel: String get() = when (type) {
        "bank"         -> "🏦"
        "microfinance" -> "🏛️"
        "imf"          -> "💼"
        else           -> "🏦"
    }
}

data class InstitutionsResponse(
    @SerializedName("data")  val data: List<Institution> = emptyList(),
    @SerializedName("total") val total: Int = 0,
)

data class InstitutionRef(
    @SerializedName("name")    val name: String = "",
    @SerializedName("code")    val code: String = "",
    @SerializedName("type")    val type: String = "bank",
    @SerializedName("country") val country: String = "CG",
)

data class BankAccount(
    @SerializedName("accountId")     val accountId: String = "",
    @SerializedName("accountNumber") val accountNumber: String = "",
    @SerializedName("accountName")   val accountName: String = "",
    @SerializedName("iban")          val iban: String? = null,
    @SerializedName("status")        val status: String = "verified",
    @SerializedName("isDefault")     val isDefault: Boolean = false,
    @SerializedName("institution")   val institution: InstitutionRef? = null,
    @SerializedName("bankName")      val bankName: String? = null,
    @SerializedName("accountMasked") val accountMasked: String? = null,
) {
    val isVerified: Boolean get() = status == "verified" || status == "active"
    val displayBank: String get() = bankName ?: institution?.name ?: "Banque"
    val displayNumber: String get() = accountMasked ?: accountNumber.let {
        if (it.length > 4) "…" + it.takeLast(4) else it
    }
}

data class BankAccountsResponse(
    @SerializedName("data")  val data: List<BankAccount> = emptyList(),
    @SerializedName("total") val total: Int = 0,
)

data class TransferParty(
    @SerializedName("institution")   val institution: String = "",
    @SerializedName("accountNumber") val accountNumber: String = "",
    @SerializedName("accountName")   val accountName: String = "",
)

data class TransferResponse(
    @SerializedName("success")       val success: Boolean = false,
    @SerializedName("transactionId") val transactionId: String? = null,
    @SerializedName("newBalance")    val newBalance: Double? = null,
    @SerializedName("amount")        val amount: Double = 0.0,
    @SerializedName("currency")      val currency: String = "XAF",
    @SerializedName("destination")   val destination: TransferParty? = null,
    @SerializedName("source")        val source: TransferParty? = null,
)

// ═══════════ KYC ═══════════
data class KycUploadResponse(
    @SerializedName("success") val success: Boolean = false,
    @SerializedName("docId")   val docId: String? = null,
    @SerializedName("docType") val docType: String? = null,
    @SerializedName("status")  val status: String = "pending",
    @SerializedName("message") val message: String? = null,
)

// ═══════════ WALLETS MOBILE MONEY ═══════════
data class Wallet(
    @SerializedName("walletId")  val walletId: String = "",
    @SerializedName("operator")  val operator: String = "mtn",
    @SerializedName("phone")     val phone: String = "",
    @SerializedName("label")     val label: String = "",
    @SerializedName("country")   val country: String = "CG",
    @SerializedName("isDefault") val isDefault: Boolean = false,
    @SerializedName("verified")  val verified: Boolean? = null,
) {
    val icon: String get() = when (operator) {
        "mtn"    -> "🟡"
        "airtel" -> "🔴"
        "orange" -> "🟠"
        else     -> "📱"
    }
}

data class WalletsResponse(
    @SerializedName("data")  val data: List<Wallet> = emptyList(),
    @SerializedName("total") val total: Int = 0,
)

// ═══════════ TRANSFERTS ═══════════
data class TransferInitResponse(
    @SerializedName("success")              val success: Boolean = false,
    @SerializedName("transferId")           val transferId: String = "",
    @SerializedName("reference")            val reference: String = "",
    @SerializedName("status")               val status: String = "pending",
    @SerializedName("amount")               val amount: Double = 0.0,
    @SerializedName("currency")             val currency: String = "XAF",
    @SerializedName("requiresConfirmation") val requiresConfirmation: Boolean = false,
    @SerializedName("destination")          val destination: TransferParty? = null,
    @SerializedName("source")               val source: TransferParty? = null,
)

data class TransferStatus(
    @SerializedName("transferId")  val transferId: String = "",
    @SerializedName("reference")   val reference: String = "",
    @SerializedName("status")      val status: String = "pending",
    @SerializedName("label")       val label: String = "",
    @SerializedName("direction")   val direction: String = "",
    @SerializedName("amount")      val amount: Double = 0.0,
    @SerializedName("currency")    val currency: String = "XAF",
    @SerializedName("institution") val institution: String? = null,
    @SerializedName("error")       val error: String? = null,
    @SerializedName("completedAt") val completedAt: String? = null,
) {
    val isDone   get() = status == "completed"
    val isFailed get() = status == "failed"
    val isWaiting get() = status == "awaiting_momo_confirmation"
}

// Item unifie pour le combo source (carte OU wallet)
data class TransferSource(
    val type: String,       // "card" | "wallet"
    val id: String,
    val label: String,
    val subtitle: String,
    val icon: String,
    val balance: Double? = null,
)

// ═══════════ ENCAISSEMENT — STATUT ═══════════
data class PaymentStatus(
    @SerializedName("txnId")       val txnId: String = "",
    @SerializedName("amount")      val amount: Double = 0.0,
    @SerializedName("fee")         val fee: Double = 0.0,
    @SerializedName("net")         val net: Double = 0.0,
    @SerializedName("status")      val status: String = "pending",
    @SerializedName("label")       val label: String = "",
    @SerializedName("operator")    val operator: String? = null,
    @SerializedName("authCode")    val authCode: String? = null,
    @SerializedName("message")     val message: String? = null,
    @SerializedName("reference")   val reference: String? = null,
    @SerializedName("completedAt") val completedAt: String? = null,
) {
    val isDone    get() = status == "authorized"
    val isFailed  get() = status == "failed"
    val isPending get() = status == "pending"
}

// ═══════════ MERCHANT — SOLDE & RETRAITS ═══════════
data class MerchantBalance(
    @SerializedName("available")        val available: Double = 0.0,
    @SerializedName("pending")          val pending: Double = 0.0,
    @SerializedName("totalCollected")   val totalCollected: Double = 0.0,
    @SerializedName("totalWithdrawn")   val totalWithdrawn: Double = 0.0,
    @SerializedName("transactionCount") val transactionCount: Int = 0,
    @SerializedName("currency")         val currency: String = "XAF",
)

data class MerchantPayoutResponse(
    @SerializedName("success")     val success: Boolean = false,
    @SerializedName("transferId")  val transferId: String = "",
    @SerializedName("reference")   val reference: String = "",
    @SerializedName("amount")      val amount: Double = 0.0,
    @SerializedName("fee")         val fee: Double = 0.0,
    @SerializedName("net")         val net: Double = 0.0,
    @SerializedName("status")      val status: String = "",
    @SerializedName("message")     val message: String? = null,
    @SerializedName("destination") val destination: PayoutDest? = null,
)

data class PayoutDest(
    @SerializedName("type")          val type: String = "",
    @SerializedName("institution")   val institution: String? = null,
    @SerializedName("operator")      val operator: String? = null,
    @SerializedName("phone")         val phone: String? = null,
    @SerializedName("accountNumber") val accountNumber: String? = null,
)

data class MerchantTransfer(
    @SerializedName("transferId")  val transferId: String = "",
    @SerializedName("reference")   val reference: String = "",
    @SerializedName("destType")    val destType: String = "",
    @SerializedName("amount")      val amount: Double = 0.0,
    @SerializedName("fee")         val fee: Double = 0.0,
    @SerializedName("net")         val net: Double = 0.0,
    @SerializedName("status")      val status: String = "",
    @SerializedName("institution") val institution: String? = null,
    @SerializedName("operator")    val operator: String? = null,
    @SerializedName("phone")       val phone: String? = null,
    @SerializedName("createdAt")   val createdAt: String? = null,
) {
    val statusLabel: String get() = when (status) {
        "completed"          -> "Effectué"
        "pending_settlement" -> "En traitement"
        "processing"         -> "En cours"
        "failed"             -> "Échoué"
        else                 -> status
    }
    val statusColor: String get() = when (status) {
        "completed"  -> "#007a5a"
        "failed"     -> "#c53030"
        else         -> "#c47000"
    }
    val destLabel: String get() = if (destType == "wallet")
        "${operator?.uppercase()} +$phone" else (institution ?: "Banque")
    val destIcon: String get() = if (destType == "wallet") "📱" else "🏦"
}

data class MerchantTransfersResponse(
    @SerializedName("data")  val data: List<MerchantTransfer> = emptyList(),
    @SerializedName("total") val total: Int = 0,
)

data class GtpStatus(
    @SerializedName("configured") val configured: Boolean = false,
    @SerializedName("hasCard")    val hasCard: Boolean = false,
    @SerializedName("message")    val message: String = "",
)

// ═══════════ CAISSE MARCHANDE (WAVE-4, docs/CAISSE-API.md) ═══════════
// Tous les champs sont optionnels/par defaut : le backend est implemente en parallele.
data class CashBalance(
    @SerializedName("available") val available: Double = 0.0,
    @SerializedName("pending")   val pending: Double = 0.0,
    @SerializedName("reserved")  val reserved: Double = 0.0,
)

data class CashToday(
    @SerializedName("collected")      val collected: Double = 0.0,
    @SerializedName("collectedCount") val collectedCount: Int = 0,
    @SerializedName("byMethod")       val byMethod: Map<String, Double>? = null,
    @SerializedName("withdrawn")      val withdrawn: Double = 0.0,
    @SerializedName("transfersOut")   val transfersOut: Double = 0.0,
    @SerializedName("transfersIn")    val transfersIn: Double = 0.0,
) {
    val mobileMoney: Double get() = byMethod?.get("mobile_money") ?: 0.0
    val card: Double        get() = byMethod?.get("card") ?: 0.0
}

data class CashLimits(
    @SerializedName("withdrawDailyMax")       val withdrawDailyMax: Double? = null,
    @SerializedName("withdrawDailyRemaining") val withdrawDailyRemaining: Double? = null,
    @SerializedName("transferMin")            val transferMin: Double? = null,
)

data class CashWallet(
    @SerializedName("operator")   val operator: String? = null,
    @SerializedName("phone")      val phone: String? = null,
    @SerializedName("verifiedAt") val verifiedAt: String? = null,
) {
    val isSet: Boolean get() = !phone.isNullOrBlank()
    val operatorLabel: String get() = CashLabels.operator(operator)
}

data class CashProfile(
    @SerializedName("kybLevel")       val kybLevel: Int = 0,
    @SerializedName("wallet")         val wallet: CashWallet? = null,
    @SerializedName("bankAccounts")   val bankAccounts: Int = 0,
    @SerializedName("cardAcceptance") val cardAcceptance: String? = null,
)

data class CashSummary(
    @SerializedName("currency") val currency: String? = null,
    @SerializedName("balance")  val balance: CashBalance? = null,
    @SerializedName("today")    val today: CashToday? = null,
    @SerializedName("limits")   val limits: CashLimits? = null,
    @SerializedName("profile")  val profile: CashProfile? = null,
) {
    val cur: String get() = currency ?: "XAF"
    val available: Double get() = balance?.available ?: 0.0
}

data class CashCollectRequest(
    @SerializedName("amount")        val amount: Double,
    @SerializedName("method")        val method: String,               // mobile_money | card
    @SerializedName("currency")      val currency: String? = null,
    @SerializedName("customerPhone") val customerPhone: String? = null,
    @SerializedName("operator")      val operator: String? = null,     // forcage (Wave, Express Union…)
    @SerializedName("description")   val description: String? = null,
    @SerializedName("reference")     val reference: String? = null,
)

data class CashPayLink(
    @SerializedName("shortId")   val shortId: String? = null,
    @SerializedName("shortUrl")  val shortUrl: String? = null,
    @SerializedName("expiresAt") val expiresAt: String? = null,
)

data class CashCollectResponse(
    @SerializedName("txnId")         val txnId: String? = null,
    @SerializedName("status")        val status: String? = null,
    @SerializedName("method")        val method: String? = null,
    @SerializedName("operator")      val operator: String? = null,
    @SerializedName("operatorLabel") val operatorLabel: String? = null,
    @SerializedName("country")       val country: String? = null,
    @SerializedName("currency")      val currency: String? = null,
    @SerializedName("amount")        val amount: Double? = null,
    @SerializedName("fee")           val fee: Double? = null,
    @SerializedName("net")           val net: Double? = null,
    @SerializedName("reference")     val reference: String? = null,
    @SerializedName("statusUrl")     val statusUrl: String? = null,
    @SerializedName("payLink")       val payLink: CashPayLink? = null,
)

data class CashCollectStatus(
    @SerializedName("txnId")         val txnId: String? = null,
    @SerializedName("status")        val status: String? = null,   // pending|authorized|failed|expired
    @SerializedName("amount")        val amount: Double? = null,
    @SerializedName("fee")           val fee: Double? = null,
    @SerializedName("net")           val net: Double? = null,
    @SerializedName("operator")      val operator: String? = null,
    @SerializedName("customerPhone") val customerPhone: String? = null,
    @SerializedName("reference")     val reference: String? = null,
    @SerializedName("createdAt")     val createdAt: String? = null,
    @SerializedName("finalizedAt")   val finalizedAt: String? = null,
    @SerializedName("receiptUrl")    val receiptUrl: String? = null,
    @SerializedName("error")         val error: String? = null,
) {
    val isDone    get() = status == "authorized"
    val isFailed  get() = status == "failed" || status == "expired"
    val isPending get() = status == null || status == "pending"
}

/** PUT /merchant/cash/wallet { operator, phone, confirm } (step-up §6). */
data class CashWalletRequest(
    @SerializedName("operator") val operator: String,
    @SerializedName("phone")    val phone: String,
    @SerializedName("confirm")  val confirm: Map<String, String>,
)

/** POST /merchant/cash/withdraw { amount, description?, confirm } */
data class WithdrawRequest(
    @SerializedName("amount")      val amount: Double,
    @SerializedName("description") val description: String? = null,
    @SerializedName("confirm")     val confirm: Map<String, String>,
)

data class WithdrawResponse(
    @SerializedName("transferId") val transferId: String? = null,
    @SerializedName("reference")  val reference: String? = null,
    @SerializedName("status")     val status: String? = null,
    @SerializedName("amount")     val amount: Double? = null,
    @SerializedName("fee")        val fee: Double? = null,
    @SerializedName("net")        val net: Double? = null,
    @SerializedName("wallet")     val wallet: CashWallet? = null,
)

/** POST /merchant/cash/transfers { direction, accountId?, amount, description?, confirm } */
data class TransferRequest(
    @SerializedName("direction")   val direction: String,            // wallet_to_bank | bank_to_wallet
    @SerializedName("amount")      val amount: Double,
    @SerializedName("accountId")   val accountId: String? = null,
    @SerializedName("description") val description: String? = null,
    @SerializedName("confirm")     val confirm: Map<String, String>,
)

data class BankInstructions(
    @SerializedName("bankName")      val bankName: String? = null,
    @SerializedName("accountName")   val accountName: String? = null,
    @SerializedName("accountNumber") val accountNumber: String? = null,
    @SerializedName("iban")          val iban: String? = null,
    @SerializedName("swift")         val swift: String? = null,
    @SerializedName("reference")     val reference: String? = null,
    @SerializedName("expiresAt")     val expiresAt: String? = null,
)

data class TransferBankAccount(
    @SerializedName("bankName")      val bankName: String? = null,
    @SerializedName("accountMasked") val accountMasked: String? = null,
)

data class Transfer(
    @SerializedName("transferId")   val transferId: String = "",
    @SerializedName("reference")    val reference: String? = null,
    @SerializedName("direction")    val direction: String? = null,
    @SerializedName("status")       val status: String? = null,
    @SerializedName("amount")       val amount: Double = 0.0,
    @SerializedName("fee")          val fee: Double? = null,
    @SerializedName("net")          val net: Double? = null,
    @SerializedName("currency")     val currency: String? = null,
    @SerializedName("description")  val description: String? = null,
    @SerializedName("bankAccount")  val bankAccount: TransferBankAccount? = null,
    @SerializedName("instructions") val instructions: BankInstructions? = null,
    @SerializedName("createdAt")    val createdAt: String? = null,
    @SerializedName("completedAt")  val completedAt: String? = null,
) {
    val isFunding: Boolean  get() = direction == "bank_to_wallet" || direction == "funding"
    val canCancel: Boolean  get() = status == "awaiting_funds" || status == "pending_manual"
    val statusLabel: String get() = CashLabels.transferStatus(status)
    val statusColor: String get() = CashLabels.statusColor(status)
    val title: String get() = when {
        isFunding -> "Approvisionnement banque → wallet"
        bankAccount != null -> "Vers ${bankAccount.bankName ?: "banque"} ${bankAccount.accountMasked ?: ""}".trim()
        direction == "wallet_to_bank" || direction == "payout" -> "Vers la banque"
        else -> "Transfert"
    }
}

data class TransfersResponse(
    @SerializedName("data")  val data: List<Transfer> = emptyList(),
    @SerializedName("total") val total: Int = 0,
)

/** GET /merchant/cash/history — une ligne du journal. */
data class HistoryEntry(
    @SerializedName("id")           val id: String = "",
    @SerializedName("type")         val type: String? = null,        // collect|withdraw|transfer_out|transfer_in
    @SerializedName("reference")    val reference: String? = null,
    @SerializedName("amount")       val amount: Double = 0.0,
    @SerializedName("fee")          val fee: Double? = null,
    @SerializedName("net")          val net: Double? = null,
    @SerializedName("status")       val status: String? = null,
    @SerializedName("counterparty") val counterparty: String? = null,
    @SerializedName("method")       val method: String? = null,
    @SerializedName("createdAt")    val createdAt: String? = null,
) {
    val isIncoming: Boolean get() = type == "collect" || type == "transfer_in"
    val typeLabel: String get() = when (type) {
        "collect"      -> "Encaissement"
        "withdraw"     -> "Retrait"
        "transfer_out" -> "Transfert vers banque"
        "transfer_in"  -> "Approvisionnement"
        else           -> type ?: "Mouvement"
    }
    val icon: String get() = when (type) {
        "collect"      -> "📥"
        "withdraw"     -> "📤"
        "transfer_out" -> "🏦"
        "transfer_in"  -> "💰"
        else           -> "💳"
    }
}

data class HistoryTotals(
    @SerializedName("in")  val inTotal: Double = 0.0,
    @SerializedName("out") val outTotal: Double = 0.0,
)

data class HistoryResponse(
    @SerializedName("data")   val data: List<HistoryEntry> = emptyList(),
    @SerializedName("total")  val total: Int = 0,
    @SerializedName("totals") val totals: HistoryTotals? = null,
)

/** 428 STEP_UP_REQUIRED { methods: ["totp"] | ["password"] } */
data class StepUpError(
    @SerializedName("error")   val error: String? = null,
    @SerializedName("code")    val code: String? = null,
    @SerializedName("methods") val methods: List<String> = emptyList(),
) {
    val method: String get() = methods.firstOrNull() ?: "password"
}

/** POST /detect/phone (public) — services/detection/detection.engine.js */
data class PhoneAlternative(
    @SerializedName("operator") val operator: String = "",
    @SerializedName("brand")    val brand: String? = null,
    @SerializedName("gateway")  val gateway: String? = null,
)

data class PhoneDetection(
    @SerializedName("success")      val success: Boolean = false,
    @SerializedName("phone")        val phone: String? = null,
    @SerializedName("country")      val country: String? = null,
    @SerializedName("countryName")  val countryName: String? = null,
    @SerializedName("currency")     val currency: String? = null,
    @SerializedName("region")       val region: String? = null,
    @SerializedName("operator")     val operator: String? = null,
    @SerializedName("brand")        val brand: String? = null,
    @SerializedName("gateway")      val gateway: String? = null,
    @SerializedName("verified")     val verified: Boolean? = null,
    @SerializedName("alternatives") val alternatives: List<PhoneAlternative> = emptyList(),
    @SerializedName("error")        val error: String? = null,
    @SerializedName("code")         val code: String? = null,
) {
    val operatorLabel: String get() = brand ?: CashLabels.operator(operator)
}

/** Libelles partages (operateurs, statuts) pour la caisse. */
object CashLabels {
    val OPERATORS: List<Pair<String, String>> = listOf(
        "mtn_momo"      to "MTN MoMo",
        "orange_money"  to "Orange Money",
        "airtel_money"  to "Airtel Money",
        "moov_money"    to "Moov Money",
        "wave"          to "Wave",
        "express_union" to "Express Union Mobile",
        "mpesa"         to "M-Pesa",
        "free_money"    to "Free Money",
    )

    fun operator(code: String?): String {
        if (code.isNullOrBlank()) return "Mobile Money"
        val key = code.lowercase()
        OPERATORS.firstOrNull { it.first == key }?.let { return it.second }
        return when (key) {
            "mtn"    -> "MTN MoMo"
            "orange" -> "Orange Money"
            "airtel" -> "Airtel Money"
            "moov"   -> "Moov Money"
            else     -> code.replace('_', ' ').replaceFirstChar { it.uppercase() }
        }
    }

    fun transferStatus(status: String?): String = when (status) {
        "pending"        -> "En attente"
        "processing"     -> "En cours"
        "pending_manual" -> "Traitement J+1"
        "awaiting_funds" -> "Virement attendu"
        "completed"      -> "Effectué"
        "failed"         -> "Échoué"
        "cancelled"      -> "Annulé"
        "rejected"       -> "Rejeté"
        "authorized"     -> "Autorisé"
        "expired"        -> "Expiré"
        else             -> status ?: "—"
    }

    fun statusColor(status: String?): String = when (status) {
        "completed", "authorized"               -> "#007a5a"
        "failed", "rejected", "expired"         -> "#c53030"
        "cancelled"                             -> "#5a6677"
        else                                    -> "#c47000"
    }
}
