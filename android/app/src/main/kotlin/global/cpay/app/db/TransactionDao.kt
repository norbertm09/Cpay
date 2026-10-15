package global.cpay.app.db

import androidx.room.*

@Dao
interface TransactionDao {

    @Query("SELECT * FROM transactions WHERE userType = :userType ORDER BY initiatedAt DESC LIMIT 50")
    suspend fun getAll(userType: String): List<TransactionEntity>

    @Query("SELECT * FROM transactions WHERE userType = :userType AND initiatedAt >= :since ORDER BY initiatedAt DESC")
    suspend fun getSince(userType: String, since: String): List<TransactionEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(txns: List<TransactionEntity>)

    @Query("DELETE FROM transactions WHERE userType = :userType AND initiatedAt < :before")
    suspend fun purgeBefore(userType: String, before: String)

    @Query("DELETE FROM transactions WHERE userType = :userType")
    suspend fun clearAll(userType: String)

    @Query("SELECT COUNT(*) FROM transactions WHERE userType = :userType")
    suspend fun count(userType: String): Int
}
