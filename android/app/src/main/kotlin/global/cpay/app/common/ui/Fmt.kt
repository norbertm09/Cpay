package global.cpay.app.common.ui

import java.text.NumberFormat
import java.text.ParseException
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Formats partages (montants, dates) — francais, sans emoji. */
object Fmt {
    private val number: NumberFormat = NumberFormat.getNumberInstance(Locale.FRANCE).apply {
        maximumFractionDigits = 0
    }
    private val numberDecimals: NumberFormat = NumberFormat.getNumberInstance(Locale.FRANCE).apply {
        maximumFractionDigits = 2
    }

    /** « 12 500 XAF » (entiers pour XOF/XAF/CDF, 2 decimales sinon si besoin). */
    fun money(v: Double?, currency: String): String {
        val x = v ?: 0.0
        val s = if (x == Math.floor(x)) number.format(x) else numberDecimals.format(x)
        return "$s $currency"
    }

    fun amount(v: Double?): String = number.format(v ?: 0.0)

    private val isoPatterns = listOf(
        "yyyy-MM-dd'T'HH:mm:ss.SSSX", "yyyy-MM-dd'T'HH:mm:ssX",
        "yyyy-MM-dd'T'HH:mm:ss.SSS", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd",
    )

    /** Parse une date ISO (UTC si suffixe Z / decalage), sinon null. */
    fun parse(iso: String?): Date? {
        if (iso.isNullOrBlank()) return null
        val s = iso.trim().replace("Z", "+00:00")
        for (p in isoPatterns) {
            try {
                val f = SimpleDateFormat(p, Locale.US)
                if (!p.endsWith("X")) f.timeZone = TimeZone.getTimeZone("UTC")
                return f.parse(s)
            } catch (_: ParseException) { } catch (_: IllegalArgumentException) { }
        }
        return null
    }

    private val dayFmt   = SimpleDateFormat("EEEE d MMMM yyyy", Locale.FRANCE)
    private val shortFmt = SimpleDateFormat("d MMM yyyy", Locale.FRANCE)
    private val timeFmt  = SimpleDateFormat("HH:mm", Locale.FRANCE)
    private val fullFmt  = SimpleDateFormat("d MMM yyyy 'à' HH:mm", Locale.FRANCE)
    private val keyFmt   = SimpleDateFormat("yyyy-MM-dd", Locale.US)

    /** « 15 oct. 2026 à 14:32 » ; chaine brute tronquee si non analysable. */
    fun dateTime(iso: String?): String {
        val d = parse(iso) ?: return (iso ?: "").take(16).replace("T", " ")
        return fullFmt.format(d).replaceFirstChar { it.lowercase() }
    }

    fun time(iso: String?): String = parse(iso)?.let { timeFmt.format(it) } ?: ""

    fun dateTime(d: Date): String = fullFmt.format(d)

    /** Cle de regroupement par jour (local). */
    fun dayKey(iso: String?): String = parse(iso)?.let { keyFmt.format(it) } ?: (iso ?: "").take(10)

    /** « Aujourd'hui » / « Hier » / « lundi 12 octobre 2026 ». */
    fun dayLabel(iso: String?, today: String, yesterday: String): String {
        val d = parse(iso) ?: return (iso ?: "").take(10)
        val cal = Calendar.getInstance()
        val todayKey = keyFmt.format(cal.time)
        cal.add(Calendar.DAY_OF_YEAR, -1)
        val yKey = keyFmt.format(cal.time)
        return when (keyFmt.format(d)) {
            todayKey -> today
            yKey     -> yesterday
            else     -> dayFmt.format(d).replaceFirstChar { it.uppercase() }
        }
    }

    fun shortDate(iso: String?): String = parse(iso)?.let { shortFmt.format(it) } ?: (iso ?: "").take(10)
}
