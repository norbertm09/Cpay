package africa.calculus.plus.ui.screens

import androidx.compose.animation.*
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.draw.*
import androidx.compose.ui.graphics.*
import androidx.compose.ui.text.*
import androidx.compose.ui.text.font.*
import androidx.compose.ui.text.style.*
import androidx.compose.ui.unit.*
import androidx.hilt.navigation.compose.hiltViewModel
import africa.calculus.plus.domain.model.*
import africa.calculus.plus.ui.components.*
import africa.calculus.plus.ui.theme.*
import africa.calculus.plus.ui.viewmodel.*

// ════════════════════════════════════════════════════════════════
// DASHBOARD SCREEN
// ════════════════════════════════════════════════════════════════

@Composable
fun DashboardScreen(
    onCollect:     () -> Unit,
    onPayout:      () -> Unit,
    onQrCode:      () -> Unit,
    onPayLink:     () -> Unit,
    onTransactions: () -> Unit,
    onSettlements: () -> Unit,
    vm: DashboardViewModel = hiltViewModel(),
) {
    val state by vm.uiState.collectAsState()

    Scaffold(
        containerColor = CalculusBg,
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
        ) {
            // ── Header ──────────────────────────────────────────
            DashboardHeader(
                greeting    = state.greeting,
                businessName = state.businessName,
            )

            Spacer(Modifier.height(24.dp))

            // ── Boutons primaires : Encaisser + Retrait ──────────
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                PrimaryActionButton(
                    label    = "Encaisser",
                    icon     = Icons.Filled.Add,
                    color    = CalculusGreen,
                    modifier = Modifier.weight(1f),
                    onClick  = onCollect,
                )
                PrimaryActionButton(
                    label    = "Retrait",
                    icon     = Icons.Filled.ArrowUpward,
                    color    = CalculusBlue,
                    modifier = Modifier.weight(1f),
                    onClick  = onPayout,
                )
            }

            Spacer(Modifier.height(12.dp))

            // ── Boutons secondaires : QR + Lien ─────────────────
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                SecondaryActionButton(
                    label    = "QR Code",
                    icon     = Icons.Outlined.QrCode,
                    modifier = Modifier.weight(1f),
                    onClick  = onQrCode,
                )
                SecondaryActionButton(
                    label    = "Lien de Paiement",
                    icon     = Icons.Outlined.Link,
                    modifier = Modifier.weight(1f),
                    onClick  = onPayLink,
                )
            }

            Spacer(Modifier.height(28.dp))
            Divider(color = CalculusDivider, modifier = Modifier.padding(horizontal = 20.dp))
            Spacer(Modifier.height(20.dp))

            // ── Résumé du jour ────────────────────────────────────
            DaySummarySection(state = state)

            Spacer(Modifier.height(20.dp))

            // ── Liens vers les listes ─────────────────────────────
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlineListButton(
                    label    = "Transactions",
                    modifier = Modifier.weight(1f),
                    onClick  = onTransactions,
                )
                OutlineListButton(
                    label    = "Règlements",
                    modifier = Modifier.weight(1f),
                    onClick  = onSettlements,
                )
            }

            Spacer(Modifier.height(32.dp))
        }
    }
}

// ════════════════════════════════════════════════════════════════
// COLLECT SCREEN — Encaissement
// ════════════════════════════════════════════════════════════════

@Composable
fun CollectScreen(
    onBack:  () -> Unit,
    vm: CollectViewModel = hiltViewModel(),
) {
    val state by vm.uiState.collectAsState()

    // Routing automatique selon l'étape
    when (state.step) {
        CollectStep.SELECT_METHOD  -> MethodSelectionScreen("Encaisser", onBack, onMobileMoney = { vm.selectMobileMoney() }, onCard = { vm.selectCard() })
        CollectStep.ENTER_AMOUNT   -> AmountEntryScreen(title = "Montant à encaisser", currency = state.currency, onBack = { vm.goBack() }, onNext = { vm.setAmount(it) })
        CollectStep.ENTER_PHONE    -> PhoneEntryScreen(onBack = { vm.goBack() }, onNext = { vm.setPhone(it) })
        CollectStep.WAITING_NFC    -> NfcTapScreen(amount = state.amount, currency = state.currency, amountCents = (state.amount * 100).toLong(), onBack = { vm.goBack() }, vm = vm)
        CollectStep.PROCESSING     -> ProcessingScreen()
        CollectStep.SUCCESS        -> SuccessScreen(result = state.result as PaymentResult.Success, onDone = onBack)
        CollectStep.FAILURE        -> FailureScreen(result = state.result as PaymentResult.Failure, onRetry = { vm.retry() }, onBack = onBack)
    }
}

