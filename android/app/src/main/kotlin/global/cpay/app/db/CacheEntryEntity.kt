package global.cpay.app.db

import androidx.room.Entity
import androidx.room.PrimaryKey

/** Cache cle/valeur JSON (WAVE-5) : dernier resume de caisse, premiere page du journal. */
@Entity(tableName = "cache_entries")
data class CacheEntryEntity(
    @PrimaryKey val key: String,
    val json: String,
    val savedAt: Long = System.currentTimeMillis(),
)
