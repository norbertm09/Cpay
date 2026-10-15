package global.cpay.app.db

import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "transactions")
data class TransactionEntity(
    @PrimaryKey val txnId: String,
    val type: String,
    val amount: Double,
    val currency: String,
    val status: String,
    val method: String?,
    val initiatedAt: String?,
    val authCode: String?,
    val customerPhone: String?,
    val description: String? = null,
    val userType: String,   // "cardholder" | "merchant"
    val cachedAt: Long = System.currentTimeMillis()
)