// ════════════════════════════════════════════════════════════════
// PAYOUT SCREEN — Retrait
// ════════════════════════════════════════════════════════════════

@Composable
fun PayoutScreen(
    onBack: () -> Unit,
    vm: PayoutViewModel = hiltViewModel(),
) {
    val state by vm.uiState.collectAsState()

    when (state.step) {
        PayoutStep.SELECT_METHOD -> MethodSelectionScreen("Retrait", onBack, onMobileMoney = { vm.selectMobileMoney() }, onCard = { vm.selectCard() })
        PayoutStep.ENTER_AMOUNT  -> AmountEntryScreen(title = "Montant du retrait", currency = state.currency, onBack = { vm.goBack() }, onNext = { vm.setAmount(it) })
        PayoutStep.ENTER_PHONE   -> PhoneEntryScreen(onBack = { vm.goBack() }, onNext = { vm.setPhone(it) })
        PayoutStep.WAITING_NFC   -> NfcTapScreen(amount = state.amount, currency = state.currency, amountCents = (state.amount * 100).toLong(), onBack = { vm.goBack() }, vm = vm)
        PayoutStep.PROCESSING    -> ProcessingScreen()
        PayoutStep.SUCCESS       -> SuccessScreen(result = state.result as PaymentResult.Success, onDone = onBack, label = "Retrait effectué")
        PayoutStep.FAILURE       -> FailureScreen(result = state.result as PaymentResult.Failure, onRetry = { vm.retry() }, onBack = onBack)
    }
}

// ════════════════════════════════════════════════════════════════
// QR CODE SCREEN
// ════════════════════════════════════════════════════════════════

@Composable
fun QrCodeScreen(
    onBack: () -> Unit,
    vm: QrViewModel = hiltViewModel(),
) {
    val state by vm.uiState.collectAsState()

    when {
        state.qrPayload != null -> QrDisplayScreen(payload = state.qrPayload!!, onBack = onBack, onNew = { vm.reset() })
        state.isLoading -> ProcessingScreen()
        else -> {
            AmountEntryScreen(
                title     = "QR Code de paiement",
                currency  = state.currency,
                subtitle  = "Le client scannera le QR pour payer",
                onBack    = onBack,
                onNext    = { amount ->
                    val desc = state.description
                    vm.generateQr(amount, desc)
                },
                showDescriptionField = true,
                descriptionValue     = state.description,
                onDescriptionChange  = { vm.setDescription(it) },
            )
        }
    }
}

// ════════════════════════════════════════════════════════════════
// PAY LINK SCREEN
// ════════════════════════════════════════════════════════════════

@Composable
fun PayLinkScreen(
    onBack: () -> Unit,
    vm: PayLinkViewModel = hiltViewModel(),
) {
    val state by vm.uiState.collectAsState()

    when {
        state.payLink != null -> PayLinkShareScreen(payLink = state.payLink!!, onBack = onBack, onNew = { vm.reset() })
        state.isLoading -> ProcessingScreen()
        else -> AmountEntryScreen(
            title     = "Lien de paiement",
            currency  = state.currency,
            subtitle  = "Partagez le lien avec votre client",
            onBack    = onBack,
            onNext    = { vm.generatePayLink(it, state.description) },
            showDescriptionField = true,
            descriptionValue     = state.description,
            onDescriptionChange  = { vm.setDescription(it) },
        )
    }
}

