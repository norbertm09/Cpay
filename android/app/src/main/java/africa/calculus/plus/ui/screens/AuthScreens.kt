package africa.calculus.plus.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.*
import androidx.compose.ui.text.font.*
import androidx.compose.ui.text.input.*
import androidx.compose.ui.unit.*
import androidx.hilt.navigation.compose.hiltViewModel
import africa.calculus.plus.ui.theme.*
import africa.calculus.plus.ui.viewmodel.AuthViewModel

// ════════════════════════════════════════════════════════════════
// LOGIN SCREEN
// ════════════════════════════════════════════════════════════════

@Composable
fun LoginScreen(
    onSuccess:  () -> Unit,
    onRegister: () -> Unit = {},
    vm: AuthViewModel = hiltViewModel(),
) {
    val state by vm.uiState.collectAsState()

    LaunchedEffect(state.isLoggedIn) {
        if (state.isLoggedIn) onSuccess()
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(CalculusBg)
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Spacer(Modifier.height(64.dp))

        // Logo / Titre
        Text(
            "Calculus Plus",
            style = MaterialTheme.typography.headlineLarge.copy(
                fontWeight = FontWeight.ExtraBold,
                color      = CalculusGreen,
            ),
        )
        Text(
            "Encaissez partout en Afrique",
            style = MaterialTheme.typography.bodyMedium,
            color = CalculusTextSecondary,
        )

        Spacer(Modifier.height(48.dp))

        // Email / Téléphone
        OutlinedTextField(
            value         = state.emailOrPhone,
            onValueChange = { vm.setEmailOrPhone(it) },
            label         = { Text("Email ou téléphone") },
            singleLine    = true,
            modifier      = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor   = CalculusGreen,
                unfocusedBorderColor = CalculusDivider,
                focusedTextColor     = CalculusText,
                unfocusedTextColor   = CalculusText,
                cursorColor          = CalculusGreen,
            ),
        )

        Spacer(Modifier.height(16.dp))

        // Mot de passe
        var showPassword by remember { mutableStateOf(false) }
        OutlinedTextField(
            value         = state.password,
            onValueChange = { vm.setPassword(it) },
            label         = { Text("Mot de passe") },
            singleLine    = true,
            modifier      = Modifier.fillMaxWidth(),
            visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
            trailingIcon  = {
                IconButton(onClick = { showPassword = !showPassword }) {
                    Icon(if (showPassword) Icons.Filled.VisibilityOff else Icons.Filled.Visibility,
                        null, tint = CalculusTextSecondary)
                }
            },
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor   = CalculusGreen,
                unfocusedBorderColor = CalculusDivider,
                focusedTextColor     = CalculusText,
                unfocusedTextColor   = CalculusText,
                cursorColor          = CalculusGreen,
            ),
        )

        // Erreur
        if (state.error != null) {
            Spacer(Modifier.height(8.dp))
            Text(state.error!!, color = CalculusRed, style = MaterialTheme.typography.bodySmall)
        }

        Spacer(Modifier.height(32.dp))

        // Bouton connexion
        Button(
            onClick  = { vm.login() },
            enabled  = !state.isLoading && state.emailOrPhone.isNotBlank() && state.password.isNotBlank(),
            modifier = Modifier.fillMaxWidth().height(56.dp),
            shape    = RoundedCornerShape(14.dp),
            colors   = ButtonDefaults.buttonColors(containerColor = CalculusGreen),
        ) {
            if (state.isLoading) {
                CircularProgressIndicator(color = CalculusBg, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
            } else {
                Text("Se connecter", style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold))
            }
        }

        Spacer(Modifier.height(16.dp))

        TextButton(onClick = onRegister) {
            Text("Créer un compte marchand", color = CalculusGreen)
        }
    }
}

// ════════════════════════════════════════════════════════════════
// ONBOARDING — Création compte marchand
// ════════════════════════════════════════════════════════════════

