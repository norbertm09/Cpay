package africa.calculus.plus.domain.usecase

import africa.calculus.plus.data.repository.PaymentRepository
import africa.calculus.plus.data.repository.MerchantRepository
import africa.calculus.plus.domain.model.*
import javax.inject.Inject

/**
 * CollectUseCase — Encaissement
 *
 * Le marchand fournit uniquement : montant + numéro client OU emvPayload
 * Tout le reste (opérateur, réseau, acquéreur, devise) est détecté automatiquement.
 */
class CollectUseCase @Inject constructor(
    private val paymentRepo: PaymentRepository,
) {
    /**
     * @param amount         Montant (ex: 5000)
     * @param customerPhone  Numéro Mobile Money du client (+221XXXXXXXXX)
     * @param emvPayload     Données NFC EMV (si paiement carte)
     * @param aidDetected    AID NFC détecté
     * @param description    Description optionnelle (ex: "Vente article 5")
     * @param deviceId       ID de l'appareil terminal
     */
    suspend operator fun invoke(
        amount:        Double,
        customerPhone: String? = null,
        emvPayload:    String? = null,
        aidDetected:   String? = null,
        description:   String? = null,
        deviceId:      String? = null,
    ): PaymentResult {
        if (amount <= 0) return PaymentResult.Failure(null, "Montant invalide")
        if (customerPhone == null && emvPayload == null && aidDetected == null) {
            return PaymentResult.Failure(null, "Mode de paiement requis")
        }
        return paymentRepo.collect(
            amount        = amount,
            customerPhone = customerPhone,
            emvPayload    = emvPayload,
            aidDetected   = aidDetected,
            description   = description,
            deviceId      = deviceId,
        )
    }
}

/**
 * PayoutUseCase — Retrait
 */
class PayoutUseCase @Inject constructor(
    private val paymentRepo: PaymentRepository,
) {
    suspend operator fun invoke(
        amount:        Double,
        customerPhone: String? = null,
        emvPayload:    String? = null,
        description:   String? = null,
    ): PaymentResult {
        if (amount <= 0) return PaymentResult.Failure(null, "Montant invalide")
        return paymentRepo.payout(
            amount        = amount,
            customerPhone = customerPhone,
            emvPayload    = emvPayload,
            description   = description,
        )
    }
}

/**
 * GenerateQrUseCase — Génère un QR Code de paiement
 */
class GenerateQrUseCase @Inject constructor(
    private val paymentRepo: PaymentRepository,
) {
    suspend operator fun invoke(
        amount:      Double,
        description: String? = null,
    ): Result<QrPayload> {
        if (amount <= 0) return Result.failure(Exception("Montant invalide"))
        return paymentRepo.generateQr(amount, description)
    }
}

/**
 * GeneratePayLinkUseCase — Génère un lien de paiement partageable
 */
class GeneratePayLinkUseCase @Inject constructor(
    private val paymentRepo: PaymentRepository,
) {
    suspend operator fun invoke(
        amount:      Double,
        description: String? = null,
    ): Result<PayLink> {
        if (amount <= 0) return Result.failure(Exception("Montant invalide"))
        return paymentRepo.generatePayLink(amount, description)
    }
}

/**
 * GetDashboardUseCase — Données du dashboard marchand
 */
class GetDashboardUseCase @Inject constructor(
    private val merchantRepo: MerchantRepository,
) {
    suspend operator fun invoke(): Result<DashboardData> =
        merchantRepo.getDashboard()
}

/**
 * GetTransactionsUseCase — Historique des transactions (simplifié)
 */
class GetTransactionsUseCase @Inject constructor(
    private val paymentRepo: PaymentRepository,
) {
    suspend operator fun invoke(page: Int = 1): Result<List<Transaction>> =
        paymentRepo.getTransactions(page)
}
