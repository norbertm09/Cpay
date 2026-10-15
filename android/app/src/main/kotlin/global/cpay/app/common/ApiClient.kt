package global.cpay.app.common

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.google.gson.Gson
import global.cpay.app.BuildConfig
import global.cpay.app.onboarding.ProfileSelectActivity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Authenticator
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.Route
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.io.IOException
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Client HTTP C-Pay.
 *
 * WAVE-3 — contrat d'authentification unifie (backend vagues 1-2) :
 *  - access JWT 15 min + refresh opaque (rotation a chaque usage) ;
 *  - rafraichissement proactif quand l'access expire dans < 60 s (intercepteur) ;
 *  - sur 401, [TokenAuthenticator] rafraichit UNE fois (single-flight, verrou)
 *    puis rejoue la requete ; si le refresh est refuse (INVALID_REFRESH,
 *    REFRESH_REUSED…) la session locale est effacee et l'app revient a l'ecran
 *    de connexion. Une panne reseau pendant le refresh ne deconnecte pas.
 */
object ApiClient {

    private const val TAG = "CPay-Auth"
    const val ACTION_LOGOUT = "global.cpay.app.LOGOUT"
    const val EXTRA_SESSION_EXPIRED = "session_expired"

    private val JSON = "application/json; charset=utf-8".toMediaType()
    private val USER_AGENT = "CPay-Android/${BuildConfig.VERSION_NAME}"

    // Routes sans jeton : pas de bearer, pas de refresh, pas de deconnexion sur 401.
    private val PUBLIC_SUFFIXES = listOf(
        "/auth/login", "/auth/register", "/auth/2fa/validate", "/auth/refresh",
        "/auth/forgot-password", "/auth/reset-password",
        "/detect/phone",                                  // WAVE-4 : detection operateur (publique)
    )

    private lateinit var retrofit: Retrofit
    private lateinit var appContext: Context
    private lateinit var refreshClient: OkHttpClient
    private val gson = Gson()
    private val refreshLock = ReentrantLock()

    val api: ApiService by lazy { retrofit.create(ApiService::class.java) }

    fun init(context: Context) {
        appContext = context.applicationContext

        val logging = HttpLoggingInterceptor().apply {
            level = if (BuildConfig.DEBUG) HttpLoggingInterceptor.Level.BODY
                    else HttpLoggingInterceptor.Level.NONE
        }

        // Client dedie au refresh : aucun intercepteur d'auth (evite toute recursion).
        refreshClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(15, TimeUnit.SECONDS)
            .writeTimeout(15, TimeUnit.SECONDS)
            .addInterceptor(logging)
            .build()

        val client = OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .addInterceptor(AuthInterceptor())
            .authenticator(TokenAuthenticator())
            .addInterceptor(logging)
            .build()

        retrofit = Retrofit.Builder()
            .baseUrl(BuildConfig.API_BASE_URL + "/")
            .client(client)
            .addConverterFactory(GsonConverterFactory.create())
            .build()
    }

    // ─── Helpers de routage ───────────────────────────────────────────
    private fun isPublic(url: HttpUrl): Boolean {
        val p = url.encodedPath
        return PUBLIC_SUFFIXES.any { p.endsWith(it) }
    }
    private fun isLogout(url: HttpUrl): Boolean = url.encodedPath.endsWith("/auth/logout")

    // Codes 401 qui designent un access token invalide/expire (middleware/auth.js).
    private val TOKEN_401_CODES = setOf("INVALID_TOKEN", "MISSING_TOKEN", "TOKEN_EXPIRED")

    /** Vrai si ce 401 est du au jeton d'acces (et non a un code metier comme INVALID_TOTP). */
    private fun isTokenFailure(response: Response): Boolean {
        val code = try {
            val txt = response.peekBody(2048).string()
            gson.fromJson(txt, ApiError::class.java)?.code
        } catch (_: Exception) { null }
        return code == null || code in TOKEN_401_CODES
    }

    // ─── Intercepteur : en-tetes + refresh proactif ───────────────────
    private class AuthInterceptor : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val original = chain.request()
            val publicRoute = isPublic(original.url)
            var token = SessionManager.token

            if (!publicRoute && !isLogout(original.url) && !token.isNullOrBlank()
                && SessionManager.isAccessTokenExpiringSoon
                && !SessionManager.refreshToken.isNullOrBlank()) {
                when (refreshBlocking(token)) {
                    RefreshResult.OK       -> token = SessionManager.token
                    RefreshResult.REJECTED -> onSessionLost()
                    RefreshResult.NETWORK  -> { /* on tente avec l'access courant */ }
                }
            }