@Composable
fun OnboardingScreen(
    onSuccess: () -> Unit,
    onBack:    () -> Unit,
    vm: AuthViewModel = hiltViewModel(),
) {
    val state by vm.uiState.collectAsState()

    LaunchedEffect(state.isLoggedIn) {
        if (state.isLoggedIn) onSuccess()
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(CalculusBg)
            .padding(24.dp)
            .verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Spacer(Modifier.height(16.dp))

        Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) {
                Icon(Icons.Filled.ArrowBack, null, tint = CalculusText)
            }
            Text("Créer votre compte",
                style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.Bold),
                color = CalculusText)
        }

        // ── Informations entreprise ──────────────────────────
        SectionLabel("Votre entreprise")

        CalcTextField("Nom de l'entreprise *", state.reg_businessName) { vm.setRegField("businessName", it) }
        CalcTextField("RCCM", state.reg_rccm) { vm.setRegField("rccm", it) }
        CalcTextField("NIF", state.reg_nif) { vm.setRegField("nif", it) }

        // ── Compte de connexion ──────────────────────────────
        SectionLabel("Connexion")
        CalcTextField("Téléphone *", state.reg_phone, KeyboardType.Phone) { vm.setRegField("phone", it) }
        CalcTextField("Email *", state.reg_email, KeyboardType.Email) { vm.setRegField("email", it) }
        var showPwd by remember { mutableStateOf(false) }
        OutlinedTextField(
            value = state.reg_password, onValueChange = { vm.setRegField("password", it) },
            label = { Text("Mot de passe *") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            visualTransformation = if (showPwd) VisualTransformation.None else PasswordVisualTransformation(),
            trailingIcon = { IconButton({ showPwd = !showPwd }) {
                Icon(if (showPwd) Icons.Filled.VisibilityOff else Icons.Filled.Visibility, null, tint = CalculusTextSecondary) } },
            colors = calcTextFieldColors(),
        )

        // ── Compte de règlement ──────────────────────────────
        SectionLabel("Compte de règlement")
        Text("Où souhaitez-vous recevoir vos règlements J+1 ?",
            style = MaterialTheme.typography.bodySmall, color = CalculusTextSecondary)

        // Choix Mobile Money ou Banque
        var settlementType by remember { mutableStateOf("mobile_money") }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            FilterChip(selected = settlementType == "mobile_money",
                onClick = { settlementType = "mobile_money"; vm.setRegField("settlementType", "mobile_money") },
                label = { Text("Mobile Money") })
            FilterChip(selected = settlementType == "bank",
                onClick = { settlementType = "bank"; vm.setRegField("settlementType", "bank") },
                label = { Text("Banque") })
        }

        CalcTextField(
            label    = if (settlementType == "bank") "IBAN / Numéro de compte" else "Numéro de téléphone Mobile Money",
            value    = state.reg_settlementAccount,
            keyboardType = if (settlementType == "bank") KeyboardType.Text else KeyboardType.Phone,
            onValueChange = { vm.setRegField("settlementAccount", it) },
        )
        CalcTextField(
            label    = if (settlementType == "bank") "Nom de la banque" else "Opérateur (ex: MTN, Orange)",
            value    = state.reg_settlementProvider,
            onValueChange = { vm.setRegField("settlementProvider", it) },
        )

        if (state.error != null) {
            Text(state.error!!, color = CalculusRed, style = MaterialTheme.typography.bodySmall)
        }

        Spacer(Modifier.height(8.dp))

        Button(
            onClick  = { vm.register() },
            enabled  = !state.isLoading,
            modifier = Modifier.fillMaxWidth().height(56.dp),
            shape    = RoundedCornerShape(14.dp),
            colors   = ButtonDefaults.buttonColors(containerColor = CalculusGreen),
        ) {
            if (state.isLoading) CircularProgressIndicator(color = CalculusBg, strokeWidth = 2.dp, modifier = Modifier.size(20.dp))
            else Text("Créer mon compte", style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.Bold))
        }

        Spacer(Modifier.height(32.dp))
    }
}

// ─── Helpers UI ────────────────────────────────────────────────

@Composable
private fun SectionLabel(text: String) {
    Text(text, style = MaterialTheme.typography.labelLarge.copy(fontWeight = FontWeight.SemiBold), color = CalculusGreen)
}

@Composable
private fun CalcTextField(label: String, value: String, keyboardType: KeyboardType = KeyboardType.Text, onValueChange: (String) -> Unit) {
    OutlinedTextField(value = value, onValueChange = onValueChange, label = { Text(label) },
        singleLine = true, modifier = Modifier.fillMaxWidth(),
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType),
        colors = calcTextFieldColors())
}

@Composable
private fun calcTextFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = CalculusGreen, unfocusedBorderColor = CalculusDivider,
    focusedTextColor = CalculusText, unfocusedTextColor = CalculusText, cursorColor = CalculusGreen,
)
