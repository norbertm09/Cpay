package africa.calculus.plus.ui.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import africa.calculus.plus.domain.model.*
import africa.calculus.plus.domain.usecase.*
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch
import javax.inject.Inject

// ─── Dashboard ────────────────────────────────────────────────────

data class DashboardUiState(
    val greeting:         String = "",
    val businessName:     String = "",
    val txnToday:         Int    = 0,
    val amountToday:      Double = 0.0,
    val settlingTomorrow: Double = 0.0,
    val currency:         String = "XOF",
    val isLoading:        Boolean = true,
)

@HiltViewModel
class DashboardViewModel @Inject constructor(
    private val getDashboard: GetDashboardUseCase,
) : ViewModel() {

    private val _uiState = MutableStateFlow(DashboardUiState())
    val uiState: StateFlow<DashboardUiState> = _uiState.asStateFlow()

    init { load() }

    fun load() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            getDashboard()
                .onSuccess { data ->
                    val hour = java.time.LocalTime.now().hour
                    val greeting = when { hour < 12 -> "Bonjour"; hour < 18 -> "Bon après-midi"; else -> "Bonsoir" }
                    _uiState.update {
                        it.copy(
                            isLoading        = false,
                            greeting         = greeting,
                            businessName     = data.merchant.businessName,
                            txnToday         = data.txnToday,
                            amountToday      = data.amountToday,
                            settlingTomorrow = data.settlingTomorrow,
                            currency         = data.currency,
                        )
                    }
                }
                .onFailure { _uiState.update { it.copy(isLoading = false) } }
        }
    }
}

// ─── Collect ──────────────────────────────────────────────────────

enum class CollectStep { SELECT_METHOD, ENTER_AMOUNT, ENTER_PHONE, WAITING_NFC, PROCESSING, SUCCESS, FAILURE }
enum class PayoutStep  { SELECT_METHOD, ENTER_AMOUNT, ENTER_PHONE, WAITING_NFC, PROCESSING, SUCCESS, FAILURE }

data class CollectUiState(
    val step:     CollectStep   = CollectStep.SELECT_METHOD,
    val method:   String?       = null,
    val amount:   Double        = 0.0,
    val currency: String        = "XOF",
    val phone:    String?       = null,
    val result:   PaymentResult? = null,
)

@HiltViewModel
class CollectViewModel @Inject constructor(
    private val collectUseCase: CollectUseCase,
) : ViewModel() {

    private val _uiState = MutableStateFlow(CollectUiState())
    val uiState: StateFlow<CollectUiState> = _uiState.asStateFlow()

    fun selectMobileMoney() { _uiState.update { it.copy(method = "mobile_money", step = CollectStep.ENTER_AMOUNT) } }
    fun selectCard()         { _uiState.update { it.copy(method = "card", step = CollectStep.ENTER_AMOUNT) } }
    fun goBack()             { _uiState.update { it.copy(step = CollectStep.SELECT_METHOD) } }

    fun setAmount(amount: Double) {
        _uiState.update { it.copy(amount = amount) }
        if (_uiState.value.method == "card") {
            _uiState.update { it.copy(step = CollectStep.WAITING_NFC) }
        } else {
            _uiState.update { it.copy(step = CollectStep.ENTER_PHONE) }
        }
    }

    fun setPhone(phone: String) {
        _uiState.update { it.copy(phone = phone) }
        processPayment()
    }

    fun onNfcResult(emvPayload: String, aidDetected: String?) {
        _uiState.update { it.copy(step = CollectStep.PROCESSING) }
        viewModelScope.launch {
            val result = collectUseCase(
                amount      = _uiState.value.amount,
                emvPayload  = emvPayload,
                aidDetected = aidDetected,
            )
            _uiState.update { it.copy(result = result, step = if (result is PaymentResult.Success) CollectStep.SUCCESS else CollectStep.FAILURE) }
        }
    }

    private fun processPayment() {
        _uiState.update { it.copy(step = CollectStep.PROCESSING) }
        viewModelScope.launch {
            val state  = _uiState.value
            val result = collectUseCase(amount = state.amount, customerPhone = state.phone)
            _uiState.update { it.copy(result = result, step = if (result is PaymentResult.Success) CollectStep.SUCCESS else CollectStep.FAILURE) }
        }
    }

    fun retry() { _uiState.update { it.copy(step = CollectStep.SELECT_METHOD, result = null) } }
}

