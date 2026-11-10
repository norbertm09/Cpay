package global.cpay.app.common

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Lot Android P2 (audit 2026-11-02 P2-4) : fonctions pures de SecurityManager. */
class SecurityManagerTest {

    @Test fun `numeros CEMAC et locaux acceptes`() {
        listOf("+242061234567", "+243 81 234 5678", "+237670000001", "+24106123456", "+23566123456", "+240222123456",
               "066123456", "66123456", "061 234 567").forEach { assertNull("attendu valide : $it", SecurityManager.validatePhone(it)) }
    }

    @Test fun `numeros hors zone ou mal formes refuses`() {
        listOf("+33612345678", "+2420612345", "12345", "", "+242abcdefghi", "0661234567890").forEach {
            assertNotNull("attendu invalide : $it", SecurityManager.validatePhone(it))
        }
    }

    @Test fun `normalisation locale vers international`() {
        assertEquals("+242066123456", SecurityManager.normalizePhone("066123456"))
        assertEquals("+242066123456", SecurityManager.normalizePhone("066 123 456"))
        assertEquals("+237670000001", SecurityManager.normalizePhone("670000001", "+237"))
        assertEquals("+243812345678", SecurityManager.normalizePhone("+243812345678", "+242"))
    }

    @Test fun `montant borne`() {
        assertNotNull(SecurityManager.validateAmount(50.0))
        assertNull(SecurityManager.validateAmount(100.0))
        assertNull(SecurityManager.validateAmount(5_000_000.0))
        assertNotNull(SecurityManager.validateAmount(5_000_001.0))
    }

    @Test fun `cle d'idempotence = UUID unique`() {
        val a = SecurityManager.newIdempotencyKey(); val b = SecurityManager.newIdempotencyKey()
        assertTrue(a.matches(Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")))
        assertNotEquals(a, b)
        assertTrue(SecurityManager.generateRef("PAY").startsWith("PAY-"))
    }
}
