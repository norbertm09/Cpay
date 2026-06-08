package africa.calculus.plus.data.repository

import africa.calculus.plus.data.api.*
import africa.calculus.plus.domain.model.*
import africa.calculus.plus.security.SecureStorage
import android.util.Log
import java.time.LocalDateTime
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
class PaymentRepository @Inject constructor(
    private val api:           CalculusApiService,
    private val secureStorage: SecureStorage,
) {

    // ─── Encaissement ───────────────────────────────────────────

    suspend fun collect(
        amount:        Double,
        customerPhone: String?,
        emvPayload:    String?,
        aidDetected:   String?,
        description:   String?,
        deviceId:      String?,
    ): PaymentResult = try {
        val response = api.collect(
            CollectRequest(
                amount        = amount,
                customerPhone = customerPhone,
                emvPayload    = emvPayload,
                aidDetected   = aidDetected,
                description   = description,
                deviceId      = deviceId ?: secureStorage.getDeviceId(),
            )
        )

        if (response.isSuccessful && response.body()?.success == true) {
            val b = response.body()!!
            PaymentResult.Success(txnId = b.txnId, amount = b.amount, currency = b.currency, authCode = b.authCode)
        } else {
            val msg = response.body()?.message ?: response.body()?.error ?: "Paiement refusé"
            PaymentResult.Failure(txnId = response.body()?.txnId, message = msg)
        }
    } catch (e: Exception) {
        Log.e("PaymentRepo", "collect error: ${e.message}")
        PaymentResult.Failure(txnId = null, message = "Erreur de connexion", retryable = true)
    }

    // ─── Retrait ────────────────────────────────────────────────

    suspend fun payout(
        amount:        Double,
        customerPhone: String?,
        emvPayload:    String?,
        description:   String?,
    ): PaymentResult = try {
        val response = api.payout(
            PayoutRequest(amount = amount, customerPhone = customerPhone, emvPayload = emvPayload, description = description)
        )
        if (response.isSuccessful && response.body()?.success == true) {
            val b = response.body()!!
            PaymentResult.Success(txnId = b.txnId, amount = b.amount, currency = b.currency, authCode = b.authCode)
        } else {
            PaymentResult.Failure(txnId = response.body()?.txnId, message = response.body()?.message ?: "Retrait refusé")
        }
    } catch (e: Exception) {
        PaymentResult.Failure(null, "Erreur de connexion", retryable = true)
    }

    // ─── QR Code ────────────────────────────────────────────────

    suspend fun generateQr(amount: Double, description: String?): Result<QrPayload> = try {
        val r = api.generateQr(QrRequest(amount, description))
        if (r.isSuccessful && r.body() != null) {
            val b = r.body()!!
            Result.success(QrPayload(qrId = b.qrId, url = b.url, qrContent = b.qrContent, amount = amount, currency = "", description = description))
        } else {
            Result.failure(Exception("Erreur génération QR"))
        }
    } catch (e: Exception) {
        Result.failure(e)
    }

    // ─── Pay Link ────────────────────────────────────────────────

    suspend fun generatePayLink(amount: Double, description: String?): Result<PayLink> = try {
        val r = api.generatePayLink(PayLinkRequest(amount, description))
        if (r.isSuccessful && r.body() != null) {
            val b = r.body()!!
            Result.success(PayLink(
                linkId = b.linkId, url = b.url, shareText = b.shareText,
                whatsappUrl = b.channels["whatsapp"] ?: "", smsText = b.channels["sms"] ?: "",
                amount = amount, currency = "", description = description,
            ))
        } else Result.failure(Exception("Erreur génération lien"))
    } catch (e: Exception) { Result.failure(e) }

    // ─── Transactions ────────────────────────────────────────────

    suspend fun getTransactions(page: Int): Result<List<Transaction>> = try {
        val r = api.getTransactions(page = page)
        if (r.isSuccessful) {
            Result.success(r.body()?.data?.map { it.toDomain() } ?: emptyList())
        } else Result.failure(Exception("Erreur chargement transactions"))
    } catch (e: Exception) { Result.failure(e) }

    private fun TransactionItem.toDomain() = Transaction(
        txnId         = transaction_id,
        type          = when (type) { "payout" -> TransactionType.PAYOUT; "qr_payment" -> TransactionType.QR_PAYMENT; else -> TransactionType.COLLECT },
        amount        = amount, currency = currency,
        paymentMethod = when (payment_method) { "card_nfc" -> PaymentMethod.CARD_NFC; "qr" -> PaymentMethod.QR; else -> PaymentMethod.MOBILE_MONEY },
        status        = when (status) { "authorized" -> TransactionStatus.AUTHORIZED; "failed" -> TransactionStatus.FAILED; else -> TransactionStatus.PENDING },
        description   = description, authCode = auth_code,
        feeAmount     = fee_amount,  netAmount = net_amount,
        initiatedAt   = LocalDateTime.now(), completedAt = null,
    )
}

