package global.cpay.app.common

import retrofit2.Response
import retrofit2.http.*

interface ApiService {

    // ═══════════ AUTH MERCHANT ═══════════
    @POST("merchant/auth/login")
    suspend fun merchantLogin(@Body body: LoginRequest): Response<AuthResponse>

    @POST("merchant/auth/register")
    suspend fun merchantRegister(@Body body: Map<String, String>): Response<AuthResponse>

    @POST("merchant/auth/logout")
    suspend fun merchantLogout(@Body body: RefreshRequest): Response<Map<String, Any>>

    @POST("merchant/auth/2fa/validate")
    suspend fun merchant2FAValidate(@Body body: MfaValidateRequest): Response<AuthResponse>

    @GET("merchant/auth/me")
    suspend fun merchantMe(): Response<AuthResponse>

    @POST("merchant/auth/forgot-password")
    suspend fun merchantForgotPassword(@Body body: Map<String, String>): Response<Map<String, Any>>

    @POST("merchant/auth/reset-password")
    suspend fun merchantResetPassword(@Body body: Map<String, String>): Response<Map<String, Any>>

    // ═══════════ AUTH CARDHOLDER ═══════════
    @POST("cardholder/auth/login")
    suspend fun cardholderLogin(@Body body: LoginRequest): Response<AuthResponse>

    @POST("cardholder/auth/register")
    suspend fun cardholderRegister(@Body body: Map<String, String>): Response<AuthResponse>

    @POST("cardholder/auth/logout")
    suspend fun cardholderLogout(@Body body: RefreshRequest): Response<Map<String, Any>>

    @POST("cardholder/auth/2fa/validate")
    suspend fun cardholder2FAValidate(@Body body: MfaValidateRequest): Response<AuthResponse>

    @GET("cardholder/auth/me")
    suspend fun cardholderMe(): Response<AuthResponse>

    @POST("cardholder/auth/forgot-password")
    suspend fun cardholderForgotPassword(@Body body: Map<String, String>): Response<Map<String, Any>>

    @POST("cardholder/auth/reset-password")
    suspend fun cardholderResetPassword(@Body body: Map<String, String>): Response<Map<String, Any>>

    // ═══════════ 2FA MERCHANT ═══════════
    @GET("merchant/auth/2fa/status")
    suspend fun merchant2FAStatus(): Response<Map<String, Any>>

    @POST("merchant/auth/2fa/setup")
    suspend fun merchant2FASetup(): Response<Map<String, Any>>

    @POST("merchant/auth/2fa/verify")
    suspend fun merchant2FAVerify(@Body body: Map<String, String>): Response<Map<String, Any>>

    @POST("merchant/auth/2fa/disable")
    suspend fun merchant2FADisable(@Body body: Map<String, String>): Response<Map<String, Any>>

    // ═══════════ 2FA CARDHOLDER ═══════════
    @GET("cardholder/auth/2fa/status")
    suspend fun cardholder2FAStatus(): Response<Map<String, Any>>

    @POST("cardholder/auth/2fa/setup")
    suspend fun cardholder2FASetup(): Response<Map<String, Any>>

    @POST("cardholder/auth/2fa/verify")
    suspend fun cardholder2FAVerify(@Body body: Map<String, String>): Response<Map<String, Any>>

    // ═══════════ MERCHANT — DASHBOARD & TXNS ═══════════
    @GET("merchant/dashboard")
    suspend fun merchantDashboard(): Response<MerchantDashboard>

    @GET("merchant/account")
    suspend fun merchantAccount(): Response<Map<String, Any>>

    @PUT("merchant/account")
    suspend fun merchantUpdateAccount(@Body body: Map<String, String>): Response<Map<String, Any>>

    @POST("merchant/account/change-password")
    suspend fun merchantChangePassword(@Body body: Map<String, String>): Response<Map<String, Any>>

    @GET("merchant/transactions")
    suspend fun merchantTransactions(
        @Query("page")       page: Int = 1,
        @Query("limit")      limit: Int = 50,
        @Query("status")     status: String? = null,
        @Query("terminalId") terminalId: String? = null,
    ): Response<TransactionsResponse>