// ─── Payout ───────────────────────────────────────────────────────

data class PayoutUiState(
    val step:     PayoutStep     = PayoutStep.SELECT_METHOD,
    val method:   String?        = null,
    val amount:   Double         = 0.0,
    val currency: String         = "XOF",
    val phone:    String?        = null,
    val result:   PaymentResult? = null,
)

@HiltViewModel
class PayoutViewModel @Inject constructor(
    private val payoutUseCase: PayoutUseCase,
) : ViewModel() {

    private val _uiState = MutableStateFlow(PayoutUiState())
    val uiState: StateFlow<PayoutUiState> = _uiState.asStateFlow()

    fun selectMobileMoney() { _uiState.update { it.copy(method = "mobile_money", step = PayoutStep.ENTER_AMOUNT) } }
    fun selectCard()        { _uiState.update { it.copy(method = "card", step = PayoutStep.ENTER_AMOUNT) } }
    fun goBack()            { _uiState.update { it.copy(step = PayoutStep.SELECT_METHOD) } }

    fun setAmount(amount: Double) {
        _uiState.update { it.copy(amount = amount) }
        _uiState.update { it.copy(step = if (_uiState.value.method == "card") PayoutStep.WAITING_NFC else PayoutStep.ENTER_PHONE) }
    }

    fun setPhone(phone: String) {
        _uiState.update { it.copy(phone = phone, step = PayoutStep.PROCESSING) }
        viewModelScope.launch {
            val state  = _uiState.value
            val result = payoutUseCase(amount = state.amount, customerPhone = state.phone)
            _uiState.update { it.copy(result = result, step = if (result is PaymentResult.Success) PayoutStep.SUCCESS else PayoutStep.FAILURE) }
        }
    }

    fun retry() { _uiState.update { it.copy(step = PayoutStep.SELECT_METHOD, result = null) } }
}

// ─── QR ──────────────────────────────────────────────────────────

data class QrUiState(val currency: String = "XOF", val description: String? = null, val isLoading: Boolean = false, val qrPayload: QrPayload? = null)

@HiltViewModel
class QrViewModel @Inject constructor(private val generateQr: GenerateQrUseCase) : ViewModel() {
    private val _uiState = MutableStateFlow(QrUiState())
    val uiState: StateFlow<QrUiState> = _uiState.asStateFlow()
    fun setDescription(d: String) { _uiState.update { it.copy(description = d) } }
    fun generateQr(amount: Double, description: String?) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            generateQr(amount, description).onSuccess { qr -> _uiState.update { it.copy(isLoading = false, qrPayload = qr) } }
                .onFailure { _uiState.update { it.copy(isLoading = false) } }
        }
    }
    fun reset() { _uiState.update { QrUiState(currency = _uiState.value.currency) } }
}

// ─── PayLink ──────────────────────────────────────────────────────

data class PayLinkUiState(val currency: String = "XOF", val description: String? = null, val isLoading: Boolean = false, val payLink: PayLink? = null)

@HiltViewModel
class PayLinkViewModel @Inject constructor(private val generatePayLink: GeneratePayLinkUseCase) : ViewModel() {
    private val _uiState = MutableStateFlow(PayLinkUiState())
    val uiState: StateFlow<PayLinkUiState> = _uiState.asStateFlow()
    fun setDescription(d: String) { _uiState.update { it.copy(description = d) } }
    fun generatePayLink(amount: Double, description: String?) {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true) }
            generatePayLink(amount, description).onSuccess { pl -> _uiState.update { it.copy(isLoading = false, payLink = pl) } }
                .onFailure { _uiState.update { it.copy(isLoading = false) } }
        }
    }
    fun reset() { _uiState.update { PayLinkUiState(currency = _uiState.value.currency) } }
}

// ─── Auth ─────────────────────────────────────────────────────────