@Singleton
class MerchantRepository @Inject constructor(
    private val api:           CalculusApiService,
    private val secureStorage: SecureStorage,
) {
    suspend fun getDashboard(): Result<DashboardData> = try {
        val r = api.getDashboard()
        if (r.isSuccessful && r.body() != null) {
            val b  = r.body()!!
            val merchant = MerchantInfo(
                merchantId   = secureStorage.getMerchantId() ?: "",
                businessName = secureStorage.getBusinessName() ?: "",
                firstName    = secureStorage.getFirstName(),
                currency     = secureStorage.getCurrency() ?: "XOF",
                kybLevel     = secureStorage.getKybLevel(),
            )
            Result.success(DashboardData(
                merchant         = merchant,
                txnToday         = b.txnToday,
                amountToday      = b.amountToday,
                settlingTomorrow = b.settlingTomorrow,
                currency         = merchant.currency,
            ))
        } else Result.failure(Exception("Erreur dashboard"))
    } catch (e: Exception) { Result.failure(e) }
}

@Singleton
class AuthRepository @Inject constructor(
    private val api:           CalculusApiService,
    private val secureStorage: SecureStorage,
) {
    suspend fun login(emailOrPhone: String, password: String): Result<Unit> = try {
        val r = api.login(LoginRequest(emailOrPhone, password))
        if (r.isSuccessful && r.body() != null) {
            val b = r.body()!!
            secureStorage.saveSession(
                accessToken  = b.access_token,
                refreshToken = b.refresh_token,
                userId       = b.user.userId,
                merchantId   = b.user.merchantId,
                businessName = b.user.businessName,
                firstName    = b.user.firstName,
                currency     = b.user.currency,
                kybLevel     = b.user.kybLevel,
            )
            Result.success(Unit)
        } else Result.failure(Exception("Identifiants incorrects"))
    } catch (e: Exception) { Result.failure(e) }

    suspend fun register(
        businessName: String, rccm: String?, nif: String?,
        phone: String, email: String, password: String,
        settlementType: String, settlementAccount: String?, settlementProvider: String?,
    ): Result<Unit> = try {
        val r = api.register(RegisterRequest(businessName, rccm, nif, phone, email, password, settlementType, settlementAccount, settlementProvider))
        if (r.isSuccessful && r.body() != null) {
            val b = r.body()!!
            secureStorage.saveSession(
                accessToken  = b.access_token, refreshToken = b.refresh_token,
                userId       = b.user.userId,  merchantId   = b.user.merchantId,
                businessName = b.user.businessName, firstName = b.user.firstName,
                currency     = b.user.currency, kybLevel    = b.user.kybLevel,
            )
            Result.success(Unit)
        } else Result.failure(Exception(r.errorBody()?.string() ?: "Erreur inscription"))
    } catch (e: Exception) { Result.failure(e) }

    fun logout() { secureStorage.clearSession() }
}