    @GET("merchant/transactions/{id}")
    suspend fun merchantTransactionDetail(@Path("id") id: String): Response<Transaction>

    // ═══════════ MERCHANT — ENCAISSEMENT ═══════════
    @POST("merchant/collect")
    suspend fun merchantCollect(@Body body: CollectRequest): Response<PaymentResponse>

    @POST("merchant/collect/contactless")
    suspend fun merchantCollectNFC(@Body body: Map<String, Any>): Response<PaymentResponse>

    @GET("merchant/collect/{txnId}/status")
    suspend fun merchantCollectStatus(@Path("txnId") txnId: String): Response<PaymentStatus>

    @GET("merchant/disburse/{txnId}/status")
    suspend fun merchantDisburseStatus(@Path("txnId") txnId: String): Response<PaymentStatus>

    // ═══════════ MERCHANT — SOLDE & TRANSFERTS ═══════════
    @GET("merchant/balance")
    suspend fun merchantBalance(): Response<MerchantBalance>

    @GET("merchant/bank-accounts")
    suspend fun merchantBankAccounts(): Response<BankAccountsResponse>

    @POST("merchant/bank-accounts")
    suspend fun merchantAddBankAccount(@Body body: Map<String, String>): Response<BankAccount>

    @DELETE("merchant/bank-accounts/{id}")
    suspend fun merchantDeleteBankAccount(@Path("id") id: String): Response<Map<String, Any>>

    @POST("merchant/transfer/payout")
    suspend fun merchantPayout(@Body body: Map<String, Any>): Response<MerchantPayoutResponse>

    @GET("merchant/transfers")
    suspend fun merchantTransfers(): Response<MerchantTransfersResponse>

    // ═══════════ MERCHANT — DECAISSEMENT & RETRAIT ═══════════
    @POST("merchant/disburse")
    suspend fun merchantDisburse(@Body body: DisburseRequest): Response<PaymentResponse>

    @POST("merchant/withdraw")
    suspend fun merchantWithdraw(@Body body: WithdrawRequest): Response<PaymentResponse>

    // ═══════════ MERCHANT — PAY LINKS ═══════════
    @GET("merchant/pay-links")
    suspend fun merchantPayLinks(): Response<PayLinksResponse>

    @POST("merchant/pay-links")
    suspend fun merchantCreatePayLink(@Body body: Map<String, Any>): Response<PayLinkCreateResponse>

    @POST("merchant/pay-links/{id}/send")
    suspend fun merchantSendPayLink(@Path("id") id: String, @Body body: Map<String, String>): Response<Map<String, Any>>

    @DELETE("merchant/pay-links/{id}")
    suspend fun merchantDeletePayLink(@Path("id") id: String): Response<Map<String, Any>>

    // ═══════════ MERCHANT — RECU SMS ═══════════
    @POST("merchant/receipts/sms")
    suspend fun merchantReceiptSms(@Body body: Map<String, Any>): Response<Map<String, Any>>

    // ═══════════ MERCHANT — REGLEMENTS ═══════════
    @GET("merchant/settlements")
    suspend fun merchantSettlements(): Response<SettlementsResponse>

    @GET("merchant/fees")
    suspend fun merchantFees(): Response<Map<String, Any>>

    // ═══════════ MERCHANT — TERMINAUX ═══════════
    @POST("merchant/terminals/pair")
    suspend fun terminalPair(@Body body: PairRequest): Response<PairResponse>

    @POST("merchant/terminals/check")
    suspend fun terminalCheck(@Body body: CheckRequest): Response<CheckResponse>

    @GET("merchant/terminals")
    suspend fun merchantTerminals(): Response<TerminalsResponse>

    @POST("merchant/terminals")
    suspend fun merchantCreateTerminal(@Body body: Map<String, String>): Response<Terminal>

    @DELETE("merchant/terminals/{id}")
    suspend fun merchantDeleteTerminal(@Path("id") id: String): Response<Map<String, Any>>

    // ═══════════ MERCHANT — CLES API ═══════════
    @GET("merchant/api-keys")
    suspend fun merchantApiKeys(): Response<ApiKeysResponse>

