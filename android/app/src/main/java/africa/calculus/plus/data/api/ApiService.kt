package africa.calculus.plus.data.api

import africa.calculus.plus.BuildConfig
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Response
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.*
import java.util.concurrent.TimeUnit

// ─── Request / Response models ────────────────────────────────────

data class CollectRequest(
    val amount:        Double,
    val customerPhone: String?  = null,
    val emvPayload:    String?  = null,
    val aidDetected:   String?  = null,
    val description:   String?  = null,
    val deviceId:      String?  = null,
)

data class PayoutRequest(
    val amount:        Double,
    val customerPhone: String? = null,
    val emvPayload:    String? = null,
    val description:   String? = null,
)

data class QrRequest(val amount: Double, val description: String? = null)
data class PayLinkRequest(val amount: Double, val description: String? = null)

data class LoginRequest(val emailOrPhone: String, val password: String)
data class RegisterRequest(
    val businessName:       String,
    val rccm:               String?,
    val nif:                String?,
    val phone:              String,
    val email:              String,
    val password:           String,
    val settlementType:     String = "mobile_money",
    val settlementAccount:  String?,
    val settlementProvider: String?,
)

// ─── API Responses ────────────────────────────────────────────────

data class TransactionResponse(
    val success:   Boolean,
    val txnId:     String,
    val message:   String,
    val amount:    Double,
    val currency:  String,
    val authCode:  String?,
    val error:     String?,
)

data class QrResponse(
    val success:    Boolean,
    val qrId:       String,
    val url:        String,
    val qrContent:  String,
)

data class PayLinkResponse(
    val success:   Boolean,
    val linkId:    String,
    val url:       String,
    val shareText: String,
    val channels:  Map<String, String>,
)

data class AuthResponse(
    val access_token:  String,
    val refresh_token: String,
    val user:          UserInfo,
    val merchant:      MerchantInfo?,
)

data class UserInfo(
    val userId:      String,
    val firstName:   String?,
    val merchantId:  String,
    val businessName: String,
    val currency:    String,
    val kybLevel:    Int,
)

data class MerchantInfo(val merchantId: String, val businessName: String, val country: String, val currency: String)

data class DashboardResponse(
    val txnToday:         Int,
    val amountToday:      Double,
    val settlingTomorrow: Double,
)

data class TransactionItem(
    val transaction_id: String,
    val type:           String,
    val amount:         Double,
    val currency:       String,
    val payment_method: String,
    val status:         String,
    val description:    String?,
    val auth_code:      String?,
    val fee_amount:     Double?,
    val net_amount:     Double?,
    val initiated_at:   String,
    val completed_at:   String?,
)

data class TransactionListResponse(val data: List<TransactionItem>, val page: Int, val limit: Int)

data class SettlementItem(
    val batch_id:    String,
    val batch_date:  String,
    val total_gross: Double,
    val total_fees:  Double,
    val total_net:   Double,
    val currency:    String,
    val txn_count:   Int,
    val status:      String,
)

data class SettlementListResponse(val data: List<SettlementItem>)

// ─── Retrofit Service ─────────────────────────────────────────────

interface CalculusApiService {

    @POST("auth/register")
    suspend fun register(@Body request: RegisterRequest): Response<AuthResponse>

    @POST("auth/login")
    suspend fun login(@Body request: LoginRequest): Response<AuthResponse>

    @POST("collect")
    suspend fun collect(@Body request: CollectRequest): Response<TransactionResponse>

    @POST("payout")
    suspend fun payout(@Body request: PayoutRequest): Response<TransactionResponse>

    @POST("qr-code")
    suspend fun generateQr(@Body request: QrRequest): Response<QrResponse>

    @POST("pay-link")
    suspend fun generatePayLink(@Body request: PayLinkRequest): Response<PayLinkResponse>

    @GET("dashboard")
    suspend fun getDashboard(): Response<DashboardResponse>

    @GET("transactions")
    suspend fun getTransactions(
        @Query("page")  page:  Int = 1,
        @Query("limit") limit: Int = 20,
    ): Response<TransactionListResponse>

    @GET("settlements")
    suspend fun getSettlements(): Response<SettlementListResponse>
}

// ─── API Client Factory ───────────────────────────────────────────

object ApiClientFactory {

    fun create(tokenProvider: () -> String?): CalculusApiService {
        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BODY
                    else HttpLoggingInterceptor.Level.NONE
        }

        val client = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val req = chain.request().newBuilder().apply {
                    tokenProvider()?.let { addHeader("Authorization", "Bearer $it") }
                    addHeader("X-App-Version", BuildConfig.VERSION_NAME)
                    addHeader("X-Platform",    "Android")
                }.build()
                chain.proceed(req)
            }
            .addInterceptor(logging)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(60,  TimeUnit.SECONDS)   // Mobile Money peut prendre 30s
            .writeTimeout(30, TimeUnit.SECONDS)
            .build()

        return Retrofit.Builder()
            .baseUrl(BuildConfig.API_BASE_URL + "/api/v1/")
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
            .create(CalculusApiService::class.java)
    }
}