// ════════════════════════════════════════════════════════════════
// COMPOSABLES PARTAGÉS (sous-écrans de navigation)
// ════════════════════════════════════════════════════════════════

@Composable
private fun MethodSelectionScreen(
    title:         String,
    onBack:        () -> Unit,
    onMobileMoney: () -> Unit,
    onCard:        () -> Unit,
) {
    CalculusScaffold(title = title, onBack = onBack) {
        Column(
            modifier = Modifier.fillMaxSize().padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Spacer(Modifier.height(16.dp))

            MethodCard(
                title    = "Mobile Money",
                subtitle = "Saisir le numéro de téléphone du client",
                icon     = Icons.Filled.PhoneAndroid,
                onClick  = onMobileMoney,
            )

            MethodCard(
                title    = "Carte Bancaire NFC",
                subtitle = "Approcher la carte ou le téléphone du client",
                icon     = Icons.Outlined.CreditCard,
                onClick  = onCard,
            )
        }
    }
}

@Composable
private fun AmountEntryScreen(
    title:                String,
    currency:             String,
    subtitle:             String? = null,
    onBack:               () -> Unit,
    onNext:               (Double) -> Unit,
    showDescriptionField: Boolean = false,
    descriptionValue:     String? = null,
    onDescriptionChange:  (String) -> Unit = {},
) {
    var amountStr by remember { mutableStateOf("") }

    CalculusScaffold(title = title, onBack = onBack) {
        Column(
            modifier = Modifier.fillMaxSize().padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (subtitle != null) {
                Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = CalculusTextSecondary)
                Spacer(Modifier.height(24.dp))
            }

            // Affichage du montant
            Text(
                text  = if (amountStr.isEmpty()) "0" else amountStr,
                style = MaterialTheme.typography.displayMedium.copy(
                    fontWeight = FontWeight.Bold,
                    color      = if (amountStr.isEmpty()) CalculusTextHint else CalculusText,
                ),
            )
            Text(currency, style = MaterialTheme.typography.titleLarge, color = CalculusTextSecondary)

            Spacer(Modifier.height(32.dp))

            // Numpad
            CalculusNumpad(
                onKeyPress = { key ->
                    when (key) {
                        "DEL" -> if (amountStr.isNotEmpty()) amountStr = amountStr.dropLast(1)
                        "."   -> if (!amountStr.contains('.')) amountStr = "$amountStr."
                        else  -> {
                            val new = amountStr + key
                            if (new.matches(Regex("^\\d{0,8}(\\.\\d{0,2})?\$"))) amountStr = new
                        }
                    }
                }
            )

            if (showDescriptionField) {
                Spacer(Modifier.height(16.dp))
                OutlinedTextField(
                    value         = descriptionValue ?: "",
                    onValueChange = onDescriptionChange,
                    label         = { Text("Description (optionnelle)") },
                    singleLine    = true,
                    modifier      = Modifier.fillMaxWidth(),
                )
            }

            Spacer(Modifier.weight(1f))

            Button(
                onClick  = { amountStr.toDoubleOrNull()?.let { if (it > 0) onNext(it) } },
                enabled  = amountStr.toDoubleOrNull()?.let { it > 0 } == true,
                modifier = Modifier.fillMaxWidth().height(56.dp),
                colors   = ButtonDefaults.buttonColors(containerColor = CalculusGreen),
            ) {
                Text("Continuer", style = MaterialTheme.typography.titleMedium)
            }
        }
    }
}

