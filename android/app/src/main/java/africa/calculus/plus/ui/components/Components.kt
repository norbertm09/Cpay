package africa.calculus.plus.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.*
import androidx.compose.ui.unit.*
import africa.calculus.plus.ui.theme.*

@Composable
fun DashboardHeader(greeting: String, businessName: String) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 24.dp)) {
        Text("$greeting,", style = MaterialTheme.typography.bodyLarge, color = CalculusTextSecondary)
        Text(businessName, style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Bold), color = CalculusText)
    }
}

@Composable
fun PrimaryActionButton(label: String, icon: ImageVector, color: Color, modifier: Modifier, onClick: () -> Unit) {
    Button(
        onClick  = onClick,
        modifier = modifier.height(72.dp),
        shape    = RoundedCornerShape(16.dp),
        colors   = ButtonDefaults.buttonColors(containerColor = color),
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(icon, null, modifier = Modifier.size(24.dp))
            Spacer(Modifier.height(4.dp))
            Text(label, style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold))
        }
    }
}

@Composable
fun SecondaryActionButton(label: String, icon: ImageVector, modifier: Modifier, onClick: () -> Unit) {
    OutlinedButton(
        onClick  = onClick,
        modifier = modifier.height(60.dp),
        shape    = RoundedCornerShape(12.dp),
        colors   = ButtonDefaults.outlinedButtonColors(contentColor = CalculusText),
        border   = androidx.compose.foundation.BorderStroke(1.dp, CalculusDivider),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(icon, null, modifier = Modifier.size(18.dp), tint = CalculusGreen)
            Text(label, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
fun DaySummarySection(state: africa.calculus.plus.ui.viewmodel.DashboardUiState) {
    Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Aujourd'hui", style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold), color = CalculusText)
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            SummaryCard("Transactions", "${state.txnToday}", modifier = Modifier.weight(1f))
            SummaryCard("Encaissé", "%.0f %s".format(state.amountToday, state.currency), modifier = Modifier.weight(1f))
        }
        SummaryCard("Règlement J+1", "%.0f %s".format(state.settlingTomorrow, state.currency), modifier = Modifier.fillMaxWidth(), highlight = true)
    }
}

@Composable
fun SummaryCard(label: String, value: String, modifier: Modifier, highlight: Boolean = false) {
    Card(
        modifier = modifier,
        shape    = RoundedCornerShape(12.dp),
        colors   = CardDefaults.cardColors(containerColor = if (highlight) CalculusGreen.copy(alpha = 0.12f) else CalculusCard),
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text(label, style = MaterialTheme.typography.labelMedium, color = CalculusTextSecondary)
            Spacer(Modifier.height(4.dp))
            Text(value, style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Bold),
                color = if (highlight) CalculusGreen else CalculusText)
        }
    }
}

@Composable
fun OutlineListButton(label: String, modifier: Modifier, onClick: () -> Unit) {
    OutlinedButton(onClick = onClick, modifier = modifier.height(48.dp), shape = RoundedCornerShape(10.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, CalculusDivider),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = CalculusText)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(label, style = MaterialTheme.typography.bodyMedium)
            Icon(Icons.Filled.ArrowForwardIos, null, modifier = Modifier.size(12.dp), tint = CalculusTextSecondary)
        }
    }
}

@Composable
fun MethodCard(title: String, subtitle: String, icon: ImageVector, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        shape    = RoundedCornerShape(16.dp),
        colors   = CardDefaults.cardColors(containerColor = CalculusCard),
    ) {
        Row(modifier = Modifier.padding(20.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Box(modifier = Modifier.size(48.dp).clip(CircleShape).background(CalculusGreen.copy(alpha = 0.15f)), contentAlignment = Alignment.Center) {
                Icon(icon, null, tint = CalculusGreen, modifier = Modifier.size(24.dp))
            }
            Column(modifier = Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold), color = CalculusText)
                Text(subtitle, style = MaterialTheme.typography.bodySmall, color = CalculusTextSecondary)
            }
            Icon(Icons.Filled.ChevronRight, null, tint = CalculusTextSecondary)
        }
    }
}

@Composable
fun CalculusNumpad(onKeyPress: (String) -> Unit) {
    val keys = listOf("1","2","3","4","5","6","7","8","9",".","0","DEL")
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        keys.chunked(3).forEach { row ->
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                row.forEach { key ->
                    Button(
                        onClick  = { onKeyPress(key) },
                        modifier = Modifier.weight(1f).height(64.dp),
                        shape    = RoundedCornerShape(12.dp),
                        colors   = ButtonDefaults.buttonColors(containerColor = CalculusCard, contentColor = CalculusText),
                    ) {
                        if (key == "DEL") Icon(Icons.Filled.Backspace, null, tint = CalculusTextSecondary)
                        else Text(key, style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Medium))
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CalculusScaffold(title: String, onBack: () -> Unit, content: @Composable () -> Unit) {
    Scaffold(
        containerColor = CalculusBg,
        topBar = {
            TopAppBar(
                title = { Text(title, style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.SemiBold), color = CalculusText) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.Filled.ArrowBack, null, tint = CalculusText) } },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = CalculusBg),
            )
        }
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) { content() }
    }
}