    @POST("merchant/api-keys")
    suspend fun merchantCreateApiKey(@Body body: Map<String, Any>): Response<ApiKey>

    @DELETE("merchant/api-keys/{id}")
    suspend fun merchantRevokeApiKey(@Path("id") id: String): Response<Map<String, Any>>

    // ═══════════ MERCHANT — KYB ═══════════
    @GET("merchant/kyb")
    suspend fun merchantKyb(): Response<KycStatus>

    // ═══════════ MERCHANT — SUPPORT ═══════════
    @GET("merchant/support/tickets")
    suspend fun merchantTickets(): Response<TicketsResponse>

    @POST("merchant/support/tickets")
    suspend fun merchantCreateTicket(@Body body: Map<String, String>): Response<Ticket>

    // ═══════════ CARDHOLDER — DASHBOARD ═══════════
    @GET("cardholder/dashboard")
    suspend fun cardholderDashboard(): Response<CardholderDashboard>

    @GET("cardholder/transactions")
    suspend fun cardholderTransactions(
        @Query("page")  page: Int = 1,
        @Query("limit") limit: Int = 50,
    ): Response<TransactionsResponse>

    // ═══════════ CARDHOLDER — CARTES CREEES ═══════════
    @GET("cardholder/card")
    suspend fun cardholderCard(): Response<CardDetail>

    @GET("cardholder/cards/created")
    suspend fun cardholderCreatedCards(): Response<CreatedCardsResponse>

    @GET("cardholder/gtp/status")
    suspend fun gtpStatus(): Response<GtpStatus>

    @POST("cardholder/cards/create")
    suspend fun cardholderCreateCard(@Body body: Map<String, String>): Response<CardDetail>

    @DELETE("cardholder/cards/created/{id}")
    suspend fun cardholderDeleteCard(@Path("id") id: String): Response<Map<String, Any>>

    @PATCH("cardholder/card/status")
    suspend fun cardholderCardStatus(@Body body: Map<String, String>): Response<Map<String, Any>>

    @POST("cardholder/card/pin")
    suspend fun cardholderSetPin(@Body body: Map<String, String>): Response<Map<String, Any>>

    // ═══════════ CARDHOLDER — CARTES ENROLEES ═══════════
    @GET("cardholder/cards")
    suspend fun cardholderEnrolledCards(): Response<EnrolledCardsResponse>

    @POST("cardholder/cards/enroll")
    suspend fun cardholderEnrollCard(@Body body: Map<String, Any>): Response<EnrolledCard>

    @DELETE("cardholder/cards/{id}")
    suspend fun cardholderRemoveEnrolled(@Path("id") id: String): Response<Map<String, Any>>

    @PATCH("cardholder/cards/{id}/default")
    suspend fun cardholderSetDefaultCard(@Path("id") id: String): Response<Map<String, Any>>

    // ═══════════ CARDHOLDER — SOLDE ═══════════
    @POST("cardholder/topup")
    suspend fun cardholderTopup(@Body body: Map<String, Any>): Response<Map<String, Any>>

    @POST("cardholder/unload")
    suspend fun cardholderUnload(@Body body: Map<String, Any>): Response<Map<String, Any>>

    // ═══════════ CARDHOLDER — PAIEMENT ═══════════
    @POST("cardholder/payment")
    suspend fun cardholderPay(@Body body: Map<String, Any>): Response<PaymentResponse>

    @POST("cardholder/payment/tokenized")
    suspend fun cardholderPayTokenized(@Body body: Map<String, Any>): Response<PaymentResponse>

    // ═══════════ CARDHOLDER — PROFIL ═══════════
    @PATCH("cardholder/profile")
    suspend fun cardholderUpdateProfile(@Body body: Map<String, String>): Response<Map<String, Any>>

    @POST("cardholder/profile/change-password")
    suspend fun cardholderChangePassword(@Body body: Map<String, String>): Response<Map<String, Any>>

    @GET("cardholder/kyc")
    suspend fun cardholderKyc(): Response<KycStatus>

    @GET("cardholder/security/events")
    suspend fun cardholderSecurityEvents(): Response<Map<String, Any>>