data class AuthUiState(
    val emailOrPhone: String  = "",
    val password:     String  = "",
    val isLoading:    Boolean = false,
    val isLoggedIn:   Boolean = false,
    val error:        String? = null,
    // Register fields
    val reg_businessName:     String = "",
    val reg_rccm:             String = "",
    val reg_nif:              String = "",
    val reg_phone:            String = "",
    val reg_email:            String = "",
    val reg_password:         String = "",
    val reg_settlementType:   String = "mobile_money",
    val reg_settlementAccount:String = "",
    val reg_settlementProvider:String = "",
)

@HiltViewModel
class AuthViewModel @Inject constructor(
    private val authRepository: africa.calculus.plus.data.repository.AuthRepository,
) : ViewModel() {
    private val _uiState = MutableStateFlow(AuthUiState())
    val uiState: StateFlow<AuthUiState> = _uiState.asStateFlow()

    fun setEmailOrPhone(v: String) { _uiState.update { it.copy(emailOrPhone = v) } }
    fun setPassword(v: String)     { _uiState.update { it.copy(password = v) } }
    fun setRegField(field: String, value: String) {
        _uiState.update { s -> when (field) {
            "businessName"     -> s.copy(reg_businessName = value)
            "rccm"             -> s.copy(reg_rccm = value)
            "nif"              -> s.copy(reg_nif = value)
            "phone"            -> s.copy(reg_phone = value)
            "email"            -> s.copy(reg_email = value)
            "password"         -> s.copy(reg_password = value)
            "settlementType"   -> s.copy(reg_settlementType = value)
            "settlementAccount"-> s.copy(reg_settlementAccount = value)
            "settlementProvider"->s.copy(reg_settlementProvider = value)
            else               -> s
        }}
    }

    fun login() {
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, error = null) }
            authRepository.login(_uiState.value.emailOrPhone, _uiState.value.password)
                .onSuccess { _uiState.update { it.copy(isLoading = false, isLoggedIn = true) } }
                .onFailure { _uiState.update { it.copy(isLoading = false, error = it.error ?: "Erreur de connexion") } }
        }
    }

    fun register() {
        val s = _uiState.value
        viewModelScope.launch {
            _uiState.update { it.copy(isLoading = true, error = null) }
            authRepository.register(
                businessName = s.reg_businessName, rccm = s.reg_rccm.ifBlank { null },
                nif = s.reg_nif.ifBlank { null }, phone = s.reg_phone, email = s.reg_email,
                password = s.reg_password, settlementType = s.reg_settlementType,
                settlementAccount = s.reg_settlementAccount.ifBlank { null },
                settlementProvider = s.reg_settlementProvider.ifBlank { null },
            ).onSuccess { _uiState.update { it.copy(isLoading = false, isLoggedIn = true) } }
             .onFailure { err -> _uiState.update { it.copy(isLoading = false, error = err.message) } }
        }
    }
}

// ─── Transactions ─────────────────────────────────────────────────

data class TransactionsUiState(val transactions: List<Transaction> = emptyList(), val isLoading: Boolean = true)

@HiltViewModel
class TransactionsViewModel @Inject constructor(private val getTransactions: GetTransactionsUseCase) : ViewModel() {
    private val _uiState = MutableStateFlow(TransactionsUiState())
    val uiState: StateFlow<TransactionsUiState> = _uiState.asStateFlow()
    init { viewModelScope.launch {
        getTransactions().onSuccess { list -> _uiState.update { it.copy(isLoading = false, transactions = list) } }
                         .onFailure { _uiState.update { it.copy(isLoading = false) } }
    }}
}

// ─── Settlements ──────────────────────────────────────────────────

data class SettlementsUiState(
    val settlements: List<africa.calculus.plus.data.api.SettlementItem> = emptyList(),
    val isLoading: Boolean = true,
)

@HiltViewModel
class SettlementsViewModel @Inject constructor(
    private val api: africa.calculus.plus.data.api.CalculusApiService,
) : ViewModel() {
    private val _uiState = MutableStateFlow(SettlementsUiState())
    val uiState: StateFlow<SettlementsUiState> = _uiState.asStateFlow()
    init { viewModelScope.launch {
        try {
            val r = api.getSettlements()
            _uiState.update { it.copy(isLoading = false, settlements = r.body()?.data ?: emptyList()) }
        } catch (e: Exception) { _uiState.update { it.copy(isLoading = false) } }
    }}
}
