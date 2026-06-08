package africa.calculus.plus.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.*
import androidx.compose.ui.unit.*
import androidx.hilt.navigation.compose.hiltViewModel
import africa.calculus.plus.domain.model.*
import africa.calculus.plus.ui.components.CalculusScaffold
import africa.calculus.plus.ui.theme.*
import africa.calculus.plus.ui.viewmodel.TransactionsViewModel
import africa.calculus.plus.ui.viewmodel.SettlementsViewModel

// ════════════════════════════════════════════════════════════════
// TRANSACTIONS SCREEN
// ════════════════════════════════════════════════════════════════

@Composable
fun TransactionsScreen(
    onBack: () -> Unit,
    vm: TransactionsViewModel = hiltViewModel(),
) {
    val state by vm.uiState.collectAsState()

    CalculusScaffold(title = "Transactions", onBack = onBack) {
        when {
            state.isLoading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = CalculusGreen)
            }
            state.transactions.isEmpty() -> EmptyState("Aucune transaction")
            else -> LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(state.transactions) { txn -> TransactionCard(txn) }
            }
        }
    }
}

@Composable
private fun TransactionCard(txn: Transaction) {
    val statusColor = when (txn.status) {
        TransactionStatus.AUTHORIZED -> CalculusGreen
        TransactionStatus.FAILED     -> CalculusRed
        TransactionStatus.PENDING    -> CalculusOrange
        else                         -> CalculusTextSecondary
    }
    val typeIcon = when (txn.type) {
        TransactionType.COLLECT   -> Icons.Filled.Add
        TransactionType.PAYOUT    -> Icons.Filled.ArrowUpward
        TransactionType.QR_PAYMENT -> Icons.Filled.QrCode
        TransactionType.PAY_LINK  -> Icons.Filled.Link
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape    = RoundedCornerShape(12.dp),
        colors   = CardDefaults.cardColors(containerColor = CalculusCard),
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            // Icône type
            Box(
                modifier = Modifier.size(40.dp).background(statusColor.copy(alpha = 0.15f), RoundedCornerShape(10.dp)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(typeIcon, null, tint = statusColor, modifier = Modifier.size(20.dp))
            }

            Column(modifier = Modifier.weight(1f)) {
                Text(
                    txn.description ?: txn.type.label,
                    style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium),
                    color = CalculusText,
                )
                Text(
                    txn.status.label,
                    style = MaterialTheme.typography.bodySmall,
                    color = statusColor,
                )
            }

            Column(horizontalAlignment = Alignment.End) {
                Text(
                    txn.formattedAmount(),
                    style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold),
                    color = if (txn.type == TransactionType.PAYOUT) CalculusRed else CalculusText,
                )
                txn.netAmount?.let {
                    Text("Net : %.0f".format(it), style = MaterialTheme.typography.bodySmall, color = CalculusTextSecondary)
                }
            }
        }
    }
}

// ════════════════════════════════════════════════════════════════
// SETTLEMENTS SCREEN
// ════════════════════════════════════════════════════════════════

@Composable
fun SettlementsScreen(
    onBack: () -> Unit,
    vm: SettlementsViewModel = hiltViewModel(),
) {
    val state by vm.uiState.collectAsState()

    CalculusScaffold(title = "Règlements", onBack = onBack) {
        when {
            state.isLoading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = CalculusGreen)
            }
            state.settlements.isEmpty() -> EmptyState("Aucun règlement")
            else -> LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(state.settlements) { settlement ->
                    SettlementCard(settlement)
                }
            }
        }
    }
}

@Composable
private fun SettlementCard(item: africa.calculus.plus.data.api.SettlementItem) {
    val statusColor = when (item.status) {
        "completed" -> CalculusGreen
        "pending", "submitted" -> CalculusOrange
        else -> CalculusRed
    }
    val statusLabel = when (item.status) {
        "completed" -> "Réglé"
        "submitted" -> "En cours"
        "pending"   -> "En attente"
        else        -> item.status
    }

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape    = RoundedCornerShape(12.dp),
        colors   = CardDefaults.cardColors(containerColor = CalculusCard),
    ) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(
                    item.batch_date,
                    style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold),
                    color = CalculusText,
                )
                Text(
                    statusLabel,
                    style = MaterialTheme.typography.labelMedium,
                    color = statusColor,
                )
            }

            Divider(color = CalculusDivider)

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                SettlementAmountItem("Volume brut", "%.0f %s".format(item.total_gross, item.currency))
                SettlementAmountItem("Frais", "- %.0f".format(item.total_fees))
                SettlementAmountItem("Net reçu", "%.0f %s".format(item.total_net, item.currency), highlight = true)
            }

            Text(
                "${item.txn_count} transaction${if (item.txn_count > 1) "s" else ""}",
                style = MaterialTheme.typography.bodySmall,
                color = CalculusTextSecondary,
            )
        }
    }
}

@Composable
private fun SettlementAmountItem(label: String, value: String, highlight: Boolean = false) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = CalculusTextSecondary)
        Text(value, style = MaterialTheme.typography.bodyMedium.copy(
            fontWeight = FontWeight.SemiBold,
            color = if (highlight) CalculusGreen else CalculusText,
        ))
    }
}

@Composable
private fun EmptyState(message: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Icons.Filled.Inbox, null, tint = CalculusTextHint, modifier = Modifier.size(48.dp))
            Text(message, color = CalculusTextSecondary)
        }
    }
}