@Composable
private fun PhoneEntryScreen(
    onBack: () -> Unit,
    onNext: (String) -> Unit,
) {
    var phone by remember { mutableStateOf("") }

    CalculusScaffold(title = "Numéro du client", onBack = onBack) {
        Column(
            modifier = Modifier.fillMaxSize().padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(
                "Saisir le numéro Mobile Money avec l'indicatif pays",
                style = MaterialTheme.typography.bodyMedium,
                color = CalculusTextSecondary,
            )

            OutlinedTextField(
                value         = phone,
                onValueChange = { phone = it },
                label         = { Text("Numéro de téléphone") },
                placeholder   = { Text("+237 6XX XXX XXX") },
                singleLine    = true,
                modifier      = Modifier.fillMaxWidth(),
                prefix        = { Text("+") },
            )

            Spacer(Modifier.weight(1f))

            Button(
                onClick  = { if (phone.isNotBlank()) onNext(if (!phone.startsWith("+")) "+$phone" else phone) },
                enabled  = phone.length >= 8,
                modifier = Modifier.fillMaxWidth().height(56.dp),
                colors   = ButtonDefaults.buttonColors(containerColor = CalculusGreen),
            ) {
                Text("Confirmer", style = MaterialTheme.typography.titleMedium)
            }
        }
    }
}

@Composable
private fun NfcTapScreen(
    amount:      Double,
    currency:    String,
    amountCents: Long,
    onBack:      () -> Unit,
    vm:          Any, // CollectViewModel ou PayoutViewModel
) {
    Box(modifier = Modifier.fillMaxSize().background(CalculusBg)) {
        Column(
            modifier            = Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(
                imageVector = Icons.Outlined.Contactless,
                contentDescription = null,
                modifier    = Modifier.size(80.dp),
                tint        = CalculusGreen,
            )
            Spacer(Modifier.height(24.dp))
            Text(
                "Approcher la carte ou le téléphone",
                style = MaterialTheme.typography.titleLarge.copy(fontWeight = FontWeight.Medium),
                color = CalculusText,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(8.dp))
            Text(
                "%.0f %s".format(amount, currency),
                style = MaterialTheme.typography.displaySmall.copy(fontWeight = FontWeight.Bold),
                color = CalculusGreen,
            )
            Spacer(Modifier.height(48.dp))
            CircularProgressIndicator(color = CalculusGreen, strokeWidth = 3.dp, modifier = Modifier.size(32.dp))
        }
        IconButton(onClick = onBack, modifier = Modifier.align(Alignment.TopStart).padding(16.dp)) {
            Icon(Icons.Filled.ArrowBack, contentDescription = "Retour", tint = CalculusText)
        }
    }
}

@Composable
private fun ProcessingScreen() {
    Box(modifier = Modifier.fillMaxSize().background(CalculusBg), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
            CircularProgressIndicator(color = CalculusGreen, strokeWidth = 4.dp, modifier = Modifier.size(48.dp))
            Text("Traitement en cours…", style = MaterialTheme.typography.titleMedium, color = CalculusTextSecondary)
        }
    }
}

@Composable
private fun SuccessScreen(result: PaymentResult.Success, onDone: () -> Unit, label: String = "Paiement accepté") {
    Box(modifier = Modifier.fillMaxSize().background(CalculusBg)) {
        Column(
            modifier = Modifier.fillMaxSize().padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(Icons.Filled.CheckCircle, null, tint = CalculusGreen, modifier = Modifier.size(80.dp))
            Spacer(Modifier.height(24.dp))
            Text(label, style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Bold), color = CalculusText)
            Spacer(Modifier.height(8.dp))
            Text("%.0f %s".format(result.amount, result.currency), style = MaterialTheme.typography.displaySmall.copy(fontWeight = FontWeight.Bold, color = CalculusGreen))
            result.authCode?.let {
                Spacer(Modifier.height(8.dp))
                Text("Ref : $it", style = MaterialTheme.typography.bodyMedium, color = CalculusTextSecondary)
            }
            Spacer(Modifier.height(48.dp))
            Button(onClick = onDone, modifier = Modifier.fillMaxWidth().height(56.dp), colors = ButtonDefaults.buttonColors(containerColor = CalculusGreen)) {
                Text("Terminer", style = MaterialTheme.typography.titleMedium)
            }
        }
    }
}