            val builder = original.newBuilder()
                .header("Accept", "application/json")
                .header("User-Agent", USER_AGENT)
                .header("X-App-Platform", "android")
            if (!publicRoute && !token.isNullOrBlank()) builder.header("Authorization", "Bearer $token")
            return chain.proceed(builder.build())
        }
    }

    // ─── Authenticator : 401 → refresh (une fois) → rejeu ─────────────
    private class TokenAuthenticator : Authenticator {
        override fun authenticate(route: Route?, response: Response): Request? {
            val req = response.request
            if (isPublic(req.url) || isLogout(req.url)) return null
            if (responseCount(response) >= 2) return null            // deja rejoue une fois
            if (!isTokenFailure(response)) return null               // 401 metier (TOTP, mot de passe…)

            val sent = req.header("Authorization")?.removePrefix("Bearer ")?.trim()
            if (sent.isNullOrBlank()) return null                    // requete sans jeton
            val current = SessionManager.token
            if (current.isNullOrBlank()) return null                 // session deja effacee

            val fresh: String? = if (current != sent) {
                current                                              // deja rafraichi par un autre appel
            } else when (refreshBlocking(sent)) {
                RefreshResult.OK       -> SessionManager.token
                RefreshResult.REJECTED -> { onSessionLost(); null }
                RefreshResult.NETWORK  -> null
            }
            if (fresh.isNullOrBlank()) return null
            return req.newBuilder().header("Authorization", "Bearer $fresh").build()
        }

        private fun responseCount(r: Response): Int {
            var count = 1
            var prior = r.priorResponse
            while (prior != null) { count++; prior = prior.priorResponse }
            return count
        }
    }

    private enum class RefreshResult { OK, REJECTED, NETWORK }

    /**
     * Rafraichit la paire access/refresh (POST /<type>/auth/refresh { refreshToken }).
     * Single-flight : si un autre thread a deja rafraichi (le token stocke differe de
     * [staleToken]), on reutilise simplement le nouveau jeton.
     */
    private fun refreshBlocking(staleToken: String?): RefreshResult =
        refreshLock.withLock { refreshLocked(staleToken) }

    private fun refreshLocked(staleToken: String?): RefreshResult {
        val current = SessionManager.token
        if (current.isNullOrBlank()) return RefreshResult.REJECTED
        if (staleToken != null && current != staleToken) return RefreshResult.OK

        val rt   = SessionManager.refreshToken
        val type = SessionManager.userType
        if (rt.isNullOrBlank() || (type != "merchant" && type != "cardholder")) {
            return RefreshResult.REJECTED
        }

        val body = gson.toJson(RefreshRequest(rt)).toRequestBody(JSON)
        val request = Request.Builder()
            .url("${BuildConfig.API_BASE_URL}/$type/auth/refresh")
            .post(body)
            .header("Accept", "application/json")
            .header("User-Agent", USER_AGENT)
            .header("X-App-Platform", "android")
            .build()

        return try {
            refreshClient.newCall(request).execute().use { resp ->
                val text = resp.body?.string()
                if (resp.isSuccessful && !text.isNullOrBlank()) {
                    val auth = try { gson.fromJson(text, AuthResponse::class.java) } catch (_: Exception) { null }
                    if (auth != null && auth.accessToken.isNotBlank()) {
                        SessionManager.saveTokens(auth.accessToken, auth.refreshToken, auth.expiresIn)
                        Log.d(TAG, "refresh OK (expires_in=${auth.expiresIn})")
                        RefreshResult.OK
                    } else {
                        Log.w(TAG, "refresh: reponse inattendue")
                        RefreshResult.REJECTED
                    }
                } else {
                    Log.w(TAG, "refresh refuse: HTTP ${resp.code}")
                    // 400/401/403/422 : refresh invalide, reutilise ou revoque → deconnexion.
                    // 429/5xx : incident cote serveur, on ne deconnecte pas.
                    if (resp.code in listOf(400, 401, 403, 422)) RefreshResult.REJECTED
                    else RefreshResult.NETWORK
                }
            }
        } catch (e: IOException) {
            Log.w(TAG, "refresh: erreur reseau ${e.message}")
            RefreshResult.NETWORK
        }
    }

    /**
     * Session irrecuperable : efface les jetons (l'appairage terminal est conserve),
     * notifie et renvoie l'utilisateur a l'ecran de choix de profil.
     */
    fun onSessionLost() {
        if (!SessionManager.isLoggedIn) return
        SessionManager.clearSession()
        global.cpay.app.merchant.CashSession.clear()
        global.cpay.app.merchant.StepUp.reset()
        appContext.sendBroadcast(Intent(ACTION_LOGOUT).setPackage(appContext.packageName))
        Handler(Looper.getMainLooper()).post {
            val i = Intent(appContext, ProfileSelectActivity::class.java)
            i.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            i.putExtra(EXTRA_SESSION_EXPIRED, true)
            appContext.startActivity(i)
        }
    }

    /**
     * Deconnexion volontaire : POST /<type>/auth/logout { refreshToken } (revocation
     * serveur, erreurs ignorees) puis effacement de la session locale.
     */
    suspend fun logout() = withContext(Dispatchers.IO) {
        val type = SessionManager.userType
        // Le logout porteur exige un access valide : on rafraichit s'il est sur le point d'expirer.
        if (SessionManager.isAccessTokenExpiringSoon && !SessionManager.refreshToken.isNullOrBlank()) {
            refreshBlocking(SessionManager.token)
        }
        val rt = SessionManager.refreshToken ?: ""
        try {
            when (type) {
                "merchant"   -> api.merchantLogout(RefreshRequest(rt))
                "cardholder" -> api.cardholderLogout(RefreshRequest(rt))
                else         -> null
            }
        } catch (e: Exception) {
            Log.w(TAG, "logout: ${e.message}")
        }
        SessionManager.clearSession()
        global.cpay.app.merchant.CashSession.clear()
        global.cpay.app.merchant.StepUp.reset()
    }
}
