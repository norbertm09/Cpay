package global.cpay.app.common

import org.junit.Assert.assertEquals
import org.junit.Test

/** Lot Android P2 (audit P2-4) : libelles purs des statuts et operateurs (CashLabels). */
class CashLabelsTest {

    @Test fun `statuts de transfert, dont sending et unknown`() {
        assertEquals("Envoi en cours", CashLabels.transferStatus("sending"))
        assertEquals("Résultat incertain", CashLabels.transferStatus("unknown"))
        assertEquals("Effectué", CashLabels.transferStatus("completed"))
        assertEquals("—", CashLabels.transferStatus(null))
        assertEquals("statut_inconnu", CashLabels.transferStatus("statut_inconnu"))
    }

    @Test fun `operateurs connus, alias et repli`() {
        assertEquals("MTN MoMo", CashLabels.operator("mtn_momo"))
        assertEquals("MTN MoMo", CashLabels.operator("MTN"))
        assertEquals("Airtel Money", CashLabels.operator("airtel"))
        assertEquals("Mobile Money", CashLabels.operator(null))
        assertEquals("Camtel money", CashLabels.operator("camtel_money"))
    }
}