@Composable
private fun FailureScreen(result: PaymentResult.Failure, onRetry: () -> Unit, onBack: () -> Unit) {
    Box(modifier = Modifier.fillMaxSize().background(CalculusBg)) {
        Column(
            modifier = Modifier.fillMaxSize().padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Icon(Icons.Filled.Cancel, null, tint = CalculusRed, modifier = Modifier.size(80.dp))
            Spacer(Modifier.height(24.dp))
            Text("Paiement refusé", style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Bold), color = CalculusText)
            Spacer(Modifier.height(8.dp))
            Text(result.message, style = MaterialTheme.typography.bodyMedium, color = CalculusTextSecondary, textAlign = TextAlign.Center)
            Spacer(Modifier.height(40.dp))
            if (result.retryable) {
                Button(onClick = onRetry, modifier = Modifier.fillMaxWidth().height(56.dp), colors = ButtonDefaults.buttonColors(containerColor = CalculusGreen)) {
                    Text("Réessayer", style = MaterialTheme.typography.titleMedium)
                }
                Spacer(Modifier.height(12.dp))
            }
            OutlinedButton(onClick = onBack, modifier = Modifier.fillMaxWidth().height(56.dp)) {
                Text("Retour", style = MaterialTheme.typography.titleMedium)
            }
        }
    }
}

@Composable
private fun QrDisplayScreen(payload: QrPayload, onBack: () -> Unit, onNew: () -> Unit) {
    CalculusScaffold(title = "QR Code", onBack = onBack) {
        Column(modifier = Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(Modifier.height(16.dp))
            Text("%.0f %s".format(payload.amount, payload.currency), style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Bold), color = CalculusGreen)
            payload.description?.let { Text(it, color = CalculusTextSecondary) }
            Spacer(Modifier.height(24.dp))
            // QR Code rendu via ZXing ou Compose-QR
            Box(modifier = Modifier.size(240.dp).background(Color.White, RoundedCornerShape(16.dp)).padding(16.dp), contentAlignment = Alignment.Center) {
                // TODO: remplacer par QrCodeImage(payload.qrContent)
                Text("QR: ${payload.qrContent.take(30)}…", style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
            }
            Spacer(Modifier.height(24.dp))
            Text("Le client scanne ce QR avec son application de paiement", style = MaterialTheme.typography.bodySmall, color = CalculusTextSecondary, textAlign = TextAlign.Center)
            Spacer(Modifier.weight(1f))
            OutlinedButton(onClick = onNew, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text("Nouveau QR") }
        }
    }
}

@Composable
private fun PayLinkShareScreen(payLink: PayLink, onBack: () -> Unit, onNew: () -> Unit) {
    CalculusScaffold(title = "Lien de Paiement", onBack = onBack) {
        Column(modifier = Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(Modifier.height(16.dp))
            Text("%.0f %s".format(payLink.amount, payLink.currency), style = MaterialTheme.typography.headlineMedium.copy(fontWeight = FontWeight.Bold), color = CalculusGreen)
            payLink.description?.let { Text(it, color = CalculusTextSecondary) }
            Spacer(Modifier.height(24.dp))
            Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
                Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Lien de paiement", style = MaterialTheme.typography.labelMedium, color = CalculusTextSecondary)
                    Text(payLink.url, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.Medium), color = CalculusGreen)
                }
            }
            Spacer(Modifier.height(24.dp))
            // Boutons de partage
            ShareButton(label = "WhatsApp", icon = Icons.Filled.Chat, url = payLink.whatsappUrl)
            Spacer(Modifier.height(8.dp))
            ShareButton(label = "SMS", icon = Icons.Filled.Sms, url = payLink.smsText)
            Spacer(Modifier.weight(1f))
            OutlinedButton(onClick = onNew, modifier = Modifier.fillMaxWidth().height(52.dp)) { Text("Nouveau lien") }
        }
    }
}

@Composable
private fun ShareButton(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, url: String) {
    OutlinedButton(modifier = Modifier.fillMaxWidth().height(52.dp), onClick = { /* TODO: Intent.ACTION_VIEW */ }) {
        Icon(icon, contentDescription = null, tint = CalculusGreen, modifier = Modifier.size(20.dp))
        Spacer(Modifier.width(8.dp))
        Text("Partager via $label")
    }
}
