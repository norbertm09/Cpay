package global.cpay.app.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Lot Android P2 (audit P2-4) : lecture des erreurs `{ error, code }` et regles d'idempotence (CAISSE-API § 0). */
class ApiErrorsTest {

    @Test fun `parse tolere le vide, le JSON et le texte brut`() {
        assertNull(ApiErrors.parse(null).code)
        assertNull(ApiErrors.parse("").code)
        val e = ApiErrors.parse("""{"error":"Solde insuffisant","code":"INSUFFICIENT_BALANCE","available":1250.5}""")
        assertEquals("INSUFFICIENT_BALANCE", e.code); assertEquals(1250.5, e.available!!, 0.0)
        val raw = ApiErrors.parse("<html>502 Bad Gateway</html>")
        assertNull(raw.code); assertTrue(raw.error!!.startsWith("<html>"))
    }

    @Test fun `la cle d'idempotence est conservee tant que le resultat n'est pas definitif`() {
        assertTrue(ApiErrors.keepIdempotencyKey(500, null))
        assertTrue(ApiErrors.keepIdempotencyKey(502, ApiError(code = "GATEWAY_ERROR")))
        assertTrue(ApiErrors.keepIdempotencyKey(428, ApiError(code = ApiErrors.STEP_UP_REQUIRED)))
        assertTrue(ApiErrors.keepIdempotencyKey(409, ApiError(code = ApiErrors.IDEMPOTENCY_IN_PROGRESS)))
        assertTrue(ApiErrors.keepIdempotencyKey(409, ApiError(code = ApiErrors.IDEMPOTENCY_RETRY_AFTER_ERROR)))
        // refus metier definitif : la cle est liberee
        assertFalse(ApiErrors.keepIdempotencyKey(422, ApiError(code = ApiErrors.INSUFFICIENT_BALANCE)))
        assertFalse(ApiErrors.keepIdempotencyKey(409, ApiError(code = ApiErrors.IDEMPOTENCY_CONFLICT)))
        assertFalse(ApiErrors.keepIdempotencyKey(403, ApiError(code = "MERCHANT_INACTIVE")))
    }

    @Test fun `messages caisse par code structure`() {
        assertTrue(ApiErrors.cashMessage(422, ApiError(code = ApiErrors.INSUFFICIENT_BALANCE, available = 1500.0), "XAF").contains("1"))
        assertEquals(ApiErrors.FEATURE_DISABLED_MESSAGE, ApiErrors.cashMessage(410, ApiError()))
        assertEquals(ApiErrors.FEATURE_DISABLED_MESSAGE, ApiErrors.cashMessage(200, ApiError(code = ApiErrors.FEATURE_DISABLED)))
        assertEquals("Confirmation invalide", ApiErrors.cashMessage(428, ApiError(code = "INVALID_TOTP")))
        assertEquals("Donnees du serveur", ApiErrors.cashMessage(422, ApiError(code = "VALIDATION_ERROR", error = "Donnees du serveur")))
        assertEquals("Erreur", ApiErrors.cashMessage(500, ApiError()))
        assertTrue(ApiErrors.cashMessage(429, ApiError()).contains("Trop"))
    }
}
