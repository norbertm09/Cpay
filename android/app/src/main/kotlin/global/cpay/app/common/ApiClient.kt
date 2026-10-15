package global.cpay.app.common

import android.content.Context
import android.content.Intent
import global.cpay.app.BuildConfig
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.TimeUnit

object ApiClient {

    private lateinit var retrofit: Retrofit
    private lateinit var appContext: Context
    val api: ApiService by lazy { retrofit.create(ApiService::class.java) }

    fun init(context: Context) {
        appContext = context.applicationContext

        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BODY
                    else HttpLoggingInterceptor.Level.NONE
        }

        val client = OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .addInterceptor { chain ->
                val token = SessionManager.token

                // Auto-logout si token expiré
                if (!token.isNullOrBlank() && SecurityManager.isTokenExpired(token)) {
                    SessionManager.clearSession()
                    val intent = Intent("global.cpay.app.LOGOUT")
                    appContext.sendBroadcast(intent)
                }

                val request = chain.request().newBuilder()
                    .addHeader("Content-Type", "application/json")
                    .addHeader("User-Agent", "CPlus-Android/${BuildConfig.VERSION_NAME}")
                    .addHeader("X-App-Platform", "android")
                    .apply {
                        if (!token.isNullOrBlank()) {
                            addHeader("Authorization", "Bearer $token")
                        }
                    }
                    .build()

                val response = chain.proceed(request)

                // Auto-logout sur 401
                if (response.code == 401) {
                    SessionManager.clearSession()
                    val intent = Intent("global.cpay.app.LOGOUT")
                    appContext.sendBroadcast(intent)
                }

                response
            }
            .addInterceptor(logging)
            .build()

        retrofit = Retrofit.Builder()
            .baseUrl(BuildConfig.API_BASE_URL + "/")
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
    }
}
