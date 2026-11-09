package global.cpay.app.db

import android.content.Context
import com.google.gson.Gson
import global.cpay.app.common.Transaction
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*

object CacheManager {

    private val sdf = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())

    // Sauvegarder les transactions en local
    suspend fun saveTransactions(context: Context, txns: List<Transaction>, userType: String) {
        val dao = AppDatabase.get(context).transactionDao()
        val entities = txns.map { t ->
            TransactionEntity(
                txnId         = t.txnId.ifEmpty { java.util.UUID.randomUUID().toString() },
                type          = t.type,
                amount        = t.amount,
                currency      = t.currency,
                status        = t.status,
                method        = t.method,
                initiatedAt   = t.initiatedAt,
                authCode      = t.authCode,
                customerPhone = t.customerPhone,
                description   = t.description,
                userType      = userType
            )
        }
        dao.insertAll(entities)
        purgeOld(context, userType)
    }

    // Récupérer depuis le cache (J et J-1)
    suspend fun getCachedTransactions(context: Context, userType: String): List<TransactionEntity> {
        val dao = AppDatabase.get(context).transactionDao()
        val yesterday = Calendar.getInstance().apply { add(Calendar.DAY_OF_YEAR, -1) }
        val since = sdf.format(yesterday.time) + "T00:00:00"
        return dao.getSince(userType, since)
    }

    // Purger les données de plus de J-1
    suspend fun purgeOld(context: Context, userType: String) {
        val dao = AppDatabase.get(context).transactionDao()
        val yesterday = Calendar.getInstance().apply { add(Calendar.DAY_OF_YEAR, -1) }
        val before = sdf.format(yesterday.time) + "T00:00:00"
        dao.purgeBefore(userType, before)
    }

    // Convertir entity en Transaction pour l'adapter
    fun entityToTransaction(e: TransactionEntity) = Transaction(
        txnIdCh       = e.txnId,
        type          = e.type,
        amount        = e.amount,
        currency      = e.currency,
        status        = e.status,
        method        = e.method,
        initiatedAt   = e.initiatedAt,
        authCode      = e.authCode,
        customerPhone = e.customerPhone,
        description   = e.description,
    )

    // ─── WAVE-5 : cache JSON generique (resume de caisse, journal) ───
    private val gson = Gson()

    // Lot 4 (audit 2026-11-02 mobile P1-3) : cles prefixees par l'utilisateur connecte — un autre marchand sur le
    // meme terminal ne relit jamais le solde ou le journal du precedent ; tout est purge a la deconnexion.
    private fun scope() = global.cpay.app.common.SessionManager.userId ?: "anon"
    fun keyCashSummary() = "cash_summary_" + scope()
    fun keyHistory(type: String?) = "cash_history_" + scope() + "_" + (type ?: "all")

    /** Valeur en cache + date d'enregistrement (epoch ms), ou null. */
    class Cached<T>(val value: T, val savedAt: Long)

    suspend fun <T> putJson(context: Context, key: String, value: T) {
        try {
            AppDatabase.get(context).cacheDao().put(CacheEntryEntity(key, gson.toJson(value)))
        } catch (_: Exception) { }
    }

    suspend fun <T> getJson(context: Context, key: String, type: Class<T>): Cached<T>? {
        return try {
            val e = AppDatabase.get(context).cacheDao().get(key) ?: return null
            val v = gson.fromJson(e.json, type) ?: return null
            Cached(v, e.savedAt)
        } catch (_: Exception) { null }
    }

    suspend fun clearJson(context: Context) {
        try { AppDatabase.get(context).cacheDao().clear() } catch (_: Exception) { }
    }

    /** Purge complete (deconnexion, session perdue) : cache JSON + transactions des deux profils. */
    suspend fun clearAll(context: Context) {
        clearJson(context)
        try {
            val dao = AppDatabase.get(context).transactionDao()
            dao.clearAll("merchant"); dao.clearAll("cardholder")
        } catch (_: Exception) { }
    }

    /** Variante hors coroutine (intercepteur OkHttp) : execution sur un thread IO, erreurs avalees. */
    fun clearAllAsync(context: Context) {
        kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).launch { clearAll(context) }
    }
}
