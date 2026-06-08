package africa.calculus.plus.domain.model

import java.time.LocalDateTime

// ─── Transaction ───────────────────────────────────────────────────

data class Transaction(
    val txnId:         String,
    val type:          TransactionType,
    val amount:        Double,
    val currency:      String,
    val paymentMethod: PaymentMethod,
    val status:        TransactionStatus,
    val description:   String?,
    val authCode:      String?,
    val feeAmount:     Double?,
    val netAmount:     Double?,
    val initiatedAt:   LocalDateTime,
    val completedAt:   LocalDateTime?,
) {
    /** Montant formaté pour affichage marchand — sans aucune info technique */
    fun formattedAmount(): String = "%.0f %s".format(amount, currency)
    fun formattedNet(): String    = "%.0f %s".format(netAmount ?: amount, currency)
}

enum class TransactionType(val label: String) {
    COLLECT("Encaissement"),
    PAYOUT("Retrait"),
    QR_PAYMENT("QR Code"),
    PAY_LINK("Lien de paiement"),
}

enum class TransactionStatus(val label: String) {
    PENDING("En cours"),
    AUTHORIZED("Accepté"),
    FAILED("Refusé"),
    REVERSED("Annulé"),
    REFUNDED("Remboursé"),
}

enum class PaymentMethod {
    MOBILE_MONEY, CARD_NFC, QR, PAY_LINK;
}

// ─── Résultat de paiement ──────────────────────────────────────────
// Simple, binaire — le marchand voit juste "Accepté" ou "Refusé"

sealed class PaymentResult {
    data class Success(
        val txnId:     String,
        val amount:    Double,
        val currency:  String,
        val authCode:  String?,
        val message:   String = "Paiement accepté",
    ) : PaymentResult()

    data class Failure(
        val txnId:     String?,
        val message:   String,
        val retryable: Boolean = false,
    ) : PaymentResult()

    object Processing : PaymentResult()
}

// ─── Info marchand ─────────────────────────────────────────────────

data class MerchantInfo(
    val merchantId:   String,
    val businessName: String,
    val firstName:    String?,
    val currency:     String,
    val kybLevel:     Int,
)

// ─── Dashboard ─────────────────────────────────────────────────────

data class DashboardData(
    val merchant:         MerchantInfo,
    val txnToday:         Int,
    val amountToday:      Double,
    val settlingTomorrow: Double,
    val currency:         String,
)

// ─── QR / Pay Link ────────────────────────────────────────────────

data class QrPayload(
    val qrId:      String,
    val url:       String,
    val qrContent: String,   // texte encodé dans le QR
    val amount:    Double,
    val currency:  String,
    val description: String?,
)

data class PayLink(
    val linkId:    String,
    val url:       String,
    val shareText: String,
    val whatsappUrl: String,
    val smsText:   String,
    val amount:    Double,
    val currency:  String,
    val description: String?,
)

// ─── État UI paiement ─────────────────────────────────────────────

sealed class PaymentUiState {
    object Idle       : PaymentUiState()
    object Processing : PaymentUiState()
    data class NfcReady(val amountCents: Long, val currency: String) : PaymentUiState()
    data class Success(val result: PaymentResult.Success) : PaymentUiState()
    data class Failure(val result: PaymentResult.Failure) : PaymentUiState()
}