    // ═══════════ CARDHOLDER — SUPPORT ═══════════
    @GET("cardholder/support/tickets")
    suspend fun cardholderTickets(): Response<TicketsResponse>

    @POST("cardholder/support/tickets")
    suspend fun cardholderCreateTicket(@Body body: Map<String, String>): Response<Ticket>

    // ═══════════ GTP — CARTES ═══════════
    @GET("cardholder/gtp/ping")
    suspend fun gtpPing(): Response<Map<String, Any>>

    @GET("cardholder/gtp/cards")
    suspend fun gtpCards(): Response<GtpCardsResponse>

    @GET("cardholder/gtp/cards/{id}")
    suspend fun gtpCardDetail(@Path("id") id: Long): Response<GtpCard>

    @POST("cardholder/gtp/issue")
    suspend fun gtpIssueCard(@Body body: Map<String, Any>): Response<Map<String, Any>>

    @GET("cardholder/gtp/cards/{id}/transactions")
    suspend fun gtpTransactions(
        @Path("id") id: Long,
        @Query("limit") limit: Int = 50,
    ): Response<GtpTransactionsResponse>

    @POST("cardholder/gtp/cards/{id}/topup")
    suspend fun gtpTopup(@Path("id") id: Long, @Body body: Map<String, Any>): Response<TransferResponse>

    @POST("cardholder/gtp/cards/{id}/unload")
    suspend fun gtpUnload(@Path("id") id: Long, @Body body: Map<String, Any>): Response<TransferResponse>

    @POST("cardholder/gtp/cards/{id}/payment")
    suspend fun gtpPayment(@Path("id") id: Long, @Body body: Map<String, Any>): Response<TransferResponse>

    @POST("cardholder/gtp/cards/{id}/pin")
    suspend fun gtpSetPin(@Path("id") id: Long, @Body body: Map<String, String>): Response<Map<String, Any>>

    @PATCH("cardholder/gtp/cards/{id}/freeze")
    suspend fun gtpFreeze(@Path("id") id: Long): Response<Map<String, Any>>

    @PATCH("cardholder/gtp/cards/{id}/unfreeze")
    suspend fun gtpUnfreeze(@Path("id") id: Long): Response<Map<String, Any>>

    // ═══════════ TRANSFERTS BANCAIRES (items 13/14) ═══════════
    @GET("cardholder/gtp/institutions")
    suspend fun institutions(
        @Query("country") country: String? = null,
        @Query("type")    type: String? = null,
    ): Response<InstitutionsResponse>

    @GET("cardholder/gtp/bank-accounts")
    suspend fun bankAccounts(): Response<BankAccountsResponse>

    @POST("cardholder/gtp/bank-accounts")
    suspend fun addBankAccount(@Body body: Map<String, String>): Response<BankAccount>

    @DELETE("cardholder/gtp/bank-accounts/{id}")
    suspend fun deleteBankAccount(@Path("id") id: String): Response<Map<String, Any>>

    @POST("cardholder/gtp/transfer/initiate")
    suspend fun transferInitiate(@Body body: Map<String, Any>): Response<TransferInitResponse>

    @GET("cardholder/gtp/transfer/{id}/status")
    suspend fun transferStatus(@Path("id") id: String): Response<TransferStatus>

    @GET("cardholder/gtp/wallets")
    suspend fun wallets(): Response<WalletsResponse>

    @POST("cardholder/gtp/wallets")
    suspend fun addWallet(@Body body: Map<String, String>): Response<Wallet>

    @DELETE("cardholder/gtp/wallets/{id}")
    suspend fun deleteWallet(@Path("id") id: String): Response<Map<String, Any>>

    // ═══════════ KYC (item 8) ═══════════
    @Multipart
    @POST("cardholder/kyc/documents")
    suspend fun uploadKycDoc(
        @Part("docType") docType: okhttp3.RequestBody,
        @Part file: okhttp3.MultipartBody.Part,
    ): Response<KycUploadResponse>

    @Multipart
    @POST("merchant/kyb/documents")
    suspend fun uploadKybDoc(@Body body: KybDocRequest): Response<Map<String, Any>>
}