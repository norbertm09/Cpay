package africa.calculus.plus

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.*
import androidx.navigation.compose.*
import africa.calculus.plus.security.SecureStorage
import africa.calculus.plus.ui.screens.*
import africa.calculus.plus.ui.theme.*
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject lateinit var secureStorage: SecureStorage

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            CalculusPlusTheme {
                val navController = rememberNavController()
                val startDest     = if (secureStorage.isLoggedIn()) "dashboard" else "login"

                NavHost(navController = navController, startDestination = startDest) {
                    composable("login")    { LoginScreen(onSuccess = { navController.navigate("dashboard") { popUpTo(0) } }) }
                    composable("dashboard") {
                        DashboardScreen(
                            onCollect      = { navController.navigate("collect") },
                            onPayout       = { navController.navigate("payout") },
                            onQrCode       = { navController.navigate("qr") },
                            onPayLink      = { navController.navigate("paylink") },
                            onTransactions = { navController.navigate("transactions") },
                            onSettlements  = { navController.navigate("settlements") },
                        )
                    }
                    composable("collect")      { CollectScreen(onBack = { navController.popBackStack() }) }
                    composable("payout")       { PayoutScreen(onBack = { navController.popBackStack() }) }
                    composable("qr")           { QrCodeScreen(onBack = { navController.popBackStack() }) }
                    composable("paylink")      { PayLinkScreen(onBack = { navController.popBackStack() }) }
                    composable("transactions") { TransactionsScreen(onBack = { navController.popBackStack() }) }
                    composable("settlements")  { SettlementsScreen(onBack = { navController.popBackStack() }) }
                }
            }
        }
    }
}

@Composable
fun CalculusPlusTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary   = CalculusGreen,
            background = CalculusBg,
            surface   = CalculusSurface,
            onPrimary  = CalculusBg,
            onBackground = CalculusText,
            onSurface  = CalculusText,
        ),
        content = content,
    )
}
