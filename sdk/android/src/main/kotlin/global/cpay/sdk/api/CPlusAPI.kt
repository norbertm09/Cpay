package global.cpay.sdk.api

import global.cpay.sdk.models.*
import global.cpay.sdk.utils.CPlusLogger
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

class CPlusAPI(private val config: CPlusConfig) {

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(config.timeout, TimeUnit.MILLISECONDS)
        .readTimeout(config.timeout, TimeUnit.MILLISECONDS)
        .writeTimeout(config.timeout, TimeUnit.MILLISECONDS)
        .addInterceptor { chain ->
            val request = chain.request().newBuilder()
                .addHeader("X-API-Key",    config.apiKey)
                .addHeader("X-API-Secret", config.apiSecret)
                .addHeader("Content-Type", "application/json")
                .addHeader("User-Agent",   "CPlus-Android-SDK/2.6.0")
                .build()
            chain.proceed(request)
        }
        .apply {
            if (config.debugMode) {
                addInterceptor(okhttp3.logging.HttpLoggingInterceptor().apply {
                    level = okhttp3.logging.HttpLoggingInterceptor.Level.BODY
                })
            }
        }
        .build()

    private val JSON = "application/json".toMediaType()

    fun collect(
        request:   CPlusPaymentRequest,
        onSuccess: (CPlusTransaction) -> Unit,
        onError:   (CPlusError) -> Unit
    ) {
        val body = JSONObject().apply {
            put("amount",        request.amount)
            put("currency",      request.currency)
            put("customerPhone", request.phone ?: "")
            put("method",        request.method.value)
            put("reference",     request.reference)
            put("description",   request.description)
        }

        post("/merchant/public/collect", body, onSuccess, onError)
    }

    fun disburse(
        request:   CPlusPaymentRequest,
        onSuccess: (CPlusTransaction) -> Unit,
        onError:   (CPlusError) -> Unit
    ) {
        val body = JSONObject().apply {
            put("amount",         request.amount)
            put("recipientPhone", request.phone ?: "")
            put("method",         request.method.value)
            put("reference",      request.reference)
            put("description",    request.description)
        }

        post("/merchant/public/collect", body, onSuccess, onError)
    }

    fun createPayLink(
        request:   CPlusPaymentRequest,
        onSuccess: (JSONObject) -> Unit,
        onError:   (CPlusError) -> Unit
    ) {
        val body = JSONObject().apply {
            put("amount",      request.amount)
            put("currency",    request.currency)
            put("description", request.description)
            put("reference",   request.reference)
        }

        val httpRequest = Request.Builder()
            .url(config.baseUrl + "/merchant/public/pay-links")
            .post(body.toString().toRequestBody(JSON))
            .build()

        client.newCall(httpRequest).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                onError(CPlusError.network(e.message ?: "Erreur réseau"))
            }
            override fun onResponse(call: Call, response: Response) {
                val json = JSONObject(response.body?.string() ?: "{}")
                if (response.isSuccessful) onSuccess(json)
                else onError(CPlusError.api(json.optString("error", "Erreur API")))
            }
        })
    }

    fun getTransaction(
        txnId:     String,
        onSuccess: (CPlusTransaction) -> Unit,
        onError:   (CPlusError) -> Unit
    ) {
        val httpRequest = Request.Builder()
            .url("${config.baseUrl}/merchant/public/transactions/$txnId")
            .get()
            .build()

        client.newCall(httpRequest).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                onError(CPlusError.network(e.message ?: "Erreur réseau"))
            }
            override fun onResponse(call: Call, response: Response) {
                val json = JSONObject(response.body?.string() ?: "{}")
                if (response.isSuccessful) {
                    onSuccess(parseTransaction(json))
                } else {
                    onError(CPlusError.api(json.optString("error", "Erreur API")))
                }
            }
        })
    }

    private fun post(
        endpoint:  String,
        body:      JSONObject,
        onSuccess: (CPlusTransaction) -> Unit,
        onError:   (CPlusError) -> Unit
    ) {
        CPlusLogger.log("POST $endpoint — ${body}")
        val httpRequest = Request.Builder()
            .url(config.baseUrl + endpoint)
            .post(body.toString().toRequestBody(JSON))
            .build()

        client.newCall(httpRequest).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                CPlusLogger.log("Erreur réseau: ${e.message}")
                onError(CPlusError.network(e.message ?: "Erreur réseau"))
            }
            override fun onResponse(call: Call, response: Response) {
                val json = JSONObject(response.body?.string() ?: "{}")
                CPlusLogger.log("Réponse ${response.code}: $json")
                if (response.isSuccessful) {
                    onSuccess(parseTransaction(json))
                } else {
                    onError(CPlusError.api(json.optString("error", "Erreur API")))
                }
            }
        })
    }

    private fun parseTransaction(json: JSONObject) = CPlusTransaction(
        txnId     = json.optString("txnId",     ""),
        reference = json.optString("reference", ""),
        status    = when (json.optString("status")) {
            "completed" -> TransactionStatus.COMPLETED
            "failed"    -> TransactionStatus.FAILED
            "cancelled" -> TransactionStatus.CANCELLED
            else        -> TransactionStatus.PENDING
        },
        amount    = json.optDouble("amount",   0.0),
        fee       = json.optDouble("fee",      0.0),
        net       = json.optDouble("net",      0.0),
        currency  = json.optString("currency", "XAF"),
        method    = json.optString("method",   ""),
        createdAt = json.optString("createdAt",""),
        authCode  = json.optString("authCode", "").ifEmpty { null },
    )
}
